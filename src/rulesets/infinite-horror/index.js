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
  version: '1.1.0',
  actor: INFINITE_HORROR_ACTOR,
  health: INFINITE_HORROR_HEALTH,
  statuses: {
    definitions: INFINITE_HORROR_STATUS_DEFINITIONS,
    derive: deriveInfiniteHorrorStatuses,
    canonicalizeChangeTarget: (_actor, path) => canonicalizeInfiniteHorrorAttributePath(path),
  },
  vision: {
    describe(actor, context = {}) {
      return INFINITE_HORROR_ACTOR.derive(actor, context)?.detection
        || Object.freeze({ enabled: false, rangeMeters: 0, preciseRangeMeters: 0, vagueRangeMeters: 0, senses: {} });
    },
  },
  movement: {
    describe(actor, context = {}) {
      const granted = {
        ...(actor?.system?.runtime?.movementCapabilities || {}),
        ...(context.token?.movement?.capabilities || {}),
      };
      return Object.freeze({
        walk: granted.walk !== false,
        swim: granted.swim !== false,
        waterWalk: granted.waterWalk === true,
        fly: granted.fly === true,
        swimCostMultiplier: Number.isFinite(Number(granted.swimSpeedMeters)) ? 1 : 2,
      });
    },
    calculateCost({ defaultCostMeters }) {
      return defaultCostMeters;
    },
  },
  calculations: {
    explain: INFINITE_HORROR_ACTOR.explainCalculation,
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
