import { createEntityUiTool } from './ui.js';
import { createCharacterSheetExtension } from './character-sheet-extension.js';
import { createEntityTokenReadUiSystem } from './token-read-ui.js';
import { createEntityTokenDeleteUiSystem } from './token-delete-ui.js';
import { createFeatureTokenUiSystem } from './feature-token-ui.js';
import { withCanonicalEntityTokenReadView } from './store.js';

export { createEmptyEntityState, createActorFromImport, createFormFromImport, createLegacyActor, createTokenForActor, normalizeEntityState, migrateLegacyCharacters, actorForToken, currentForm, addFormToActor, BAD_STATUS_DEFS } from './model.js';
export { resolveActor, resolveAttribute, resolveResource, resolveBadStatus, setResourceCurrent, setResourceMaxOverride, setAttributeAdjustment, setBadStatusCurrent, addCustomResource, removeCustomResource, setActorForm, cycleActorForm, addEffect } from './resolver.js';
export { parseSharedStrings, parseWorksheetCells, parseRelationships, parseWorkbookSheets, resolveZipPath, readXlsxCachedWorkbook } from './xlsx-lite.js';
export { guessFormName, parseCharacterSheets, importCharacterXlsx } from './xlsx-importer.js';
export { imageToAvatarDataUrl } from './avatar.js';
export { EntityStore, withCanonicalEntityTokenReadView, refreshCanonicalEntityUiStore, getCanonicalEntityUiStore } from './store.js';
export { createCharacterSheetExtension } from './character-sheet-extension.js';
export { createEntityTokenReadUiSystem, listCanonicalActorTokens, readCanonicalEntityToken, formatCanonicalTokenPlacement } from './token-read-ui.js';
export { createEntityTokenDeleteUiSystem } from './token-delete-ui.js';
export { deleteCanonicalActor, deleteCanonicalToken, listWorldActorTokens, removeActorAndTokensFromWorld } from './canonical-delete.js';
export { createFeatureTokenUiSystem } from './feature-token-ui.js';
export { listFeatureTokenViews } from './feature-token-view.js';

export function createEntitySystem(options = {}) {
  const ui = createEntityUiTool(options);
  const extension = createCharacterSheetExtension();
  const tokenReads = createEntityTokenReadUiSystem();
  const tokenDelete = createEntityTokenDeleteUiSystem();
  const featureTokens = createFeatureTokenUiSystem();
  return {
    register(api) {
      // Only the long-lived Entity editor store is a canonical Token read view.
      // Health/Status/Damage create ordinary EntityStore instances later and
      // must keep mutable World drafts for atomic reducer writes.
      withCanonicalEntityTokenReadView(() => ui.register(api));
      extension.register(api);
      tokenReads.register(api);
      tokenDelete.register(api);
      featureTokens.register(api);
    },
  };
}
