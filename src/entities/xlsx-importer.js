// Compatibility facade: character-card parsing is ruleset-specific and now lives in
// rulesets/infinite-horror. Existing entity UI/tests can keep importing this module
// while the World/Ruleset selection flow is introduced incrementally.
export {
  guessInfiniteHorrorFormName as guessFormName,
  parseInfiniteHorrorCharacterSheets as parseCharacterSheets,
  importInfiniteHorrorCharacterXlsx as importCharacterXlsx,
} from '../rulesets/infinite-horror/importers/xlsx.js';
