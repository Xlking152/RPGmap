export function createJournalSystem({ serverRuntime = false } = {}) {
  return { register(api) {
    const doc = api.map.getContainer().ownerDocument;
    const multiplayerStatus = () => api.multiplayer?.getStatus?.();
    const gm = () => {
      const status = multiplayerStatus();
      return status?.connected ? status.session?.role === 'gm'
        : !serverRuntime && !status?.joining && !api.getState().audienceProjection;
    };
    const world = () => api.getState().preferences.worldV2;
    const journals = {
      canEdit: gm,
      list() { return structuredClone(world().journals || []); },
      async read(entry) {
        const current = journals.list().find(value => value.id === entry.id && value.bodyRef === entry.bodyRef);
        if (!current) throw Object.assign(new Error('journal_not_found'), { code: 'journal_not_found' });
        const blob = await api.content.get(current.bodyRef);
        const body = JSON.parse(await blob.text());
        return { entry: current, body };
      },
      async save({ entry, markdown, images = [], expected = null }) {
        if (!gm()) throw Object.assign(new Error('journal_gm_only'), { code: 'journal_gm_only' });
        const worldId = world().id;
        const stored = await api.content.putJournal({ markdown, images });
        if (world().id !== worldId) throw new Error('journal_world_changed');
        const next = { ...structuredClone(entry), bodyRef: stored.reference, updatedAt: new Date().toISOString() };
        await api.documents.dispatch({
          action: expected ? 'update' : 'create',
          document: { type: 'Journal', id: next.id, parent: null },
          intent: 'journal.upsert', data: { journal: next, expected },
        });
        return next;
      },
      async remove(entry) {
        if (!gm()) throw Object.assign(new Error('journal_gm_only'), { code: 'journal_gm_only' });
        return api.documents.dispatch({
          action: 'delete', document: { type: 'Journal', id: entry.id, parent: null },
          intent: 'journal.delete', data: { journalId: entry.id, expected: entry },
        });
      },
    };
    api.journals = Object.freeze(journals);
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'tool-button'; button.textContent = '资料页';
    button.title = '打开 World 资料页'; button.dataset.journal = 'true';
    doc.querySelector('.toolbar-right')?.append(button);
    let view = null;
    let opening = null;
    button.addEventListener('click', () => {
      if (opening) return;
      opening = import('./ui.js')
        .then(module => { view ||= module.createJournalView(api); view.open(); })
        .catch(error => api.showToast?.(error.message, 'error') || api.setStatus?.(error.message))
        .finally(() => { opening = null; });
    });
    return () => { button.remove(); view?.destroy(); };
  } };
}

