function parseMessage(event) {
  try { return JSON.parse(String(event.data)); } catch { return null; }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class LauncherAdminClient {
  constructor({ url, gmSecret, name = 'RPGmap Launcher' } = {}) {
    this.url = String(url || 'ws://127.0.0.1:30000/ws');
    this.gmSecret = String(gmSecret || '');
    this.name = String(name || 'RPGmap Launcher');
    this.ws = null;
    this.welcome = null;
    this.access = { users: [], pending: [], actors: [], canManage: false, selfUserId: null };
    this.presence = [];
    this.waiters = new Set();
    this.listeners = new Set();
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && this.welcome?.session?.role === 'gm';
  }

  snapshot() {
    return {
      connected: this.connected,
      access: clone(this.access),
      presence: clone(this.presence),
      session: clone(this.welcome?.session || null),
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch {}
    }
  }

  settleWaiters(message) {
    for (const waiter of [...this.waiters]) {
      let matched = false;
      try { matched = waiter.predicate(message); } catch (error) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.reject(error);
        continue;
      }
      if (!matched) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  waitFor(predicate, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('Launcher admin message timeout'));
      }, timeout);
      this.waiters.add(waiter);
    });
  }

  handleMessage(event) {
    const message = parseMessage(event);
    if (!message) return;

    if (message.type === 'welcome') this.welcome = message;
    if (message.type === 'access.snapshot') {
      this.access = {
        users: Array.isArray(message.users) ? message.users : [],
        pending: Array.isArray(message.pending) ? message.pending : [],
        actors: Array.isArray(message.actors) ? message.actors : [],
        canManage: message.canManage === true,
        selfUserId: message.selfUserId || null,
      };
    }
    if (message.type === 'presence') this.presence = Array.isArray(message.clients) ? message.clients : [];

    this.settleWaiters(message);
    if (['welcome', 'access.snapshot', 'presence', 'permissions.update'].includes(message.type)) this.emit();
  }

  async connect(timeout = 7000) {
    this.close();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('message', event => this.handleMessage(event));
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.welcome = null;
        this.emit();
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Launcher admin WebSocket open timeout')), timeout);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Launcher admin WebSocket connection failed')); }, { once: true });
    });

    const welcomePromise = this.waitFor(message => message.type === 'welcome', timeout);
    const accessPromise = this.waitFor(message => message.type === 'access.snapshot', timeout);
    ws.send(JSON.stringify({
      type: 'hello',
      name: this.name,
      requestedRole: 'gm',
      gmSecret: this.gmSecret,
    }));
    const welcome = await welcomePromise;
    if (welcome?.session?.role !== 'gm') throw new Error('Launcher did not receive GM permissions');
    await accessPromise;
    this.emit();
    return this.snapshot();
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.welcome = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Launcher admin connection closed'));
    }
    this.waiters.clear();
  }

  send(message) {
    if (!this.connected) throw new Error('Launcher admin is not connected');
    this.ws.send(JSON.stringify(message));
  }

  async refresh() {
    const promise = this.waitFor(message => message.type === 'access.snapshot');
    this.send({ type: 'access.request' });
    await promise;
    return this.snapshot();
  }

  async createUser({ name, defaultActorId = '', ownership = {} } = {}) {
    const claim = this.waitFor(message => message.type === 'access.claim');
    this.send({ type: 'access.user.create', name, defaultActorId, ownership });
    const result = await claim;
    await this.refresh();
    return { user: clone(result.user), playerKey: result.claimCode || result.playerKey || '' };
  }

  async approvePending({ sessionId, name, defaultActorId = '', ownership = {} } = {}) {
    const notice = this.waitFor(message => message.type === 'access.notice');
    this.send({ type: 'access.user.approve', sessionId, name, defaultActorId, ownership });
    await notice;
    await this.refresh();
    return this.snapshot();
  }

  async updateUser({ userId, name, defaultActorId = '', ownership = {}, disabled } = {}) {
    const before = JSON.stringify(this.access.users);
    const changed = this.waitFor(message => message.type === 'access.snapshot' && JSON.stringify(message.users || []) !== before);
    this.send({ type: 'access.user.update', userId, name, defaultActorId, ownership, ...(disabled === undefined ? {} : { disabled }) });
    await changed;
    return this.snapshot();
  }

  async resetPlayerKey(userId) {
    const claim = this.waitFor(message => message.type === 'access.claim' && message.user?.id === userId);
    this.send({ type: 'access.user.reset-claim', userId });
    const result = await claim;
    await this.refresh();
    return { user: clone(result.user), playerKey: result.claimCode || result.playerKey || '' };
  }

  async deleteUser(userId) {
    const before = JSON.stringify(this.access.users);
    const changed = this.waitFor(message => message.type === 'access.snapshot' && JSON.stringify(message.users || []) !== before);
    this.send({ type: 'access.user.delete', userId });
    await changed;
    return this.snapshot();
  }
}
