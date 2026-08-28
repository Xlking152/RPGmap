function copyPoint(point) { return { x: Number(point.x), y: Number(point.y) }; }
function safeColor(value, fallback = '#3d9b63') { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback; }
export function createTokenGhostDescriptor(tokenView, point, { blocked = false, sizePixels = 42 } = {}) {
  if (!tokenView || !point) return null;
  const name = String(tokenView.name || '角色');
  const avatarDataUrl = typeof tokenView.avatarDataUrl === 'string' && tokenView.avatarDataUrl.startsWith('data:image/') ? tokenView.avatarDataUrl : null;
  return Object.freeze({ tokenId: tokenView.id, name, initial: (name.trim()[0] || '?').toUpperCase(), avatarDataUrl, color: safeColor(tokenView.color), point: copyPoint(point), blocked: Boolean(blocked), sizePixels: Number(sizePixels) || 42 });
}
export function isMovementEndpointLayer(options = {}) {
  return options.pane === 'measurePane' && Number(options.radius) === 9 && options.interactive === false;
}
