function copyPoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

function appendRoutePoints(target, points) {
  if (!points?.length) return;
  points.forEach((point, index) => {
    if (index === 0 && target.length) return;
    target.push(copyPoint(point));
  });
}

export async function calculateWaypointRoute({ session, destination, findPath }) {
  const controls = session.getControlPoints(destination);
  const points = [];
  const segments = [];
  let distance = 0;
  let snappedDestination = false;

  for (let index = 0; index < controls.length - 1; index += 1) {
    const route = await findPath(controls[index], controls[index + 1]);
    if (!route) {
      return { valid: false, failedSegmentIndex: index, controls, segments, points, distance };
    }
    appendRoutePoints(points, route.points);
    segments.push({
      index,
      from: copyPoint(controls[index]),
      to: copyPoint(controls[index + 1]),
      distance: route.distance,
      points: route.points.map(copyPoint),
      snappedDestination: Boolean(route.snappedDestination),
    });
    distance += route.distance;
    snappedDestination = Boolean(route.snappedDestination);
  }

  return {
    valid: true,
    controls,
    points,
    segments,
    distance,
    destination: points.at(-1) || copyPoint(destination),
    snappedDestination,
  };
}
