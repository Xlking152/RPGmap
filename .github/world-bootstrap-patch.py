from pathlib import Path
import re


def replace(path, old, new, label, count=1):
    p = Path(path)
    source = p.read_text()
    if old not in source:
        raise RuntimeError(f"Pattern not found: {label} in {path}")
    p.write_text(source.replace(old, new, count))


# Runtime persistence is World-scoped, not MapPackage-scoped.
runtime = "src/engine/runtime.js"
replace(
    runtime,
    """  mapPackage,
  ruleset,
  storageAdapter,
  initialLoad = null,""",
    """  worldId = null,
  worldName = '',
  mapPackage,
  ruleset,
  storageAdapter,
  initialLoad = null,""",
    "runtime World identity arguments",
)
replace(
    runtime,
    """  const persistence = createWorldStatePersistence({
    mapPackage,
    ruleset,
    storageAdapter,""",
    """  const persistence = createWorldStatePersistence({
    worldId,
    worldName,
    mapPackage,
    ruleset,
    storageAdapter,""",
    "runtime World persistence identity",
)
replace(
    runtime,
    "link.download = `${mapPackage.id}-world-${new Date().toISOString().slice(0, 10)}.json`;",
    "link.download = `${worldId || mapPackage.id}-world-${new Date().toISOString().slice(0, 10)}.json`;",
    "World export filename",
)

# For a modern World, active Scene MapPackage is canonical. The flat mapId is a
# projection of the previously active Scene and may legitimately be stale on a
# cross-Map reload.
runtime_state = "src/engine/runtime-state.js"
replace(
    runtime_state,
    """  const metadata = mapMetadata(mapPackage);
  const mapId = String(source.mapId ?? metadata.id).trim();
  const mapVersion = String(source.mapVersion ?? metadata.version).trim();
  if (mapId !== metadata.id) throw new TypeError('state.mapId does not match MapPackage');
  if (mapVersion !== metadata.version) throw new TypeError('state.mapVersion does not match MapPackage');""",
    """  const metadata = mapMetadata(mapPackage);
  const hasCanonicalWorld = Boolean(source.preferences?.[WORLD_STATE_KEY]);
  const mapId = hasCanonicalWorld ? metadata.id : String(source.mapId ?? metadata.id).trim();
  const mapVersion = hasCanonicalWorld ? metadata.version : String(source.mapVersion ?? metadata.version).trim();
  if (mapId !== metadata.id) throw new TypeError('state.mapId does not match MapPackage');
  if (mapVersion !== metadata.version) throw new TypeError('state.mapVersion does not match MapPackage');""",
    "World-aware flat map projection validation",
)

world_model = "src/world/model.js"
replace(
    world_model,
    """  const next = clone(state || {});
  next.markers = clone(scene.markers);""",
    """  const next = clone(state || {});
  next.mapId = currentMap.id;
  next.mapVersion = currentMap.version;
  next.markers = clone(scene.markers);""",
    "project active Scene map metadata",
)

# Infinite Horror seeds generic Actor image/prototype defaults while retaining
# per-Form avatar/tokenAppearance as a Ruleset presentation override.
ih = "src/rulesets/infinite-horror/actor.js"
replace(
    ih,
    """  return {
    name: text(context.name, card.identity.name),
    system: {
      schemaVersion: INFINITE_HORROR_ACTOR_SYSTEM_VERSION,""",
    """  return {
    name: text(context.name, card.identity.name),
    img: card.avatarDataUrl,
    prototypeToken: {
      texture: { src: card.avatarDataUrl },
      color: card.tokenAppearance.color,
      diameterMeters: 1,
      showName: true,
    },
    system: {
      schemaVersion: INFINITE_HORROR_ACTOR_SYSTEM_VERSION,""",
    "Ruleset import Core appearance seed",
)
replace(
    ih,
    """  if (actor.runtime && typeof actor.runtime === 'object') {
    existing.runtime = mergeValue(existing.runtime, actor.runtime);
  }
  return { name: text(actor.name, '未命名角色'), system: existing };""",
    """  if (actor.runtime && typeof actor.runtime === 'object') {
    existing.runtime = mergeValue(existing.runtime, actor.runtime);
  }
  const forms = Array.isArray(existing.forms) ? existing.forms : [];
  const current = forms.find(form => String(form?.id) === String(existing.currentFormId)) || forms[0] || null;
  const hasImg = Object.prototype.hasOwnProperty.call(actor, 'img');
  const hasPrototype = Object.prototype.hasOwnProperty.call(actor, 'prototypeToken');
  const img = hasImg ? actor.img : (actor.avatarDataUrl ?? current?.avatarDataUrl ?? null);
  const prototypeToken = hasPrototype ? clone(actor.prototypeToken) : {
    texture: { src: img },
    color: text(current?.tokenAppearance?.color, '#3d9b63'),
    diameterMeters: 1,
    showName: true,
  };
  return { name: text(actor.name, '未命名角色'), img, prototypeToken, system: existing };""",
    "Ruleset legacy Core appearance migration",
)

