const CONTROL = 'input:not([type="file"]),textarea,select';
const isControl = node => Boolean(node?.matches?.(CONTROL));

export function readSheetControl(node) {
  if (['checkbox', 'radio'].includes(node.type)) return Boolean(node.checked);
  if (node.multiple) return [...node.selectedOptions].map(option => option.value);
  return String(node.value ?? '');
}

export function writeSheetControl(node, value) {
  if (['checkbox', 'radio'].includes(node.type)) { if (node.checked !== value) node.checked = Boolean(value); }
  else if (node.multiple) {
    for (const option of node.options) option.selected = Array.isArray(value) && value.includes(option.value);
  } else if (node.value !== String(value ?? '')) node.value = String(value ?? '');
}

export function sheetControlKey(node) {
  if (!isControl(node)) return null;
  const attrs = [...node.attributes].filter(attr => (attr.name.startsWith('data-') && !['data-sheet-field-key', 'data-sheet-field-state'].includes(attr.name))
    || ['name', 'id', 'type'].includes(attr.name)).map(attr => [attr.name, attr.value]);
  if (!attrs.length) return null;
  if (['checkbox', 'radio'].includes(node.type)) attrs.push(['value', node.value]);
  const section = node.closest('[data-sheet-section-id]')?.dataset.sheetSectionId || '';
  const token = node.closest('[data-token-id]')?.dataset.tokenId || '';
  return JSON.stringify([token, section, node.tagName, attrs.sort(([a], [b]) => a.localeCompare(b))]);
}

function nodeKey(node) {
  if (node.nodeType !== 1) return null;
  if (isControl(node)) return sheetControlKey(node);
  for (const name of ['data-sheet-section-id', 'data-actor-id', 'data-token-id', 'data-sheet-tab', 'data-status-id', 'data-sheet-part']) {
    if (node.hasAttribute(name)) return `${node.tagName}:${name}:${node.getAttribute(name)}`;
  }
  if (node.tagName === 'LABEL') return sheetControlKey(node.querySelector(CONTROL));
  return null;
}

function synchronizeAttributes(current, incoming) {
  for (const { name } of [...current.attributes]) {
    if (name.startsWith('data-sheet-field-') || (name === 'open' && current.tagName === 'DETAILS')) continue;
    if (!incoming.hasAttribute(name)) current.removeAttribute(name);
  }
  for (const { name, value } of [...incoming.attributes]) {
    if (name === 'open' && current.tagName === 'DETAILS') continue;
    if (current.getAttribute(name) !== value) current.setAttribute(name, value);
  }
}

function seedFields(root, drafts) {
  if (!drafts) return;
  const controls = [...(isControl(root) ? [root] : []), ...root.querySelectorAll(CONTROL)];
  for (const control of controls) {
    const key = sheetControlKey(control);
    if (!key) continue;
    const field = drafts.observe(key, readSheetControl(control));
    control.dataset.sheetFieldKey = key;
    writeSheetControl(control, field.value);
  }
}

// Reuse keyed elements in place, including focused controls and open details.
export function reconcileSheetNode(current, incoming, { drafts = null } = {}) {
  if (current.nodeType !== incoming.nodeType || current.nodeName !== incoming.nodeName) throw new Error('Sheet reconciliation requires matching nodes');
  if (current.nodeType !== 1) {
    if (current.nodeValue !== incoming.nodeValue) current.nodeValue = incoming.nodeValue;
    return current;
  }
  const key = isControl(current) ? sheetControlKey(incoming) : null;
  const canonical = key ? readSheetControl(incoming) : undefined;
  const field = drafts && key ? drafts.observe(key, canonical) : null;
  synchronizeAttributes(current, incoming);
  if (!isControl(current) || current.tagName === 'SELECT') {
    const previous = [...current.childNodes];
    const keyed = new Map(previous.map(node => [nodeKey(node), node]).filter(([id]) => id));
    const used = new Set();
    let cursor = current.firstChild;
    for (const next of [...incoming.childNodes]) {
      const id = nodeKey(next);
      let candidate = id ? keyed.get(id) : cursor;
      if (candidate && (used.has(candidate) || candidate.nodeName !== next.nodeName || nodeKey(candidate) !== id)) candidate = null;
      if (!candidate) {
        candidate = next;
        current.insertBefore(candidate, cursor);
        if (candidate.nodeType === 1) seedFields(candidate, drafts);
      } else {
        if (candidate !== cursor) current.insertBefore(candidate, cursor);
        reconcileSheetNode(candidate, next, { drafts });
      }
      used.add(candidate);
      cursor = candidate.nextSibling;
    }
    for (const node of previous) if (!used.has(node)) node.remove();
  }
  if (key) {
    current.dataset.sheetFieldKey = key;
    writeSheetControl(current, field ? field.value : canonical);
    current.dataset.sheetFieldState = field?.conflict ? 'conflict' : field?.pending ? 'pending' : field?.dirty ? 'draft' : 'confirmed';
  }
  return current;
}

export function initializeSheetFields(root, drafts) { seedFields(root, drafts); }
