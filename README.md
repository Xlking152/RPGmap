# RPGmap

RPGmap is an offline-first browser VTT/map runtime with a packaged Local/LAN server option.

## Current architecture checkpoint

The ongoing V1.6 refactor separates generic VTT capabilities from game-system rules and makes World/Scene/Token ownership explicit:

```text
RPGmap Core
├── World V2
│   ├── Ruleset
│   ├── Actors
│   └── Scenes
│       └── Tokens
├── Ruleset runtime
├── Token Runtime V2
├── Synthetic Actor (Base Actor + actorDelta)
├── Movement → Scene Token
└── Renderer → Scene Token
```

The built-in `infinite-horror` ruleset owns its health/status/XLSX semantics. MapPackages own map content and Feature declarations. Core owns Actor/Token/Scene existence, movement, interaction, multiplayer synchronization and rendering.

### Canonical Token runtime

Scene Tokens have independent ids and may share one Actor template. Unlinked Tokens use `actorLink:false + actorDelta` so HP, B/L/A wounds and Actor-scoped status effects can remain instance-local.

Movement and the visible Leaflet Token stack now consume active `Scene.tokens[]` through `api.tokens` rather than using `state.characters[]` as their source of truth. Token display data resolves through `api.tokens.resolveActor()`, so unlinked instances render their Synthetic Actor name/avatar/form data correctly.

The legacy Character projection is still retained temporarily for the sidebar placement/editor UI. It is not the canonical map renderer and is scheduled for removal after that UI is migrated to Token APIs.

See [`文档/WORLD_V2.md`](%E6%96%87%E6%A1%A3/WORLD_V2.md) for the ownership model and migration sequence.

## Development

```bash
npm ci
npm test
npm run build
```

Build the Windows Local/LAN package with:

```bash
npm run package:local-server
```

The CI candidate workflow also validates JavaScript syntax, package contents and starts the packaged Windows server to verify `/api/health`.
