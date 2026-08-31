export function nextTokenInstanceName(tokens = [], actor = {}) {
  const base = String(actor?.name || 'Token').trim() || 'Token';
  const actorId = String(actor?.id || '');
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  const used = new Set((Array.isArray(tokens) ? tokens : []).flatMap(token => {
    if (String(token?.actorId || '') !== actorId) return [];
    const match = pattern.exec(String(token?.name || ''));
    return match ? [Number(match[1])] : [];
  }));
  let suffix = 1;
  while (used.has(suffix)) suffix += 1;
  return `${base}${suffix}`;
}
