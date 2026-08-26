function copyPoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

function appendRoutePoints(target, points) {
  if (!points?.length) return;
  points.forEach(point => {
    const next = copyPoint(point);
    const previous = target.at(-1);
    if (previous && previous.x === next.x && previous.y === next.y) return;
    target.push(next);
  });
}

export async function calculateWaypointRoute({ session, destination, findPath }) {
  const controls = session.getControlPoints(destination);
  const points = [];
  const segments = [];
  let distance = 0;

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
      routeType: 'direct',
    });
    distance += route.distance;
  }

  return {
    valid: true,
    controls,
    points,
    segments,
    distance,
    destination: points.at(-1) || copyPoint(destination),
    routeType: 'direct',
  };
}
