function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function targetError(message, code = 'unknown_actor_attribute_path') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function actorKey(actor, fallback = '') {
  return String(actor?.id || fallback || '(unknown)');
}

function allowedTargets(ruleset, actor) {
  if (typeof ruleset?.actor?.attributePaths !== 'function') return null;
  const values = ruleset.actor.attributePaths(actor) || [];
  return new Set((Array.isArray(values) ? values : [])
    .map(item => String(item?.path || '').trim())
    .filter(Boolean));
}

export function canonicalizeStatusChangeTarget(ruleset, actor, target) {
  const raw = String(target ?? '').trim();
  if (!raw) return '';
  const canonicalize = ruleset?.statuses?.canonicalizeChangeTarget;
  if (typeof canonicalize !== 'function') return raw;
  return String(canonicalize(actor, raw) ?? '').trim();
}

/**
 * Validate and canonicalize StatusDefinition numeric targets against concrete
 * Actors. Attribute paths are the Ruleset's writable mechanical surface; a
 * separately resolvable/read-only path is intentionally not enough.
 *
 * With no concrete Actor context the definition remains reusable and is left
 * unchanged. It will be checked when it is applied to an Actor later.
 */
export function validateStatusDefinitionForActors(definition, actors = [], ruleset = null) {
  const result = clone(definition || {});
  const changes = Array.isArray(result.changes) ? result.changes : [];
  if (!changes.length || typeof ruleset?.actor?.attributePaths !== 'function') return result;

  const concrete = (Array.isArray(actors) ? actors : [actors]).filter(Boolean);
  if (!concrete.length) return result;

  let canonicalTargets = null;
  for (const actor of concrete) {
    const allowed = allowedTargets(ruleset, actor) || new Set();
    const actorTargets = changes.map(change => {
      const target = canonicalizeStatusChangeTarget(ruleset, actor, change?.target);
      if (!target || !allowed.has(target)) {
        throw targetError(`Ruleset does not expose status target ${String(change?.target || '(missing)')} for Actor ${actorKey(actor)}`);
      }
      return target;
    });

    if (canonicalTargets === null) canonicalTargets = actorTargets;
    else if (actorTargets.some((target, index) => target !== canonicalTargets[index])) {
      throw targetError('Status target canonicalization differs between affected Actors', 'status_target_ambiguous');
    }
  }

  result.changes = changes.map((change, index) => ({ ...clone(change), target: canonicalTargets[index] }));
  return result;
}

export default validateStatusDefinitionForActors;
