function normalizeId(value) {
  if (value == null) return null;
  const id = String(value);
  return id || null;
}

export function tokenIdsInBounds(characters, start, end) {
  const minX = Math.min(Number(start?.x) || 0, Number(end?.x) || 0);
  const maxX = Math.max(Number(start?.x) || 0, Number(end?.x) || 0);
  const minY = Math.min(Number(start?.y) || 0, Number(end?.y) || 0);
  const maxY = Math.max(Number(start?.y) || 0, Number(end?.y) || 0);
  return (characters || [])
    .filter(character => character?.visible !== false && character?.location?.type === 'map')
    .filter(character => {
      const x = Number(character.location.x);
      const y = Number(character.location.y);
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    })
    .map(character => String(character.id));
}

export class TokenSelectionState {
  constructor() {
    this.ids = new Set();
    this.primaryId = null;
  }

  snapshot() {
    return { ids: [...this.ids], primaryId: this.primaryId };
  }

  has(id) {
    const value = normalizeId(id);
    return value ? this.ids.has(value) : false;
  }

  replace(ids, primaryId = null) {
    this.ids = new Set((ids || []).map(normalizeId).filter(Boolean));
    const preferred = normalizeId(primaryId);
    this.primaryId = preferred && this.ids.has(preferred) ? preferred : (this.ids.values().next().value || null);
    return this.snapshot();
  }

  add(ids, primaryId = null) {
    for (const id of ids || []) {
      const value = normalizeId(id);
      if (value) this.ids.add(value);
    }
    const preferred = normalizeId(primaryId);
    if (preferred && this.ids.has(preferred)) this.primaryId = preferred;
    else if (!this.primaryId) this.primaryId = this.ids.values().next().value || null;
    return this.snapshot();
  }

  remove(ids) {
    for (const id of ids || []) {
      const value = normalizeId(id);
      if (value) this.ids.delete(value);
    }
    if (this.primaryId && !this.ids.has(this.primaryId)) this.primaryId = this.ids.values().next().value || null;
    return this.snapshot();
  }

  toggle(id) {
    const value = normalizeId(id);
    if (!value) return this.snapshot();
    if (this.ids.has(value)) return this.remove([value]);
    return this.add([value], value);
  }

  clear() {
    this.ids.clear();
    this.primaryId = null;
    return this.snapshot();
  }
}
