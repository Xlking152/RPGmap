import { MovementSession } from './movement-path.js';

function copyPoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

export const TokenDragPhase = Object.freeze({
  IDLE: 'idle',
  DRAGGING: 'dragging',
  PLANNING: 'planning',
  READY: 'ready',
  MOVING: 'moving',
});

export class TokenDragPlan {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = TokenDragPhase.IDLE;
    this.pointerId = null;
    this.characterId = null;
    this.session = null;
    this.current = null;
    this.route = null;
    this.startClient = null;
    return this;
  }

  begin({ characterId, start, pointerId = null, client = null }) {
    this.phase = TokenDragPhase.DRAGGING;
    this.pointerId = pointerId;
    this.characterId = characterId;
    this.session = new MovementSession({ characterId, start });
    this.current = copyPoint(start);
    this.route = null;
    this.startClient = client ? { x: Number(client.x), y: Number(client.y) } : null;
    return this;
  }

  update(point, route = this.route) {
    if (!this.session) return false;
    this.current = copyPoint(point);
    this.session.updateCurrent(point);
    this.route = route;
    return true;
  }

  setRoute(route) {
    this.route = route || null;
    return this.route;
  }

  addWaypoint(point = this.route?.destination || this.current) {
    if (!this.session || !point) return false;
    this.session.addWaypoint(point);
    this.current = copyPoint(point);
    this.route = null;
    this.phase = TokenDragPhase.PLANNING;
    return true;
  }

  removeWaypoint() {
    if (!this.session?.waypoints.length) return null;
    const removed = this.session.removeLastWaypoint();
    this.current = copyPoint(this.session.current);
    this.route = null;
    if (this.phase === TokenDragPhase.READY) this.phase = TokenDragPhase.PLANNING;
    return removed;
  }

  continuePlanning() {
    if (!this.session) return false;
    this.phase = TokenDragPhase.PLANNING;
    return true;
  }

  ready(route = this.route) {
    if (!this.session || !route?.valid) return false;
    this.route = route;
    this.current = copyPoint(route.destination);
    this.session.updateCurrent(route.destination);
    this.phase = TokenDragPhase.READY;
    return true;
  }

  startMoving() {
    if (this.phase !== TokenDragPhase.READY || !this.route?.valid) return false;
    this.phase = TokenDragPhase.MOVING;
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

  get active() {
    return this.phase !== TokenDragPhase.IDLE;
  }
}
