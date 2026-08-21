const STYLE_ID = 'rpgmap-combat-tracker-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

export function installCombatStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .combat-top-controls { display:flex; gap:5px; align-items:center; }
    .combat-top-status { padding:0 7px; color:#526164; font-size:12px; font-weight:800; white-space:nowrap; }
    .combat-top-controls .danger { color:#a43b34; border-color:rgba(164,59,52,.3); }
    .rpgmap-combat-tracker {
      position:absolute; z-index:3350; left:12px; top:12px; width:250px; max-height:calc(100% - 24px);
      display:grid; grid-template-rows:auto minmax(0,1fr); overflow:hidden;
      border:1px solid rgba(49,69,70,.28); border-radius:11px;
      background:rgba(248,250,247,.96); box-shadow:0 12px 34px rgba(15,25,25,.24);
      backdrop-filter:blur(5px);
    }
    .rpgmap-combat-tracker[hidden] { display:none !important; }
    .combat-tracker-head { display:flex; align-items:center; gap:8px; padding:10px 11px; border-bottom:1px solid rgba(55,75,75,.16); }
    .combat-tracker-head strong { flex:1; }
    .combat-tracker-head small { color:#6d797b; }
    .combat-tracker-list { overflow:auto; padding:6px; display:grid; gap:4px; }
    .combatant-row {
      display:grid; grid-template-columns:18px 34px minmax(0,1fr) 54px 24px; gap:6px; align-items:center;
      min-height:46px; padding:5px; border:1px solid transparent; border-radius:8px; background:#fff;
    }
    .combatant-row:hover { border-color:rgba(23,109,118,.24); }
    .combatant-row.current { border-color:#176d76; box-shadow:inset 3px 0 #176d76; background:#edf6f4; }
    .combatant-drag { cursor:grab; color:#829092; font-weight:900; text-align:center; user-select:none; }
    .combatant-drag:active { cursor:grabbing; }
    .combatant-avatar, .combatant-avatar img { width:32px; height:32px; border-radius:50%; object-fit:cover; }
    .combatant-avatar { display:grid; place-items:center; overflow:hidden; color:#fff; background:#3d7e84; font-weight:850; }
    .combatant-name { min-width:0; cursor:pointer; }
    .combatant-name strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .combatant-name small { display:block; color:#788486; font-size:10px; }
    .combatant-initiative { width:52px; min-width:0; padding:5px 4px; text-align:center; font-weight:850; }
    .combatant-remove { border:0; background:transparent; color:#9a5450; cursor:pointer; font-size:17px; line-height:1; }
    .combat-tracker-empty { padding:18px 12px; text-align:center; color:#778385; font-size:12px; line-height:1.55; }
    .combatant-row.drag-over { outline:2px dashed rgba(23,109,118,.55); outline-offset:-2px; }
    @media (max-width:900px) {
      .rpgmap-combat-tracker { width:220px; }
      .combat-top-status { display:none; }
    }
  `;
  documentNode.head.append(style);
}

export function combatantView(combatant, appState) {
  const character = (appState.characters || []).find(item => String(item.id) === String(combatant.tokenId));
  const name = character?.name || `Token ${combatant.tokenId}`;
  const avatar = character?.avatarDataUrl || null;
  return { character, name, avatar };
}

export function renderCombatTracker(root, combat, appState) {
  if (!combat) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;
  const currentId = combat.state === 'active' ? combat.combatants[combat.turnIndex]?.id : null;
  const rows = combat.combatants.map(combatant => {
    const view = combatantView(combatant, appState);
    const avatar = view.avatar
      ? `<span class="combatant-avatar"><img src="${escapeHtml(view.avatar)}" alt=""></span>`
      : `<span class="combatant-avatar">${escapeHtml(view.name.trim()[0] || '?')}</span>`;
    return `<div class="combatant-row ${combatant.id === currentId ? 'current' : ''}" data-combatant-id="${escapeHtml(combatant.id)}" data-token-id="${escapeHtml(combatant.tokenId)}">
      <span class="combatant-drag" draggable="true" title="拖动调整顺序">⋮⋮</span>
      ${avatar}
      <span class="combatant-name" title="点击选择并定位 Token"><strong>${escapeHtml(view.name)}</strong><small>${combat.state === 'active' && combatant.id === currentId ? '当前回合' : 'Token'}</small></span>
      <input class="combatant-initiative" type="number" step="1" placeholder="—" value="${combatant.initiative ?? ''}" data-combat-initiative="${escapeHtml(combatant.id)}" aria-label="${escapeHtml(view.name)} 先攻">
      <button type="button" class="combatant-remove" data-combat-remove="${escapeHtml(combatant.id)}" title="移出战斗">×</button>
    </div>`;
  }).join('');
  root.innerHTML = `<header class="combat-tracker-head"><strong>先攻表</strong><small>${combat.state === 'active' ? `第 ${combat.round} 轮` : '准备阶段'} · ${combat.combatants.length} 人</small></header>
    <div class="combat-tracker-list">${rows || '<div class="combat-tracker-empty">尚无参战 Token。框选或选择 Token 后点击顶部“加入所选”。</div>'}</div>`;
}

export function renderCombatTopbar(root, combat, appState, selectedCount = 0, addableCount = selectedCount) {
  if (!combat) {
    root.innerHTML = `<button type="button" class="ui-primary-tool" data-combat-action="enter">进入战斗${selectedCount ? ` · ${selectedCount}` : ''}</button>`;
    return;
  }
  if (combat.state === 'setup') {
    root.innerHTML = `<span class="combat-top-status">战斗准备 · ${combat.combatants.length} 人</span>
      <button type="button" class="ui-primary-tool" data-combat-action="add">加入所选${addableCount ? ` · ${addableCount}` : ''}</button>
      <button type="button" class="ui-primary-tool active" data-combat-action="start">开始战斗</button>
      <button type="button" class="ui-primary-tool danger" data-combat-action="end">结束</button>`;
    return;
  }
  const current = combat.combatants[combat.turnIndex];
  const currentName = current ? combatantView(current, appState).name : '—';
  root.innerHTML = `<span class="combat-top-status">第 ${combat.round} 轮 · ${escapeHtml(currentName)}</span>
    <button type="button" class="ui-primary-tool" data-combat-action="add">加入所选${addableCount ? ` · ${addableCount}` : ''}</button>
    <button type="button" class="ui-primary-tool active" data-combat-action="next">下一回合</button>
    <button type="button" class="ui-primary-tool danger" data-combat-action="end">结束战斗</button>`;
}
