const copy = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Each sheet window owns one ledger. Canonical values never replace dirty input.
export class SheetFieldDrafts {
  constructor() { this.fields = new Map(); }

  observe(key, canonical) {
    let field = this.fields.get(key);
    if (!field) {
      field = { canonical: copy(canonical), base: copy(canonical), value: copy(canonical), dirty: false, pending: false, conflict: false, error: '' };
      this.fields.set(key, field);
    } else {
      field.canonical = copy(canonical);
      if (!field.dirty && !field.pending) field.value = field.base = copy(canonical);
      else if (equal(canonical, field.value)) {
        field.dirty = false;
        field.conflict = false;
        field.base = copy(canonical);
      } else if (field.pending && equal(canonical, field.submitted)) {
        field.base = copy(canonical);
        field.conflict = false;
      } else field.conflict = !equal(canonical, field.base);
    }
    return this.get(key);
  }

  edit(key, value) {
    const field = this.fields.get(key);
    if (!field) throw new Error('Sheet field must have a canonical value before editing');
    field.value = copy(value);
    field.dirty = !equal(field.value, field.canonical);
    field.error = '';
    if (!field.dirty) field.conflict = false;
    return this.get(key);
  }

  begin(key) {
    const field = this.fields.get(key);
    if (!field || field.pending || field.conflict) return null;
    field.pending = true;
    field.submitted = copy(field.value);
    field.error = '';
    return { value: copy(field.value), expected: copy(field.base) };
  }

  settle(key, { success, error = '' } = {}) {
    const field = this.fields.get(key);
    if (!field) return;
    field.pending = false;
    if (success) {
      if (equal(field.value, field.submitted)) field.value = copy(field.canonical);
      field.base = copy(field.canonical);
      field.conflict = false;
    } else field.error = String(error || '保存失败');
    field.dirty = !equal(field.value, field.canonical);
    delete field.submitted;
    return this.get(key);
  }

  adopt(key) {
    const field = this.fields.get(key);
    if (!field || field.pending) return null;
    field.value = field.base = copy(field.canonical);
    field.dirty = field.conflict = false;
    field.error = '';
    return this.get(key);
  }

  retry(key) {
    const field = this.fields.get(key);
    if (!field || field.pending) return null;
    field.base = copy(field.canonical);
    field.conflict = false;
    field.error = '';
    return this.get(key);
  }

  get(key) { return this.fields.has(key) ? copy(this.fields.get(key)) : null; }
  notices() { return [...this.fields].filter(([, field]) => field.conflict || field.error).map(([key, field]) => ({ key, ...copy(field) })); }
  clear() { this.fields.clear(); }
}
