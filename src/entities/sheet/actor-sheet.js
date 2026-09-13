import { createSheetContext } from './permission.js';
import { renderLimitedSheetBody, renderPublicProfileEditor, renderSheetBadges } from './parts.js';

function changedPaths(value, path = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return [path.join('.')];
  return Object.entries(value).flatMap(([key, item]) => changedPaths(item, [...path, key]));
}

export class ActorSheet {
  constructor({ actor, token = null, permissionLevel, mode = 'play', canRuntimeEdit = false, canTokenEdit = false } = {}) {
    this.actor = actor;
    this.token = token;
    this.context = createSheetContext({
      permissionLevel, mode, target: token ? 'token' : 'template', canRuntimeEdit, canTokenEdit,
    });
    this.parts = new Map();
    this.definePart('badges', {
      dependencies: { Actor: ['type', 'system', 'audienceRestricted'], Token: ['actorLink', 'actorDelta'] },
      render: input => renderSheetBadges({ actor: this.actor, token: this.token, context: this.context, description: input.description || {} }),
    });
    this.definePart('limited', {
      dependencies: { Actor: ['name', 'img', 'publicProfile'], Token: ['name', 'img'] },
      render: () => renderLimitedSheetBody({ actor: this.actor, token: this.token }),
    });
    this.definePart('public-profile', {
      dependencies: { Actor: ['publicProfile'], StatusDefinition: ['*'] },
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

  affectedParts(changes) {
    if (!Array.isArray(changes)) return new Set(this.parts.keys());
    return new Set([...this.parts].filter(([, part]) => changes.some(change => {
      const dependencies = part.dependencies?.[change.document?.type] || [];
      if (!dependencies.length) return false;
      if (['create', 'delete'].includes(change.action) || dependencies.includes('*')) return true;
      const paths = [...changedPaths(change.changed), ...(change.removed || []).map(path => path.join('.'))];
      return dependencies.some(dependency => paths.some(path => !path || path === dependency || path.startsWith(`${dependency}.`) || dependency.startsWith(`${path}.`)));
    })).map(([name]) => name));
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
