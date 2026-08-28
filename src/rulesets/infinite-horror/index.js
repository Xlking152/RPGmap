import { prepareRuleset } from '../../ruleset/contract.js';
import { canonicalizeInfiniteHorrorAttributePath, INFINITE_HORROR_ACTOR } from './actor.js';
import { INFINITE_HORROR_HEALTH } from './health.js';
import { deriveInfiniteHorrorStatuses, INFINITE_HORROR_STATUS_DEFINITIONS } from './statuses.js';
import {
  guessInfiniteHorrorFormName,
  parseInfiniteHorrorActorSheets,
  importInfiniteHorrorActorXlsx,
} from './importers/xlsx.js';

export const infiniteHorrorRuleset = prepareRuleset({
  apiVersion: 1,
  id: 'infinite-horror',
  title: '无限跑团',
  version: '1.0.0',
  actor: INFINITE_HORROR_ACTOR,
  health: INFINITE_HORROR_HEALTH,
  statuses: {
    definitions: INFINITE_HORROR_STATUS_DEFINITIONS,
    derive: deriveInfiniteHorrorStatuses,
    canonicalizeChangeTarget: (_actor, path) => canonicalizeInfiniteHorrorAttributePath(path),
  },
  importers: {
    xlsx: {
      id: 'character-card-v1',
      title: '无限跑团 Excel 角色卡',
      guessFormName: guessInfiniteHorrorFormName,
      parse: parseInfiniteHorrorActorSheets,
      importFile: importInfiniteHorrorActorXlsx,
    },
  },
  metadata: {
    builtIn: true,
    description: 'RPGmap 内置无限跑团规则包。',
  },
});

export default infiniteHorrorRuleset;
