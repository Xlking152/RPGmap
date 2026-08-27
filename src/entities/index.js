import { createEntityUiTool } from './ui.js';
import { createCharacterSheetExtension } from './character-sheet-extension.js';
import { createEntityTokenReadUiSystem } from './token-read-ui.js';

export { createEmptyEntityState, createActorFromImport, createFormFromImport, createLegacyActor, createTokenForActor, normalizeEntityState, migrateLegacyCharacters, actorForToken, currentForm, addFormToActor, BAD_STATUS_DEFS } from './model.js';
export { resolveActor, resolveAttribute, resolveResource, resolveBadStatus, setResourceCurrent, setResourceMaxOverride, setAttributeAdjustment, setBadStatusCurrent, addCustomResource, removeCustomResource, setActorForm, cycleActorForm, addEffect } from './resolver.js';
export { parseSharedStrings, parseWorksheetCells, parseRelationships, parseWorkbookSheets, resolveZipPath, readXlsxCachedWorkbook } from './xlsx-lite.js';
export { guessFormName, parseCharacterSheets, importCharacterXlsx } from './xlsx-importer.js';
export { imageToAvatarDataUrl } from './avatar.js';
export { EntityStore } from './store.js';
export { createCharacterSheetExtension } from './character-sheet-extension.js';
export { createEntityTokenReadUiSystem, listCanonicalActorTokens, readCanonicalEntityToken, formatCanonicalTokenPlacement } from './token-read-ui.js';

export function createEntitySystem(options = {}) {
  const ui = createEntityUiTool(options);
  const extension = createCharacterSheetExtension();
  const tokenReads = createEntityTokenReadUiSystem();
  return {
    register(api) {
      ui.register(api);
      extension.register(api);
      // The legacy Entity shell still owns Actor editing, but every Token list,
      // placement/display read is overlaid from the canonical active Scene.
      tokenReads.register(api);
    },
  };
}
