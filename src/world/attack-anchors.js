function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

export function canonicalAttackAreaAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return clone(anchor);
  if (anchor.type === 'character' || anchor.characterId !== undefined) {
    const error = new Error('Character attack-area anchors are migration-only; use { type: "token", tokenId }');
    error.code = 'legacy_character_anchor_forbidden';
    throw error;
  }
  if (anchor.type === 'token') {
    const tokenId = String(anchor.tokenId ?? '').trim();
    if (!tokenId) throw new Error('Token attack-area anchor requires tokenId');
    return { type: 'token', tokenId };
  }
  return clone(anchor);
}

export function canonicalAttackAreas(areas) {
  return array(areas).map(raw => {
    const area = clone(raw);
    if (area && typeof area === 'object' && !Array.isArray(area)) {
      area.anchor = canonicalAttackAreaAnchor(area.anchor);
    }
    return area;
  });
}
