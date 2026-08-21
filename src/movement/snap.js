export const MOVEMENT_STEPS = Object.freeze([5, 10, 20, 50, 100]);

export function normalizeMovementStep(value, fallback = 5) {
  const number = Number(value);
  return MOVEMENT_STEPS.includes(number) ? number : fallback;
}
export function cycleMovementStep(current, direction) {
  const step = normalizeMovementStep(current);
  const index = MOVEMENT_STEPS.indexOf(step);
  const delta = direction > 0 ? 1 : direction < 0 ? -1 : 0;
  return MOVEMENT_STEPS[Math.max(0, Math.min(MOVEMENT_STEPS.length - 1, index + delta))];
}
export function snapMovementPoint(point, step = 5) {
  const normalizedStep = normalizeMovementStep(step);
  return {
    x: Math.round(Number(point.x) / normalizedStep) * normalizedStep,
    y: Math.round(Number(point.y) / normalizedStep) * normalizedStep,
  };
}
export function movementMetersPerPixel(map, mapPackage) {
  if (!map?.getCenter || !map?.latLngToContainerPoint || !map?.containerPointToLatLng) return null;
  const center = map.getCenter();
  const pixel = map.latLngToContainerPoint(center);
  const other = map.containerPointToLatLng([pixel.x + 100, pixel.y]);
  const meters = Math.abs(Number(other.lng) - Number(center.lng)) * Number(mapPackage?.metersPerUnit || 1);
  return Number.isFinite(meters) ? meters / 100 : null;
}
export function recommendedMovementStep({ metersPerPixel, fallback = 5 } = {}) {
  const value = Number(metersPerPixel);
  if (!Number.isFinite(value) || value <= 0) return normalizeMovementStep(fallback);
  if (value < 0.8) return 5;
  if (value < 1.5) return 10;
  if (value < 3) return 20;
  if (value < 8) return 50;
  return 100;
}
export function recommendedMovementStepForMap(map, mapPackage, fallback = 5) {
  return recommendedMovementStep({ metersPerPixel: movementMetersPerPixel(map, mapPackage), fallback });
}
