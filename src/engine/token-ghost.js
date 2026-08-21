function copyPoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

function safeColor(value, fallback = '#3d9b63') {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}

export function createTokenGhostDescriptor(character, point, { blocked = false } = {}) {
  if (!character || !point) return null;
  const name = String(character.name || '角色');
  const avatarDataUrl = typeof character.avatarDataUrl === 'string' && character.avatarDataUrl.startsWith('data:image/')
    ? character.avatarDataUrl
    : null;
  return Object.freeze({
    characterId: character.id,
    name,
    initial: (name.trim()[0] || '?').toUpperCase(),
    avatarDataUrl,
    color: safeColor(character.color),
    point: copyPoint(point),
    blocked: Boolean(blocked),
  });
}

export function isMovementEndpointLayer(options = {}) {
  return options.pane === 'measurePane'
    && Number(options.radius) === 9
    && options.interactive === false;
}
