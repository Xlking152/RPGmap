import { previewTemplateImport, prepareTemplateImport } from './model.js';

export function createTemplateLibrarySystem({ serverRuntime = false } = {}) {
  return { register(api) {
    const doc = api.map.getContainer().ownerDocument;
    const gm = () => {
      const status = api.multiplayer?.getStatus?.();
      return status?.connected ? status.session?.role === 'gm'
        : !serverRuntime && !status?.joining && !api.getState().audienceProjection;
    };
    const requireGm = () => { if (!gm()) throw Object.assign(new Error('library_gm_only'), { code: 'library_gm_only' }); };
    const world = () => api.getState().preferences.worldV2;
    const requireWorld = id => { requireGm(); if (world().id !== id) throw new Error('library_world_changed'); };
    const packagePreviews = new WeakMap();
    const dispatch = (intent, data, actorId = null) => {
      requireGm();
      return api.documents.dispatch({ action: intent.endsWith('.delete') ? 'delete' : 'update',
        document: { type: actorId ? 'Actor' : 'World', id: actorId || world().id, parent: null }, intent,
        data: actorId ? data : { ...data, worldId: world().id } });
    };
    const importActor = async (bundle, entry = null) => {
      requireGm();
      const prepared = prepareTemplateImport(bundle, world(), { ruleset: api.ruleset });
      const writes = prepared.definitions.length ? [{ action: 'create', document: { type: 'Status', id: 'definitions', parent: null },
        intent: 'status.definition.import', data: { statusSchemaVersion: 4, definitions: prepared.definitions } }] : [];
      if (entry) writes.push({ action: 'update', document: { type: 'World', id: world().id, parent: null },
        intent: 'world.library.upsert', data: { worldId: world().id, entry, expectedBodyRef: null, expectedEntry: null } });
      writes.push({ action: 'create', document: { type: 'Actor', id: prepared.actor.id, parent: null }, intent: 'actor.upsert', data: { actor: prepared.actor } });
      await api.documents.dispatchBatch(writes);
      return prepared.actor.id;
    };
    const library = {
      list() { requireGm(); return structuredClone(Object.values(world().templateLibrary || {})); },
      async save(actorId) {
        requireGm();
        const sourceWorldId = world().id;
        const source = world().actors.find(actor => actor.id === actorId);
        if (!source || source.audienceRestricted) throw new Error('actor_not_found');
        const { persistInlineImages } = await import('../content/data-url.js');
        requireWorld(sourceWorldId);
        const actor = await persistInlineImages(structuredClone(source), api.content);
        requireWorld(sourceWorldId);
        for (const key of ['ownership', 'permissions', 'controllerUserIds', 'sourceTokenId']) delete actor[key];
        const used = new Set((actor.effects || []).map(effect => effect.definitionId || effect.statusId));
        const bundle = { kind: 'actor-template', schemaVersion: 1, ruleset: structuredClone(world().ruleset), actor,
          statusDefinitions: structuredClone(world().statusDefinitions.filter(definition => used.has(definition.id))) };
        const stored = await api.content.putTemplate(bundle);
        requireWorld(sourceWorldId);
        const entry = { id: `template-${crypto.randomUUID()}`, name: actor.name, type: actor.type, tags: structuredClone(actor.organization?.tags || []), archived: false,
          ruleset: bundle.ruleset, bodyRef: stored.reference };
        await dispatch('world.library.upsert', { entry, expectedBodyRef: null, expectedEntry: null });
        return entry;
      },
      async read(entryId) {
        requireGm();
        const sourceWorldId = world().id;
        const entry = library.list().find(item => item.id === entryId);
        if (!entry) throw new Error('library_entry_not_found');
        const blob = await api.content.get(entry.bodyRef);
        const bundle = JSON.parse(await blob.text());
        requireWorld(sourceWorldId);
        return { entry, bundle };
      },
      async preview(entryId) {
        const loaded = await library.read(entryId);
        return { ...loaded, ...previewTemplateImport(loaded.bundle, world()) };
      },
      async import(entryId, expectedBodyRef) {
        const loaded = await library.read(entryId);
        if (loaded.entry.bodyRef !== expectedBodyRef) throw new Error('document_field_conflict');
        return importActor(loaded.bundle);
      },
      async export(entryId) {
        const sourceWorldId = world().id;
        const { bundle } = await library.read(entryId);
        const { exportTemplateArchive } = await import('../content/archive.js');
        requireWorld(sourceWorldId);
        const blob = await exportTemplateArchive(bundle, api.content);
        requireWorld(sourceWorldId);
        return blob;
      },
      async previewPackage(file) {
        requireGm();
        const worldId = world().id;
        const { readTemplateArchive, MAX_ARCHIVE_BYTES } = await import('../content/archive.js');
        if (file.size > MAX_ARCHIVE_BYTES) throw new Error('archive_size_exceeded');
        const loaded = await readTemplateArchive(new Uint8Array(await file.arrayBuffer()));
        requireWorld(worldId);
        const preview = { ...previewTemplateImport(loaded.bundle, world()), imageCount: loaded.records.length };
        packagePreviews.set(preview, { ...loaded, worldId });
        return preview;
      },
      async importPackage(preview) {
        const loaded = packagePreviews.get(preview);
        if (!loaded) throw new Error('template_preview_required');
        requireWorld(loaded.worldId);
        prepareTemplateImport(loaded.bundle, world(), { ruleset: api.ruleset });
        const { persistArchiveContent } = await import('../content/archive.js');
        requireWorld(loaded.worldId);
        await persistArchiveContent(loaded.records, api.content);
        requireWorld(loaded.worldId);
        const stored = await api.content.putTemplate(loaded.bundle);
        requireWorld(loaded.worldId);
        const { actor, ruleset } = loaded.bundle;
        const entry = { id: `template-${crypto.randomUUID()}`, name: actor.name, type: actor.type, tags: [], archived: false,
          ruleset, bodyRef: stored.reference };
        const id = await importActor(loaded.bundle, entry);
        packagePreviews.delete(preview);
        return id;
      },
      update(entry, expectedEntry) { return dispatch('world.library.upsert', { entry, expectedBodyRef: expectedEntry.bodyRef, expectedEntry }); },
      organize(actorId, organization, expected) { return dispatch('actor.organization.update', { actorId, organization, expected }, actorId); },
      remove(entry) { return dispatch('world.library.delete', { entryId: entry.id, expectedBodyRef: entry.bodyRef, expectedEntry: entry }); },
      async copy(actorId) {
        const newActorId = `actor-${crypto.randomUUID()}`;
        await dispatch('actor.copy', { actorId, newActorId }, actorId);
        return newActorId;
      },
    };
    api.library = Object.freeze(library);
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'tool-button'; button.textContent = '资料库'; button.title = '模板与图片资料库';
    button.dataset.templateLibrary = 'true';
    doc.querySelector('.toolbar-right')?.append(button);
    let view, opening;
    button.addEventListener('click', () => {
      if (opening) return;
      opening = import('./ui.js').then(module => { requireGm(); view ||= module.createLibraryView(api, { gm }); view.open(); })
        .catch(error => api.setStatus(error.message)).finally(() => { opening = null; });
    });
    const refresh = () => { button.hidden = !gm(); if (!gm()) view?.close(); };
    const unsubscribe = api.on('multiplayer:capabilities', refresh);
    refresh();
    return () => { unsubscribe?.(); button.remove(); view?.destroy(); };
  } };
}
