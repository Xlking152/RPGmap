function canvasSurface(documentNode) {
  const canvas = documentNode.createElement('canvas');
  return { canvas, context: canvas.getContext('2d') };
}

export function createContinuousMaskRenderer(documentNode) {
  const mask = canvasSurface(documentNode), illumination = canvasSurface(documentNode);
  const light = canvasSurface(documentNode), tint = canvasSurface(documentNode);
  let preparedKey = null;
  function size(surface, width, height, dpr) {
    const pixelsX = Math.ceil(width * dpr), pixelsY = Math.ceil(height * dpr);
    if (surface.canvas.width !== pixelsX || surface.canvas.height !== pixelsY) {
      surface.canvas.width = pixelsX; surface.canvas.height = pixelsY;
    }
    const context = surface.context;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#fff';
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
    return illumination.canvas;
  }
  return {
    reset() { preparedKey = null; },
    draw(target, { key, geometry, source, radiusUnits, kind, viewport, width, height, dpr }) {
      if (preparedKey !== key) {
        size(mask, width, height, dpr);
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
              size(tint, width, height, dpr);
              circle(tint.context, viewport, source.x, source.y, radiusUnits); tint.context.fill();
              tint.context.globalCompositeOperation = 'destination-out';
              for (const rings of geometry.shadows || []) polygon(tint.context, viewport, rings);
              tint.context.globalCompositeOperation = 'source-over';
              tint.context.save(); circle(tint.context, viewport, source.x, source.y, radiusUnits); tint.context.clip();
              for (const facade of geometry.facades || []) for (const rings of facade.polygons || []) polygon(tint.context, viewport, rings);
              tint.context.restore();
              tint.context.globalCompositeOperation = 'destination-in';
              tint.context.drawImage(lightUnion(regions, true, viewport, width, height, dpr), 0, 0, width, height);
              context.globalCompositeOperation = 'source-over'; context.drawImage(tint.canvas, 0, 0, width, height);
            } else {
              context.globalCompositeOperation = 'destination-in';
              context.drawImage(lightUnion(regions, mode === 'normal', viewport, width, height, dpr), 0, 0, width, height);
            }
          }
        }
        preparedKey = key;
      }
      if (target.globalCompositeOperation === 'destination-out') target.drawImage(mask.canvas, 0, 0, width, height);
      else {
        size(tint, width, height, dpr);
        tint.context.drawImage(mask.canvas, 0, 0, width, height);
        tint.context.globalCompositeOperation = 'source-in';
        tint.context.fillStyle = target.fillStyle;
        tint.context.fillRect(0, 0, width, height);
        target.drawImage(tint.canvas, 0, 0, width, height);
      }
    },
    dispose() { for (const surface of [mask, illumination, light, tint]) surface.canvas.width = surface.canvas.height = 0; },
  };
}
