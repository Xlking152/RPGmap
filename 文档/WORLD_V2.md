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

This synchronization also means a Player cannot move a Token by forging only `worldV2.scenes[].tokens[]`: before authorization/persistence, the active Scene Token mirror is reconstructed from the submitted runtime projection. Legitimate Movement commits submit matching canonical and compatibility projections; canonical-only tampering is overwritten before it can persist.

## Completed runtime migrations

1. World V2 canonical storage and active-Scene compatibility projection.
2. independent Scene Token identity and placement.
3. Base Actor + `actorDelta` Synthetic Actor health/runtime semantics.
4. Synthetic Actor status resolution and authoritative status writes.
5. Selection/Combat/Token-health consumers beginning to read canonical Tokens.
6. Movement, collision planning, Feature enter/exit and movement authority using `Scene.tokens[]`.

## Next migrations

The next runtime migration is **Renderer → `Scene.tokens[]`**. Renderer is intentionally next because Movement is already canonical while the visible Leaflet Token layer still consumes the Character compatibility projection.

1. Render map Tokens from `api.tokens.list()` / active `Scene.tokens[]` rather than `state.characters[]`.
2. Resolve display name/avatar/color from `Token + resolved Actor/Synthetic Actor`.
3. Keep only a thin Character compatibility projection for remaining Actor placement/editor UI.
4. Migrate Actor placement UI to canonical Token create/update/remove APIs.
5. Remove `characterId` as a Token compatibility alias and finally retire `state.characters[]`.
6. Add MapPackage registry/reload so `setActiveScene()` can switch across different maps.
7. Move remaining subsystem state into explicit World/Scene documents where appropriate.

Until those migrations land, code must treat World V2 as canonical and the flat SaveV2 fields as compatibility projections only.
