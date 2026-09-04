import { worldToLatLng } from '../engine/geometry.js';
import { FOG_CELL_SIZE_METERS, normalizeFogState } from './fog.js';

const FOG_PANE = 'fogVisionPane';

function mergeSpans(values) {
  const ordered = values.map(span => [Number(span[0]), Number(span[1])])
    .filter(span => Number.isSafeInteger(span[0]) && Number.isSafeInteger(span[1]) && span[1] >= span[0])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const result = [];
  for (const span of ordered) {
    const previous = result.at(-1);
    if (!previous || span[0] > previous[1] + 1) result.push(span);
    else previous[1] = Math.max(previous[1], span[1]);
  }
  return result;
}

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

function runtimeScene(api) {
  const world = api.getState?.()?.preferences?.worldV2;
  return world?.scenes?.find(scene => String(scene?.id ?? '') === String(world?.activeSceneId ?? '')) || null;
}

export function resolveLiveAudienceVision(audience, scene, sourceTokenId = undefined) {
  if (!audience || typeof audience !== 'object') return null;
  const requestedTokenId = sourceTokenId === undefined ? audience.source?.tokenId : sourceTokenId;
  const tokenId = String(requestedTokenId ?? '').trim();
  if (!tokenId) return { ...audience, source: null };
  const token = scene?.tokens?.find(item => String(item?.id ?? '') === tokenId);
  if (!token || token.placement !== 'map') return { ...audience, source: null };
  return {
    ...audience,
    source: {
      ...(audience.source || {}),
      tokenId,
      x: Number(token.x),
      y: Number(token.y),
    },
  };
}

