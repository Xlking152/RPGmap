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
- reserved `actorDelta` payload for unlinked/Synthetic Actor support.
- map placement (`x`, `y`) or feature placement (`featureId`).
- size, rotation, elevation, hidden/locked/name-display flags.
- Token-scoped effects.

## Ruleset boundary

`world.ruleset` is canonical. The first-run browser bootstrap key only selects a ruleset while a new/legacy World is being opened. Once World V2 exists, its ruleset id activates the installed Ruleset.

Ruleset-specific HP, B/L/A wound logic, bad-status resources, and XLSX parsing remain outside MapPackage and Token geometry.

## Compatibility projection

The current map shell predates World V2 and still reads:

```text
state.characters[]
state.markers[]
state.attackAreas[]
state.sceneEvents[]
state.preferences.entitySystem
```

These fields are now an **active-Scene compatibility projection**, not the desired long-term ownership model.

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

## Server behavior

The Local/LAN server accepts legacy states without World V2 for backward compatibility.

When `preferences.worldV2` exists, `assertWorldState()` synchronizes the active runtime projection back into World V2 and then validates:

- World/Scene/Actor/Token IDs.
- active Scene references.
- Actor references from Tokens.
- Token placement.
- `actorLink` and `actorDelta` shape.
- MapPackage references.

This is required because server-authoritative Status operations can mutate Actor/Token effects without a browser-side commit.

## Next migrations

World V2 makes the following later removals possible without another storage redesign:

1. Move map rendering/movement from `characters[]` directly to `Scene.tokens[]`.
2. Remove `characterId` as a Token compatibility alias.
3. Implement unlinked Tokens as Base Actor + `actorDelta` Synthetic Actor.
4. Add MapPackage registry/reload so `setActiveScene()` can switch across different maps.
5. Move remaining subsystem state into explicit World/Scene documents where appropriate.

Until those migrations land, code must treat World V2 as canonical and the flat SaveV2 fields as compatibility projections only.
