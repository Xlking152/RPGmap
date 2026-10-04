import { FOG_CELL_SIZE_METERS, normalizeFogState, mergeSpans } from './fog.js';
import { computeVisibilityRowsAsync } from './visibility.js';
import { sceneVisionContext, releaseVisionContexts } from './context.js';
import { createVisionBackground } from './background.js';
import { createVisionViewport, visionZoomTransform } from './viewport.js';
import { createContinuousMaskRenderer } from './mask-renderer.js';
import { readRuntimeState } from '../engine/state-access.js';
import { classifyVisionChange, tokenVisionLight, visionStatusTargets, visionScene as runtimeScene } from './invalidation.js';
import {
  sphereGroundRadiusMeters,
  visionIgnoresOcclusion,
} from '../spatial/kernel.js';

const FOG_PANE = 'fogVisionPane';

function exploredRows(fog, partyIds) {
  const byRow = new Map();
  for (const partyId of partyIds) {
    const rows = fog.exploredByParty?.[String(partyId)]?.rows || {};
    for (const [row, spans] of Object.entries(rows)) {
      byRow.set(row, [...(byRow.get(row) || []), ...(Array.isArray(spans) ? spans : [])]);
    }
  }
  return new Map([...byRow].map(([row, spans]) => [row, mergeSpans(spans)]));
}

function mergeDirtyBounds(left, right) {
  if (left === null || right === null) return null;
  if (!left) return right;
  if (!right) return left;
  return {
    minX: Math.min(Number(left.minX), Number(right.minX)),
    minY: Math.min(Number(left.minY), Number(right.minY)),
    maxX: Math.max(Number(left.maxX), Number(right.maxX)),
    maxY: Math.max(Number(left.maxY), Number(right.maxY)),
  };
}

export function resolveVisionAudience(connected, serverAudience, localAudience) {
  return connected ? serverAudience || null : localAudience;
}

export function resolveLiveAudienceVision(audience, scene, sourceTokenId = undefined, visualPoint = null) {
  if (!audience || typeof audience !== 'object') return null;
  const requestedTokenId = sourceTokenId === undefined ? audience.source?.tokenId : sourceTokenId;
  const tokenId = String(requestedTokenId ?? '').trim();
  if (!tokenId) return { ...audience, source: null };
  const token = scene?.tokens?.find(item => String(item?.id ?? '') === tokenId);
  if (!token || token.placement !== 'map') return { ...audience, source: null };
  const visualX = Number(visualPoint?.x);
  const visualY = Number(visualPoint?.y);
  const visualElevation = Number(visualPoint?.elevationMeters);
  const hasVisualPoint = Number.isFinite(visualX) && Number.isFinite(visualY);
  return {
    ...audience,
    source: {
      ...(audience.source || {}),
      tokenId,
      x: hasVisualPoint ? visualX : Number(token.x),
      y: hasVisualPoint ? visualY : Number(token.y),
      elevationMeters: Number.isFinite(visualElevation)
        ? Math.max(0, visualElevation)
        : Number(token.elevationMeters) || 0,
    },
  };
}

