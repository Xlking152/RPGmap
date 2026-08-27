function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

/** Normalize any imported Character-era anchor into the World V2 Token form. */
export function canonicalAttackAreaAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return clone(anchor);
  if (anchor.type === 'character' && anchor.characterId != null) {
    return { type: 'token', tokenId: String(anchor.characterId) };
  }
  if (anchor.type === 'token' && anchor.tokenId != null) {
    return { type: 'token', tokenId: String(anchor.tokenId) };
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

/**
 * SaveV2/AppCore still parses `character` anchors. Translate only while
 * projecting the canonical Scene into that legacy flat serialization shell.
 */
export function legacyRuntimeAttackAreas(areas) {
  return array(areas).map(raw => {
    const area = clone(raw);
    if (!area || typeof area !== 'object' || Array.isArray(area)) return area;
    const anchor = area.anchor;
    if (anchor?.type === 'token' && anchor.tokenId != null) {
      area.anchor = { type: 'character', characterId: String(anchor.tokenId) };
    }
    return area;
  });
}
