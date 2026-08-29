function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeTokenPoint(value) {
  const x = finite(value?.x);
  const y = finite(value?.y);
  return x === null || y === null ? null : Object.freeze({ x, y });
}

export function sameTokenPoint(left, right, epsilon = 1e-6) {
  const a = normalizeTokenPoint(left);
  const b = normalizeTokenPoint(right);
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

export function interpolateTokenPoint(from, to, progress) {
  const start = normalizeTokenPoint(from);
  const end = normalizeTokenPoint(to);
  if (!start || !end) return null;
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  return Object.freeze({
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
  });
}

export function tokenMoveDuration(from, to, {
  minMs = 180,
  maxMs = 900,
  millisecondsPerMeter = 35,
} = {}) {
  const start = normalizeTokenPoint(from);
  const end = normalizeTokenPoint(to);
  if (!start || !end) return Math.max(0, Number(minMs) || 0);
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  const scaled = distance * Math.max(0, Number(millisecondsPerMeter) || 0);
  return Math.max(min, Math.min(max, scaled));
}
