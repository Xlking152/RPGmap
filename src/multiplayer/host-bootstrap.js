import { isLocalHost } from './protocol.js';

const HOST_FLAG = 'rpgmap-host';

export function parseHostBootstrap(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  if (params.get(HOST_FLAG) !== '1') return null;
  const gmSecret = String(params.get('gmSecret') || '').trim();
  if (!gmSecret) return null;
  return Object.freeze({
    name: 'GM',
    requestedRole: 'gm',
    gmSecret,
  });
}

export function createMultiplayerHostBootstrapSystem() {
  return Object.freeze({
    register(api) {
      const windowNode = api.map?.getContainer?.()?.ownerDocument?.defaultView || globalThis.window;
      const launch = parseHostBootstrap(windowNode?.location?.hash);
      if (!launch || !isLocalHost(windowNode?.location) || typeof api.multiplayer?.connect !== 'function') return;

      // Consume the secret-bearing hash before opening the socket so it does not
      // remain visible in the address bar or normal browser history.
      const cleanUrl = `${windowNode.location.pathname || '/'}${windowNode.location.search || ''}`;
      windowNode.history?.replaceState?.(null, '', cleanUrl);

      queueMicrotask(() => {
        api.multiplayer.connect({
          name: launch.name,
          requestedRole: launch.requestedRole,
          gmSecret: launch.gmSecret,
        });
      });
    },
  });
}
