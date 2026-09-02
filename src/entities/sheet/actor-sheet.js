import { createSheetContext, ACTOR_PERMISSION_LEVELS } from './permission.js';
import { renderPart } from './parts.js';

export class ActorSheet {
  constructor({ actor, userId, description = {}, mode = 'play' } = {}) {
    this.actor = actor;
    this.description = description;
    this.context = createSheetContext({ actor, userId, mode });
  }

  get visibleSections() {
    const sections = this.description?.tabs?.flatMap(tab => tab.sections || []) || [];
    if (this.context.level === ACTOR_PERMISSION_LEVELS.LIMITED) {
      return sections.filter(section => ['text', 'description', 'biography'].includes(section.type));
    }
    return sections;
  }

  render() {
    const title = this.actor?.name || 'Unknown';
    const readonly = this.context.editable ? '' : ' entity-sheet-readonly';

    return `
      <article class="entity-sheet${readonly}" data-sheet-mode="${this.context.mode}">
        <header class="entity-sheet-header">
          <strong>${title}</strong>
          <button data-sheet-mode-toggle>${this.context.mode === 'edit' ? 'Play' : 'Edit'}</button>
        </header>
        <div class="entity-sheet-body">
          ${this.visibleSections.map(renderPart).join('')}
        </div>
      </article>`;
  }
}
