function copyPoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

export class MovementSession {
  constructor({ tokenId = null, start, arrival = null, movementType = 'walk', snapStep = 5 }) {
    this.tokenId = tokenId;
    this.start = copyPoint(start);
    this.waypoints = [];
    this.current = copyPoint(start);
    this.rawPointer = copyPoint(start);
    this.arrival = arrival;
    this.movementType = movementType;
    this.snapStep = Number(snapStep) || 5;
  }

  addWaypoint(point) {
    this.waypoints.push(copyPoint(point));
    this.current = copyPoint(point);
    return this.waypoints.length;
  }

  removeLastWaypoint() {
    const removed = this.waypoints.pop() || null;
    this.current = copyPoint(this.waypoints.at(-1) || this.start);
    return removed;
  }

  updateCurrent(point, rawPointer = point) {
    this.current = copyPoint(point);
    this.rawPointer = copyPoint(rawPointer);
  }

  updateRawPointer(point) {
    this.rawPointer = copyPoint(point);
  }

  setSnapStep(step) {
    this.snapStep = Number(step) || this.snapStep;
    return this.snapStep;
  }

  getControlPoints(destination = this.current) {
    return [this.start, ...this.waypoints, copyPoint(destination)];
  }
}
