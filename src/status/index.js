import { createStatusController } from './controller.js';

export {
  MAX_STACKS,
  STATUS_SCHEMA_VERSION,
  STATUS_ICON_NAMES,
  deriveActorStatuses,
  getStatusDefinitions,
  normalizeEntityStatusState,
  normalizeStatusDefinition,
  reduceStatusOperation,
  resolveStatusCapabilities,
  resolveStatuses,
  statusStateFingerprint,
} from './model.js';
export { applyStatusOperationsToState, createStatusController } from './controller.js';
export * from './ui.js';

export function createStatusSystem() {
  return createStatusController();
}

export default createStatusSystem;
