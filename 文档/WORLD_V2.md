# RPGmap World V2

World V2 is the canonical campaign/session data model introduced after Ruleset V1.

## Ownership hierarchy

```text
World
├── ruleset
├── actors[]
├── statusDefinitions[]
├── activeSceneId
└── scenes[]
    ├── mapPackage
    ├── tokens[]
    ├── markers[]
    ├── attackAreas[]
    └── sceneEvents[]
```

### World owns

- Ruleset identity/version.
- Actor source/runtime data.
- World-level status definitions.
- Scene catalog and active Scene identity.

### Scene owns

- MapPackage reference.
- Token instances and placement.
- Markers and attack areas.
- Destruction/restore history (`sceneEvents`).
- Scene-local presentation settings such as grid visibility.

### Token owns

- `id` and `actorId`.
- `actorLink`.
- `actorDelta` for unlinked/Synthetic Actor instance data.
- map placement (`x`, `y`) or feature placement (`featureId`).
- size, rotation, elevation, hidden/locked/name-display flags.
- Token-scoped effects.

For an unlinked Token, runtime Actor state resolves as:

```text
Base World Actor + token.actorDelta = Synthetic Actor
```

Independent health and Actor-scoped status effects for that Token instance are persisted in `actorDelta`; the World Actor template and sibling Tokens are not mutated.

## Ruleset boundary

`world.ruleset` is canonical. The first-run browser bootstrap key only selects a ruleset while a new/legacy World is being opened. Once World V2 exists, its ruleset id activates the installed Ruleset.

Ruleset-specific HP, B/L/A wound logic, bad-status resources, and XLSX parsing remain outside MapPackage and Token geometry.

## Compatibility projection

The current map shell predates World V2 and still has consumers of:

```text
state.characters[]
state.markers[]
state.attackAreas[]
state.sceneEvents[]
state.preferences.entitySystem
```

These fields are an **active-Scene compatibility projection**, not the desired long-term ownership model.

`createWorldSystem()` wraps AppCore mutation boundaries:

```text
legacy runtime mutation
        ↓
synchronizeWorldV2FromRuntimeState()
        ↓
commit / authoritative commit
```

Remote imports run in the opposite direction:

```text
World V2 snapshot
        ↓
projectWorldV2ToRuntimeState()
        ↓
legacy active-Scene UI
```

This lets the repository migrate subsystem-by-subsystem without keeping two independent sources of truth.

## Movement ownership

Movement is now a canonical Scene Token subsystem. `src/movement/token-runtime.js` owns the authoritative movement boundary:

```text
tokenId
  ↓
api.tokens.get(tokenId)
  ↓
Scene Token x/y + elevation + diameter + resolved status
  ↓
path / collision validation
  ↓
api.movement.planTokenMove()
  ↓
api.movement.commitTokenMove()
  ↓
Scene.tokens[]
  ↓
api.world.commit()
```

Feature placement uses the same model:

```text
map placement       feature placement
{x, y}       ↔       {featureId}
```

Entering a Feature changes canonical Token placement only after the interactive route is confirmed. Leaving a Feature resolves a walkable map point and writes the Token back to map placement. Feature status side effects are applied to the canonical World in the same commit; Actor-scoped effects on an unlinked Token are redirected to its Synthetic Actor.

`api.planCharacterMove()`, `api.commitCharacterMove()`, `api.exitBuilding()` and `character:move` remain temporary compatibility facades/events for the old shell. Movement itself no longer treats `characters[].location` as authoritative.

## Renderer ownership

The visible Leaflet Token stack is now canonical. `src/render/token-layer.js` renders only active Scene Tokens:

```text
api.tokens.list()
  ↓
Scene.tokens[]
  ↓
api.tokens.resolveActor(tokenId)
  ↓
Base Actor or Synthetic Actor
  ↓
Token ViewModel
  ├── x / y / diameter / rotation / elevation / hidden / showName
  └── Actor name / active-form avatar / token color
  ↓
Leaflet Token layer
  ├── Token body + name tooltip
  ├── elevation label
  └── canonical Status badges
```

