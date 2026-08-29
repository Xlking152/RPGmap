function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHeading(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function headingBetween(origin, point) {
  return normalizeHeading(Math.atan2(Number(point.x) - Number(origin.x), -(Number(point.y) - Number(origin.y))) * 180 / Math.PI);
}

function angularDelta(a, b) {
  let delta = normalizeHeading(a) - normalizeHeading(b);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function distance(from, to) {
  return Math.hypot(Number(to.x) - Number(from.x), Number(to.y) - Number(from.y));
}

function bearingVector(degrees) {
  const radians = normalizeHeading(degrees) * Math.PI / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

function forwardPoint(origin, length, headingDeg) {
  const vector = bearingVector(headingDeg);
  return {
    x: Number(origin.x) + vector.x * Number(length),
    y: Number(origin.y) + vector.y * Number(length),
  };
}

function rightVector(headingDeg) {
  const forward = bearingVector(headingDeg);
  return { x: -forward.y, y: forward.x };
}

export function applyAreaHandleDrag(rawArea, kind, rawPoint, { maxSize = Infinity } = {}) {
  const area = clone(rawArea);
  const point = { x: Number(rawPoint?.x), y: Number(rawPoint?.y) };
  if (!area || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return area;
  const origin = { x: Number(area.origin?.x) || 0, y: Number(area.origin?.y) || 0 };
  const limit = Number.isFinite(Number(maxSize)) ? Math.max(1, Number(maxSize)) : Infinity;

  if (kind === 'origin') {
    area.origin = point;
    area.anchor = { type: 'free', markerId: null };
    return area;
  }

  if (kind === 'radius' && area.shape === 'circle') {
    area.radius = clamp(distance(origin, point), 1, limit);
    return area;
  }

  if (kind === 'direction' && (area.shape === 'sector' || area.shape === 'rectangle')) {
    const nextDistance = clamp(distance(origin, point), 1, limit);
    area.headingDeg = headingBetween(origin, point);
    if (area.shape === 'sector') area.range = nextDistance;
    else area.length = nextDistance;
    return area;
  }

  if (kind === 'angle' && area.shape === 'sector') {
    const edgeHeading = headingBetween(origin, point);
    area.angleDeg = clamp(Math.abs(angularDelta(edgeHeading, Number(area.headingDeg) || 0)) * 2, 1, 359);
    return area;
  }

  if (kind === 'width' && area.shape === 'rectangle') {
    const heading = Number(area.headingDeg) || 0;
    const midpoint = forwardPoint(origin, (Number(area.length) || 1) / 2, heading);
    const right = rightVector(heading);
    const projection = (point.x - midpoint.x) * right.x + (point.y - midpoint.y) * right.y;
    area.width = clamp(Math.abs(projection) * 2, 1, limit);
    return area;
  }

  return area;
}

export function areaHandlePoints(area) {
  const origin = area.origin;
  const points = [{ kind: 'origin', point: origin, label: '起点', title: '拖动范围起点', secondary: false }];
  if (area.shape === 'circle') {
    points.push({
      kind: 'radius',
      point: forwardPoint(origin, Number(area.radius) || 1, 90),
      label: '半径',
      title: '拖动修改半径',
      secondary: true,
    });
    return points;
  }

  if (area.shape === 'sector' || area.shape === 'rectangle') {
    const reach = area.shape === 'sector' ? Number(area.range) || 1 : Number(area.length) || 1;
    points.push({
      kind: 'direction',
      point: forwardPoint(origin, reach, Number(area.headingDeg) || 0),
      label: '方向',
      title: '拖动修改距离与朝向',
      secondary: true,
    });
  }
  if (area.shape === 'sector') {
    points.push({
      kind: 'angle',
      point: forwardPoint(origin, Number(area.range) || 1, (Number(area.headingDeg) || 0) + (Number(area.angleDeg) || 60) / 2),
      label: '角度',
      title: '拖动修改扇形夹角',
      secondary: true,
    });
  }
  if (area.shape === 'rectangle') {
    const heading = Number(area.headingDeg) || 0;
    const midpoint = forwardPoint(origin, (Number(area.length) || 1) / 2, heading);
    const right = rightVector(heading);
    points.push({
      kind: 'width',
      point: {
        x: midpoint.x + right.x * (Number(area.width) || 1) / 2,
        y: midpoint.y + right.y * (Number(area.width) || 1) / 2,
      },
      label: '宽度',
      title: '拖动修改矩形宽度',
      secondary: true,
    });
  }
  return points;
}
