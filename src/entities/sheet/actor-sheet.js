import { createSheetContext } from './permission.js';
import { renderLimitedSheetBody, renderPublicProfileEditor, renderSheetBadges } from './parts.js';

export class ActorSheet {
  constructor({ actor, token = null, permissionLevel, mode = 'play', canRuntimeEdit = false, canTokenEdit = false } = {}) {
    this.actor = actor;
    this.token = token;
    this.context = createSheetContext({
      permissionLevel, mode, target: token ? 'token' : 'template', canRuntimeEdit, canTokenEdit,
    });
  }

  renderBadges(description = {}) {
    return renderSheetBadges({ actor: this.actor, token: this.token, context: this.context, description });
  }

  renderLimited() {
    return renderLimitedSheetBody({ actor: this.actor, token: this.token });
  }

  renderPublicProfileEditor(options = {}) {
    return renderPublicProfileEditor({ actor: this.actor, ...options });
  }
}
