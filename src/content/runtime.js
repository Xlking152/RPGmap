import { collectContentReferences, contentReference, readableImageReferences, hasStoredContentReference } from './references.js';

export function createContentSystem({ serverRuntime = false, worldId = 'default' } = {}) {
  return {
    register(api) {
      const documentNode = api.map.getContainer().ownerDocument;
      const urls = new Map();
      const pending = new WeakMap();
      let local, epoch = 0;
      const network = () => serverRuntime || api.multiplayer?.getStatus?.().connected;
      const storage = () => local ||= import('./indexed-storage.js').then(module => module.createIndexedContentStorage(documentNode.defaultView.indexedDB, { worldId }));
      const request = (path, options) => {
        if (!api.multiplayer?.fetchContent) throw new Error('identity_required');
        return api.multiplayer.fetchContent(path, options);
      };
      const content = {
        async putImage(blob) {
          const { inspectImage } = await import('./image.js');
          inspectImage(new Uint8Array(await blob.arrayBuffer()), blob.type);
          return network() ? (await request('', { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } })).json()
            : (await storage()).put(blob);
        },
        async get(reference) {
          const value = contentReference(reference);
          if (value?.kind !== 'asset') throw new Error('content_not_found');
          return network() ? (await request(`/${value.id}`)).blob() : (await storage()).get(value.id);
        },
        async list() { return network() ? (await (await request('')).json()).records : (await storage()).list(); },
        async references(reference) {
          const value = contentReference(reference);
          if (value?.kind !== 'asset') throw new Error('content_not_found');
          if (network()) return (await request(`/${value.id}/references`)).json();
          const paths = collectContentReferences(api.getState()?.preferences?.worldV2).get(reference) || [];
          return { paths, count: paths.length };
        },
        async remove(reference) {
          const value = contentReference(reference);
          if (value?.kind !== 'asset') throw new Error('content_not_found');
          if (network()) await request(`/${value.id}`, { method: 'DELETE' });
          else {
            if (collectContentReferences(api.getState()).has(reference)) throw new Error('content_in_use');
            if (hasStoredContentReference(documentNode.defaultView.localStorage, reference)) throw new Error('content_in_use');
            await (await storage()).remove(value.id);
          }
          clear();
        },
      };
      api.content = Object.freeze(content);

      function hydrate(node) {
        if (!node?.matches?.('img[data-content-ref]')) return;
        const ref = node.dataset.contentRef, currentEpoch = epoch;
        if (contentReference(ref)?.kind !== 'asset' || pending.get(node) === `${epoch}:${ref}`) return;
        pending.set(node, `${epoch}:${ref}`);
        let record = urls.get(ref);
        if (!record) {
          record = { url: null };
          record.ready = content.get(ref).then(blob => {
            if (epoch !== currentEpoch || urls.get(ref) !== record) return null;
            record.url = URL.createObjectURL(blob); return record.url;
          }).catch(() => { if (urls.get(ref) === record) urls.delete(ref); return null; });
          urls.set(ref, record);
        }
        record.ready.then(url => {
          if (epoch !== currentEpoch || node.dataset.contentRef !== ref || !node.isConnected) return;
          if (url) { node.src = url; delete node.dataset.contentError; }
          else { node.removeAttribute('src'); node.dataset.contentError = 'unavailable'; }
        });
      }
      function scan(root = documentNode) {
        hydrate(root);
        root.querySelectorAll?.('img[data-content-ref]').forEach(hydrate);
      }
      function clear() {
        epoch++;
        for (const record of urls.values()) if (record.url) URL.revokeObjectURL(record.url);
        urls.clear();
        documentNode.querySelectorAll('img[data-content-ref]').forEach(node => node.removeAttribute('src'));
        scan();
      }
      let scheduled = false;
      function prune() {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          const granted = readableImageReferences(api.getState());
          for (const [ref, record] of urls) if (!granted.has(ref)) {
            if (record.url) URL.revokeObjectURL(record.url);
            urls.delete(ref);
            documentNode.querySelectorAll(`img[data-content-ref="${ref}"]`).forEach(node => node.removeAttribute('src'));
          }
        });
      }
      const observer = new documentNode.defaultView.MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes') { pending.delete(record.target); hydrate(record.target); }
          else record.addedNodes.forEach(scan);
        }
      });
      observer.observe(documentNode.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-content-ref'] });
      const subscriptions = ['state:import', 'multiplayer:capabilities'].map(name => api.on?.(name, clear));
      for (const name of ['document:update', 'document:create', 'document:delete']) subscriptions.push(api.on?.(name, event => {
        const detail = event.detail;
        if (!['Actor', 'Token'].includes(detail?.document?.type)) return;
        const changed = detail.changed || {};
        if (detail.action === 'delete' || detail.removed?.length || collectContentReferences(changed).size
          || ['img', 'texture', 'avatarDataUrl', 'audienceRestricted'].some(key => Object.hasOwn(changed, key))) prune();
      }));
      scan();
      return () => {
        observer.disconnect(); epoch++;
        for (const unsubscribe of subscriptions) unsubscribe?.();
        for (const record of urls.values()) if (record.url) URL.revokeObjectURL(record.url);
        urls.clear();
      };
    },
  };
}