Token health bars likewise enumerate `api.tokens.list()` and resolve health by Token id. Renderer and health overlay source files no longer read `state.characters[]` or `preferences.entitySystem`.

The old AppCore `characterPane` is still constructed because the current character sidebar/editor owns private legacy view state. Token Renderer V2 hides that pane and its old tooltip/status overlay; it is a compatibility implementation detail, not a visible renderer. This allows the map surface to be canonical before the editor/placement UI is fully replaced.

Selection remains Token-based. A Token click updates canonical Token selection and emits `token:select`; `selectCharacter(tokenId)` is invoked only as a temporary sidebar-focus bridge until the character editor is replaced.

## Actor placement and reposition ownership

Modern Actor placement creates the Scene Token directly. The Entity panel may still provide the temporary Actor-selection HUD, but it no longer creates a Character first and then binds that Character into a Token.

```text
Entity panel selects Actor
        ↓
placement HUD / map click
        ↓
snapActorTokenPlacementPoint()
        ↓
current-map placement validation
        ↓
createActorTokenAtPoint()
        ↓
api.tokens.create({ actorId, x, y, ... })
        ↓
Scene.tokens[]
        ↓
api.world.commit()
        ↓
World V2 projects temporary Character/Entity compatibility views
```

Modern reposition follows the same placement policy but updates the existing Scene Token:

```text
Token editor “重新放置”
        ↓
canonical tokenId
        ↓
map click + 1 m snap
        ↓
inspectTokenPlacement(tokenId, point)
        ↓
relocateActorTokenAtPoint()
        ↓
api.tokens.move(tokenId, point)
        ↓
Scene.tokens[]
```

Passing the current Token id into placement inspection lets navigation exclude the mover's own occupied cell. Blocked locations never call `api.tokens.move()`.

`src/token/placement.js` owns the current map shell's 1 m cell-centre snapping and placement check. `api.tokens.create()` / `api.tokens.move()` themselves deliberately remain UI agnostic so future scripts, teleport operations and Scene initialization are not forced through the interactive placement policy.

`src/token/actor-placement-ui.js` is explicitly transitional. It captures the modern Entity create/reposition actions before the legacy Entity/AppCore handlers, so those actions cannot also reach `placeCharacter()` or `repositionCharacter()`. Compatibility `character:create` / `character:move` events are notifications after the canonical commit, not data writes.

## Token property ownership

Token presentation/geometry properties are written through the canonical Token runtime. `src/token/properties.js` is the DOM-free property boundary:

```text
tokenId
  ↓
api.tokens.get(tokenId)
  ↓
normalize requested value
  ↓
api.tokens.update(tokenId, patch)
  ↓
Scene.tokens[]
  ↓
api.world.commit()
```

Canonical helpers cover:

- `hidden` / visible state.
- `diameterMeters`.
- `rotation` normalized to `[0, 360)`.
- `elevationFt` normalized to a non-negative value.

`src/token/property-ui.js` is a transitional editor bridge around the current Entity/Elevation surfaces. It captures the old Token-page diameter/elevation controls before their Character-era handlers run, and adds visible/rotation controls to the same Token cards. These edits never call `EntityStore.persist()`, `api.commitState()` or write `state.characters[]` directly.

The public Token-height methods on `api.elevation` are wrapped after the Elevation system registers, so Token elevation edits use `api.tokens.update()` while Feature blocking-height editing remains owned by the existing Feature/Elevation subsystem. The existing elevation permission preflight is preserved.

The canonical renderer consumes these fields directly:

```text
hidden          → Token map visibility
diameterMeters  → rendered diameter + collision context
rotation        → Token portrait rotation
elevationFt     → elevation label + movement/collision context
```

`token:size-change` and `elevation:token-change` remain compatibility/runtime invalidation events so an already-previewed movement route is discarded when size or height changes.

## Entity editor Token read ownership

The Entity editor treats the active Scene Token catalog as a read-only canonical view instead of using the Entity Token mirror as its display source.

