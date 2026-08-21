# App Shell UI consolidation

- Replace the legacy top-level marker / character-move tool clutter with Select, Measure, Range and Scene entry points.
- Retire Marker UI nodes from the active shell and keep legacy save actions behind a compact Save menu.
- Rebuild the sidebar around Actor Library and Current Inspector contexts.
- Add a global bottom status bar that mirrors tool state and selected Token/Form state.
- Show the 5/10/20/50/100m movement-step control only while movement planning is active.
- Add Token context actions for Actor Sheet, Form switching, locking/unlocking and removing a Token from the map while retaining Actor data.
- Keep UI orchestration under `src/ui/` so MovementSystem and EntitySystem stay independent.
