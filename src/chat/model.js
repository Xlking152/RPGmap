const MAX_MESSAGES = 500;

function uid(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${value}`;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function safeData(value) {
  if (value == null) return null;
  try { return structuredClone(value); }
  catch { return null; }
}

export function createEmptyChatState() {
  return { schemaVersion: 1, messages: [] };
}

export function normalizeChatState(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyChatState();
  const messages = Array.isArray(raw.messages) ? raw.messages.filter(Boolean).slice(-MAX_MESSAGES).map(item => ({
    id: String(item.id || uid('message')),
    type: ['chat', 'system', 'combat', 'damage', 'roll'].includes(item.type) ? item.type : 'system',
    text: text(item.text),
    createdAt: Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : new Date().toISOString(),
    data: safeData(item.data),
  })) : [];
  return { schemaVersion: 1, messages };
}

export function appendMessage(state, { type = 'system', text: message = '', data = null } = {}) {
  const item = {
    id: uid('message'),
    type: ['chat', 'system', 'combat', 'damage', 'roll'].includes(type) ? type : 'system',
    text: text(message),
    createdAt: new Date().toISOString(),
    data: safeData(data),
  };
  state.messages ||= [];
  state.messages.push(item);
  if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  return item;
}

export function clearMessages(state) {
  state.messages = [];
  return state;
}
