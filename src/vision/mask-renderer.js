function canvasSurface(documentNode) {
  const canvas = documentNode.createElement('canvas');
  return { canvas, context: canvas.getContext('2d') };
}

// Align the blend region with the viewport's device-pixel grid. This retains
// the original rasterization at fractional DPR while avoiding full-viewport
// blending for a small sight circle.
export function continuousMaskBounds(viewport, source, radiusUnits, width, height, dpr) {
  const center = viewport.project(source.x, source.y);
  const radius = Math.max(0, radiusUnits * Math.abs(viewport.scaleX));
  const left = Math.max(0, Math.floor((center.x - radius - 2) * dpr));
  const top = Math.max(0, Math.floor((center.y - radius - 2) * dpr));
  const right = Math.min(Math.ceil(width * dpr), Math.ceil((center.x + radius + 2) * dpr));
  const bottom = Math.min(Math.ceil(height * dpr), Math.ceil((center.y + radius + 2) * dpr));
  return { x: left / dpr, y: top / dpr,
    width: Math.max(0, right - left) / dpr, height: Math.max(0, bottom - top) / dpr };
}

export function createContinuousMaskRenderer(documentNode) {
  const masks = {};
  const illumination = canvasSurface(documentNode);
  const light = canvasSurface(documentNode), tint = canvasSurface(documentNode);
  const preparedKeys = {};
  let alignedViewport = null;
  let currentLightingKey = null, preparedLightingKey = null;
  function resetMasks() {
    for (const key of Object.keys(masks)) { masks[key].canvas.width = masks[key].canvas.height = 0; delete masks[key]; }
    for (const key of Object.keys(preparedKeys)) delete preparedKeys[key];
    preparedLightingKey = null;
  }
  function drawPrepared(target, canvas, bounds, width, height, dpr) {
    // Canvas rounds its backing dimensions up. Preserve the legacy edge
    // resampling when either logical dimension spans fractional device pixels.
    if (!Number.isInteger(width * dpr) || !Number.isInteger(height * dpr)) {
      target.drawImage(canvas, 0, 0, width, height); return;
    }
    target.drawImage(canvas, Math.round(bounds.x * dpr), Math.round(bounds.y * dpr),
      Math.round(bounds.width * dpr), Math.round(bounds.height * dpr),
      bounds.x, bounds.y, bounds.width, bounds.height);
  }
  function size(surface, width, height, dpr, bounds = null) {
    const pixelsX = Math.ceil(width * dpr), pixelsY = Math.ceil(height * dpr);
    if (surface.canvas.width !== pixelsX || surface.canvas.height !== pixelsY) {
      surface.canvas.width = pixelsX; surface.canvas.height = pixelsY;
    }
    const context = surface.context;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.globalCompositeOperation = 'source-over';
    if (bounds) context.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);
    else context.clearRect(0, 0, width, height);
    context.fillStyle = '#fff';
  }
  function clipSurface(context, bounds) {
    context.save();
    if (bounds) {
      context.beginPath(); context.rect(bounds.x, bounds.y, bounds.width, bounds.height); context.clip();
    }
  }
  function circle(context, viewport, x, y, radius) {
    const point = viewport.project(x, y);
    context.beginPath(); context.arc(point.x, point.y, Math.max(0, radius * Math.abs(viewport.scaleX)), 0, Math.PI * 2);
  }
  function polygon(context, viewport, rings) {
    context.beginPath();
    for (const ring of rings) {
      if (!ring.length) continue;
      ring.forEach(([x, y], index) => {
        const point = viewport.project(x, y);
        if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
      });
      context.closePath();
    }
    context.fill('evenodd');
  }
  function lightUnion(regions, normal, viewport, width, height, dpr) {
    const key = currentLightingKey == null ? null : `${currentLightingKey}:${normal}`;
    if (key !== null && key === preparedLightingKey) return illumination.canvas;
    size(illumination, width, height, dpr);
    for (const region of regions) {
      const radius = normal ? region.normalRadiusUnits : region.radiusUnits;
      if (radius <= 0 || region.blocked) continue;
      size(light, width, height, dpr);
      circle(light.context, viewport, region.x, region.y, radius); light.context.fill();
      light.context.globalCompositeOperation = 'destination-out';
      for (const rings of region.shadows || []) polygon(light.context, viewport, rings);
      illumination.context.drawImage(light.canvas, 0, 0, width, height);
    }
    preparedLightingKey = key;
    return illumination.canvas;
  }
  return {
    reset() { for (const key of Object.keys(preparedKeys)) delete preparedKeys[key]; preparedLightingKey = null; },
    draw(target, { key, lightingKey = null, geometry, source, radiusUnits, kind, viewport, width, height, dpr }) {
      const bounds = continuousMaskBounds(viewport, source, radiusUnits, width, height, dpr);
      if (!bounds.width || !bounds.height) return;
      const aligned = Number.isInteger(width * dpr) && Number.isInteger(height * dpr);
      const paintBounds = aligned ? bounds : null;
      if (alignedViewport !== aligned) { resetMasks(); alignedViewport = aligned; }
      currentLightingKey = aligned ? lightingKey : null;
      // Keep the legacy single-surface lifecycle when fractional backing
      // dimensions require edge resampling. Aligned views cache both passes.
      const cacheKind = aligned ? kind : 'shared';
      const mask = masks[cacheKind] ||= canvasSurface(documentNode);
      if (preparedKeys[cacheKind] !== key) {
        size(mask, width, height, dpr, paintBounds);
        clipSurface(mask.context, paintBounds);
        if (!geometry.blocked) {
          const context = mask.context;
          circle(context, viewport, source.x, source.y, radiusUnits);
          context.save(); context.clip(); context.fill();
          context.globalCompositeOperation = 'destination-out';
          for (const rings of geometry.shadows || []) polygon(context, viewport, rings);
          context.globalCompositeOperation = 'source-over';
          for (const facade of geometry.facades || []) for (const rings of facade.polygons || []) polygon(context, viewport, rings);
          context.restore();
          if (kind === 'precise' && geometry.illumination.mode !== 'all') {
            const { mode, regions } = geometry.illumination;
            if (mode === 'dark-and-normal') {
              context.globalCompositeOperation = 'destination-out';
              context.drawImage(lightUnion(regions, false, viewport, width, height, dpr), 0, 0, width, height);
              // Build the normal-light union separately, then intersect it with
              // the same circle/shadow mask so light cannot reveal behind walls.
              size(tint, width, height, dpr, paintBounds);
              clipSurface(tint.context, paintBounds);
              circle(tint.context, viewport, source.x, source.y, radiusUnits); tint.context.fill();
              tint.context.globalCompositeOperation = 'destination-out';
              for (const rings of geometry.shadows || []) polygon(tint.context, viewport, rings);
              tint.context.globalCompositeOperation = 'source-over';
              tint.context.save(); circle(tint.context, viewport, source.x, source.y, radiusUnits); tint.context.clip();
              for (const facade of geometry.facades || []) for (const rings of facade.polygons || []) polygon(tint.context, viewport, rings);
              tint.context.restore();
              tint.context.globalCompositeOperation = 'destination-in';
              tint.context.drawImage(lightUnion(regions, true, viewport, width, height, dpr), 0, 0, width, height);
              tint.context.restore();
              context.globalCompositeOperation = 'source-over'; context.drawImage(tint.canvas, 0, 0, width, height);
            } else {
              context.globalCompositeOperation = 'destination-in';
              context.drawImage(lightUnion(regions, mode === 'normal', viewport, width, height, dpr), 0, 0, width, height);
            }
          }
        }
        mask.context.restore();
        preparedKeys[cacheKind] = key;
      }
      if (target.globalCompositeOperation === 'destination-out') drawPrepared(target, mask.canvas, bounds, width, height, dpr);
      else {
        size(tint, width, height, dpr, paintBounds);
        clipSurface(tint.context, paintBounds);
        tint.context.drawImage(mask.canvas, 0, 0, width, height);
        tint.context.globalCompositeOperation = 'source-in';
        tint.context.fillStyle = target.fillStyle;
        if (paintBounds) tint.context.fillRect(paintBounds.x, paintBounds.y, paintBounds.width, paintBounds.height);
        else tint.context.fillRect(0, 0, width, height);
        tint.context.restore();
        drawPrepared(target, tint.canvas, bounds, width, height, dpr);
      }
    },
    dispose() { for (const surface of [...Object.values(masks), illumination, light, tint]) surface.canvas.width = surface.canvas.height = 0; },
  };
}