# Preserve the previous Health authority rule: once a Health Runtime exists it
# owns maxOverride too. A stale resources.hp mirror may only seed actors that do
# not yet have Health Runtime data.
replace(
    ih,
    "const hpMaxOverride = rawHealthMaxOverride ?? legacyHpMaxOverride;",
    "const hpMaxOverride = hasHealthRuntime ? rawHealthMaxOverride : legacyHpMaxOverride;",
    "Health max override authority precedence",
)

# HP is not a generic Resource. Keep the explicit operation boundary so callers
# get a stable reason instead of treating Health as a missing Resource.
replace(
    ih,
    """  if (type === 'resource.set-current') {
    const changed = setResourceCurrent(actor, operation.resourceId, operation.value);""",
    """  if (type === 'resource.set-current') {
    if (String(operation.resourceId) === 'hp') return { changed: false, blocked: 'health_is_not_resource' };
    const changed = setResourceCurrent(actor, operation.resourceId, operation.value);""",
    "block HP resource set-current",
)
replace(
    ih,
    """  if (type === 'resource.step') {
    const current = resolveInfiniteHorrorAttribute(actor, `system.resources.${operation.resourceId}.current`);""",
    """  if (type === 'resource.step') {
    if (String(operation.resourceId) === 'hp') return { changed: false, blocked: 'health_is_not_resource' };
    const current = resolveInfiniteHorrorAttribute(actor, `system.resources.${operation.resourceId}.current`);""",
    "block HP resource step",
)
replace(
    ih,
    """  if (type === 'resource.set-max') {
    const changed = setResourceMaximum(actor, operation.resourceId, operation.value);""",
    """  if (type === 'resource.set-max') {
    if (String(operation.resourceId) === 'hp') return { changed: false, blocked: 'health_is_not_resource' };
    const changed = setResourceMaximum(actor, operation.resourceId, operation.value);""",
    "block HP resource set-max",
)

# Compatibility Entity helper may carry explicit Core Token overrides.
entities = "src/entities/model.js"
replace(
    entities,
    """    actorId: String(actorId),
    diameterMeters: normalizeTokenDiameterMeters(overrides.diameterMeters ?? overrides.size, 1),""",
    """    actorId: String(actorId),
    texture: overrides.texture && typeof overrides.texture === 'object' ? clone(overrides.texture) : { src: null },
    color: typeof overrides.color === 'string' ? overrides.color : null,
    diameterMeters: normalizeTokenDiameterMeters(overrides.diameterMeters ?? overrides.size, 1),""",
    "Entity Token Core appearance",
)

# World Manager legacy adoption must not invent a MapPackage version. Missing
# version means "load the registered package and accept its canonical version".
manager = "src/world/manager.js"
replace(
    manager,
    "mapPackage: header?.mapPackage?.id ? header.mapPackage : { id: mapId, version: String(mapPackage.version || '1') },",
    "mapPackage: header?.mapPackage?.id ? header.mapPackage : { id: mapId, version: String(mapPackage.version || '') },",
    "legacy MapPackage version",
)

# Scene Manager uses the runtime document rather than an ambient browser global.
scene_manager = "src/scene/manager.js"
replace(
    scene_manager,
    """  const mapElement = api.map?.getContainer?.();
  const shell = mapElement?.closest?.('.app-shell');
  const toolbar = shell?.querySelector?.('.toolbar-right');
  if (!toolbar || toolbar.querySelector('[data-scene-manager]')) return;

  const wrap = document.createElement('label');""",
    """  const mapElement = api.map?.getContainer?.();
  const documentNode = mapElement?.ownerDocument || globalThis.document;
  const shell = mapElement?.closest?.('.app-shell');
  const toolbar = shell?.querySelector?.('.toolbar-right');
  if (!documentNode || !toolbar || toolbar.querySelector('[data-scene-manager]')) return;

  const wrap = documentNode.createElement('label');""",
    "Scene Manager document boundary",
)

