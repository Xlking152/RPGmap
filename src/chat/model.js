function uid(prefix = 'log') {
  const value = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${value}`;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function createEmptyChatState() {
  return { schemaVersion: 1, messages: [] };
}

export function normalizeChatState(raw) {
  const messages = Array.isArray(raw?.messages) ? raw.messages.filter(Boolean).map(message => ({
    id: String(message.id || uid()),
    type: String(message.type || 'system'),
    author: text(message.author, ''),
    text: text(message.text, ''),
    createdAt: message.createdAt || new Date().toISOString(),
    data: message.data && typeof message.data === 'object' ? structuredClone(message.data) : {},
  })) : [];
  return { schemaVersion: 1, messages: messages.slice(-500) };
}

export function createChatMessage({ type = 'system', author = '', text: messageText = '', data = {} } = {}) {
  return {
    id: uid(type),
    type,
    author: text(author, ''),
    text: text(messageText, ''),
    createdAt: new Date().toISOString(),
    data: data && typeof data === 'object' ? structuredClone(data) : {},
  };
}

export function appendChatMessage(state, message) {
  state.messages ||= [];
  state.messages.push(message);
  if (state.messages.length > 500) state.messages.splice(0, state.messages.length - 500);
  return message;
}
