import { createEntityUiTool } from './ui.js';
import { createCharacterSheetExtension } from './character-sheet-extension.js';

export { createEmptyEntityState, createActorFromImport, createFormFromImport, createLegacyActor, createTokenForActor, normalizeEntityState, migrateLegacyCharacters, actorForToken, currentForm, addFormToActor, BAD_STATUS_DEFS } from './model.js';
export { resolveActor, resolveAttribute, resolveResource, resolveBadStatus, setResourceCurrent, setResourceMaxOverride, setAttributeAdjustment, setBadStatusCurrent, addCustomResource, removeCustomResource, setActorForm, cycleActorForm, addEffect } from './resolver.js';
export { parseSharedStrings, parseWorksheetCells, parseRelationships, parseWorkbookSheets, resolveZipPath, readXlsxCachedWorkbook } from './xlsx-lite.js';
export { guessFormName, parseCharacterSheets, importCharacterXlsx } from './xlsx-importer.js';
export { imageToAvatarDataUrl } from './avatar.js';
export { EntityStore } from './store.js';
export { createCharacterSheetExtension } from './character-sheet-extension.js';
export { createEntityTokenController } from './token-controller.js';
export { deleteCanonicalActor, deleteCanonicalToken, listWorldActorTokens, removeActorAndTokensFromWorld } from './canonical-delete.js';
export { listFeatureTokenViews } from './feature-token-view.js';

export function createEntitySystem(options = {}) {
  const ui = createEntityUiTool(options);
  const extension = createCharacterSheetExtension();
  return {
    register(api) {
      ui.register(api);
      extension.register(api);
    },
  };
}
