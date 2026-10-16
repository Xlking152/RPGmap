import { prepareRuntimeState } from '../engine/runtime-state.js';
import { prepareInlineImageMigration } from '../content/migration.js';

// Validation and inline-image extraction are shared by both persistence adapters.
export async function prepareWorldContentState(raw, context) {
  const content = await prepareInlineImageMigration(raw);
  const prepared = prepareRuntimeState(content.state, context);
  return { ...prepared, migrated: prepared.migrated || content.migrated, records: content.records };
}
