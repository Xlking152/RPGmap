import { createEntityUiTool } from './ui.js';

export { createEmptyEntityState, createActorFromImport, createFormFromImport, createTokenForActor, normalizeEntityState, actorForToken, currentForm, addFormToActor } from './model.js';
export { resolveActor, resolveAttribute, resolveResource, setResourceCurrent, setResourceMaxOverride, setAttributeAdjustment, addCustomResource, removeCustomResource, setActorForm, cycleActorForm } from './resolver.js';
export { parseSharedStrings, parseWorksheetCells, parseRelationships, parseWorkbookSheets, resolveZipPath, readXlsxCachedWorkbook } from './xlsx-lite.js';
export { guessFormName, parseActorSheets, importActorXlsx } from './xlsx-importer.js';
export { imageToAvatarDataUrl } from './avatar.js';
export { EntityStore } from './store.js';
export { createEntityTokenController } from './token-controller.js';
export { deleteCanonicalActor, deleteCanonicalToken, listWorldActorTokens, removeActorAndTokensFromWorld } from './canonical-delete.js';
export { listFeatureTokenViews } from './feature-token-view.js';

export function createEntitySystem(options = {}) {
  const ui = createEntityUiTool(options);
  return {
    register(api) {
      ui.register(api);
    },
  };
}
