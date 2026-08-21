import { normalizeMovementStep, cycleMovementStep, recommendedMovementStepForMap } from './snap.js';

export class MovementSettings {
  constructor({ defaultStep = 5, autoStep = true } = {}) {
    this.defaultStep = normalizeMovementStep(defaultStep);
    this.step = this.defaultStep;
    this.autoStep = autoStep !== false;
    this.listeners = new Set();
    this.storageKey = null;
  }
  attach(api) {
    this.storageKey = (api.mapPackage?.id || 'rpg-map') + ':movement-step';
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored !== null) this.step = normalizeMovementStep(stored, this.step);
    } catch {}
    return this;
  }
  beginSession(map, mapPackage) {
    if (this.autoStep) this.setStep(recommendedMovementStepForMap(map, mapPackage, this.step), { persist: false, source: 'auto' });
    return this.step;
  }
  setStep(value, { persist = true, source = 'manual' } = {}) {
    const next = normalizeMovementStep(value, this.step);
    const changed = next !== this.step;
    this.step = next;
    if (persist && this.storageKey) {
      try { localStorage.setItem(this.storageKey, String(next)); } catch {}
    }
    if (changed || source === 'auto') {
      const event = Object.freeze({ step: next, source });
      this.listeners.forEach(listener => listener(event));
    }
    return next;
  }
  cycle(direction, options = {}) { return this.setStep(cycleMovementStep(this.step, direction), options); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