```text
Actor card Token count / Status Token list
        ↓
api.tokens.list()

Token card placement / geometry / flags
        ↓
api.tokens.get(tokenId)

Token card Actor display
        ↓
api.tokens.resolveActor(tokenId)
        ↓
World Actor or Synthetic Actor
```

`src/entities/token-read-ui.js` is the current read bridge. It refreshes Actor Token counts and Token card placement/display data from the canonical runtime and exposes `api.entityTokenReads` for the remaining editor migration. The bridge is deliberately read-only: it does not call Token create/move/update/remove operations and does not read `state.characters[]` or `preferences.entitySystem`.

The long-lived Entity editor store also receives a UI-scoped live Token catalog, so existing editor/status code that still asks its local `state.tokens` view is backed by `api.tokens.list()`. This scope is intentionally limited to the Entity UI instance:

```text
Entity UI EntityStore
  → canonical Token read view

Health / Status / Damage reducer EntityStore
  → mutable World draft Tokens
```

This distinction is required for Synthetic Actor operations. Reducers must mutate the Token object inside their draft (for example `token.actorDelta`) and persist that exact draft atomically; replacing reducer Tokens with clones returned by `api.tokens.get()` / `list()` would discard those changes.

## Token and Actor deletion ownership

Modern deletion is now canonical as well.

A single active-Scene Token is deleted through:

```text
Entity Token delete
        ↓
api.tokens.get(tokenId)
        ↓
api.tokens.remove(tokenId)
        ↓
removeSceneToken()
        ├── detach Token-bound attackArea anchors
        └── remove Scene.tokens[] entry
        ↓
api.world.commit()
```

A Token-bound attack area is converted to a free anchor in the same World mutation. If the Token was on the map, the area's origin is frozen at the Token's last canonical `x/y`; a Feature-placed Token keeps the area's existing origin because another Scene/MapPackage may not be loaded to resolve a Feature centre safely.

`src/entities/token-delete-ui.js` captures both the current Entity Token delete controls and the old `delete-character` button path before AppCore can mutate `state.characters[]`. It also replaces the public `api.deleteCharacter(tokenId)` compatibility method with a canonical facade that delegates to Token Runtime. New deletion paths emit `token:delete`, not `character:delete`.

Actor deletion is a World-level structural operation rather than a loop over current-Scene Characters:

```text
Actor delete
   ↓
scan world.scenes[]
   ↓
remove every Token whose actorId matches
   ├── Scene A
   ├── Scene B
   └── ...
   ↓
detach their Scene-local attackArea anchors
   ↓
remove World Actor
   ↓
api.world.commit()
```

This preserves the Actor → many Tokens model across multiple Scenes. `src/entities/canonical-delete.js` owns the DOM-free deletion operation and never calls `deleteCharacter()`, `EntityStore.removeToken()` or `EntityStore.removeActor()`.

The old AppCore Character deletion function and EntityStore compatibility methods still exist internally for the remaining bridge/fallback code. They are no longer the public or visible modern deletion path and are scheduled for removal together with the Character facade.

## Feature occupant view ownership

The visible Feature inspector occupant list now comes from canonical active-Scene Tokens:

```text
selected Feature id
       ↓
api.tokens.list()
       ↓
placement === 'feature' && featureId matches
       ↓
api.tokens.resolveActor(tokenId)
       ↓
Linked Actor or Synthetic Actor display
```

`src/entities/feature-token-view.js` is the DOM-free resolver and `src/entities/feature-token-ui.js` overlays the current Feature inspector while AppCore is still present. Synthetic Actor name/avatar/form overrides are therefore displayed per Token instance rather than from the Character compatibility projection.

The older AppCore Feature template still exists underneath this transitional bridge and will be deleted when the AppCore Character sidebar is retired; it is not the visible occupant data source after the bridge registers.

## World referential integrity before Local/LAN authority

Deleting a Token or Actor can invalidate Combat references. The Local/LAN server correctly rejects a World where a Combatant refers to a missing Token or Actor, so post-commit UI cleanup would be too late.

World V2 therefore prunes dangling runtime references before authoritative validation:

