// Read-only BVH. Results retain source order, including first-hit LOS semantics.
const indexes = new WeakMap();
const immutableCollections = new WeakSet();
function isImmutableRing(ring) {
  return Array.isArray(ring) && ring.length >= 3 && Object.isFrozen(ring)
    && ring.every(point => Array.isArray(point) && point.length >= 2
      && Object.isFrozen(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
}
export function isIndexableOccluderCollection(occluders) {
  if (!Array.isArray(occluders) || !Object.isFrozen(occluders)) return false;
  if (immutableCollections.has(occluders)) return true;
  if (!occluders.every(value => value && Object.isFrozen(value)
    && isImmutableRing(value.polygon)
    && (value.polygons === undefined || Array.isArray(value.polygons)
      && Object.isFrozen(value.polygons)
      && value.polygons.every(region => Array.isArray(region) && Object.isFrozen(region)
        && region.every(isImmutableRing))))) return false;
  immutableCollections.add(occluders);
  return true;
}
export function boundsOf(points) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }
  return bounds;
}
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function queryOccluders(occluders, bounds) {
  // Array freezing alone does not protect nested polygons from mutation.
  if (!isIndexableOccluderCollection(occluders) || !occluders.length) return occluders;
  let root = indexes.get(occluders);
  if (!root) {
    const build = items => {
      const box = boundsOf(items.flatMap(item => [[item.bounds[0], item.bounds[1]], [item.bounds[2], item.bounds[3]]]));
      if (items.length <= 8) return { box, items };
      const axis = box[2] - box[0] >= box[3] - box[1] ? 0 : 1;
      items.sort((a, b) => a.bounds[axis] + a.bounds[axis + 2] - b.bounds[axis] - b.bounds[axis + 2]);
      const half = items.length >> 1;
      return { box, left: build(items.slice(0, half)), right: build(items.slice(half)) };
    };
    root = build(occluders.map((value, order) => ({ value, order,
      bounds: boundsOf([ ...value.polygon, ...(value.polygons?.flat(2) || []) ]) })));
    indexes.set(occluders, root);
  }
  const found = [];
  const visit = node => {
    if (!overlaps(node.box, bounds)) return;
    if (node.items) { for (const item of node.items) if (overlaps(item.bounds, bounds)) found.push(item); }
    else { visit(node.left); visit(node.right); }
  };
  visit(root);
  return found.sort((a, b) => a.order - b.order).map(item => item.value);
}
