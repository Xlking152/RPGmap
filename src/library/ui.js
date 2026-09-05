import { createElement, X, Copy, Archive, ArchiveRestore, Download, Upload, Star, Trash2, Pencil, Save, FileInput } from 'lucide';

export function createLibraryView(api, { gm }) {
  const doc = api.map.getContainer().ownerDocument;
  const dialog = doc.createElement('dialog');
  dialog.dataset.libraryDialog = 'true';
  dialog.style.cssText = 'width:760px;max-width:calc(100vw - 24px);max-height:85vh;box-sizing:border-box;padding:16px;border:1px solid #aab8b6;border-radius:6px;color:#253b39;background:#fff';
  dialog.innerHTML = `<style>
    [data-library-dialog]{font-size:14px;letter-spacing:0}
    [data-library-dialog] [role=tab]{flex:1;height:32px;border:1px solid #cbd6d0;border-radius:4px;background:#f4f7f5}
    [data-library-dialog] [aria-selected=true]{background:#e0eee8;border-color:#558477;color:#214d40;font-weight:600}
    [data-library-dialog] input:not([type=checkbox]),[data-library-dialog] select{min-height:32px;border:1px solid #bdccc4;border-radius:4px;padding:4px 6px}
    [data-library-dialog] button{cursor:pointer}
    [data-library-dialog] button:disabled{cursor:wait;opacity:.55}
    [data-library-dialog] button:focus-visible{outline:2px solid #397783;outline-offset:2px}
    [data-library-dialog] [data-library-conflict] button{margin:8px 8px 0 0;padding:5px 8px}
  </style><header style="display:flex;align-items:center;justify-content:space-between"><h2 style="font-size:18px;margin:0">模板与图片资料库</h2><span data-close></span></header>
    <div role="tablist" style="display:flex;gap:4px;margin:12px 0"><button type="button" role="tab" data-tab="actors">模板</button><button type="button" role="tab" data-tab="library">资料库</button><button type="button" role="tab" data-tab="assets">图片</button></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="search" data-search aria-label="搜索名称或标签" placeholder="名称或标签" style="flex:1;min-width:120px;width:120px"><select data-type aria-label="类型"><option value="">全部类型</option><option value="pc">PC</option><option value="monster">怪物</option><option value="npc">NPC</option><option value="summon">召唤物</option><option value="other">其他</option></select><select data-sort aria-label="排序"><option value="name">名称</option><option value="type">类型</option><option value="favorite">收藏优先</option></select></div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:10px 0"><label><input type="checkbox" data-archived> 显示归档</label><label><input type="checkbox" data-favorites> 仅收藏</label><span data-upload></span><span data-package-control></span></div>
    <p role="status" data-status style="overflow-wrap:anywhere;margin:8px 0;min-height:20px"></p>
    <div data-list style="max-height:44vh;overflow:auto"></div><section data-detail hidden style="border-top:1px solid #ccd6d1;margin-top:12px;padding-top:12px"></section>`;
  doc.body.append(dialog);
  const status = dialog.querySelector('[data-status]'), list = dialog.querySelector('[data-list]'), detail = dialog.querySelector('[data-detail]');
  const key = `rpgmap:library-ui:${api.getState().preferences.worldV2.id}`;
  let preferences = { favorites: [], sort: 'name' };
  try { preferences = { ...preferences, ...JSON.parse(doc.defaultView.localStorage.getItem(key) || '{}') }; } catch {}
  if (!Array.isArray(preferences.favorites)) preferences.favorites = [];
  let tab = 'actors', records = [], epoch = 0, previewUrl, pending = false, scheduled = false;
  const nodes = new Map();
  const drafts = new Map();
  let rememberDetail = () => {};
  const writePreferences = () => { try { doc.defaultView.localStorage.setItem(key, JSON.stringify(preferences)); } catch {} };
  const button = (icon, label, action) => {
    const value = doc.createElement('button');
    value.type = 'button'; value.title = label; value.setAttribute('aria-label', label);
    value.style.cssText = 'width:30px;height:30px;padding:5px;flex:0 0 30px;border:1px solid #cad5cf;border-radius:4px;background:#fff;color:#314e48';
    value.append(createElement(icon, { width: 18, height: 18, 'aria-hidden': true }));
    value.addEventListener('click', action); return value;
  };
  const message = value => { status.textContent = String(value || ''); };
  const errors = {
    content_in_use: '仍有 World、正文或备份引用，不能删除。', document_field_conflict: '服务器记录已变化，输入已保留。',
    library_gm_only: '只有 GM 可以管理资料库。', template_ruleset_incompatible: '模板与当前 World 的规则包版本不一致。',
    library_world_changed: 'World 已切换，请重新选择模板。', archive_content_hash_mismatch: '模板包内容校验失败，未导入。',
  };
  const run = async action => {
    if (pending) return;
    pending = true; message('提交中'); dialog.setAttribute('aria-busy', 'true');
    try { if (!gm()) throw new Error('library_gm_only'); await action(); message(detail.querySelector('[data-dirty="true"]') ? '已确认；标签有未提交修改' : '已确认'); await refresh(); }
    catch (error) {
      message(errors[error.code || error.message] || `操作失败：${error.message}`);
      if ((error.code || error.message) === 'document_field_conflict') {
        const conflict = detail.querySelector('[data-library-conflict]'); if (conflict) conflict.hidden = false;
      }
    }
    finally { pending = false; dialog.removeAttribute('aria-busy'); }
  };
  const clearDetail = () => { rememberDetail(); rememberDetail = () => {}; epoch++; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; detail.replaceChildren(); detail.hidden = true; };
  const close = () => { clearDetail(); dialog.close(); };
  dialog.querySelector('[data-close]').append(button(X, '关闭', close));
  dialog.addEventListener('cancel', clearDetail);
  const file = doc.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.hidden = true;
  dialog.append(file);
  dialog.querySelector('[data-upload]').append(button(Upload, '上传图片', () => file.click()));
  file.addEventListener('change', () => { const blob = file.files?.[0]; file.value = ''; if (blob) run(() => api.content.putImage(blob)); });
  const packageFile = doc.createElement('input'); packageFile.type = 'file'; packageFile.accept = '.zip,application/zip'; packageFile.hidden = true;
  dialog.append(packageFile);
  dialog.querySelector('[data-package-control]').append(button(Upload, '导入模板包', () => packageFile.click()));
  packageFile.addEventListener('change', () => {
    const selected = packageFile.files?.[0]; packageFile.value = '';
    if (!selected) return;
    run(async () => {
      const preview = await api.library.previewPackage(selected);
      clearDetail(); detail.hidden = false;
      const summary = doc.createElement('p'); summary.style.overflowWrap = 'anywhere';
      summary.textContent = `${preview.name} · ${preview.imageCount} 张图片。${preview.conflicts.length ? `冲突定义：${preview.conflicts.join('、')}；将重映射为新 ID。` : '依赖无冲突。'}`;
      detail.append(summary, button(Upload, '确认导入模板包', () => run(async () => { await api.library.importPackage(preview); clearDetail(); })));
    });
  });
  const favoriteKey = record => `${tab}:${record.id}`;
  const isFavorite = record => preferences.favorites.includes(favoriteKey(record));
  const actorWorld = () => api.getState().preferences.worldV2;
  const tagsOf = value => Array.isArray(value?.tags) ? value.tags : [];
  const toggleFavorite = record => {
    const id = favoriteKey(record);
    preferences.favorites = isFavorite(record) ? preferences.favorites.filter(value => value !== id) : [...preferences.favorites, id];
    writePreferences(); render();
  };

  function render() {
    const query = dialog.querySelector('[data-search]').value.trim().toLocaleLowerCase();
    const type = dialog.querySelector('[data-type]').value;
    const archived = dialog.querySelector('[data-archived]').checked;
    const favorites = dialog.querySelector('[data-favorites]').checked;
    const values = records.filter(record => (!type || tab === 'assets' || record.type === type)
      && (archived || !(record.archived || record.organization?.archived))
      && (!favorites || isFavorite(record))
      && `${record.name || record.id} ${tagsOf(tab === 'actors' ? record.organization : record).join(' ')}`.toLocaleLowerCase().includes(query));
    values.sort((a, b) => (preferences.sort === 'favorite' ? Number(isFavorite(b)) - Number(isFavorite(a)) : 0)
      || (preferences.sort === 'type' ? String(a.type).localeCompare(String(b.type)) : 0)
      || String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'));
    const retained = new Set();
    let cursor = list.firstChild;
    for (const record of values) {
      retained.add(record.id);
      let row = nodes.get(record.id);
      if (!row) {
        row = doc.createElement('div'); row.dataset.libraryId = record.id;
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #e0e7e3';
        const name = doc.createElement('button'); name.type = 'button'; name.style.cssText = 'min-width:0;flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px;border:0;background:transparent;color:inherit';
        name.addEventListener('click', () => show(records.find(value => value.id === row.dataset.libraryId)));
        row.append(name, button(Star, '收藏', () => toggleFavorite(records.find(value => value.id === row.dataset.libraryId)))) ;
        nodes.set(record.id, row);
      }
      const name = tab === 'assets' ? `${record.type} · ${record.width} × ${record.height} · ${Math.ceil(record.size / 1024)} KiB` : record.name;
      if (row.firstChild.textContent !== name) row.firstChild.textContent = name;
      row.firstChild.title = name;
      row.lastChild.setAttribute('aria-pressed', String(isFavorite(record)));
      row.lastChild.style.color = isFavorite(record) ? '#996411' : '#314e48';
      if (row !== cursor) list.insertBefore(row, cursor);
      cursor = row.nextSibling;
    }
    for (const [id, row] of nodes) if (!retained.has(id)) { row.remove(); nodes.delete(id); }
    if (!values.length) { const empty = doc.createElement('p'); empty.textContent = '暂无记录'; empty.dataset.empty = ''; list.append(empty); }
    list.querySelectorAll('[data-empty]').forEach((node, index, all) => { if (values.length || index < all.length - 1) node.remove(); });
  }

  async function refresh() {
    if (!gm()) { close(); return; }
    const currentTab = tab;
    const values = tab === 'assets' ? (await api.content.list()).filter(record => (record.kind || 'asset') === 'asset')
      : tab === 'library' ? api.library.list() : actorWorld().actors;
    if (tab !== currentTab || !dialog.open) return;
    records = values; render();
  }

  function show(record) {
    if (!record) return;
    clearDetail(); detail.hidden = false;
    const requestEpoch = epoch;
    const heading = doc.createElement('h3'); heading.style.cssText = 'font-size:15px;margin:0 0 8px;overflow-wrap:anywhere'; heading.textContent = record.name || record.id;
    const commands = doc.createElement('div'); commands.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
    detail.append(heading, commands);
    if (tab === 'assets') {
      const img = doc.createElement('img'); img.alt = ''; img.style.cssText = 'display:block;width:100%;height:120px;object-fit:contain;margin:10px 0'; detail.append(img);
      const refs = doc.createElement('p'); refs.style.overflowWrap = 'anywhere'; detail.append(refs);
      api.content.get(record.reference).then(blob => { if (epoch === requestEpoch && gm()) { previewUrl = URL.createObjectURL(blob); img.src = previewUrl; } }).catch(error => message(error.message));
      api.content.references(record.reference).then(value => { if (epoch === requestEpoch) refs.textContent = `当前 World 引用：${value.count}`; }).catch(error => message(error.message));
      commands.append(button(Trash2, '删除未引用图片', () => {
        if (doc.defaultView.confirm('删除这张图片？仍被引用的内容不会删除。')) run(async () => { await api.content.remove(record.reference); clearDetail(); });
      }));
      return;
    }
    const recordTab = tab, draftKey = `${recordTab}:${record.id}`, draft = drafts.get(draftKey);
    if (draft) record = draft.record;
    let organization = recordTab === 'actors' ? record.organization || {} : record, lastPatch = draft?.lastPatch;
    const tags = doc.createElement('input'); tags.type = 'text'; tags.value = tagsOf(organization).join(', ');
    if (draft) tags.value = draft.text;
    tags.setAttribute('aria-label', '标签'); tags.placeholder = '标签，以逗号分隔'; tags.style.cssText = 'min-width:100px;flex:1;width:140px;padding:6px';
    const parsedTags = () => [...new Set(tags.value.split(/[,，]/).map(value => value.trim()).filter(Boolean))];
    const markDraft = () => { tags.dataset.dirty = String(JSON.stringify(parsedTags()) !== JSON.stringify(tagsOf(organization))); };
    tags.addEventListener('input', markDraft);
    const conflict = doc.createElement('div'); conflict.dataset.libraryConflict = ''; conflict.hidden = !draft?.conflict; detail.append(conflict);
    rememberDetail = () => {
      markDraft();
      if (tags.dataset.dirty === 'true' || !conflict.hidden) drafts.set(draftKey, { record: structuredClone(record), text: tags.value,
        start: tags.selectionStart, end: tags.selectionEnd, conflict: !conflict.hidden, lastPatch });
      else drafts.delete(draftKey);
    };
    markDraft();
    if (draft) tags.setSelectionRange(draft.start, draft.end);
    if (tags.dataset.dirty === 'true') message('标签有未提交修改');
    const useCurrent = () => {
      const current = recordTab === 'actors' ? actorWorld().actors.find(actor => actor.id === record.id) : api.library.list().find(entry => entry.id === record.id);
      if (!current) throw new Error('library_entry_not_found');
      record = current; organization = recordTab === 'actors' ? current.organization || {} : current;
      archiveButton.title = organization.archived ? '取消归档' : '归档'; archiveButton.setAttribute('aria-label', archiveButton.title);
      archiveButton.replaceChildren(createElement(organization.archived ? ArchiveRestore : Archive, { width: 18, height: 18, 'aria-hidden': true }));
    };
    const saveOrganization = async patch => {
      lastPatch = patch;
      if (recordTab === 'actors') await api.library.organize(record.id, { ...organization, ...patch }, organization);
      else await api.library.update({ ...record, ...patch }, record);
      if (epoch !== requestEpoch) return;
      useCurrent(); markDraft(); conflict.hidden = true;
    };
    const archiveButton = button(organization.archived ? ArchiveRestore : Archive, organization.archived ? '取消归档' : '归档', () => run(() => saveOrganization({ archived: !organization.archived })));
    commands.append(tags, button(Save, '保存标签', () => run(() => saveOrganization({ tags: parsedTags() }))), archiveButton);
    for (const [label, action] of [
      ['采用服务器值', () => { useCurrent(); tags.value = tagsOf(organization).join(', '); markDraft(); conflict.hidden = true; }],
      ['重新提交', () => { useCurrent(); return saveOrganization(lastPatch?.tags ? { tags: parsedTags() } : lastPatch); }],
    ]) {
      const control = doc.createElement('button'); control.type = 'button'; control.textContent = label;
      control.addEventListener('click', () => run(action)); conflict.append(control);
    }
    if (tab === 'actors') {
      commands.append(button(Pencil, '编辑模板', () => { close(); api.entities.openActor(record.id); }),
        button(Copy, '复制模板', () => run(() => api.library.copy(record.id))),
        button(Save, '存入资料库', () => run(() => api.library.save(record.id))));
    } else {
      const preview = doc.createElement('p'); preview.textContent = '正在读取正文'; preview.style.overflowWrap = 'anywhere'; detail.append(preview);
      const importButton = button(FileInput, '导入为新模板', () => run(async () => { await api.library.import(record.id, record.bodyRef); clearDetail(); }));
      importButton.disabled = true; commands.append(importButton,
        button(Download, '导出模板包', () => run(async () => {
          const blob = await api.library.export(record.id), url = URL.createObjectURL(blob);
          const link = doc.createElement('a'); link.href = url; link.download = `${record.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'template'}.zip`;
          link.click(); doc.defaultView.setTimeout(() => URL.revokeObjectURL(url), 1000);
        })),
        button(Trash2, '删除资料库索引', () => { if (doc.defaultView.confirm('删除此资料库索引？现有 Actor、Token 和备份不受影响。')) run(async () => { await api.library.remove(record); clearDetail(); }); }));
      api.library.preview(record.id).then(value => {
        if (epoch !== requestEpoch || !gm()) return;
        preview.textContent = value.conflicts.length ? `状态定义冲突：${value.conflicts.join('、')}。导入将生成新 ID，保留现有定义。` : '依赖无冲突；导入将创建独立的新模板。';
        importButton.disabled = false;
      }).catch(error => { if (epoch === requestEpoch) preview.textContent = errors[error.message] || error.message; });
    }
  }

  dialog.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    if (pending) return;
    tab = button.dataset.tab; clearDetail(); nodes.clear(); list.replaceChildren();
    dialog.querySelectorAll('[data-tab]').forEach(value => value.setAttribute('aria-selected', String(value === button)));
    dialog.querySelector('[data-upload]').hidden = tab !== 'assets';
    dialog.querySelector('[data-package-control]').hidden = tab !== 'library';
    refresh().catch(error => message(error.message));
  }));
  dialog.querySelector('[data-sort]').value = preferences.sort;
  dialog.querySelector('[data-sort]').addEventListener('change', event => { preferences.sort = event.target.value; writePreferences(); render(); });
  for (const selector of ['[data-search]', '[data-type]', '[data-archived]', '[data-favorites]']) dialog.querySelector(selector).addEventListener('input', render);
  const unsubscribe = api.on('state:commit', () => {
    if (!dialog.open || scheduled || tab === 'assets') return;
    scheduled = true; doc.defaultView.requestAnimationFrame(() => { scheduled = false; refresh().catch(error => message(error.message)); });
  });
  return {
    open() { if (!gm()) return; if (!dialog.open) dialog.showModal(); dialog.querySelector(`[data-tab="${tab}"]`).click(); },
    close,
    destroy() { unsubscribe?.(); clearDetail(); dialog.remove(); },
  };
}
