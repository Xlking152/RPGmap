import { createSheetContext, ACTOR_PERMISSION_LEVELS } from './permission.js';

function partFor(section) {
  const type = String(section?.type || '').trim();
  return {
    type,
    render(data = {}) {
      return `<section class="entity-section" data-sheet-part="${type}"><h3>${type || 'section'}</h3><pre>${JSON.stringify(data, null, 2)}</pre></section>`;
    },
  };
}

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
    const title = this.context.level === ACTOR_PERMISSION_LEVELS.LIMITED
      ? `${this.actor?.name || 'Unknown'}`
      : `${this.actor?.name || 'Unknown'} (${this.context.level})`;

    return `
      <article class="entity-sheet" data-sheet-mode="${this.context.mode}">
        <header class="entity-sheet-header">
          <strong>${title}</strong>
          <button data-sheet-mode-toggle>${this.context.mode === 'edit' ? 'Play' : 'Edit'}</button>
        </header>
        <div class="entity-sheet-body">
          ${this.visibleSections.map(section => partFor(section).render(section)).join('')}
        </div>
      </article>`;
  }
}
