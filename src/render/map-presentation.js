const TIER_ORDER = Object.freeze({ overview: 0, mid: 1, detail: 2 });

export function zoomTierForScale(pixelsPerWorldUnit) {
  if (!Number.isFinite(pixelsPerWorldUnit) || pixelsPerWorldUnit <= 0.24) return 'overview';
  if (pixelsPerWorldUnit <= 0.52) return 'mid';
  return 'detail';
}

export function boxesOverlap(left, right, padding = 0) {
  return left.right + padding > right.left &&
    left.left - padding < right.right &&
    left.bottom + padding > right.top &&
    left.top - padding < right.bottom;
}

function shiftedBox(box, offset) {
  return {
    left: box.left + offset.x,
    right: box.right + offset.x,
    top: box.top + offset.y,
    bottom: box.bottom + offset.y,
  };
}

function overflowScore(box, viewport, padding) {
  if (!viewport) return 0;
  return Math.max(0, viewport.left + padding - box.left) +
    Math.max(0, box.right - viewport.right + padding) +
    Math.max(0, viewport.top + padding - box.top) +
    Math.max(0, box.bottom - viewport.bottom + padding);
}

function collisionScore(box, occupied, obstacles, padding) {
  const collisions = [...occupied, ...obstacles].filter(other => boxesOverlap(box, other, padding));
  return collisions.reduce((score, other) => {
    const width = Math.max(0, Math.min(box.right, other.right) - Math.max(box.left, other.left));
    const height = Math.max(0, Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top));
    return score + width * height + 1;
  }, 0);
}

export function chooseLabelPlacement({
  box,
  candidates,
  occupied = [],
  obstacles = [],
  viewport,
  padding = 4,
}) {
  const evaluated = candidates.map((offset, index) => {
    const shifted = shiftedBox(box, offset);
    const overflow = overflowScore(shifted, viewport, padding);
    const collisions = collisionScore(shifted, occupied, obstacles, padding);
    return { offset, box: shifted, overflow, collisions, score: overflow * 10000 + collisions, index };
  });
  return evaluated.sort((left, right) => left.score - right.score || left.index - right.index)[0];
}

function parseCandidates(value) {
  const parsed = String(value || '')
    .split('|')
    .map(pair => pair.split(',').map(Number))
    .filter(pair => pair.length === 2 && pair.every(Number.isFinite))
    .map(([x, y]) => ({ x, y }));
  return parsed.length ? parsed : [
    { x: 0, y: 0 },
    { x: 0, y: -18 },
    { x: 18, y: 0 },
    { x: -18, y: 0 },
    { x: 0, y: 18 },
    { x: 24, y: -18 },
    { x: -24, y: -18 },
    { x: 48, y: 0 },
    { x: -48, y: 0 },
    { x: 0, y: 36 },
    { x: 0, y: -36 },
    { x: 72, y: 0 },
    { x: -72, y: 0 },
    { x: 120, y: 0 },
    { x: -120, y: 0 },
  ];
}

function tierAllows(currentTier, minimumTier, maximumTier) {
  return TIER_ORDER[currentTier] >= TIER_ORDER[minimumTier || 'overview'] &&
    TIER_ORDER[currentTier] <= TIER_ORDER[maximumTier || 'detail'];
}

function rectBox(rect) {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  };
}

export function createMapPresentation({ map, baseSvg, mapPackage }) {
  if (!map || !baseSvg || !mapPackage) throw new Error('地图呈现控制器缺少必要参数');
  let frame = null;
  const labelNodes = [...baseSvg.querySelectorAll('[data-map-label]')];
  labelNodes.forEach(node => {
    node.dataset.labelBaseTransform = node.getAttribute('transform') || '';
  });

  function resetLabel(node) {
    node.classList.remove('map-label-hidden', 'map-label-collided');
    const baseTransform = node.dataset.labelBaseTransform;
    if (baseTransform) node.setAttribute('transform', baseTransform);
    else node.removeAttribute('transform');
  }

  function refresh() {
    frame = null;
    const svgRect = baseSvg.getBoundingClientRect();
    if (!svgRect.width || !svgRect.height) return;
    const pixelsPerWorldUnit = svgRect.width / mapPackage.width;
    const tier = zoomTierForScale(pixelsPerWorldUnit);
    baseSvg.dataset.zoomTier = tier;

    labelNodes.forEach(resetLabel);
    const visibleLabels = labelNodes
      .filter(node => {
        const visible = tierAllows(tier, node.dataset.minZoomTier, node.dataset.maxZoomTier);
        node.classList.toggle('map-label-hidden', !visible);
        return visible && !node.classList.contains('scene-label-destroyed');
      })
      .sort((left, right) => Number(right.dataset.labelPriority || 0) - Number(left.dataset.labelPriority || 0));

    const viewport = rectBox(map.getContainer().getBoundingClientRect());
    const obstacleNodes = [...baseSvg.querySelectorAll('[data-label-obstacle="true"]')]
      .filter(node => !node.classList.contains('scene-destroyed'));
    const occupied = [];

    visibleLabels.forEach(node => {
      const ownFeatureId = node.dataset.labelAnchor || node.dataset.labelFor;
      const obstacles = obstacleNodes
        .filter(obstacle => obstacle.dataset.featureId !== ownFeatureId)
        .map(obstacle => rectBox(obstacle.getBoundingClientRect()));
      const placement = chooseLabelPlacement({
        box: rectBox(node.getBoundingClientRect()),
        candidates: parseCandidates(node.dataset.labelCandidates),
        occupied,
        obstacles,
        viewport,
        padding: tier === 'detail' ? 3 : 5,
      });
      const essential = Number(node.dataset.labelPriority || 0) >= 85;
      if (placement.overflow > 0 || (placement.collisions > 0 && !essential)) {
        node.classList.add('map-label-hidden', 'map-label-collided');
        return;
      }
      const worldX = placement.offset.x / pixelsPerWorldUnit;
      const worldY = placement.offset.y / pixelsPerWorldUnit;
      const baseTransform = node.dataset.labelBaseTransform;
      const translation = `translate(${worldX.toFixed(2)} ${worldY.toFixed(2)})`;
      node.setAttribute('transform', baseTransform ? `${translation} ${baseTransform}` : translation);
      occupied.push(placement.box);
    });
  }

  function schedule() {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refresh);
  }

  function destroy() {
    if (frame) cancelAnimationFrame(frame);
  }

  return { refresh, schedule, destroy };
}
