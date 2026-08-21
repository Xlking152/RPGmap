function copyPoint(point) {
  return point ? { x: Number(point.x), y: Number(point.y) } : null;
}

export class RulerSession {
  constructor() { this.reset(); }

  reset() {
    this.origin = null;
    this.waypoints = [];
    this.current = null;
    this.finished = false;
    return this;
  }

  begin(point) {
    const start = copyPoint(point);
    if (!start) return false;
    this.origin = start;
    this.waypoints = [];
    this.current = start;
    this.finished = false;
    return true;
  }

  update(point) {
    if (!this.origin) return false;
    this.current = copyPoint(point);
    this.finished = false;
    return true;
  }

  addWaypoint(point = this.current) {
    if (!this.origin || !point) return false;
    const next = copyPoint(point);
    const previous = this.waypoints.at(-1) || this.origin;
    if (previous.x === next.x && previous.y === next.y) return false;
    this.waypoints.push(next);
    this.current = next;
    this.finished = false;
    return true;
  }

  removeWaypoint() {
    if (!this.waypoints.length) return null;
    const removed = this.waypoints.pop();
    this.current = copyPoint(this.waypoints.at(-1) || this.origin);
    this.finished = false;
    return removed;
  }

  finish(point = this.current) {
    if (!this.origin || !point) return false;
    this.current = copyPoint(point);
    this.finished = true;
    return true;
  }

  get points() {
    if (!this.origin) return [];
    const points = [copyPoint(this.origin), ...this.waypoints.map(copyPoint)];
    const last = points.at(-1);
    if (this.current && (!last || last.x !== this.current.x || last.y !== this.current.y)) points.push(copyPoint(this.current));
    return points;
  }

  get active() { return Boolean(this.origin); }
}