export function createVisionFogSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.map || api.vision) return;
      let snapshotRevision = -1, cachedState = null, cachedSubject = null, spatial = null;
      function visionState() {
        const revision = api.getStateRevision?.();
        if (!cachedState || revision === undefined || revision !== snapshotRevision) {
          cachedState = readRuntimeState(api); snapshotRevision = revision;
          cachedSubject = null; spatial = null;
        }
        return cachedState;
      }
      const documentNode = api.map.getContainer().ownerDocument || document;
      const continuousMasks = createContinuousMaskRenderer(documentNode);
      const pane = api.map.getPane?.(FOG_PANE) || api.map.createPane(FOG_PANE);
      pane.style.zIndex = '510';
      pane.style.pointerEvents = 'none';
      const createCanvas = (layer, blendMode = '') => {
        const canvas = documentNode.createElement('canvas');
        canvas.className = `rpgmap-vision-fog-canvas rpgmap-vision-fog-${layer} leaflet-zoom-animated`;
        canvas.dataset.fogLayer = layer;
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.position = 'absolute';
        canvas.style.transformOrigin = '0 0';
        canvas.style.pointerEvents = 'none';
        if (blendMode) canvas.style.mixBlendMode = blendMode;
        pane.append(canvas);
        return canvas;
      };
      const explorationCanvas = createCanvas('exploration-cache');
      explorationCanvas.style.display = 'none';
      const perceptionCanvas = createCanvas('perception');
      const canvases = [explorationCanvas, perceptionCanvas];
      let localSourceTokenId = null;
      let lastLocalVision = null;
      let localExploreChain = Promise.resolve();
      let explorationGeneration = 0;
      let connectedClearPending = false;
      let renderFrame = 0;
      let pendingDirtyBounds;
      let explorationDirty = true;
      let exploredDirty = true, exploredCache = [], exploredParties = '', exploredFogReference = null;
      let visibilityRowsCache = null;
      let displayedVisibilityFrame = null;
      let visibilityBackground = createVisionBackground({ diagnostics: api.diagnostics });
      let visibilityPending = false;
      let latestVisibilityRequest = null;
      let visibilityGeneration = 0;
      let visibilityContext = '';
      let visibilitySignature = '';
      let visibilityAbort = null;
      let destroyed = false;
      let animatedZoom = null;
      const positionCanvases = () => {
        const transform = visionZoomTransform(api.map, api.mapPackage.height, animatedZoom);
        canvases.forEach(canvas => { canvas.style.transform = transform; });
      };

      function cancelVisibility() {
        visibilityGeneration += 1;
        visibilityRowsCache = null;
        displayedVisibilityFrame = null;
        latestVisibilityRequest = null;
        visibilitySignature = '';
        visibilityAbort?.abort();
        visibilityAbort = null;
        visibilityBackground?.cancel();
      }

      function requestVisibility(request) {
        latestVisibilityRequest = request;
        if (visibilityPending) return;
        const next = latestVisibilityRequest;
        latestVisibilityRequest = null;
        visibilityPending = true;
        const generation = visibilityGeneration;
        const controller = new AbortController();
        visibilityAbort = controller;
        const run = async () => {
          if (!visibilityBackground) return computeVisibilityRowsAsync(next.input, { signal: controller.signal });
          const background = visibilityBackground;
          try { return await background.run(next.input); }
          catch (error) {
            if (destroyed || generation !== visibilityGeneration || controller.signal.aborted) throw error;
            background.dispose();
            if (visibilityBackground === background) visibilityBackground = null;
            return computeVisibilityRowsAsync(next.input, { signal: controller.signal });
          }
        };
        run().then(result => {
          if (destroyed || generation !== visibilityGeneration || controller.signal.aborted) return;
          // There is only one running task. Its completed frame is newer than
          // the displayed frame even when movement has queued a later sample;
          // source/geometry generations still reject invalidated results.
          visibilityRowsCache = { signature: next.signature, source: next.input.source,
            requestedAt: next.requestedAt, stateRevision: next.stateRevision, feedbackRecorded: false, ...result };
          // Replace the complete mask at the next frame, coalescing Worker,
          // animation, Fog and viewport updates into one atomic paint.
          scheduleRender(null);
        }).catch(error => {
          if (!destroyed && generation === visibilityGeneration && !controller.signal.aborted)
            api.showToast?.(error.message, 'error');
        }).finally(() => {
          if (visibilityAbort === controller) visibilityAbort = null;
          visibilityPending = false;
          if (!destroyed && latestVisibilityRequest && latestVisibilityRequest.signature !== visibilityRowsCache?.signature) {
            requestVisibility(latestVisibilityRequest);
          }
        });
      }
      const off = [];
      const retain = dispose => { if (typeof dispose === 'function') off.push(dispose); };

      function localVisionSubject() {
        if (!localSourceTokenId) return null;
        const world = visionState().preferences?.worldV2;
        if (cachedSubject?.tokenId === localSourceTokenId) return cachedSubject;
        const scene = world?.scenes?.find(item => String(item.id) === String(world.activeSceneId));
        const token = scene?.tokens?.find(item => String(item.id) === String(localSourceTokenId));
        const actor = token && world?.actors?.find(item => String(item.id) === String(token.actorId));
        if (!token || !actor || token.placement !== 'map') return null;
        const resolved = api.tokens?.resolveActor?.(token.id)?.actor || actor;
        const description = api.ruleset?.vision?.describe?.(resolved, {
          token, scene, lighting: 'normal',
        }) || {};
        const legacyOverride = token.vision?.rangeOverrideMeters;
        const preciseOverride = token.vision?.preciseRangeOverrideMeters ?? legacyOverride;
        const vagueOverride = token.vision?.vagueRangeOverrideMeters ?? legacyOverride;
        let preciseRangeMeters = preciseOverride === null || preciseOverride === undefined
          ? Number(description.preciseRangeMeters ?? description.rangeMeters) || 0
          : Number(preciseOverride) || 0;
        let vagueRangeMeters = vagueOverride === null || vagueOverride === undefined
          ? Math.max(preciseRangeMeters, Number(description.vagueRangeMeters ?? preciseRangeMeters) || 0)
          : Math.max(preciseRangeMeters, Number(vagueOverride) || 0);
        const capabilities = api.status?.resolveCapabilities?.({ tokenId: token.id }) || {};
        if (capabilities.visionPrecision === 'vague') {
          vagueRangeMeters = Math.max(vagueRangeMeters, preciseRangeMeters);
          preciseRangeMeters = 0;
        }
        return cachedSubject = {
          sceneId: String(scene.id), tokenId: String(token.id),
          x: Number(token.x),
          y: Number(token.y),
          elevationMeters: Number(token.elevationMeters) || 0,
          rangeMeters: preciseRangeMeters,
          preciseRangeMeters, vagueRangeMeters,
          preciseGroundRangeMeters: sphereGroundRadiusMeters(preciseRangeMeters, token.elevationMeters) ?? 0,
          vagueGroundRangeMeters: sphereGroundRadiusMeters(vagueRangeMeters, token.elevationMeters) ?? 0,
          senses: structuredClone(description.senses || {}), lighting: scene?.settings?.lighting || 'normal',
          lineOfSightEnabled: true,
          partyId: actor.partyId ? String(actor.partyId) : null,
        };
      }

      function localVisionState() {
        const subject = localVisionSubject();
        if (!subject) return null;
        return {
          schemaVersion: 1,
          source: {
            tokenId: subject.tokenId, x: subject.x, y: subject.y,
            elevationMeters: subject.elevationMeters,
            rangeMeters: subject.rangeMeters,
            preciseRangeMeters: subject.preciseRangeMeters,
            vagueRangeMeters: subject.vagueRangeMeters,
            preciseGroundRangeMeters: subject.preciseGroundRangeMeters,
            vagueGroundRangeMeters: subject.vagueGroundRangeMeters,
            senses: subject.senses,
            lighting: subject.lighting,
            lineOfSightEnabled: subject.lineOfSightEnabled,
          },
          partyIds: subject.partyId ? [subject.partyId] : [],
          gmPreview: true,
        };
      }

      function queueLocalExploration(subject, previous = null) {
        if (previous && api.world?.queuesConfirmedExploration) return Promise.resolve(null);
        if (!subject?.partyId || subject.vagueGroundRangeMeters <= 0) return Promise.resolve(null);
        const generation = explorationGeneration;
        const payload = previous && previous.sceneId === subject.sceneId
          ? {
              sceneId: subject.sceneId, partyId: subject.partyId,
              visionSourceTokenId: subject.tokenId,
              from: { x: previous.x, y: previous.y, elevationMeters: previous.elevationMeters },
              to: { x: subject.x, y: subject.y, elevationMeters: subject.elevationMeters },
              radiusMeters: subject.vagueGroundRangeMeters,
            }
          : {
              sceneId: subject.sceneId, partyId: subject.partyId,
              visionSourceTokenId: subject.tokenId,
              x: subject.x, y: subject.y, elevationMeters: subject.elevationMeters,
              radiusMeters: subject.vagueGroundRangeMeters,
            };
        localExploreChain = localExploreChain.catch(() => null).then(() => {
          const current = localVisionSubject();
          if (generation !== explorationGeneration || api.multiplayer?.getStatus?.()?.connected || !current
            || current.sceneId !== subject.sceneId || current.tokenId !== subject.tokenId) return null;
          return api.world.performOperations([
            { type: 'scene.fog.explore', payload },
          ], { source: 'vision:explore' });
        });
        return localExploreChain;
      }

      function confirmedSourceTokenId() {
        if (api.multiplayer?.getStatus?.()?.connected) {
          return api.multiplayer?.getVisionSource?.() || null;
        }
        return localSourceTokenId;
      }

      function liveVisionState() {
        const state = visionState();
        const connected = api.multiplayer?.getStatus?.()?.connected === true;
        const audience = resolveVisionAudience(connected, state.preferences?.audienceVision,
          connected ? null : localVisionState());
        const sourceTokenId = confirmedSourceTokenId();
        const visualPoint = sourceTokenId
          ? api.renderer?.getVisualTokenPoint?.(sourceTokenId) || null
          : null;
        return resolveLiveAudienceVision(audience, runtimeScene(visionState()), sourceTokenId, visualPoint);
      }

      function clearUnavailableConnectedSource() {
        if (!api.multiplayer?.getStatus?.()?.connected || connectedClearPending) return;
        const tokenId = api.multiplayer?.getVisionSource?.();
        if (!tokenId) return;
        const scene = runtimeScene(visionState());
        const token = scene?.tokens?.find(item => String(item?.id ?? '') === String(tokenId));
        const canControl = token && token.placement === 'map'
          && api.multiplayer?.canControlToken?.(tokenId) === true;
        if (canControl) return;
        connectedClearPending = true;
        api.multiplayer.setVisionSource(null)
          .catch(error => api.showToast?.(error.message, 'error'))
          .finally(() => { connectedClearPending = false; });
      }

      function synchronizeLocalVision() {
        if (api.multiplayer?.getStatus?.()?.connected || !localSourceTokenId) return false;
        const subject = localVisionSubject();
        if (!subject) {
          localSourceTokenId = null;
          lastLocalVision = null;
          api.emit?.('vision:source-change', { tokenId: null });
          return true;
        }
        const previous = lastLocalVision;
        const moved = previous
          && previous.tokenId === subject.tokenId
          && previous.sceneId === subject.sceneId
          && (previous.x !== subject.x || previous.y !== subject.y
            || previous.elevationMeters !== subject.elevationMeters);
        const changed = JSON.stringify(previous) !== JSON.stringify(subject);
        lastLocalVision = subject;
        if (moved) queueLocalExploration(subject, previous).catch(error => api.showToast?.(error.message, 'error'));
        return changed;
      }

      function render(dirtyBounds = null) {
        const renderStarted = performance.now();
        const audience = liveVisionState();
        if (!audience) {
          canvases.forEach(canvas => { canvas.hidden = true; });
          return;
        }
        const authoritativeScene = runtimeScene(visionState());
        const scene = api.occlusionEditor?.getPreviewScene?.(authoritativeScene) || authoritativeScene;
        if (!scene) return;
        canvases.forEach(canvas => { canvas.hidden = false; });
        const size = api.map.getSize();
        const dpr = Math.max(1, Math.min(2, Number(documentNode.defaultView?.devicePixelRatio) || 1));
        let resized = false;
        for (const canvas of canvases) {
          if (canvas.width !== Math.ceil(size.x * dpr) || canvas.height !== Math.ceil(size.y * dpr)) {
            resized = true;
            canvas.width = Math.ceil(size.x * dpr);
            canvas.height = Math.ceil(size.y * dpr);
            canvas.style.width = `${size.x}px`;
            canvas.style.height = `${size.y}px`;
          }
        }
        positionCanvases();
        const exploration = explorationCanvas.getContext('2d');
        const perception = perceptionCanvas.getContext('2d');
        for (const context of [exploration, perception]) {
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        const metersPerUnit = Math.max(0.000001, Number(api.mapPackage?.metersPerUnit) || 1);
        const cellUnits = FOG_CELL_SIZE_METERS / metersPerUnit;
        const partyKey = JSON.stringify(audience.partyIds || []);
        if (exploredDirty || scene.fog !== exploredFogReference || partyKey !== exploredParties) {
          exploredCache = [...exploredRows(normalizeFogState(scene.fog), audience.partyIds || [])];
          exploredParties = partyKey; exploredFogReference = scene.fog; exploredDirty = false; explorationDirty = true;
        }
        const rows = exploredCache;
        const viewport = createVisionViewport(api.map, api.mapPackage.height);
        const { zero, scaleX, scaleY } = viewport;
        const worldRect = viewport.rectangle;
        const rowMin = Math.floor(Math.min(-zero.y / scaleY, (size.y - zero.y) / scaleY) / cellUnits) - 1;
        const rowMax = Math.ceil(Math.max(-zero.y / scaleY, (size.y - zero.y) / scaleY) / cellUnits) + 1;
        const colMin = Math.floor(Math.min(-zero.x / scaleX, (size.x - zero.x) / scaleX) / cellUnits) - 1;
        const colMax = Math.ceil(Math.max(-zero.x / scaleX, (size.x - zero.x) / scaleX) / cellUnits) + 1;
        const clip = dirtyBounds && !resized
          ? worldRect(
              Number(dirtyBounds.minX), Number(dirtyBounds.minY),
              Number(dirtyBounds.maxX) - Number(dirtyBounds.minX),
              Number(dirtyBounds.maxY) - Number(dirtyBounds.minY),
            )
          : null;
        perception.save();
        if (clip) {
          const x = Math.max(0, Math.floor(clip.x) - 2);
          const y = Math.max(0, Math.floor(clip.y) - 2);
          const width = Math.min(size.x - x, Math.ceil(clip.width) + 4);
          const height = Math.min(size.y - y, Math.ceil(clip.height) + 4);
          perception.beginPath();
          perception.rect(x, y, Math.max(0, width), Math.max(0, height));
          perception.clip();
          perception.clearRect(x, y, Math.max(0, width), Math.max(0, height));
        } else {
          perception.clearRect(0, 0, size.x, size.y);
        }
        const drawRows = (context, rowEntries) => {
          for (const [row, spans] of rowEntries) {
            if (Number(row) < rowMin || Number(row) > rowMax) continue;
            for (const [rawStart, rawEnd] of spans) {
              const start = Math.max(rawStart, colMin), end = Math.min(rawEnd, colMax);
              if (end < start) continue;
              const rect = worldRect(start * cellUnits, Number(row) * cellUnits, (end - start + 1) * cellUnits, cellUnits);
              context.fillRect(rect.x, rect.y, rect.width + 1, rect.height + 1);
            }
          }
        };
        const drawExplored = context => drawRows(context, rows);
        const source = audience.source;
        const drawCurrentCircle = (context, rawRange) => {
          const range = Number(rawRange) || 0;
          if (!source || range <= 0) return;
          const center = viewport.project(Number(source.x), Number(source.y));
          context.beginPath();
          context.arc(center.x, center.y, Math.abs(range / metersPerUnit * scaleX), 0, Math.PI * 2);
          context.fill();
        };
        let currentPrepared = false;
        const drawCurrent = (context, rawRange, kind) => {
          const rangeMeters = Number(rawRange) || 0;
          if (!source || rangeMeters <= 0) return;
          spatial ||= sceneVisionContext(api.mapPackage, scene);
          const { lights, occluders, geometryVersion, lightVersion } = spatial;
          const ignoresOcclusion = visionIgnoresOcclusion(source);
          if ((!source.lineOfSightEnabled || ignoresOcclusion) && (kind !== 'precise'
            || ((source.lighting || 'normal') === 'normal' && !lights.length))) {
            drawCurrentCircle(context, rangeMeters); return;
          }
          if (!currentPrepared) {
            currentPrepared = true;
            const contextKey = JSON.stringify({ geometryVersion, lightVersion, tokenId: confirmedSourceTokenId(),
              ...source, x: undefined, y: undefined });
            if (contextKey !== visibilityContext) {
              visibilityContext = contextKey;
              cancelVisibility();
            }
            const signature = contextKey + ':' + source.x + ':' + source.y;
            const signatureChanged = signature !== visibilitySignature;
            visibilitySignature = signature;
            if (!visibilityRowsCache || visibilityRowsCache.signature !== signature) {
              const input = { kind: 'visibility', source, occluders, lights, ignoresOcclusion, continuous: true,
                contextVersion: geometryVersion, lightVersion,
                map: { width: api.mapPackage.width, height: api.mapPackage.height, metersPerUnit } };
              if (signatureChanged || (!visibilityPending && !latestVisibilityRequest))
                requestVisibility({ signature, input, requestedAt: performance.now(), stateRevision: api.getStateRevision?.() ?? null });
            }
            api.diagnostics?.record('vision.cacheHit', spatial.cacheHit ? 1 : 0);
            api.diagnostics?.record('vision.cacheSize', spatial.cacheSize);
          }
          // While the next position is computing, keep the last complete mask
          // for this context. Context/source changes already clear the cache.
          // This avoids an all-fog frame between movement samples.
          if (visibilityRowsCache) {
            const geometry = visibilityRowsCache.continuous;
            if (geometry && !geometry.fallback && !(kind === 'precise' && geometry.illumination.regions.some(region => region.fallback))) {
              continuousMasks.draw(context, { key: `${kind}:${rangeMeters}:${visibilityRowsCache.signature}:${zero.x}:${zero.y}:${scaleX}:${scaleY}:${size.x}:${size.y}:${dpr}`, geometry, source: visibilityRowsCache.source,
                lightingKey: `${geometryVersion}:${lightVersion}:${zero.x}:${zero.y}:${scaleX}:${scaleY}:${size.x}:${size.y}:${dpr}`,
                radiusUnits: rangeMeters / metersPerUnit, kind, viewport, width: size.x, height: size.y, dpr });
            } else drawRows(context, visibilityRowsCache[kind] || []);
          }
        };

        if (explorationDirty || resized) {
          exploration.clearRect(0, 0, size.x, size.y);
          exploration.globalCompositeOperation = 'source-over';
          exploration.fillStyle = 'rgba(8,12,14,0.96)';
          exploration.fillRect(0, 0, size.x, size.y);
          exploration.globalCompositeOperation = 'destination-out';
          exploration.fillStyle = '#000';
          drawExplored(exploration);
          exploration.globalCompositeOperation = 'source-over';
          exploration.fillStyle = 'rgba(11,16,18,0.70)';
          drawExplored(exploration);
          explorationDirty = false;
        }

        perception.globalCompositeOperation = 'source-over';
        perception.drawImage(explorationCanvas, 0, 0, size.x, size.y);
        const preciseRange = Number(source?.preciseGroundRangeMeters ?? source?.preciseRangeMeters ?? source?.rangeMeters) || 0;
        const vagueRange = Number(source?.vagueGroundRangeMeters ?? source?.vagueRangeMeters ?? source?.rangeMeters) || 0;
        // With full ambient precision, the precise pass clears every vague
        // pixel inside the same range. Avoid constructing and tinting that
        // completely overwritten mask, without changing either sight range.
        const preciseCoversVague = preciseRange >= vagueRange && source?.lighting === 'normal';
        if (!preciseCoversVague) {
          perception.globalCompositeOperation = 'destination-out';
          perception.fillStyle = '#000';
          drawCurrent(perception, vagueRange, 'vague');
          perception.globalCompositeOperation = 'source-over';
          perception.fillStyle = 'rgba(218,226,228,0.20)';
          drawCurrent(perception, vagueRange, 'vague');
        }
        perception.globalCompositeOperation = 'destination-out';
        perception.fillStyle = '#000';
        drawCurrent(perception, preciseRange, 'precise');
        perception.globalCompositeOperation = 'source-over';
        perception.restore();
        if (visibilityRowsCache && !visibilityRowsCache.feedbackRecorded) {
          visibilityRowsCache.feedbackRecorded = true;
          api.diagnostics?.record('vision.feedback', performance.now() - visibilityRowsCache.requestedAt);
        }
        if (visibilityRowsCache) displayedVisibilityFrame = visibilityRowsCache;
        api.diagnostics?.record('vision.draw', performance.now() - renderStarted);
      }

      function scheduleRender(dirtyBounds = null) {
        pendingDirtyBounds = pendingDirtyBounds === undefined
          ? dirtyBounds
          : mergeDirtyBounds(pendingDirtyBounds, dirtyBounds);
        if (renderFrame) return;
        const requestFrame = documentNode.defaultView?.requestAnimationFrame || (callback => setTimeout(callback, 16));
        renderFrame = requestFrame(flushScheduledRender);
      }

      function flushScheduledRender() {
        if (renderFrame) {
          const cancelFrame = documentNode.defaultView?.cancelAnimationFrame || clearTimeout;
          cancelFrame(renderFrame);
          renderFrame = 0;
        }
        const bounds = pendingDirtyBounds;
        pendingDirtyBounds = undefined;
        if (!destroyed) render(bounds);
      }

      api.vision = {
        async setSource(tokenId = null) {
          cachedSubject = null;
          exploredDirty = true;
          explorationGeneration += 1;
          cancelVisibility();
          if (api.multiplayer?.getStatus?.()?.connected) return api.multiplayer.setVisionSource(tokenId);
          localSourceTokenId = tokenId == null ? null : String(tokenId);
          const subject = localVisionSubject();
          if (localSourceTokenId && !subject) {
            localSourceTokenId = null;
            lastLocalVision = null;
            const error = new Error('Vision source Token is unavailable in the active Scene');
            error.code = 'vision_source_unavailable';
            throw error;
          }
          api.emit?.('vision:source-change', { tokenId: localSourceTokenId });
          lastLocalVision = subject;
          if (subject) queueLocalExploration(subject).catch(error => { if (!destroyed) api.showToast?.(error.message, 'error'); });
          scheduleRender();
          return { tokenId: localSourceTokenId };
        },
        getSource() {
          return confirmedSourceTokenId();
        },
        getVisibleRegion() {
          return structuredClone(liveVisionState()?.source || null);
        },
        getFeedbackState() {
          // A later Worker completion can be waiting for RAF while the prior
          // complete frame remains on Canvas. Report the frame actually drawn.
          const feedback = displayedVisibilityFrame || visibilityRowsCache;
          if (!feedback) return null;
          const { signature, source, requestedAt, stateRevision, feedbackRecorded } = feedback;
          return { signature, source: structuredClone(source), requestedAt, stateRevision, rendered: feedbackRecorded === true };
        },
        getExplored(partyId) {
          return structuredClone(normalizeFogState(runtimeScene(visionState())?.fog).exploredByParty[String(partyId)] || { rows: {} });
        },
        resetExplored(partyId, { sceneId = null } = {}) {
          return api.world.performOperations([{ type: 'scene.fog.reset', payload: {
            sceneId: sceneId || api.world.get().activeSceneId, partyId,
          } }], { source: 'scene.fog.reset' });
        },
        hideExplored(partyId, circle, { sceneId = null } = {}) {
          return api.world.performOperations([{ type: 'scene.fog.hide', payload: {
            sceneId: sceneId || api.world.get().activeSceneId, partyId, ...circle,
          } }], { source: 'scene.fog.hide' });
        },
        render,
      };
      retain(api.selection?.subscribe?.(snapshot => {
        if (!['single', 'add', 'replace', 'external-replace'].includes(String(snapshot?.reason || ''))) return;
        const tokenId = snapshot?.primaryId;
        if (!tokenId) return;
        const multiplayer = api.multiplayer?.getStatus?.();
        const canControl = !multiplayer?.connected
          || api.multiplayer?.canControlToken?.(tokenId) === true;
        if (!canControl) return;
        api.vision.setSource(tokenId).catch(error => api.showToast?.(error.message, 'error'));
      }));
      let observedState = visionState();
      let observedSourceTokenId = confirmedSourceTokenId();
      const eventDetail = event => event?.detail || event || {};
      function observeStateChange(changeSet = null) {
        const next = readRuntimeState(api);
        const sourceTokenId = confirmedSourceTokenId();
        const invalidation = classifyVisionChange({ beforeState: observedState, afterState: next,
          changeSet, sourceTokenId, previousSourceTokenId: observedSourceTokenId,
          connected: api.multiplayer?.getStatus?.()?.connected === true });
        cachedState = next;
        snapshotRevision = api.getStateRevision?.();
        // Ruleset descriptions receive the Scene, including its ambient light.
        if (invalidation.sourceChanged || invalidation.spatialChanged) cachedSubject = null;
        if (invalidation.spatialChanged) spatial = null;
        if (invalidation.exploredChanged) { exploredDirty = true; explorationDirty = true; }
        else if (exploredFogReference === runtimeScene(observedState)?.fog) {
          // A different party's COW Fog branch must not force normalization or
          // repainting our unchanged exploration during the next animation.
          exploredFogReference = runtimeScene(next)?.fog || null;
        }
        if (invalidation.resetVisibility) cancelVisibility();
        observedState = next;
        observedSourceTokenId = sourceTokenId;
        const changed = (invalidation.sourceChanged || invalidation.spatialChanged) && synchronizeLocalVision();
        clearUnavailableConnectedSource();
        if (changed || invalidation.render) scheduleRender(invalidation.dirtyBounds);
      }
      retain(api.on?.('state:commit', event => observeStateChange(eventDetail(event).changeSet)));
      for (const eventName of ['state:import', 'scene:activate']) {
        retain(api.on?.(eventName, () => {
          explorationGeneration += 1;
          cancelVisibility();
          cachedState = readRuntimeState(api); snapshotRevision = api.getStateRevision?.();
          cachedSubject = null; spatial = null;
          observedState = cachedState; observedSourceTokenId = confirmedSourceTokenId();
          synchronizeLocalVision();
          clearUnavailableConnectedSource();
          exploredDirty = true; explorationDirty = true;
          scheduleRender();
        }));
      }
      retain(api.on?.('vision:source-change', () => {
        observedState = visionState(); observedSourceTokenId = confirmedSourceTokenId();
        scheduleRender(null);
      }));
      retain(api.on?.('vision:exploration-cancel', () => { explorationGeneration += 1; }));
      retain(api.on?.('state:patch', event => observeStateChange(eventDetail(event).changeSet)));
      // The runtime emits these notifications before its complete state:patch.
      // Classify that patch once, retaining the BEFORE snapshot for removed lights.
      retain(api.on?.('token:delete', event => {
        const detail = eventDetail(event);
        if (detail.canonical) return;
        const id = detail.tokenId || detail.id;
        observeStateChange(id ? { tokens: [{ sceneId: detail.sceneId, removeIds: [String(id)] }] } : null);
      }));
      retain(api.on?.('feature:state-change', event => {
        const detail = eventDetail(event);
        if (detail.canonical) return;
        if (detail.sceneId && String(detail.sceneId) !== String(runtimeScene(visionState())?.id)) return;
        spatial = null; scheduleRender(null);
      }));
      retain(api.on?.('occlusion:preview', () => { spatial = null; cancelVisibility(); scheduleRender(null); }));
      retain(api.on?.('scene:content-change', event => {
        const detail = eventDetail(event);
        if (detail.canonical) return;
        observeStateChange({ sceneContent: [{ sceneId: detail.sceneId, types: detail.types }] });
      }));
      retain(api.on?.('token:visual-position', event => {
        const detail = eventDetail(event), id = String(detail.tokenId || '');
        if (!id) return;
        if (detail.sceneId && String(detail.sceneId) !== String(runtimeScene(visionState())?.id)) return;
        if (id === String(confirmedSourceTokenId() || '')) { scheduleRender(null); return; }
        const token = runtimeScene(readRuntimeState(api))?.tokens?.find(item => String(item.id) === id);
        if (tokenVisionLight(token)) scheduleRender(null);
      }));
      const observeStatus = event => {
        const detail = eventDetail(event);
        if (detail.canonical || (detail.type === 'state.sync'
          && ['state:patch', 'state:commit', 'state:import'].includes(detail.source))) return;
        const scene = runtimeScene(visionState()), id = confirmedSourceTokenId();
        const token = scene?.tokens?.find(item => String(item.id) === String(id || ''));
        const targets = visionStatusTargets(detail);
        if (targets) {
          if (!targets.tokenIds.some(value => String(value) === String(id || ''))
            && !targets.actorIds.some(value => String(value) === String(token?.actorId || ''))) return;
        } else { observeStateChange(); return; }
        cachedSubject = null;
        synchronizeLocalVision();
        scheduleRender();
      };
      retain(api.on?.('status:change', observeStatus));
      retain(api.on?.('status:definitions-change', observeStatus));
      retain(api.on?.('actor:change', observeStatus));
      retain(api.on?.('fog:change', event => {
        const detail = eventDetail(event);
        if (detail.canonical) return;
        observeStateChange({ fog: [{ sceneId: detail.sceneId, dirtyBounds: detail.dirtyBounds ?? null }] });
      }));
      retain(api.on?.('multiplayer:capabilities', () => {
        observeStateChange();
      }));
      const scheduleViewportRender = () => {
        explorationDirty = true;
        scheduleRender(null);
      };
      api.map.on?.('move zoom resize viewreset', scheduleViewportRender);
      const animateViewport = event => { animatedZoom = { center: event.center, zoom: event.zoom }; positionCanvases(); };
      const finishViewport = () => { animatedZoom = null; scheduleViewportRender(); };
      api.map.on?.('zoomanim', animateViewport);
      api.map.on?.('zoomend', finishViewport);
      render();
      api.on?.('app:destroy', () => {
        destroyed = true;
        cachedState = null; observedState = null; cachedSubject = null; spatial = null; exploredCache = []; exploredFogReference = null;
        displayedVisibilityFrame = null; visibilityRowsCache = null;
        releaseVisionContexts(api.mapPackage);
        visibilityAbort?.abort();
        visibilityBackground?.dispose();
        continuousMasks.dispose();
        explorationGeneration += 1;
        off.forEach(dispose => dispose());
        api.map.off?.('move zoom resize viewreset', scheduleViewportRender);
        api.map.off?.('zoomanim', animateViewport);
        api.map.off?.('zoomend', finishViewport);
        if (renderFrame) {
          const cancelFrame = documentNode.defaultView?.cancelAnimationFrame || clearTimeout;
          cancelFrame(renderFrame);
          renderFrame = 0;
        }
        canvases.forEach(canvas => canvas.remove());
      });
    },
  });
}
