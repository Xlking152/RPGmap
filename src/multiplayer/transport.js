export function parseTransportMessage(event) {
  try {
    return JSON.parse(String(event?.data ?? ''));
  } catch {
    return null;
  }
}

export function createOperationId(prefix = 'operation', cryptoLike = globalThis.crypto) {
  const value = cryptoLike?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

export function sendTransportMessage(socket, message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}
