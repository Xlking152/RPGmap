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

function runtimeScene(api) {
  const world = api.getState?.()?.preferences?.worldV2;
  return world?.scenes?.find(scene => String(scene?.id ?? '') === String(world?.activeSceneId ?? '')) || null;
}

export function createVisionFogSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.map || api.vision) return;
      const documentNode = api.map.getContainer().ownerDocument || document;
      const pane = api.map.getPane?.(FOG_PANE) || api.map.createPane(FOG_PANE);
      pane.style.zIndex = '510';
      pane.style.pointerEvents = 'none';
      const canvas = documentNode.createElement('canvas');
      canvas.className = 'rpgmap-vision-fog-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      pane.append(canvas);
      let localSourceTokenId = null;
      let lastLocalVision = null;
      let localExploreChain = Promise.resolve();
      let renderFrame = 0;
      const off = [];

      function removeOverlay() {
        canvas.remove();
      }

      function localVisionSubject() {
        if (!localSourceTokenId) return null;
        const world = api.world?.get?.();
        const scene = world?.scenes?.find(item => String(item.id) === String(world.activeSceneId));
        const token = scene?.tokens?.find(item => String(item.id) === String(localSourceTokenId));
        const actor = token && world?.actors?.find(item => String(item.id) === String(token.actorId));
        if (!token || !actor || token.placement !== 'map') return null;
        const resolved = api.tokens?.resolveActor?.(token.id)?.actor || actor;
        const description = api.ruleset?.vision?.describe?.(resolved, { token }) || {};
        const rangeMeters = token.vision?.rangeOverrideMeters ?? description.rangeMeters;
        return {
          sceneId: String(scene.id), tokenId: String(token.id),
          x: Number(token.x), y: Number(token.y), rangeMeters: Number(rangeMeters) || 0,
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
          },
          partyIds: subject.partyId ? [subject.partyId] : [],
          gmPreview: true,
        };
      }

      function queueLocalExploration(subject, previous = null) {
        if (!subject?.partyId || subject.rangeMeters <= 0) return Promise.resolve(null);
        const payload = previous && previous.sceneId === subject.sceneId
          ? {
              sceneId: subject.sceneId, partyId: subject.partyId,
              from: { x: previous.x, y: previous.y }, to: { x: subject.x, y: subject.y },
              radiusMeters: subject.rangeMeters,
            }
          : {
              sceneId: subject.sceneId, partyId: subject.partyId,
              x: subject.x, y: subject.y, radiusMeters: subject.rangeMeters,
            };
        localExploreChain = localExploreChain.catch(() => null).then(() => api.world.performOperations([
          { type: 'scene.fog.explore', payload },
        ], { source: 'vision:explore' }));
        return localExploreChain;
      }

      function synchronizeLocalVision() {
        if (api.multiplayer?.getStatus?.()?.connected || !localSourceTokenId) return;
        const subject = localVisionSubject();
        if (!subject) {
          localSourceTokenId = null;
          lastLocalVision = null;
          api.emit?.('vision:source-change', { tokenId: null });
          return;
        }
        const previous = lastLocalVision;
        const moved = previous
          && previous.tokenId === subject.tokenId
          && previous.sceneId === subject.sceneId
          && (previous.x !== subject.x || previous.y !== subject.y);
        lastLocalVision = subject;
        if (moved) queueLocalExploration(subject, previous).catch(error => api.showToast?.(error.message, 'error'));
      }

      function render() {
        const state = api.getState?.() || {};
        const audience = state.preferences?.audienceVision || localVisionState();
        if (!audience) {
          canvas.hidden = true;
          return;
        }
        const scene = runtimeScene(api);
        if (!scene) return;
        canvas.hidden = false;
        const size = api.map.getSize();
        const dpr = Math.max(1, Math.min(2, Number(documentNode.defaultView?.devicePixelRatio) || 1));
        if (canvas.width !== Math.ceil(size.x * dpr) || canvas.height !== Math.ceil(size.y * dpr)) {
          canvas.width = Math.ceil(size.x * dpr);
          canvas.height = Math.ceil(size.y * dpr);
          canvas.style.width = `${size.x}px`;
          canvas.style.height = `${size.y}px`;
        }
        const origin = api.map.containerPointToLayerPoint([0, 0]);
        canvas.style.transform = `translate3d(${origin.x}px,${origin.y}px,0)`;
        const context = canvas.getContext('2d');
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, size.x, size.y);
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
        const drawExplored = () => {
          for (const [row, spans] of rows) {
            for (const [start, end] of spans) {
              const rect = worldRect(start * cellUnits, Number(row) * cellUnits, (end - start + 1) * cellUnits, cellUnits);
              context.fillRect(rect.x, rect.y, rect.width + 1, rect.height + 1);
            }
          }
        };
        const source = audience.source;
        const drawCurrentCircle = () => {
          if (!source || Number(source.rangeMeters) <= 0) return;
          const center = api.map.latLngToContainerPoint(worldToLatLng({ x: Number(source.x), y: Number(source.y) }, api.mapPackage.height));
          const edge = api.map.latLngToContainerPoint(worldToLatLng({
            x: Number(source.x) + Number(source.rangeMeters) / metersPerUnit,
            y: Number(source.y),
          }, api.mapPackage.height));
          context.beginPath();
          context.arc(center.x, center.y, Math.abs(edge.x - center.x), 0, Math.PI * 2);
          context.fill();
        };

        context.globalCompositeOperation = 'source-over';
        context.fillStyle = 'rgba(8,12,14,0.96)';
        context.fillRect(0, 0, size.x, size.y);
        context.globalCompositeOperation = 'destination-out';
        context.fillStyle = '#000';
        drawExplored();
        drawCurrentCircle();
        context.globalCompositeOperation = 'source-over';
        context.fillStyle = 'rgba(18,25,27,0.62)';
        drawExplored();
        context.globalCompositeOperation = 'destination-out';
        context.fillStyle = '#000';
        drawCurrentCircle();
        context.globalCompositeOperation = 'source-over';
      }

      function scheduleRender() {
        if (renderFrame) return;
        const requestFrame = documentNode.defaultView?.requestAnimationFrame || (callback => setTimeout(callback, 16));
        renderFrame = requestFrame(() => {
          renderFrame = 0;
          render();
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
          return api.getState?.()?.preferences?.audienceVision?.source?.tokenId || localSourceTokenId;
        },
        getVisibleRegion() {
          return structuredClone(api.getState?.()?.preferences?.audienceVision?.source || localVisionState()?.source || null);
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
      for (const eventName of ['state:commit', 'state:import', 'scene:activate']) {
        const dispose = api.on?.(eventName, () => {
          synchronizeLocalVision();
          scheduleRender();
        });
        if (typeof dispose === 'function') off.push(dispose);
      }
      for (const eventName of ['state:saved', 'vision:source-change']) {
        const dispose = api.on?.(eventName, scheduleRender);
        if (typeof dispose === 'function') off.push(dispose);
      }
      api.map.on?.('move zoom resize viewreset', scheduleRender);
      render();
      api.on?.('app:destroy', () => {
        off.forEach(dispose => dispose());
        api.map.off?.('move zoom resize viewreset', scheduleRender);
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
