import { prepareRuleset } from '../../ruleset/contract.js';
import { INFINITE_HORROR_RESOURCE_DEFS, INFINITE_HORROR_BAD_STATUS_DEFS } from './definitions.js';
import { INFINITE_HORROR_HEALTH } from './health.js';
import { deriveInfiniteHorrorStatuses, INFINITE_HORROR_STATUS_DEFINITIONS } from './statuses.js';
import {
  guessInfiniteHorrorFormName,
  parseInfiniteHorrorCharacterSheets,
  importInfiniteHorrorCharacterXlsx,
} from './importers/xlsx.js';

export const infiniteHorrorRuleset = prepareRuleset({
  apiVersion: 1,
  id: 'infinite-horror',
  title: '无限跑团',
  version: '1.0.0',
  actor: {
    resourceDefinitions: INFINITE_HORROR_RESOURCE_DEFS,
    badStatusDefinitions: INFINITE_HORROR_BAD_STATUS_DEFS,
  },
  health: INFINITE_HORROR_HEALTH,
  statuses: {
    definitions: INFINITE_HORROR_STATUS_DEFINITIONS,
    derive: deriveInfiniteHorrorStatuses,
  },
  importers: {
    xlsx: {
      id: 'character-card-v1',
      title: '无限跑团 Excel 角色卡',
      guessFormName: guessInfiniteHorrorFormName,
      parse: parseInfiniteHorrorCharacterSheets,
      importFile: importInfiniteHorrorCharacterXlsx,
    },
  },
  metadata: {
    builtIn: true,
    description: 'RPGmap 内置无限跑团规则包。',
  },
});

export default infiniteHorrorRuleset;
