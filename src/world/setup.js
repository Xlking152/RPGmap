function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function optionHtml(item, selectedId) {
  const version = item.version ? ` · v${item.version}` : '';
  return `<option value="${escapeHtml(item.id)}" ${String(item.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(item.title || item.id)}${escapeHtml(version)}</option>`;
}

export function renderWorldManager(container, {
  worlds = [],
  rulesets = [],
  mapPackages = [],
  activeWorldId = null,
} = {}) {
  if (!container) throw new Error('World Manager requires app container');
  const worldCards = worlds.length
    ? worlds.map(world => `<article class="world-manager-card ${String(world.id) === String(activeWorldId) ? 'active' : ''}">
        <div><strong>${escapeHtml(world.name)}</strong><span>${escapeHtml(world.ruleset?.id || '未绑定规则')} · ${escapeHtml(world.mapPackage?.id || '未绑定地图')}</span></div>
        <div class="world-manager-actions"><button type="button" data-world-open="${escapeHtml(world.id)}">进入</button><button type="button" class="danger" data-world-delete="${escapeHtml(world.id)}">删除</button></div>
      </article>`).join('')
    : '<div class="world-manager-empty">暂无本地 World</div>';
  const defaultRuleset = rulesets[0]?.id || '';
  const defaultMap = mapPackages[0]?.id || '';

  container.innerHTML = `<div class="rpgmap-boot world-manager-root">
    <style>
      .world-manager-card{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:13px 14px;border:1px solid #d8d0c4;border-radius:10px;background:#fffdf8}.world-manager-card.active{border-color:#176d76;box-shadow:0 0 0 1px #176d76 inset}.world-manager-card strong{display:block;font-size:15px;color:#3d332c}.world-manager-card span{display:block;margin-top:4px;font-size:11px;color:#796e64}.world-manager-list{display:grid;gap:8px;margin:14px 0 18px}.world-manager-actions{display:flex;gap:6px}.world-manager-actions button,.world-create-form button{border:1px solid #176d76;border-radius:7px;padding:7px 10px;background:#176d76;color:#fff;font-weight:800;cursor:pointer}.world-manager-actions .danger{border-color:#c7aaa5;background:#fff;color:#9b332b}.world-create-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.world-create-form label{display:grid;gap:4px;font-size:11px;color:#6f655d}.world-create-form input,.world-create-form select{box-sizing:border-box;width:100%;padding:8px;border:1px solid #d3cbc0;border-radius:7px;background:#fff;font:inherit}.world-create-form .wide{grid-column:1/-1}.world-manager-empty{padding:18px;border:1px dashed #cfc5b7;border-radius:9px;color:#786d63;text-align:center;font-size:12px}
    </style>
    <div class="rpgmap-boot-card" style="width:min(760px,94vw)">
      <h1 class="rpgmap-boot-title">RPGmap · World Manager</h1>
      <div class="world-manager-list">${worldCards}</div>
      <form class="world-create-form" data-world-create-form>
        <label class="wide">World 名称<input name="name" maxlength="120" value="新 World" required></label>
        <label>规则系统<select name="rulesetId">${rulesets.map(item => optionHtml(item, defaultRuleset)).join('')}</select></label>
        <label>初始地图<select name="mapPackageId">${mapPackages.map(item => optionHtml(item, defaultMap)).join('')}</select></label>
        <button class="wide" type="submit">创建并进入 World</button>
      </form>
    </div>
  </div>`;
  return container.querySelector('.world-manager-root');
}

export function chooseWorldBeforeMap({
  container,
  manager,
  rulesets = [],
  mapPackages = [],
} = {}) {
  if (!manager) throw new Error('World Manager bootstrap requires manager');
  if (!rulesets.length) throw new Error('没有可用的 RPGmap Ruleset');
  if (!mapPackages.length) throw new Error('没有可用的 RPGmap MapPackage');

  const active = manager.active();
  const root = renderWorldManager(container, {
    worlds: manager.list(),
    rulesets,
    mapPackages,
    activeWorldId: active?.id || null,
  });

  return new Promise((resolve, reject) => {
    const finish = descriptor => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      resolve({ descriptor, raw: manager.readRaw(descriptor.id) });
    };

    const onClick = event => {
      const open = event.target.closest?.('[data-world-open]');
      if (open) {
        try { finish(manager.select(open.dataset.worldOpen)); }
        catch (error) { reject(error); }
        return;
      }
      const remove = event.target.closest?.('[data-world-delete]');
      if (!remove) return;
      const descriptor = manager.get(remove.dataset.worldDelete);
      if (!descriptor) return;
      if (!globalThis.confirm?.(`删除 World「${descriptor.name}」及其本地存档？`)) return;
      manager.remove(descriptor.id);
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      resolve({ restart: true });
    };

    const onSubmit = event => {
      if (!event.target.matches('[data-world-create-form]')) return;
      event.preventDefault();
      try {
        const data = new FormData(event.target);
        const rulesetId = String(data.get('rulesetId') || '');
        const mapPackageId = String(data.get('mapPackageId') || '');
        const ruleset = rulesets.find(item => String(item.id) === rulesetId);
        const mapPackage = mapPackages.find(item => String(item.id) === mapPackageId);
        if (!ruleset || !mapPackage) throw new Error('请选择有效的 Ruleset 和 MapPackage');
        finish(manager.create({
          name: String(data.get('name') || '').trim(),
          ruleset: { id: ruleset.id, version: ruleset.version },
          mapPackage: { id: mapPackage.id, version: mapPackage.version || '' },
        }));
      } catch (error) { reject(error); }
    };

    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
  });
}
