function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value), 'https://rpgmap.invalid/');
    return ['http:', 'https:'].includes(url.protocol) ? String(value) : '#';
  } catch { return '#'; }
}

function inline(value) {
  let result = escapeHtml(value);
  result = result.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  result = result.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, href) => `<a href="${escapeHtml(safeUrl(href))}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  return result;
}

export function renderJournalMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let list = false;
  const closeList = () => { if (list) { output.push('</ul>'); list = false; } };
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (item) {
      if (!list) { output.push('<ul>'); list = true; }
      output.push(`<li>${inline(item[1])}</li>`);
    } else if (!line.trim()) closeList();
    else { closeList(); output.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return output.join('');
}

