import { assertDocumentJson } from '../documents/changes.js';
import { normalizeActorDocument } from '../actor/index.js';
import { ACTOR_TYPES } from '../actor/classification.js';
import { contentReference } from '../content/references.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);

export function normalizeLibraryEntry(value) {
  assertDocumentJson(value);
  if (!safeId(value?.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160
    || !ACTOR_TYPES.includes(value.type) || contentReference(value.bodyRef)?.kind !== 'body'
    || !value.ruleset?.id || !value.ruleset?.version) fail('invalid_library_entry');
  if (!Array.isArray(value.tags) || value.tags.length > 24 || value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) fail('invalid_library_tags');
  return { ...structuredClone(value), name: value.name.trim(), tags: [...new Set(value.tags.map(tag => tag.trim()))], archived: value.archived === true };
}

export function normalizeTemplateOrganization(value = {}) {
  assertDocumentJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_template_organization');
  if (value.placementRestricted !== undefined && typeof value.placementRestricted !== 'boolean') fail('invalid_template_organization');
  const tags = value.tags || [];
  if (Array.isArray(value) || !Array.isArray(tags) || tags.length > 24
    || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) fail('invalid_library_tags');
  return { ...structuredClone(value), tags: [...new Set(tags.map(tag => tag.trim()))], archived: value.archived === true };
}

export function assertTemplateLibrary(library) {
  if (library === undefined) return;
  if (!library || Array.isArray(library) || typeof library !== 'object' || Object.keys(library).length > 2000) fail('invalid_template_library');
  for (const [id, entry] of Object.entries(library)) if (id !== normalizeLibraryEntry(entry).id) fail('invalid_library_entry');
}

export function copyActorTemplate(source, { ruleset, id, name = source.name } = {}) {
  if (!safeId(id) || id === source.id) fail('invalid_template_actor_id');
  if (!ruleset.actor.templates?.copySystem) fail('ruleset_template_copy_unsupported');
  const actor = structuredClone(source);
  actor.id = id;
  actor.name = name;
  actor.partyId = null;
  actor.effects = [];
  actor.organization = { ...actor.organization, archived: false, placementRestricted: true };
  actor.system = ruleset.actor.templates.copySystem(source);
  for (const key of ['ownership', 'permissions', 'controllerUserIds', 'audienceRestricted', 'sourceTokenId']) delete actor[key];
  actor.prototypeToken = { ...actor.prototypeToken, visibility: { mode: 'gm', userIds: [] }, controllerUserIds: [] };
  if (actor.prototypeToken.vision) actor.prototypeToken.vision = { ...actor.prototypeToken.vision, overrideUserIds: [] };
  return normalizeActorDocument(actor, { ruleset });
}

export function previewTemplateImport(bundle, world) {
  if (bundle.ruleset.id !== world.ruleset.id || bundle.ruleset.version !== world.ruleset.version) fail('template_ruleset_incompatible');
  const existing = new Map(world.statusDefinitions.map(definition => [definition.id, definition]));
  const conflicts = [];
  for (const definition of bundle.statusDefinitions) {
    const current = existing.get(definition.id);
    if (current && JSON.stringify(current) !== JSON.stringify(definition)) conflicts.push(definition.id);
  }
  return { conflicts: [...new Set(conflicts)], name: bundle.actor.name, type: bundle.actor.type };
}

export function prepareTemplateImport(bundle, world, { ruleset, idFactory = prefix => `${prefix}-${crypto.randomUUID()}` } = {}) {
  const preview = previewTemplateImport(bundle, world);
  const definitions = new Map(world.statusDefinitions.map(definition => [definition.id, definition]));
  const remap = new Map(), additions = [];
  for (const definition of bundle.statusDefinitions) {
    if (!safeId(definition.id) || remap.has(definition.id)) fail('invalid_template_definition');
    const current = definitions.get(definition.id);
    let id = definition.id;
    if (preview.conflicts.includes(id)) id = idFactory('status');
    if (id !== definition.id && definitions.has(id)) fail('duplicate_id');
    remap.set(definition.id, id);
    if (!current || id !== definition.id) {
      const added = { ...structuredClone(definition), id, builtIn: false };
      additions.push(added); definitions.set(id, added);
    }
  }
  const actor = copyActorTemplate(bundle.actor, { ruleset, id: idFactory('actor') });
  if (world.actors.some(value => value.id === actor.id)) fail('duplicate_id');
  actor.publicProfile.visibleStatusDefinitionIds = actor.publicProfile.visibleStatusDefinitionIds.map(id => remap.get(id) || id);
  // Library effects are explicitly saved initial states, not effects copied
  // from a live Token. Each imported template gets fresh instance identities.
  actor.effects = (bundle.actor.effects || []).map(effect => {
    const definitionId = remap.get(effect.definitionId || effect.statusId) || effect.definitionId || effect.statusId;
    if (!definitions.has(definitionId)) fail('template_definition_missing');
    const next = { ...structuredClone(effect), id: idFactory('effect'), definitionId };
    if (next.source?.actorId === bundle.actor.id) next.source.actorId = actor.id;
    delete next.statusId;
    return next;
  });
  return { actor, definitions: additions, remap: Object.fromEntries(remap), conflicts: preview.conflicts };
}
