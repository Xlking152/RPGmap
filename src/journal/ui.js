import { renderJournalMarkdown } from './markdown.js';

function element(doc, tag, attributes = {}, text = null) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else if (value !== null && value !== undefined) node.setAttribute(name, String(value));
  }
  if (text !== null) node.textContent = text;
  return node;
}

export function createJournalView(api) {
  const doc = api.map.getContainer().ownerDocument;
  const dialog = element(doc, 'dialog', { className: 'journal-dialog', 'aria-label': 'World 资料页' });
  const style = element(doc, 'style');
  style.textContent = `
    .journal-dialog{width:min(900px,calc(100vw - 24px));height:min(680px,calc(100vh - 24px));padding:0;border:1px solid #82928d;background:#f5f7f4;color:#172623}
    .journal-dialog::backdrop{background:rgba(12,22,20,.52)}
    .journal-shell{display:grid;grid-template-columns:minmax(190px,260px) minmax(0,1fr);height:100%}
    .journal-index{border-right:1px solid #c3cfca;padding:12px;overflow:auto}.journal-index header,.journal-head{display:flex;align-items:center;gap:8px}
    .journal-index h2,.journal-head h2{font-size:16px;margin:0;flex:1}.journal-list{display:grid;gap:4px;margin-top:10px}
    .journal-list button{padding:8px;text-align:left;border:1px solid transparent;background:transparent;color:inherit;overflow-wrap:anywhere}
    .journal-list button[aria-current=true]{background:#dce8e2;border-color:#8ba69c}.journal-main{min-width:0;padding:14px;overflow:auto}
    .journal-form{display:grid;gap:10px}.journal-form label{display:grid;gap:4px;font-size:12px}.journal-form input,.journal-form select,.journal-form textarea{box-sizing:border-box;width:100%;padding:8px;border:1px solid #9aaba5;background:white;color:#172623}
    .journal-form textarea{min-height:280px;resize:vertical;font-family:ui-monospace,Consolas,monospace}.journal-actions{display:flex;gap:8px;flex-wrap:wrap}
    .journal-actions button,.journal-head button,.journal-index header button{min-height:34px;padding:6px 10px}.journal-message{min-height:20px;color:#8b2e28}
    .journal-article{line-height:1.58;overflow-wrap:anywhere}.journal-article img{max-width:100%;max-height:360px;display:block;object-fit:contain;margin:12px 0}
    @media(max-width:620px){.journal-shell{grid-template-columns:1fr;grid-template-rows:minmax(140px,32%) minmax(0,1fr)}.journal-index{border-right:0;border-bottom:1px solid #c3cfca}.journal-dialog{width:calc(100vw - 12px);height:calc(100vh - 12px)}}`;
  const shell = element(doc, 'div', { className: 'journal-shell' });
  const index = element(doc, 'aside', { className: 'journal-index' });
  const indexHeader = element(doc, 'header');
  const indexTitle = element(doc, 'h2', {}, '资料页');
  const add = element(doc, 'button', { type: 'button' }, '新建');
  const list = element(doc, 'div', { className: 'journal-list' });
  indexHeader.append(indexTitle, add); index.append(indexHeader, list);
  const main = element(doc, 'main', { className: 'journal-main' });
  shell.append(index, main); dialog.append(style, shell); doc.body.append(dialog);
  let selectedId = null;
  let generation = 0;

  const toast = (message, kind = 'error') => api.showToast?.(String(message), kind) || api.setStatus?.(String(message));
  const entries = () => api.journals.list().sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));

  function renderIndex() {
    const values = entries();
    add.hidden = !api.journals.canEdit();
    list.replaceChildren(...values.map(entry => {
      const button = element(doc, 'button', { type: 'button', 'aria-current': String(entry.id === selectedId) }, entry.title);
      button.addEventListener('click', () => { selectedId = entry.id; renderIndex(); show(entry); });
      return button;
    }));
    if (!values.length) list.append(element(doc, 'p', {}, '暂无资料页'));
    if (selectedId && !values.some(entry => entry.id === selectedId)) { selectedId = null; showWelcome(); }
  }

  function showWelcome() {
    generation++;
    main.replaceChildren(element(doc, 'p', {}, api.journals.canEdit() ? '选择资料页，或新建页面。' : '选择可阅读的资料页。'));
  }

  async function article(entry) {
    const current = ++generation;
    main.replaceChildren(element(doc, 'p', {}, '正在读取正文...'));
    try {
      const loaded = await api.journals.read(entry);
      if (current !== generation) return;
      const header = element(doc, 'header', { className: 'journal-head' });
      header.append(element(doc, 'h2', {}, loaded.entry.title));
      if (api.journals.canEdit()) {
        const edit = element(doc, 'button', { type: 'button' }, '编辑');
        edit.addEventListener('click', () => editor(loaded.entry, loaded.body)); header.append(edit);
      }
      const close = element(doc, 'button', { type: 'button' }, '关闭');
      close.addEventListener('click', () => dialog.close()); header.append(close);
      const body = element(doc, 'article', { className: 'journal-article' });
      body.innerHTML = renderJournalMarkdown(loaded.body.markdown);
      for (const reference of loaded.body.images || []) {
        body.append(element(doc, 'img', { 'data-content-ref': reference, alt: '' }));
      }
      main.replaceChildren(header, body);
    } catch (error) { if (current === generation) main.replaceChildren(element(doc, 'p', { className: 'journal-message' }, error.message)); }
  }

  function editor(entry = null, body = { markdown: '', images: [] }) {
    generation++;
    const expected = entry ? structuredClone(entry) : null;
    const form = element(doc, 'form', { className: 'journal-form' });
    const title = element(doc, 'input', { maxlength: 240, required: '' }); title.value = entry?.title || '';
    const folder = element(doc, 'input', { maxlength: 160 }); folder.value = entry?.folder || '';
    const visibility = element(doc, 'select');
    for (const [value, label] of [['gm', '仅 GM'], ['public', '公开'], ['party', '指定队伍'], ['users', '指定用户']]) {
      const option = element(doc, 'option', { value }, label); option.selected = value === (entry?.visibility?.mode || 'gm'); visibility.append(option);
    }
    const party = element(doc, 'input', { maxlength: 160, placeholder: 'party-default' }); party.value = entry?.partyId || '';
    const users = element(doc, 'input', { placeholder: '以逗号分隔 User ID' }); users.value = (entry?.visibility?.userIds || []).join(', ');
    const markdown = element(doc, 'textarea', { maxlength: 262144, placeholder: 'Markdown 正文（不支持原始 HTML 或内嵌图片语法）' }); markdown.value = body.markdown || '';
    const imageInput = element(doc, 'input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: '' });
    const images = [...(body.images || [])];
    const message = element(doc, 'div', { className: 'journal-message', role: 'status' });
    const actions = element(doc, 'div', { className: 'journal-actions' });
    const save = element(doc, 'button', { type: 'submit' }, '保存');
    const cancel = element(doc, 'button', { type: 'button' }, '取消'); cancel.addEventListener('click', () => entry ? article(entry) : showWelcome());
    actions.append(save, cancel);
    if (entry) {
      const remove = element(doc, 'button', { type: 'button' }, '删除');
      remove.addEventListener('click', async () => {
        if (!doc.defaultView.confirm(`删除资料页“${entry.title}”？`)) return;
        try { await api.journals.remove(expected); selectedId = null; renderIndex(); showWelcome(); }
        catch (error) { message.textContent = error.message; }
      }); actions.append(remove);
    }
    const labeled = (label, input) => { const node = element(doc, 'label'); node.append(element(doc, 'span', {}, label), input); return node; };
    form.append(labeled('标题', title), labeled('文件夹', folder), labeled('可见范围', visibility), labeled('队伍 ID', party), labeled('用户 ID', users),
      labeled('正文', markdown), labeled('添加图片', imageInput), message, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; message.textContent = '正在保存...';
      try {
        for (const file of imageInput.files || []) images.push((await api.content.putImage(file)).reference);
        const journal = {
          ...(entry || {}), id: entry?.id || `journal-${crypto.randomUUID()}`, title: title.value,
          folder: folder.value, visibility: { mode: visibility.value, userIds: users.value.split(',').map(value => value.trim()).filter(Boolean) },
          partyId: party.value.trim() || null,
        };
        const saved = await api.journals.save({ entry: journal, markdown: markdown.value, images, expected });
        selectedId = saved.id; renderIndex(); await article(saved); toast('资料页已保存', 'success');
      } catch (error) { message.textContent = error.message; save.disabled = false; }
    });
    main.replaceChildren(form); title.focus();
  }

  function show(entry) { return article(entry); }
  add.addEventListener('click', () => editor());
  const unsubscribe = api.on('state:commit', () => { if (dialog.open) renderIndex(); });
  return {
    open() { if (!dialog.open) dialog.showModal(); renderIndex(); const values = entries(); if (selectedId) show(values.find(entry => entry.id === selectedId)); else showWelcome(); },
    destroy() { unsubscribe?.(); dialog.remove(); },
  };
}

