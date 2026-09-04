import { createSheetContext } from './permission.js';
import { renderLimitedSheetBody, renderPublicProfileEditor, renderSheetBadges } from './parts.js';

export class ActorSheet {
  constructor({ actor, token = null, permissionLevel, mode = 'play', canRuntimeEdit = false, canTokenEdit = false } = {}) {
    this.actor = actor;
    this.token = token;
    this.context = createSheetContext({
      permissionLevel, mode, target: token ? 'token' : 'template', canRuntimeEdit, canTokenEdit,
    });
    this.parts = new Map();
    this.definePart('badges', {
      render: input => renderSheetBadges({ actor: this.actor, token: this.token, context: this.context, description: input.description || {} }),
    });
    this.definePart('limited', {
      render: () => renderLimitedSheetBody({ actor: this.actor, token: this.token }),
    });
    this.definePart('public-profile', {
      render: input => renderPublicProfileEditor({ actor: this.actor, ...input }),
    });
  }

  definePart(name, part) {
    const id = String(name || '').trim();
    if (!id || !part || typeof part.render !== 'function') throw new Error('ActorSheet Part requires a name and render()');
    this.parts.set(id, part);
    return this;
  }

  renderPart(name, input = {}) {
    const part = this.parts.get(String(name || ''));
    if (!part) return '';
    const context = typeof part.context === 'function'
      ? part.context({ sheet: this, actor: this.actor, token: this.token, ...input })
      : { sheet: this, actor: this.actor, token: this.token, ...input };
    return part.render(context);
  }

  updatePart(name, root, input = {}) {
    const part = this.parts.get(String(name || ''));
    if (!part) return false;
    if (typeof part.update === 'function') return part.update(root, input, this) !== false;
    const host = root?.querySelector?.(`[data-sheet-part="${String(name)}"]`);
    if (!host) return false;
    host.innerHTML = this.renderPart(name, input);
    return true;
  }

  dispose() {
    for (const part of this.parts.values()) part.dispose?.({ sheet: this, actor: this.actor, token: this.token });
    this.parts.clear();
  }

  renderBadges(description = {}) {
    return this.renderPart('badges', { description });
  }

  renderLimited() {
    return this.renderPart('limited');
  }

  renderPublicProfileEditor(options = {}) {
    return this.renderPart('public-profile', options);
  }
}
