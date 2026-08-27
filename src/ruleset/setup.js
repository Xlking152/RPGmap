import { listRulesets, setActiveRuleset } from './index.js';

export const RULESET_BOOTSTRAP_STORAGE_KEY = 'rpgmap:ruleset-bootstrap:v1';

function safeParse(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function readRulesetBootstrap(storageAdapter) {
  const raw = storageAdapter?.get?.(RULESET_BOOTSTRAP_STORAGE_KEY);
  const value = safeParse(raw);
  const id = typeof value?.rulesetId === 'string' ? value.rulesetId.trim() : '';
  if (!id || !listRulesets().some(ruleset => ruleset.id === id)) return null;
  return { rulesetId: id };
}

export function writeRulesetBootstrap(storageAdapter, rulesetId) {
  const ruleset = setActiveRuleset(rulesetId);
  storageAdapter?.set?.(RULESET_BOOTSTRAP_STORAGE_KEY, JSON.stringify({
    rulesetId: ruleset.id,
    version: ruleset.version,
  }));
  return ruleset;
}

function setupCard(ruleset) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.rulesetId = ruleset.id;
  button.style.cssText = [
    'width:100%',
    'display:block',
    'text-align:left',
    'padding:16px 18px',
    'border:1px solid #cfc5b7',
    'border-radius:10px',
    'background:#fffdf8',
    'color:#3c2c20',
    'cursor:pointer',
    'font:inherit',
  ].join(';');

  const title = document.createElement('strong');
  title.textContent = ruleset.title;
  title.style.cssText = 'display:block;font-size:17px;margin-bottom:4px';

  const version = document.createElement('span');
  version.textContent = `${ruleset.id} · v${ruleset.version}`;
  version.style.cssText = 'display:block;font-size:12px;color:#7b7065;margin-bottom:8px';

  const description = document.createElement('span');
  description.textContent = ruleset.metadata?.description || 'RPGmap 规则包';
  description.style.cssText = 'display:block;font-size:13px;line-height:1.55;color:#5e554c';

  button.append(title, version, description);
  return button;
}

export function renderRulesetSetup(container, { rulesets = listRulesets() } = {}) {
  if (!container) throw new Error('Ruleset setup requires an app container');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'rpgmap-boot';

  const card = document.createElement('div');
  card.className = 'rpgmap-boot-card';

  const title = document.createElement('h1');
  title.className = 'rpgmap-boot-title';
  title.dataset.rulesetSetupTitle = 'true';
  title.textContent = '选择规则系统';

  const lead = document.createElement('p');
  lead.className = 'rpgmap-boot-status';
  lead.dataset.rpgmapBootStatus = '';
  lead.textContent = '规则包决定角色卡、生命值、状态点数和伤害规则；Token 与地图交互仍由 RPGmap Core 管理。';
  lead.style.marginBottom = '16px';

  const choices = document.createElement('div');
  choices.dataset.rulesetChoices = 'true';
  choices.style.cssText = 'display:grid;gap:10px';
  for (const ruleset of rulesets) choices.append(setupCard(ruleset));

  card.append(title, lead, choices);
  root.append(card);
  container.append(root);
  return root;
}

export async function chooseRulesetBeforeMap({
  container,
  storageAdapter,
  forcePrompt = false,
} = {}) {
  const stored = readRulesetBootstrap(storageAdapter);
  if (stored && !forcePrompt) return setActiveRuleset(stored.rulesetId);

  const rulesets = listRulesets();
  if (!rulesets.length) throw new Error('没有可用的 RPGmap Ruleset');
  const root = renderRulesetSetup(container, { rulesets });

  return new Promise((resolve, reject) => {
    const onClick = event => {
      const button = event.target?.closest?.('[data-ruleset-id]');
      if (!button) return;
      root.removeEventListener('click', onClick);
      try {
        const ruleset = writeRulesetBootstrap(storageAdapter, button.dataset.rulesetId);
        const title = root.querySelector('[data-ruleset-setup-title]');
        const choices = root.querySelector('[data-ruleset-choices]');
        const status = root.querySelector('[data-rpgmap-boot-status]');
        if (title) title.textContent = `RPGmap · ${ruleset.title}`;
        choices?.remove();
        if (status) {
          status.textContent = `已选择规则包 ${ruleset.title}，正在准备运行环境…`;
          status.style.marginBottom = '0';
        }
        resolve(ruleset);
      } catch (error) {
        reject(error);
      }
    };
    root.addEventListener('click', onClick);
  });
}
