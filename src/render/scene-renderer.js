import { deriveFloodRegions, deriveSceneState } from '../engine/state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function stableVariant(value, count) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

function stableUnit(value) {
  return stableVariant(value, 10000) / 9999;
}

export function irregularDamagePolygon(points, seed = 'damage') {
  const normalized = (points || []).map((point) => Array.isArray(point)
    ? { x: Number(point[0]), y: Number(point[1]) }
    : { x: Number(point.x), y: Number(point.y) }
  ).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (normalized.length < 3) return normalized;

  const center = normalized.reduce((sum, point) => ({
    x: sum.x + point.x,
    y: sum.y + point.y,
  }), { x: 0, y: 0 });
  center.x /= normalized.length;
  center.y /= normalized.length;

  const sampleCount = Math.min(14, normalized.length);
  return Array.from({ length: sampleCount }, (_, index) => {
    const point = normalized[Math.floor(index * normalized.length / sampleCount)];
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const radius = Math.hypot(dx, dy);
    const radialScale = 0.68 + stableUnit(`${seed}-radius-${index}`) * 0.30;
    const tangentScale = (stableUnit(`${seed}-tangent-${index}`) - 0.5) * 0.12;
    if (radius < 1e-6) return { ...point };
    return {
      x: center.x + dx * radialScale - dy * tangentScale,
      y: center.y + dy * radialScale + dx * tangentScale,
    };
  });
}

