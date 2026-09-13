import { renderJournalMarkdown } from './markdown.js';

export function createJournalView(api) {
  const doc = api.map.getContainer().ownerDocument;
  const node = (tag, attributes = {}, text = null) => {
    const value = doc.createElement(tag);
    for (const [name, entry] of Object.entries(attributes)) {
      if (name === 'class') value.className = entry;
      else if (entry != null) value.setAttribute(name, String(entry));
    }
    if (text != null) value.textContent = text;
    return value;
  };
  const dialog = node('dialog', { class: 'journal-dialog', 'aria-label': 'World 资料页' });
  dialog.innerHTML = '<div class="journal-shell"><aside class="journal-index"><header><h2>资料页</h2><button type="button" data-add>新建</button></header><div class="journal-list"></div></aside><main class="journal-main"></main></div>';
  doc.body.append(dialog);
  const add = dialog.querySelector('[data-add]');
  const list = dialog.querySelector('.journal-list');
  const main = dialog.querySelector('.journal-main');
  let selectedId = null, generation = 0;
  const entries = () => api.journals.list().sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  const welcome = () => {
    generation++;
    main.replaceChildren(node('p', {}, api.journals.canEdit() ? '选择资料页，或新建页面。' : '选择可阅读的资料页。'));
  };

  function renderIndex() {
    const values = entries();
    add.hidden = !api.journals.canEdit();
    list.replaceChildren(...values.map(entry => {
      const button = node('button', { type: 'button', 'aria-current': entry.id === selectedId }, entry.title);
      button.onclick = () => { selectedId = entry.id; renderIndex(); show(entry); };
      return button;
    }));
    if (!values.length) list.append(node('p', {}, '暂无资料页'));
    if (selectedId && !values.some(entry => entry.id === selectedId)) { selectedId = null; welcome(); }
  }

  async function show(entry) {
    const current = ++generation;
    main.replaceChildren(node('p', {}, '正在读取正文...'));
    try {
      const loaded = await api.journals.read(entry);
      if (current !== generation) return;
      const header = node('header', { class: 'journal-head' });
      header.append(node('h2', {}, loaded.entry.title));
      const command = (label, action) => {
        const button = node('button', { type: 'button' }, label);
        button.onclick = action; header.append(button);
      };
      if (api.journals.canEdit()) command('编辑', () => edit(loaded.entry, loaded.body));
      command('关闭', () => dialog.close());
      const bodyNode = node('article', { class: 'journal-article' });
      bodyNode.innerHTML = renderJournalMarkdown(loaded.body.markdown);
      for (const reference of loaded.body.images || []) bodyNode.append(node('img', { 'data-content-ref': reference, alt: '' }));
      main.replaceChildren(header, bodyNode);
    } catch (error) {
      if (current === generation) main.replaceChildren(node('p', { class: 'journal-message' }, error.message));
    }
  }

  function edit(entry = null, body = { markdown: '', images: [] }) {
    generation++;
    const expected = entry ? structuredClone(entry) : null;
    const form = node('form', { class: 'journal-form' });
    const input = (tag, attributes, value = '') => {
      const control = node(tag, attributes); control.value = value || ''; return control;
    };
    const title = input('input', { maxlength: 240, required: '' }, entry?.title);
    const folder = input('input', { maxlength: 160 }, entry?.folder);
    const visibility = input('select', {}, entry?.visibility?.mode || 'gm');
    for (const [value, label] of [['gm', '仅 GM'], ['public', '公开'], ['party', '指定队伍'], ['users', '指定用户']]) {
      visibility.append(node('option', { value }, label));
    }
    visibility.value = entry?.visibility?.mode || 'gm';
    const party = input('input', { maxlength: 160, placeholder: 'party-default' }, entry?.partyId);
    const users = input('input', { placeholder: '以逗号分隔 User ID' }, (entry?.visibility?.userIds || []).join(', '));
    const markdown = input('textarea', { maxlength: 262144, placeholder: 'Markdown 正文（不支持原始 HTML 或内嵌图片语法）' }, body.markdown);
    const upload = input('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: '' });
    const images = [...(body.images || [])];
    const message = node('div', { class: 'journal-message', role: 'status' });
    const actions = node('div', { class: 'journal-actions' });
    const action = (label, type, handler) => {
      const button = node('button', { type }, label); if (handler) button.onclick = handler; actions.append(button); return button;
    };
    const save = action('保存', 'submit');
    action('取消', 'button', () => entry ? show(entry) : welcome());
    if (entry) action('删除', 'button', async () => {
      if (!doc.defaultView.confirm(`删除资料页“${entry.title}”？`)) return;
      try { await api.journals.remove(expected); selectedId = null; renderIndex(); welcome(); }
      catch (error) { message.textContent = error.message; }
    });
    const field = (label, control) => { const value = node('label'); value.append(node('span', {}, label), control); return value; };
    form.append(...[['标题', title], ['文件夹', folder], ['可见范围', visibility], ['队伍 ID', party], ['用户 ID', users],
      ['正文', markdown], ['添加图片', upload]].map(([label, control]) => field(label, control)), message, actions);
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true; message.textContent = '正在保存...';
      try {
        for (const file of upload.files || []) images.push((await api.content.putImage(file)).reference);
        const journal = { ...(entry || {}), id: entry?.id || `journal-${crypto.randomUUID()}`, title: title.value,
          folder: folder.value, visibility: { mode: visibility.value, userIds: users.value.split(',').map(value => value.trim()).filter(Boolean) },
          partyId: party.value.trim() || null };
        const saved = await api.journals.save({ entry: journal, markdown: markdown.value, images, expected });
        selectedId = saved.id; renderIndex(); await show(saved);
        api.showToast?.('资料页已保存', 'success');
      } catch (error) { message.textContent = error.message; save.disabled = false; }
    };
    main.replaceChildren(form); title.focus();
  }

  add.onclick = () => edit();
  const unsubscribe = api.on('state:commit', () => { if (dialog.open) renderIndex(); });
  return {
    open() {
      if (!dialog.open) dialog.showModal();
      renderIndex();
      const selected = entries().find(entry => entry.id === selectedId);
      selected ? show(selected) : welcome();
    },
    destroy() { unsubscribe?.(); dialog.remove(); },
  };
}
