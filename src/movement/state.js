import { MovementSession } from './session.js';

function copyPoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

export const MovementPhase = Object.freeze({
  IDLE: 'idle', DRAGGING: 'dragging', PLANNING: 'planning', READY: 'ready', MOVING: 'moving',
});
export const TokenDragPhase = MovementPhase;

export class TokenDragPlan {
  constructor() { this.reset(); }
  reset() {
    this.phase = MovementPhase.IDLE;
    this.pointerId = null;
    this.tokenId = null;
    this.session = null;
    this.current = null;
    this.route = null;
    this.startClient = null;
    return this;
  }
  begin({ tokenId = null, start, pointerId = null, client = null, snapStep = 5 }) {
    this.phase = MovementPhase.DRAGGING;
    this.pointerId = pointerId;
    this.tokenId = tokenId;
    this.session = new MovementSession({ tokenId, start, snapStep });
    this.current = copyPoint(start);
    this.route = null;
    this.startClient = client ? { x: Number(client.x), y: Number(client.y) } : null;
    return this;
  }
  update(point, route = this.route, rawPointer = point) {
    if (!this.session) return false;
    this.current = copyPoint(point);
    this.session.updateCurrent(point, rawPointer);
    this.route = route;
    return true;
  }
  setRoute(route) { this.route = route || null; return this.route; }
  addWaypoint(point = this.route?.destination || this.current) {
    if (!this.session || !point) return false;
    if (this.phase === MovementPhase.DRAGGING) {
      this.current = copyPoint(point);
      this.route = null;
      this.phase = MovementPhase.PLANNING;
      return false;
    }
    this.session.addWaypoint(point);
    this.current = copyPoint(point);
    this.route = null;
    this.phase = MovementPhase.PLANNING;
    return true;
  }
  removeWaypoint() {
    if (!this.session?.waypoints.length) return null;
    const removed = this.session.removeLastWaypoint();
    this.current = copyPoint(this.session.current);
    this.route = null;
    if (this.phase === MovementPhase.READY) this.phase = MovementPhase.PLANNING;
    return removed;
  }
  continuePlanning() {
    if (!this.session) return false;
    this.phase = MovementPhase.PLANNING;
    return true;
  }
  ready(route = this.route) {
    if (!this.session || !route?.valid) return false;
    this.route = route;
    this.current = copyPoint(route.destination);
    this.session.updateCurrent(route.destination, this.session.rawPointer);
    this.phase = MovementPhase.READY;
    return true;
  }
  startMoving() {
    if (this.phase !== MovementPhase.READY || !this.route?.valid) return false;
    this.phase = MovementPhase.MOVING;
    return true;
  }
  movementTargets() {
    if (!this.session || !this.route?.valid) return [];
    return [...this.session.waypoints.map(copyPoint), copyPoint(this.route.destination)];
  }
  draggedPixels(client) {
    if (!this.startClient || !client) return 0;
    return Math.hypot(Number(client.x) - this.startClient.x, Number(client.y) - this.startClient.y);
  }
  get active() { return this.phase !== MovementPhase.IDLE; }
}
