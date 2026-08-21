const MAP_LABEL_QUALIFIERS = Object.freeze([
  '（推定）',
  '（推测）',
  '（位置推定）',
  '（位置推测）',
  '（线位推测）',
  '〔推定〕',
  '〔推测〕',
  '〔位置推定〕',
  '〔位置推测〕',
  '〔线位推测〕',
]);

export function cleanMapDisplayText(value) {
  let text = String(value ?? '');
  for (const qualifier of MAP_LABEL_QUALIFIERS) text = text.replaceAll(qualifier, '');
  return text.replaceAll('推定院落', '院落');
}

export function cleanMapPackagePresentation(mapPackage) {
  if (!mapPackage || typeof mapPackage !== 'object') return mapPackage;
  const createSvg = typeof mapPackage.createSvg === 'function'
    ? (...args) => cleanMapDisplayText(mapPackage.createSvg(...args))
    : mapPackage.createSvg;
  const features = Array.isArray(mapPackage.features)
    ? mapPackage.features.map(feature => feature && typeof feature === 'object'
      ? { ...feature, name: cleanMapDisplayText(feature.name) }
      : feature)
    : mapPackage.features;
  return { ...mapPackage, features, createSvg };
}