```text
canonical World mutation
        ↓
projectWorldV2ToRuntimeState()
        ↓
pruneProjectedWorldReferences()
        ├── keep valid Combatants
        └── remove missing tokenId / actorId references
        ↓
coreCommitAuthoritativeState()
        ↓
Local/LAN validation + persistence
```

This makes Token/Actor deletion one atomic server-valid operation. If the final Combatant is removed, the temporary Combat projection is cleared rather than persisting an empty dangling tracker.

## Server behavior

The Local/LAN server accepts legacy states without World V2 for backward compatibility.

When `preferences.worldV2` exists, `assertWorldState()` synchronizes the active runtime projection back into World V2 and then validates:

- World/Scene/Actor/Token IDs.
- active Scene references.
- Actor references from Tokens.
- Token placement.
- `actorLink` and `actorDelta` shape.
- MapPackage references.
- Synthetic Actor status instances through the normal Actor Status schema.
- Combatant Token/Actor references against the submitted authoritative projection.

This synchronization also means a Player cannot move a Token by forging only `worldV2.scenes[].tokens[]`: before authorization/persistence, the active Scene Token mirror is reconstructed from the submitted runtime projection. Legitimate Movement commits submit matching canonical and compatibility projections; canonical-only tampering is overwritten before it can persist.

## Completed runtime migrations

1. World V2 canonical storage and active-Scene compatibility projection.
2. Independent Scene Token identity and placement.
3. Base Actor + `actorDelta` Synthetic Actor health/runtime semantics.
4. Synthetic Actor status resolution and authoritative status writes.
5. Selection and Combat reading canonical Tokens.
6. Movement, collision planning, Feature enter/exit and movement authority using `Scene.tokens[]`.
7. Visible Leaflet Token renderer, Token status badges and Token health bars reading canonical `Scene.tokens[]`.
8. Modern Actor map placement writing directly through `api.tokens.create()` instead of `placeCharacter()` + `bindToken()`.
9. Modern Token reposition writing through `api.tokens.move()` instead of `repositionCharacter()` / `characters[].location`.
10. Token hidden/diameter/rotation/elevation edits writing through `api.tokens.update()`, with renderer output driven by the same canonical fields.
11. Entity editor Token counts/lists/placement/display reading `api.tokens.list()` / `get()` / `resolveActor()` through a UI-scoped canonical read view.
12. Single Token deletion writing through `api.tokens.remove()` with Token-bound attack-area anchors detached atomically.
13. Actor deletion removing every matching Token across all Scenes before removing the World Actor.
14. Feature inspector occupant display reading canonical Feature-placed Tokens and resolved Linked/Synthetic Actors.
15. World authoritative commits pruning dangling Combat references before Local/LAN validation.
16. Public `api.deleteCharacter()` compatibility calls routing to canonical Token deletion instead of Character storage.

At this point the modern Token CRUD surface is canonical:

```text
Create   → api.tokens.create()
Read     → api.tokens.list() / get() / resolveActor()
Move     → api.tokens.move() / placeInFeature()
Update   → api.tokens.update()
Delete   → api.tokens.remove()
```

## Next migrations

Token CRUD and the visible Entity/Feature Token paths are canonical. The remaining Character code is now compatibility implementation rather than the modern data path.

1. Replace the temporary Actor-placement/property/read/delete/Feature UI bridges with a direct canonical Entity editor implementation.
2. Remove dormant `character:create` / `character:move` / `character:delete` compatibility listeners and AppCore Character mutation functions once no fallback caller remains.
3. Remove `characterId` as a Token compatibility alias and finally retire `state.characters[]` plus the hidden `characterPane`.
4. Move remaining Feature destruction/ejection and attack-area Character anchors to explicit Token ids/names instead of Character-era field names.
5. Add MapPackage registry/reload so `setActiveScene()` can switch across different maps.
6. Move remaining subsystem state, including Combat, into explicit World/Scene documents where appropriate.

Until those migrations land, code must treat World V2 as canonical and the flat SaveV2 fields as compatibility projections only.