export function createSceneRenderer({
  baseSvg,
  mapPackage,
  getSceneEvents,
  getDamagePreview,
}) {
  const seenFloodRegionIds = new Set();
  let hasRenderedFloods = false;
  if (!baseSvg) throw new Error('场景渲染器缺少底图 SVG');
  if (!mapPackage) throw new Error('场景渲染器缺少地图包');

  function svgNode(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    return node;
  }

  function sceneBlurFilter(id, stdDeviation) {
    const filter = svgNode('filter', {
      id,
      x: '-60%',
      y: '-60%',
      width: '220%',
      height: '220%',
    });
    filter.append(svgNode('feGaussianBlur', { stdDeviation: String(stdDeviation) }));
    return filter;
  }

  function featureNode(featureId) {
    return baseSvg.ownerDocument.getElementById('feature-' + featureId) ||
      baseSvg.querySelector('[data-feature-id="' + CSS.escape(featureId) + '"]');
  }

  function featurePolygon(feature) {
    const points = feature?.geometry?.points || feature?.polygon || [];
    if (!Array.isArray(points)) return [];
    return points.map(point => Array.isArray(point)
      ? { x: Number(point[0]), y: Number(point[1]) }
      : { x: Number(point.x), y: Number(point.y) }
    ).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  function svgPolygonPoints(points) {
    return points.map(point => {
      const x = Array.isArray(point) ? point[0] : point.x;
      const y = Array.isArray(point) ? point[1] : point.y;
      return Number(x).toFixed(2) + ',' + Number(y).toFixed(2);
    }).join(' ');
  }

  function pointBounds(points) {
    return {
      minX: Math.min(...points.map(point => point.x)),
      maxX: Math.max(...points.map(point => point.x)),
      minY: Math.min(...points.map(point => point.y)),
      maxY: Math.max(...points.map(point => point.y)),
    };
  }

  function principalAxis(points) {
    const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    center.x /= points.length;
    center.y /= points.length;
    let xx = 0;
    let yy = 0;
    let xy = 0;
    points.forEach(point => {
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      xx += dx * dx;
      yy += dy * dy;
      xy += dx * dy;
    });
    const angle = Math.atan2(2 * xy, xx - yy) / 2;
    let axis = { x: Math.cos(angle), y: Math.sin(angle) };
    const projections = points.map(point => (point.x - center.x) * axis.x + (point.y - center.y) * axis.y);
    if (Math.max(...projections) - Math.min(...projections) < 1) axis = { x: 0, y: 1 };
    const normal = { x: -axis.y, y: axis.x };
    const along = points.map(point => (point.x - center.x) * axis.x + (point.y - center.y) * axis.y);
    const across = points.map(point => (point.x - center.x) * normal.x + (point.y - center.y) * normal.y);
    return {
      center,
      axis,
      normal,
      minAlong: Math.min(...along),
      maxAlong: Math.max(...along),
      minAcross: Math.min(...across),
      maxAcross: Math.max(...across),
    };
  }

  function axisPoint(layout, along, across = 0) {
    return {
      x: layout.center.x + layout.axis.x * along + layout.normal.x * across,
      y: layout.center.y + layout.axis.y * along + layout.normal.y * across,
    };
  }

  function appendGeneratedRubble(group, feature, index, points, bounds) {
    const atlas = mapPackage.artAssets?.rubbleAtlas;
    if (!atlas?.url || feature.category !== 'building') return;
    const columns = Math.max(1, Math.floor(atlas.columns));
    const rows = Math.max(1, Math.floor(atlas.rows));
    const variant = stableVariant(feature.id, columns * rows);
    const column = variant % columns;
    const row = Math.floor(variant / columns);
    const cellWidth = atlas.width / columns;
    const cellHeight = atlas.height / rows;
    const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
    const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
    const insetX = boundsWidth * 0.08;
    const insetY = boundsHeight * 0.08;
    const clipId = `scene-rubble-clip-${index}-${variant}`;
    const defs = svgNode('defs');
    const clipPath = svgNode('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    clipPath.append(svgNode('polygon', { points: svgPolygonPoints(points) }));
    defs.append(clipPath);

    const clippedGroup = svgNode('g', {
      'clip-path': `url(#${clipId})`,
      class: 'generated-rubble-decal',
      'data-rubble-variant': variant,
    });
    const decal = svgNode('svg', {
      x: bounds.minX + insetX,
      y: bounds.minY + insetY,
      width: boundsWidth - insetX * 2,
      height: boundsHeight - insetY * 2,
      viewBox: `${column * cellWidth} ${row * cellHeight} ${cellWidth} ${cellHeight}`,
      preserveAspectRatio: 'xMidYMid slice',
      'aria-hidden': 'true',
    });
    decal.append(svgNode('image', {
      href: atlas.url,
      x: 0,
      y: 0,
      width: atlas.width,
      height: atlas.height,
      preserveAspectRatio: 'none',
    }));
    clippedGroup.append(decal);
    group.append(defs, clippedGroup);
  }

  function reset() {
    const destructibleLayer = baseSvg.querySelector('#layer-destructible');
    const featureRoot = destructibleLayer || baseSvg;
    featureRoot.querySelectorAll('[data-feature-id]').forEach(node => {
      node.classList.add('scene-feature');
      node.classList.remove('preview-hit', 'scene-destroyed');
      node.removeAttribute('mask');
    });
    baseSvg.querySelectorAll('[data-label-for]').forEach(node => node.classList.remove('scene-label-destroyed'));
    baseSvg.querySelector('#layer-damage')?.replaceChildren();
    baseSvg.querySelector('#layer-flood')?.replaceChildren();
  }

  function appendBuildingDebris(group, feature, index, points, bounds) {
    if (feature.category !== 'building') return;
    const clipId = `scene-building-debris-${index}`;
    const defs = svgNode('defs');
    const clipPath = svgNode('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    clipPath.append(svgNode('polygon', { points: svgPolygonPoints(points) }));
    defs.append(clipPath);
    const debris = svgNode('g', {
      class: 'scene-building-debris',
      'clip-path': `url(#${clipId})`,
    });
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.max(3, Math.min(width, height));
    for (let debrisIndex = 0; debrisIndex < 14; debrisIndex += 1) {
      const x = bounds.minX + stableUnit(`${feature.id}-x-${debrisIndex}`) * width;
      const y = bounds.minY + stableUnit(`${feature.id}-y-${debrisIndex}`) * height;
      const angle = Math.round(stableUnit(`${feature.id}-a-${debrisIndex}`) * 160 - 80);
      if (debrisIndex % 3 === 0) {
        const length = scale * (0.18 + stableUnit(`${feature.id}-l-${debrisIndex}`) * 0.22);
        debris.append(svgNode('line', {
          x1: x - length / 2,
          y1: y,
          x2: x + length / 2,
          y2: y,
          transform: `rotate(${angle} ${x} ${y})`,
          class: 'scene-fallen-timber',
        }));
      } else {
        const size = scale * (0.055 + stableUnit(`${feature.id}-s-${debrisIndex}`) * 0.06);
        debris.append(svgNode('rect', {
          x: x - size,
          y: y - size * 0.45,
          width: size * 2,
          height: size * 0.9,
          rx: size * 0.16,
          transform: `rotate(${angle} ${x} ${y})`,
          class: debrisIndex % 2 ? 'scene-broken-tile dark' : 'scene-broken-tile',
        }));
      }
    }
    group.append(defs, debris);
  }

  function appendBridgeRuin(runtimeGroup, feature, points) {
    const layout = principalAxis(points);
    const width = Math.max(18, layout.maxAcross - layout.minAcross);
    const gapHalf = Math.max(28, (layout.maxAlong - layout.minAlong) * 0.18);
    const group = svgNode('g', { class: 'scene-ruin scene-bridge-ruin', 'data-ruin-for': feature.id });
    const deckPoints = (start, end, halfWidth) => [
      axisPoint(layout, start, -halfWidth),
      axisPoint(layout, end, -halfWidth),
      axisPoint(layout, end, halfWidth),
      axisPoint(layout, start, halfWidth),
    ];
    const deckHalfWidth = width * 0.34;
    [
      [layout.minAlong, -gapHalf],
      [gapHalf, layout.maxAlong],
    ].forEach(([start, end], stubIndex) => {
      group.append(svgNode('polygon', {
        points: svgPolygonPoints(deckPoints(start, end, deckHalfWidth)),
        class: 'scene-bridge-stub-shadow',
        transform: `translate(5 7)`,
      }));
      group.append(svgNode('polygon', {
        points: svgPolygonPoints(deckPoints(start, end, deckHalfWidth)),
        class: 'scene-bridge-stub',
      }));
      for (let plankIndex = 1; plankIndex < 7; plankIndex += 1) {
        const along = start + (end - start) * plankIndex / 7;
        const left = axisPoint(layout, along, -deckHalfWidth * 0.92);
        const right = axisPoint(layout, along, deckHalfWidth * 0.92);
        group.append(svgNode('line', {
          x1: left.x,
          y1: left.y,
          x2: right.x,
          y2: right.y,
          class: 'scene-bridge-stub-plank',
        }));
      }
      const breakAlong = stubIndex === 0 ? end : start;
      const breakLeft = axisPoint(layout, breakAlong, -deckHalfWidth);
      const breakRight = axisPoint(layout, breakAlong, deckHalfWidth);
      group.append(svgNode('path', {
        d: `M ${breakLeft.x} ${breakLeft.y} L ${axisPoint(layout, breakAlong + (stubIndex ? 12 : -12), 0).x} ${axisPoint(layout, breakAlong + (stubIndex ? 12 : -12), 0).y} L ${breakRight.x} ${breakRight.y}`,
        class: 'scene-bridge-splinter-edge',
      }));
    });
    [-0.62, -0.12, 0.43, 0.76].forEach((position, boatIndex) => {
      const along = gapHalf * position;
      const across = (boatIndex % 2 ? 1 : -1) * width * (0.30 + boatIndex * 0.08);
      const boat = axisPoint(layout, along, across);
      const angle = Math.atan2(layout.axis.y, layout.axis.x) * 180 / Math.PI + (boatIndex - 1.5) * 13;
      group.append(svgNode('ellipse', {
        cx: boat.x,
        cy: boat.y,
        rx: width * 0.30,
        ry: width * 0.105,
        transform: `rotate(${angle} ${boat.x} ${boat.y})`,
        class: 'scene-loose-pontoon',
      }));
    });
    const looseTimberStart = axisPoint(layout, -gapHalf * 0.35, -width * 0.42);
    const looseTimberEnd = axisPoint(layout, gapHalf * 0.48, width * 0.48);
    group.append(svgNode('line', {
      x1: looseTimberStart.x,
      y1: looseTimberStart.y,
      x2: looseTimberEnd.x,
      y2: looseTimberEnd.y,
      class: 'scene-floating-timber',
    }));
    runtimeGroup.append(group);
  }

  function appendObjectRuin(runtimeGroup, feature, index) {
    const points = featurePolygon(feature);
    if (points.length < 3) return;
    if (feature.category === 'bridge') {
      appendBridgeRuin(runtimeGroup, feature, points);
      return;
    }
    const group = svgNode('g', { class: 'scene-ruin', 'data-ruin-for': feature.id });
    group.append(svgNode('polygon', {
      points: svgPolygonPoints(points),
      fill: 'none',
      stroke: '#241608',
      'stroke-width': 28,
      opacity: 0.38,
      filter: 'url(#scene-soft)',
      class: 'scene-scorch',
    }));
    group.append(svgNode('polygon', {
      points: svgPolygonPoints(points),
      fill: 'url(#rubble-pattern)',
      stroke: feature.category === 'vegetation' ? '#4f593e' : '#705b43',
      'stroke-width': 7,
      'stroke-opacity': 0.85,
      opacity: 0.95,
    }));
    const { minX, maxX, minY, maxY } = pointBounds(points);
    appendGeneratedRubble(group, feature, index, points, { minX, maxX, minY, maxY });
    appendBuildingDebris(group, feature, index, points, { minX, maxX, minY, maxY });
    const inset = Math.min(maxX - minX, maxY - minY) * 0.18;
    if (maxX - minX > 8 && maxY - minY > 8) {
      group.append(svgNode('path', {
        d: 'M ' + (minX + inset) + ' ' + (minY + inset) + ' L ' + (maxX - inset) + ' ' + (maxY - inset) +
          ' M ' + (maxX - inset) + ' ' + (minY + inset) + ' L ' + (minX + inset) + ' ' + (maxY - inset),
        fill: 'none',
        stroke: index % 2 ? '#8d7658' : '#5f4c39',
        'stroke-width': 5,
        'stroke-dasharray': '16 9',
        opacity: 0.82,
      }));
    }
    runtimeGroup.append(group);
  }

  function appendWallBreach(scarGroup, hit, feature, hitIndex) {
    const hitPoints = hit.polygon.map(point => Array.isArray(point)
      ? { x: Number(point[0]), y: Number(point[1]) }
      : { x: Number(point.x), y: Number(point.y) });
    const bounds = pointBounds(hitPoints);
    const center = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    const radius = Math.max(18, Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.48);
    const jagged = Array.from({ length: 12 }, (_, pointIndex) => {
      const angle = Math.PI * 2 * pointIndex / 12;
      const variance = 0.68 + stableUnit(`${feature.id}-${hitIndex}-${pointIndex}`) * 0.42;
      return {
        x: center.x + Math.cos(angle) * radius * variance,
        y: center.y + Math.sin(angle) * radius * variance,
      };
    });
    scarGroup.append(svgNode('polygon', {
      points: svgPolygonPoints(jagged),
      class: 'scene-wall-breach-shadow',
    }));
    scarGroup.append(svgNode('polygon', {
      points: svgPolygonPoints(jagged),
      class: 'scene-wall-breach',
    }));
    for (let fragmentIndex = 0; fragmentIndex < 9; fragmentIndex += 1) {
      const angle = Math.PI * 2 * fragmentIndex / 9;
      const distance = radius * (0.62 + stableUnit(`${feature.id}-wall-${hitIndex}-${fragmentIndex}`) * 0.55);
      const size = radius * (0.08 + stableUnit(`${feature.id}-wall-size-${fragmentIndex}`) * 0.10);
      const x = center.x + Math.cos(angle) * distance;
      const y = center.y + Math.sin(angle) * distance;
      scarGroup.append(svgNode('rect', {
        x: x - size,
        y: y - size * 0.5,
        width: size * 2,
        height: size,
        rx: size * 0.18,
        transform: `rotate(${Math.round(angle * 180 / Math.PI + 18)} ${x} ${y})`,
        class: 'scene-wall-fragment',
      }));
    }
  }

  function appendClipDamage(runtimeDefs, runtimeGroup, feature, hits, index) {
    const node = featureNode(feature.id);
    const featurePoints = featurePolygon(feature);
    if (!node || featurePoints.length < 3) return;
    const maskId = 'scene-mask-' + index;
    const mask = svgNode('mask', {
      id: maskId,
      maskUnits: 'userSpaceOnUse',
      x: -mapPackage.width * 4,
      y: -mapPackage.height * 4,
      width: mapPackage.width * 9,
      height: mapPackage.height * 9,
    });
    mask.append(svgNode('rect', {
      x: -mapPackage.width * 4,
      y: -mapPackage.height * 4,
      width: mapPackage.width * 9,
      height: mapPackage.height * 9,
      fill: '#fff',
    }));
    const damagePolygons = hits.map((hit, hitIndex) => (
      feature.category === 'building'
        ? irregularDamagePolygon(hit.polygon, `${feature.id}-${hitIndex}`)
        : hit.polygon
    ));
    damagePolygons.forEach((points) => {
      mask.append(svgNode('polygon', { points: svgPolygonPoints(points), fill: '#000' }));
    });
    runtimeDefs.append(mask);
    node.setAttribute('mask', 'url(#' + maskId + ')');

    const clipId = 'scene-feature-clip-' + index;
    const clipPath = svgNode('clipPath', { id: clipId });
    clipPath.append(svgNode('polygon', { points: svgPolygonPoints(featurePoints) }));
    runtimeDefs.append(clipPath);
    const scarGroup = svgNode('g', {
      class: 'scene-ruin',
      'clip-path': 'url(#' + clipId + ')',
      'data-scar-for': feature.id,
    });
    hits.forEach((hit, hitIndex) => {
      const damagePoints = damagePolygons[hitIndex];
      scarGroup.append(svgNode('polygon', {
        points: svgPolygonPoints(damagePoints),
        fill: 'none',
        stroke: '#241608',
        'stroke-width': feature.category === 'building' ? 16 : 24,
        opacity: feature.category === 'building' ? 0.34 : 0.42,
        filter: 'url(#scene-soft)',
        class: 'scene-scorch',
      }));
      if (feature.category === 'building') {
        scarGroup.append(svgNode('polygon', {
          points: svgPolygonPoints(damagePoints),
          fill: '#5f5141',
          stroke: '#4a392c',
          'stroke-width': 4,
          'stroke-linejoin': 'bevel',
          opacity: 0.82,
          'data-irregular-damage': 'true',
        }));
        scarGroup.append(svgNode('polygon', {
          points: svgPolygonPoints(damagePoints),
          fill: 'url(#rubble-pattern)',
          stroke: '#887055',
          'stroke-width': 2,
          'stroke-opacity': 0.78,
          'stroke-linejoin': 'bevel',
          opacity: 0.96,
        }));
      } else {
        scarGroup.append(svgNode('polygon', {
          points: svgPolygonPoints(damagePoints),
          fill: feature.category === 'terrain' ? '#725640' : 'url(#rubble-pattern)',
          stroke: feature.category === 'terrain' ? '#4c372c' : '#7a654b',
          'stroke-width': feature.category === 'terrain' ? 10 : 5,
          'stroke-opacity': feature.category === 'terrain' ? 0.85 : 0.7,
          opacity: feature.category === 'terrain' ? 0.88 : 0.98,
          'data-irregular-damage': 'false',
        }));
      }
      if (feature.category === 'building') {
        const bounds = pointBounds(damagePoints);
        const fragmentSize = Math.max(2.5, Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.12);
        for (let fragmentIndex = 0; fragmentIndex < 5; fragmentIndex += 1) {
          const point = damagePoints[stableVariant(`${feature.id}-${hitIndex}-fragment-${fragmentIndex}`, damagePoints.length)];
          const angle = stableUnit(`${feature.id}-${hitIndex}-angle-${fragmentIndex}`) * 180;
          scarGroup.append(svgNode('rect', {
            x: point.x - fragmentSize * 0.72,
            y: point.y - fragmentSize * 0.24,
            width: fragmentSize * 1.44,
            height: fragmentSize * 0.48,
            rx: fragmentSize * 0.08,
            transform: `rotate(${Math.round(angle)} ${point.x} ${point.y})`,
            class: fragmentIndex % 2 ? 'scene-local-tile' : 'scene-local-timber',
          }));
        }
      }
      if (feature.category === 'wall') appendWallBreach(scarGroup, hit, feature, hitIndex);
    });
    runtimeGroup.append(scarGroup);
  }

  function appendGroundCrater(runtimeGroup, craterId, hits) {
    hits.forEach(hit => {
      const points = svgPolygonPoints(hit.polygon);
      const group = svgNode('g', { class: 'scene-crater', 'data-crater-for': craterId });
      group.append(svgNode('polygon', {
        points,
        fill: 'none',
        stroke: '#241608',
        'stroke-width': 30,
        opacity: 0.35,
        filter: 'url(#scene-soft-wide)',
        class: 'scene-scorch',
      }));
      group.append(svgNode('polygon', { points, fill: 'url(#scene-crater-depth)' }));
      group.append(svgNode('polygon', { points, fill: 'url(#rubble-pattern)', opacity: 0.4 }));
      runtimeGroup.append(group);
    });
  }

  function renderFloods(floodLayer, floodRegions) {
    floodRegions.forEach((region) => {
      const isNew = hasRenderedFloods && !seenFloodRegionIds.has(region.id);
      const group = svgNode('g', {
        class: `scene-flood scene-flood-${region.kind}${isNew ? ' scene-flood-new' : ''}`,
        'data-flood-for': region.id,
      });
      group.append(svgNode('polygon', {
        points: svgPolygonPoints(region.polygon),
        fill: 'url(#scene-flood-depth)',
      }));
      if (region.kind === 'inlet' && Array.isArray(region.flowLine)) {
        group.append(svgNode('path', {
          d: `M ${region.flowLine[0][0]} ${region.flowLine[0][1]} L ${region.flowLine[1][0]} ${region.flowLine[1][1]}`,
          class: 'scene-flood-flow-line',
          'pathLength': 1,
        }));
      }
      floodLayer.append(group);
      seenFloodRegionIds.add(region.id);
    });
    hasRenderedFloods = true;
  }

  function appendRuntimeDefs(damageLayer) {
    const runtimeDefs = svgNode('defs', { id: 'scene-runtime-defs' });
    damageLayer.append(runtimeDefs);
    runtimeDefs.append(sceneBlurFilter('scene-soft', 6));
    runtimeDefs.append(sceneBlurFilter('scene-soft-wide', 10));

    const craterDepth = svgNode('radialGradient', {
      id: 'scene-crater-depth',
      cx: '50%',
      cy: '50%',
      r: '72%',
    });
    [
      ['0%', '#20150c', '0.92'],
      ['50%', '#2e2115', '0.78'],
      ['80%', '#4a3825', '0.45'],
      ['100%', '#7a6547', '0.08'],
    ].forEach(([offset, color, opacity]) => {
      craterDepth.append(svgNode('stop', {
        offset,
        'stop-color': color,
        'stop-opacity': opacity,
      }));
    });
    runtimeDefs.append(craterDepth);

    const floodDepth = svgNode('radialGradient', {
      id: 'scene-flood-depth',
      cx: '50%',
      cy: '50%',
      r: '72%',
    });
    [
      ['0%', '#2f5a6b', '0.88'],
      ['55%', '#4f879b', '0.72'],
      ['85%', '#7fa8ad', '0.42'],
      ['100%', '#9dbdb8', '0.12'],
    ].forEach(([offset, color, opacity]) => {
      floodDepth.append(svgNode('stop', {
        offset,
        'stop-color': color,
        'stop-opacity': opacity,
      }));
    });
    runtimeDefs.append(floodDepth);
    return runtimeDefs;
  }

  function render() {
    reset();
    if (!mapPackage.features?.length) return;
    const scene = deriveSceneState(getSceneEvents?.() || []);
    const labelsLayer = baseSvg.querySelector('#layer-labels');
    let damageLayer = baseSvg.querySelector('#layer-damage');
    if (!damageLayer) {
      damageLayer = svgNode('g', { id: 'layer-damage', 'data-layer': 'damage' });
      if (labelsLayer) baseSvg.insertBefore(damageLayer, labelsLayer); else baseSvg.append(damageLayer);
    }
    let floodLayer = baseSvg.querySelector('#layer-flood');
    if (!floodLayer) {
      floodLayer = svgNode('g', { id: 'layer-flood', 'data-layer': 'flood' });
      if (labelsLayer) baseSvg.insertBefore(floodLayer, labelsLayer); else baseSvg.append(floodLayer);
    }
    const runtimeDefs = appendRuntimeDefs(damageLayer);
    const featureById = new Map(mapPackage.features.map(feature => [feature.id, feature]));

    (scene.destroyedObjectIds || []).forEach((id, index) => {
      const node = featureNode(id);
      const feature = featureById.get(id);
      if (node) node.classList.add('scene-destroyed');
      baseSvg.querySelectorAll('[data-label-for="' + CSS.escape(id) + '"]').forEach(label => {
        label.classList.add('scene-label-destroyed');
      });
      if (feature && !feature.severeOnly) appendObjectRuin(damageLayer, feature, index);
    });

    const groupedClipHits = new Map();
    const explicitCraterEventIds = new Set((scene.craterRegions || []).map(crater => crater.eventId));
    (scene.clipHits || []).forEach(hit => {
      if (explicitCraterEventIds.has(hit.eventId) && featureById.get(hit.featureId)?.severeOnly) return;
      if (!groupedClipHits.has(hit.featureId)) groupedClipHits.set(hit.featureId, []);
      groupedClipHits.get(hit.featureId).push(hit);
    });
    [...groupedClipHits.entries()].forEach(([id, hits], index) => {
      const feature = featureById.get(id);
      if (!feature) return;
      if (feature.severeOnly) {
        appendGroundCrater(damageLayer, feature.id, hits);
      } else {
        appendClipDamage(runtimeDefs, damageLayer, feature, hits, index);
      }
    });
    (scene.craterRegions || []).forEach(crater => {
      appendGroundCrater(damageLayer, crater.eventId, [crater]);
    });

    const floodRegions = deriveFloodRegions(
      scene,
      mapPackage.liquidBodies || [],
      mapPackage.features || [],
      mapPackage.floodRules || {},
    );
    renderFloods(floodLayer, floodRegions);

    const damagePreview = getDamagePreview?.();
    const previewIds = damagePreview?.featureIds || [
      ...(damagePreview?.objectIds || []),
      ...(damagePreview?.clipHits || []).map(hit => hit.featureId),
    ];
    previewIds.forEach(id => featureNode(id)?.classList.add('preview-hit'));
  }

  return { render, reset };
}