# LAN bootstrap tells the client which Active Scene MapPackage to load before
# creating Leaflet, so World bootstrap works identically offline and online.
server = Path("deployment/local-server/server.mjs")
source = server.read_text()
pattern = re.compile(r"function worldBootstrapInfo\(\) \{.*?\n\}\nfunction sendWelcome", re.S)
match = pattern.search(source)
if not match:
    raise RuntimeError("Pattern not found: server worldBootstrapInfo boundary")
replacement = """function worldBootstrapInfo() {
  const rawWorld = world.state?.preferences?.worldV2;
  if (!world.state) return { initialized: false, kind: 'empty', schemaVersion: null, worldId: WORLD_ID, name: null, activeSceneId: null, mapPackage: null, ruleset: null };
  if (!rawWorld || typeof rawWorld !== 'object' || Array.isArray(rawWorld)) {
    return { initialized: true, kind: 'legacy', schemaVersion: null, worldId: WORLD_ID, name: null, activeSceneId: null, mapPackage: null, ruleset: null };
  }
  const scenes = Array.isArray(rawWorld.scenes) ? rawWorld.scenes : [];
  const activeScene = scenes.find(scene => String(scene?.id || '') === String(rawWorld.activeSceneId || '')) || scenes[0] || null;
  return {
    initialized: true,
    kind: 'world-v2',
    schemaVersion: Number(rawWorld.schemaVersion) || null,
    worldId: String(rawWorld.id || WORLD_ID),
    name: String(rawWorld.name || ''),
    activeSceneId: activeScene?.id ? String(activeScene.id) : null,
    mapPackage: activeScene?.mapPackage?.id ? {
      id: String(activeScene.mapPackage.id),
      version: String(activeScene.mapPackage.version || ''),
    } : null,
    ruleset: {
      id: String(rawWorld.ruleset?.id || ''),
      version: String(rawWorld.ruleset?.version || ''),
    },
  };
}
function sendWelcome"""
server.write_text(source[:match.start()] + replacement + source[match.end():])

# A server-authoritative Scene activation can change MapPackage. Do not import
# that World into a runtime created for another map; update the revision and
# reload so main.js boots the new Active Scene package from server metadata.
mp = "src/multiplayer/controller.js"
replace(
    mp,
    """            await api.importState(requestedState, false);
            if (epoch !== remoteEpoch) return false;
            revision = requestedRevision;""",
    """            const requestedWorld = requestedState?.preferences?.worldV2;
            const requestedScenes = Array.isArray(requestedWorld?.scenes) ? requestedWorld.scenes : [];
            const requestedScene = requestedScenes.find(scene => String(scene?.id || '') === String(requestedWorld?.activeSceneId || '')) || requestedScenes[0] || null;
            const requestedMapId = String(requestedScene?.mapPackage?.id || '');
            const loadedMapId = String(api.mapPackage?.id || api.mapPackage?.mapId || '');
            if (requestedMapId && loadedMapId && requestedMapId !== loadedMapId) {
              revision = requestedRevision;
              lastServerState = structuredClone(serverState);
              lastObservedLocalState = structuredClone(requestedState);
              setMapStatus(`Scene 已切换到 ${requestedMapId}，正在重新载入地图…`);
              queueMicrotask(() => documentNode.defaultView?.location?.reload?.());
              return true;
            }
            await api.importState(requestedState, false);
            if (epoch !== remoteEpoch) return false;
            revision = requestedRevision;""",
    "multiplayer cross-Map Scene reload",
)

# Update the pre-existing Actor contract test to the established v3 API shape:
# deriveActorDocument.resources is an array, and custom Resources use
# resource.add-custom/resourceId.
contract_test = "tests/actor-ruleset-contract.test.js"
replace(
    contract_test,
    """  assert.equal(derived.resources.stamina.current, 4);
  assert.equal(derived.resources.focus.current, 2);""",
    """  assert.equal(derived.resources.find(resource => resource.id === 'stamina')?.current, 4);
  assert.equal(derived.resources.find(resource => resource.id === 'focus')?.current, 2);""",
    "Actor derived Resource array assertions",
)
replace(
    contract_test,
    "const custom = performActorOperation(actor, { type: 'resource.custom-create', id: 'hp', name: '假生命', max: 99 }, context);",
    "const custom = performActorOperation(actor, { type: 'resource.add-custom', resourceId: 'hp', name: '假生命', max: 99 }, context);",
    "Actor custom Resource operation name",
)
