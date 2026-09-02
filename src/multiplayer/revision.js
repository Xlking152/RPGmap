export function hasWorldOperationRevisionGap(message, currentRevision) {
  const baseRevision = message?.baseRevision;
  const nextRevision = message?.revision;
  return !Number.isSafeInteger(baseRevision)
    || !Number.isSafeInteger(nextRevision)
    || !Number.isSafeInteger(currentRevision)
    || baseRevision !== currentRevision
    || nextRevision !== baseRevision + 1;
}

export function shouldApplyOwnServerSnapshot(message) {
  const reason = String(message?.reason || '');
  return reason === 'chat.append' || reason === 'chat.clear';
}