export function createVisionFogSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.map || api.vision) return;
      const documentNode = api.map.getContainer().ownerDocument || document;
      const pane = api.map.getPane?.(FOG_PANE) || api.map.createPane(FOG_PANE);
      pane.style.zIndex = '510';
      pane.style.pointerEvents = 'none';
      const createCanvas = (layer, blendMode = '') => {
        const canvas = documentNode.createElement('canvas');
        canvas.className = `rpgmap-vision-fog-canvas rpgmap-vision-fog-${layer}`;
        canvas.dataset.fogLayer = layer;
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.position = 'absolute';
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
      let connectedClearPending = false;
      let renderFrame = 0;
      let pendingDirtyBounds;
      let lastVisionSignature = '';
      let explorationDirty = true;
      const off = [];

      function removeOverlay() {
        canvases.forEach(canvas => canvas.remove());
      }

      function localVisionSubject() {
        if (!localSourceTokenId) return null;
        const world = api.world?.get?.();
        const scene = world?.scenes?.find(item => String(item.id) === String(world.activeSceneId));
        const token = scene?.tokens?.find(item => String(item.id) === String(localSourceTokenId));
        const actor = token && world?.actors?.find(item => String(item.id) === String(token.actorId));
        if (!token || !actor || token.placement !== 'map') return null;
        const resolved = api.tokens?.resolveActor?.(token.id)?.actor || actor;
        const description = api.ruleset?.vision?.describe?.(resolved, {
          token, scene, lighting: scene?.settings?.lighting || 'normal',
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
        return {
          sceneId: String(scene.id), tokenId: String(token.id),
          x: Number(api.renderer?.getVisualTokenPoint?.(token.id)?.x ?? token.x),
          y: Number(api.renderer?.getVisualTokenPoint?.(token.id)?.y ?? token.y), rangeMeters: preciseRangeMeters,
          preciseRangeMeters, vagueRangeMeters,
          senses: structuredClone(description.senses || {}), lighting: description.lighting || 'normal',
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
            rangeMeters: subject.rangeMeters,
            preciseRangeMeters: subject.preciseRangeMeters,
            vagueRangeMeters: subject.vagueRangeMeters,
            senses: subject.senses,
            lighting: subject.lighting,
          },
          partyIds: subject.partyId ? [subject.partyId] : [],
          gmPreview: true,
        };
      }

      function queueLocalExploration(subject, previous = null) {
        if (!subject?.partyId || subject.vagueRangeMeters <= 0) return Promise.resolve(null);
        const payload = previous && previous.sceneId === subject.sceneId
          ? {
              sceneId: subject.sceneId, partyId: subject.partyId,
              from: { x: previous.x, y: previous.y }, to: { x: subject.x, y: subject.y },
              radiusMeters: subject.vagueRangeMeters,
            }
          : {
              sceneId: subject.sceneId, partyId: subject.partyId,
              x: subject.x, y: subject.y, radiusMeters: subject.vagueRangeMeters,
            };
        localExploreChain = localExploreChain.catch(() => null).then(() => api.world.performOperations([
          { type: 'scene.fog.explore', payload },
        ], { source: 'vision:explore' }));
        return localExploreChain;
      }

      function confirmedSourceTokenId() {
        if (api.multiplayer?.getStatus?.()?.connected) {
          return api.multiplayer?.getVisionSource?.() || null;
        }
        return localSourceTokenId;
      }

      function liveVisionState() {
        const state = api.getState?.() || {};
        const audience = state.preferences?.audienceVision || localVisionState();
        return resolveLiveAudienceVision(audience, runtimeScene(api), confirmedSourceTokenId());
      }

      function clearUnavailableConnectedSource() {
        if (!api.multiplayer?.getStatus?.()?.connected || connectedClearPending) return;
        const tokenId = api.multiplayer?.getVisionSource?.();
        if (!tokenId) return;
        const scene = runtimeScene(api);
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
          && (previous.x !== subject.x || previous.y !== subject.y);
        const changed = JSON.stringify(previous) !== JSON.stringify(subject);
        lastLocalVision = subject;
        if (moved) queueLocalExploration(subject, previous).catch(error => api.showToast?.(error.message, 'error'));
        return changed;
      }

      function visionSignature() {
        const audience = liveVisionState();
        return JSON.stringify({ source: audience?.source || null, partyIds: audience?.partyIds || [] });
      }

      function render(dirtyBounds = null) {
        const audience = liveVisionState();
        if (!audience) {
          canvases.forEach(canvas => { canvas.hidden = true; });
          lastVisionSignature = '';
          return;
        }
        const scene = runtimeScene(api);
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
        const origin = api.map.containerPointToLayerPoint([0, 0]);
        canvases.forEach(canvas => { canvas.style.transform = `translate3d(${origin.x}px,${origin.y}px,0)`; });
        const exploration = explorationCanvas.getContext('2d');
        const perception = perceptionCanvas.getContext('2d');
        for (const context of [exploration, perception]) {
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        const fog = normalizeFogState(scene.fog);
        const metersPerUnit = Math.max(0.000001, Number(api.mapPackage?.metersPerUnit) || 1);
        const cellUnits = FOG_CELL_SIZE_METERS / metersPerUnit;
        const rows = exploredRows(fog, Array.isArray(audience.partyIds) ? audience.partyIds : []);
        const worldRect = (x, y, width, height) => {
          const first = api.map.latLngToContainerPoint(worldToLatLng({ x, y }, api.mapPackage.height));
          const second = api.map.latLngToContainerPoint(worldToLatLng({ x: x + width, y: y + height }, api.mapPackage.height));
          return {
            x: Math.min(first.x, second.x), y: Math.min(first.y, second.y),
            width: Math.abs(second.x - first.x), height: Math.abs(second.y - first.y),
          };
        };
        const clip = dirtyBounds && !resized
          ? worldRect(
              Number(dirtyBounds.minX), Number(dirtyBounds.minY),
              Number(dirtyBounds.maxX) - Number(dirtyBounds.minX),
              Number(dirtyBounds.maxY) - Number(dirtyBounds.minY),
            )
          : null;
        for (const context of [perception]) {
          context.save();
          if (clip) {
            const x = Math.max(0, Math.floor(clip.x) - 2);
            const y = Math.max(0, Math.floor(clip.y) - 2);
            const width = Math.min(size.x - x, Math.ceil(clip.width) + 4);
            const height = Math.min(size.y - y, Math.ceil(clip.height) + 4);
            context.beginPath();
            context.rect(x, y, Math.max(0, width), Math.max(0, height));
            context.clip();
            context.clearRect(x, y, Math.max(0, width), Math.max(0, height));
          } else context.clearRect(0, 0, size.x, size.y);
        }
        const drawExplored = context => {
          for (const [row, spans] of rows) {
            for (const [start, end] of spans) {
              const rect = worldRect(start * cellUnits, Number(row) * cellUnits, (end - start + 1) * cellUnits, cellUnits);
              context.fillRect(rect.x, rect.y, rect.width + 1, rect.height + 1);
            }
          }
        };
        const source = audience.source;
        const drawCurrentCircle = (context, rawRange) => {
          const range = Number(rawRange) || 0;
          if (!source || range <= 0) return;
          const center = api.map.latLngToContainerPoint(worldToLatLng({ x: Number(source.x), y: Number(source.y) }, api.mapPackage.height));
          const edge = api.map.latLngToContainerPoint(worldToLatLng({
            x: Number(source.x) + range / metersPerUnit,
            y: Number(source.y),
          }, api.mapPackage.height));
          context.beginPath();
          context.arc(center.x, center.y, Math.abs(edge.x - center.x), 0, Math.PI * 2);
          context.fill();
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
        perception.globalCompositeOperation = 'destination-out';
        perception.fillStyle = '#000';
        drawCurrentCircle(perception, source?.vagueRangeMeters ?? source?.rangeMeters);
        perception.globalCompositeOperation = 'source-over';
        perception.fillStyle = 'rgba(218,226,228,0.20)';
        drawCurrentCircle(perception, source?.vagueRangeMeters ?? source?.rangeMeters);
        perception.globalCompositeOperation = 'destination-out';
        perception.fillStyle = '#000';
        drawCurrentCircle(perception, source?.preciseRangeMeters ?? source?.rangeMeters);
        perception.globalCompositeOperation = 'source-over';
        lastVisionSignature = visionSignature();
        perception.restore();
      }

      function scheduleRender(dirtyBounds = null) {
        pendingDirtyBounds = pendingDirtyBounds === undefined
          ? dirtyBounds
          : mergeDirtyBounds(pendingDirtyBounds, dirtyBounds);
        if (renderFrame) return;
        const requestFrame = documentNode.defaultView?.requestAnimationFrame || (callback => setTimeout(callback, 16));
        renderFrame = requestFrame(() => {
          renderFrame = 0;
          const bounds = pendingDirtyBounds;
          pendingDirtyBounds = undefined;
          render(bounds);
        });
      }

      api.vision = {
        async setSource(tokenId = null) {
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
          lastLocalVision = subject;
          if (subject) await queueLocalExploration(subject);
          render();
          api.emit?.('vision:source-change', { tokenId: localSourceTokenId });
          return { tokenId: localSourceTokenId };
        },
        getSource() {
          return confirmedSourceTokenId();
        },
        getVisibleRegion() {
          return structuredClone(liveVisionState()?.source || null);
        },
        getExplored(partyId) {
          return structuredClone(normalizeFogState(runtimeScene(api)?.fog).exploredByParty[String(partyId)] || { rows: {} });
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
      const unsubscribeSelection = api.selection?.subscribe?.(snapshot => {
        if (!['single', 'add', 'replace', 'external-replace'].includes(String(snapshot?.reason || ''))) return;
        const tokenId = snapshot?.primaryId;
        if (!tokenId) return;
        const multiplayer = api.multiplayer?.getStatus?.();
        const canControl = !multiplayer?.connected
          || api.multiplayer?.canControlToken?.(tokenId) === true;
        if (!canControl) return;
        api.vision.setSource(tokenId).catch(error => api.showToast?.(error.message, 'error'));
      });
      if (typeof unsubscribeSelection === 'function') off.push(unsubscribeSelection);
      const disposeCommit = api.on?.('state:commit', detail => {
        const changed = synchronizeLocalVision();
        clearUnavailableConnectedSource();
        if (changed || /fog|vision|scene|import/i.test(String(detail?.source || ''))) scheduleRender();
      });
      if (typeof disposeCommit === 'function') off.push(disposeCommit);
      for (const eventName of ['state:import', 'scene:activate']) {
        const dispose = api.on?.(eventName, () => {
          synchronizeLocalVision();
          clearUnavailableConnectedSource();
          explorationDirty = true;
          scheduleRender();
        });
        if (typeof dispose === 'function') off.push(dispose);
      }
      const disposeSource = api.on?.('vision:source-change', () => scheduleRender(null));
      if (typeof disposeSource === 'function') off.push(disposeSource);
      const disposeVisualPosition = api.on?.('token:visual-position', event => {
        if (String(event?.detail?.tokenId || '') === String(confirmedSourceTokenId() || '')) scheduleRender(null);
      });
      if (typeof disposeVisualPosition === 'function') off.push(disposeVisualPosition);
      const disposeStatus = api.on?.('status:change', () => {
        synchronizeLocalVision();
        if (visionSignature() !== lastVisionSignature) scheduleRender();
      });
      if (typeof disposeStatus === 'function') off.push(disposeStatus);
      const disposeFog = api.on?.('fog:change', event => {
        explorationDirty = true;
        scheduleRender(event?.detail?.dirtyBounds ?? null);
      });
      if (typeof disposeFog === 'function') off.push(disposeFog);
      const disposeCapabilities = api.on?.('multiplayer:capabilities', () => {
        clearUnavailableConnectedSource();
        scheduleRender();
      });
      if (typeof disposeCapabilities === 'function') off.push(disposeCapabilities);
      const scheduleViewportRender = () => {
        explorationDirty = true;
        scheduleRender(null);
      };
      api.map.on?.('move zoom resize viewreset', scheduleViewportRender);
      render();
      api.on?.('app:destroy', () => {
        off.forEach(dispose => dispose());
        api.map.off?.('move zoom resize viewreset', scheduleViewportRender);
        if (renderFrame) {
          const cancelFrame = documentNode.defaultView?.cancelAnimationFrame || clearTimeout;
          cancelFrame(renderFrame);
          renderFrame = 0;
        }
        removeOverlay();
      });
    },
  });
}
