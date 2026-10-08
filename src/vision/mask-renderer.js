import { facadeMaskPolygons } from './facade-mask.js';

// Full viewport surfaces already have this device-pixel transform. Avoid a
// scaled image transfer when the backing dimensions are exact; keep the old
// resampling for fractional backing sizes. save/restore preserves the current
// clip, blend mode, and caller path.
export function copyViewportCanvas(context, canvas, width, height, dpr) {
  if (Number.isInteger(width * dpr) && Number.isInteger(height * dpr)
    && canvas.width === width * dpr && canvas.height === height * dpr) {
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(canvas, 0, 0); context.restore();
  } else context.drawImage(canvas, 0, 0, width, height);
}

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
  const facadeMasks = new Map();
  let geometryIds = new WeakMap(), nextGeometryId = 0, cachedVertices = 0, cachedVersions = 0;
  const preparedKeys = {};
  let alignedViewport = null;
  let currentLightingKey = null, preparedLightingKey = null;
  let coloredKey = null, coloredStyle = null, coloredKind = null;
  const copyClips = new Map();
  const whiteCopies = { precise: null, vague: null };
  let coloredCopy = null, coloredRevision = 0;
  function copyRecord() {
    return { ...canvasSurface(documentNode), source: null, revision: null, bounds: null };
  }
  function releaseCopies() {
    for (const key of Object.keys(whiteCopies)) {
      const entry = whiteCopies[key];
      if (entry) entry.canvas.width = entry.canvas.height = 0;
      whiteCopies[key] = null;
    }
    if (coloredCopy) coloredCopy.canvas.width = coloredCopy.canvas.height = 0;
    coloredCopy = null;
  }
  function resetMasks() {
    for (const key of Object.keys(masks)) { masks[key].canvas.width = masks[key].canvas.height = 0; delete masks[key]; }
    for (const key of Object.keys(preparedKeys)) delete preparedKeys[key];
    preparedLightingKey = null;
    coloredKey = coloredStyle = coloredKind = null; copyClips.clear();
    releaseCopies();
    facadeMasks.clear(); geometryIds = new WeakMap(); nextGeometryId = cachedVertices = cachedVersions = 0;
  }
  function drawPrepared(target, canvas, bounds, width, height, dpr, copy = null, revision = null) {
    // Canvas rounds its backing dimensions up. Preserve the legacy edge
    // resampling when either logical dimension spans fractional device pixels.
    if (!Number.isInteger(width * dpr) || !Number.isInteger(height * dpr)) {
      target.drawImage(canvas, 0, 0, width, height); return;
    }
    const left = Math.round(bounds.x * dpr), top = Math.round(bounds.y * dpr);
    const pixelsX = Math.round(bounds.width * dpr), pixelsY = Math.round(bounds.height * dpr);
    if (copy) {
      const previous = copy.bounds;
      if (copy.source !== canvas || copy.revision !== revision || !previous
        || previous[0] !== left || previous[1] !== top || previous[2] !== pixelsX || previous[3] !== pixelsY) {
        if (copy.canvas.width !== pixelsX || copy.canvas.height !== pixelsY) {
          copy.canvas.width = pixelsX; copy.canvas.height = pixelsY;
        }
        // Rasterize geometry on the unchanged full viewport. Copy only its
        // finished integer pixels into this owned surface, without resampling
        // or blending the source alpha a second time.
        copy.context.setTransform(1, 0, 0, 1, 0, 0);
        copy.context.globalCompositeOperation = 'copy';
        copy.context.drawImage(canvas, -left, -top);
        copy.source = canvas; copy.revision = revision;
        copy.bounds = [left, top, pixelsX, pixelsY];
      }
    }
    // Round-tripping an integer pixel through x / fractional-DPR and the
    // canvas transform can introduce a subpixel sample (including alpha 1 on
    // a black pixel). Copy aligned frames on the actual backing pixel grid.
    target.save(); target.setTransform(1, 0, 0, 1, 0, 0);
    if (typeof globalThis.Path2D === 'function') {
      const key = `${left}:${top}:${pixelsX}:${pixelsY}`;
      let clip = copyClips.get(key);
      if (!clip) {
        clip = new globalThis.Path2D(); clip.rect(left, top, pixelsX, pixelsY);
        copyClips.set(key, clip);
        if (copyClips.size > 2) copyClips.delete(copyClips.keys().next().value);
      }
      // An integer-pixel destination clip permits an unscaled image copy.
      // The retained full surface preserves Canvas's exact path rasterization.
      target.clip(clip);
      if (copy) target.drawImage(copy.canvas, left, top);
      else target.drawImage(canvas, 0, 0);
    } else if (copy) target.drawImage(copy.canvas, left, top);
    else target.drawImage(canvas, left, top, pixelsX, pixelsY, left, top, pixelsX, pixelsY);
    target.restore();
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
  function identity(value) {
    if (!value || typeof value !== 'object') return 0;
    let id = geometryIds.get(value);
    if (id === undefined) { id = ++nextGeometryId; geometryIds.set(value, id); }
    return id;
  }
  function forgetFacade(id) {
    const entry = facadeMasks.get(id);
    for (const version of entry.versions) { cachedVertices -= version.vertices; cachedVersions--; }
    facadeMasks.delete(id);
  }
  function facadePolygons(geometry, facade) {
    const id = facade.id ?? facade.featureId ?? '@' + identity(facade);
    // All keys and derived contours belong to this renderer. Weak identities
    // distinguish new Worker results without retaining their private geometry.
    const version = [geometry, geometry.shadows, facade, facade.polygons, facade.otherShadowIndices].map(identity).join(':');
    let entry = facadeMasks.get(id);
    const hit = entry?.versions.find(value => value.version === version);
    if (hit) {
      entry.versions = [...entry.versions.filter(value => value !== hit), hit];
      facadeMasks.delete(id); facadeMasks.set(id, entry); return hit.polygons;
    }
    const polygons = facadeMaskPolygons(facade.polygons || [], geometry.shadows || [], facade.otherShadowIndices || []);
    const vertices = polygons.reduce((sum, rings) => sum + rings.reduce((size, ring) => size + ring.length, 0), 0);
    // Complex masks remain exact when they exceed the cache budget; only their
    // reconstructible contours are left uncached, never their visibility.
    if (vertices > 65_536) return polygons;
    if (!entry) entry = { versions: [] };
    entry.versions.push({ version, polygons, vertices }); cachedVertices += vertices; cachedVersions++;
    if (entry.versions.length > 2) {
      const oldest = entry.versions.shift(); cachedVertices -= oldest.vertices; cachedVersions--;
    }
    facadeMasks.delete(id); facadeMasks.set(id, entry);
    while (facadeMasks.size > 512 || cachedVertices > 65_536) forgetFacade(facadeMasks.keys().next().value);
    return polygons;
  }
  function paintFacades(context, geometry, viewport) {
    for (const facade of geometry.facades || []) {
      const polygons = facade.otherShadowIndices?.length ? facadePolygons(geometry, facade) : facade.polygons || [];
      // Each connected component shares all facade/shadow intersections. Keep
      // its holes in the original evenodd fill and independent components in
      // separate fills, preserving the reference antialias composition.
      for (const rings of polygons) polygon(context, viewport, rings);
    }
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
      copyViewportCanvas(illumination.context, light.canvas, width, height, dpr);
    }
    preparedLightingKey = key;
    return illumination.canvas;
  }
  return {
    reset() { resetMasks(); },
    draw(target, { key, lightingKey = null, geometry, source, radiusUnits, kind, viewport, width, height, dpr }) {
      const bounds = continuousMaskBounds(viewport, source, radiusUnits, width, height, dpr);
      if (!bounds.width || !bounds.height) return;
      const aligned = Number.isInteger(width * dpr) && Number.isInteger(height * dpr);
      // Multiple overlapping antialiased shadows must retain the reference
      // clip stack: an extra rectangle can change their coverage rounding by
      // one alpha unit at a buried edge. Facade boundaries are cached separately.
      const paintBounds = aligned && (geometry.shadows || []).length <= 1 ? bounds : null;
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
          paintFacades(context, geometry, viewport);
          context.restore();
          if (kind === 'precise' && geometry.illumination.mode !== 'all') {
            const { mode, regions } = geometry.illumination;
            if (mode === 'dark-and-normal') {
              context.globalCompositeOperation = 'destination-out';
              copyViewportCanvas(context, lightUnion(regions, false, viewport, width, height, dpr), width, height, dpr);
              // Build the normal-light union separately, then intersect it with
              // the same circle/shadow mask so light cannot reveal behind walls.
              coloredKey = coloredStyle = coloredKind = null;
              size(tint, width, height, dpr, paintBounds);
              clipSurface(tint.context, paintBounds);
              circle(tint.context, viewport, source.x, source.y, radiusUnits); tint.context.fill();
              tint.context.globalCompositeOperation = 'destination-out';
              for (const rings of geometry.shadows || []) polygon(tint.context, viewport, rings);
              tint.context.globalCompositeOperation = 'source-over';
              tint.context.save(); circle(tint.context, viewport, source.x, source.y, radiusUnits); tint.context.clip();
              paintFacades(tint.context, geometry, viewport);
              tint.context.restore();
              tint.context.globalCompositeOperation = 'destination-in';
              copyViewportCanvas(tint.context, lightUnion(regions, true, viewport, width, height, dpr), width, height, dpr);
              tint.context.restore();
              context.globalCompositeOperation = 'source-over'; copyViewportCanvas(context, tint.canvas, width, height, dpr);
            } else {
              context.globalCompositeOperation = 'destination-in';
              copyViewportCanvas(context, lightUnion(regions, mode === 'normal', viewport, width, height, dpr), width, height, dpr);
            }
          }
        }
        mask.context.restore();
        preparedKeys[cacheKind] = key;
        mask.copyRevision = (mask.copyRevision || 0) + 1;
      }
      // A full-viewport region gains nothing from an extra complete copy.
      const copyEligible = aligned && (kind === 'precise' || kind === 'vague')
        && (Math.round(bounds.width * dpr) < Math.ceil(width * dpr)
          || Math.round(bounds.height * dpr) < Math.ceil(height * dpr));
      if (target.globalCompositeOperation === 'destination-out') {
        const copy = copyEligible ? (whiteCopies[kind] ||= copyRecord()) : null;
        drawPrepared(target, mask.canvas, bounds, width, height, dpr, copy, mask.copyRevision);
      }
      else {
        const cacheable = aligned && typeof target.fillStyle === 'string';
        if (!cacheable || coloredKind !== cacheKind || coloredKey !== key || coloredStyle !== target.fillStyle) {
          size(tint, width, height, dpr, paintBounds);
          clipSurface(tint.context, paintBounds);
          copyViewportCanvas(tint.context, mask.canvas, width, height, dpr);
          tint.context.globalCompositeOperation = 'source-in';
          tint.context.fillStyle = target.fillStyle;
          if (paintBounds) tint.context.fillRect(paintBounds.x, paintBounds.y, paintBounds.width, paintBounds.height);
          else tint.context.fillRect(0, 0, width, height);
          tint.context.restore();
          coloredKey = cacheable ? key : null; coloredStyle = cacheable ? target.fillStyle : null;
          coloredKind = cacheable ? cacheKind : null;
          coloredRevision++;
        }
        const copy = copyEligible && cacheable ? (coloredCopy ||= copyRecord()) : null;
        drawPrepared(target, tint.canvas, bounds, width, height, dpr, copy, coloredRevision);
      }
    },
    cacheStats() { return { objects: facadeMasks.size, versions: cachedVersions, vertices: cachedVertices }; },
    dispose() {
      resetMasks();
      for (const surface of [illumination, light, tint]) surface.canvas.width = surface.canvas.height = 0;
      currentLightingKey = null; alignedViewport = null;
    },
  };
}
