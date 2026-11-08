---
name: ui-verify-via-statechart-render
when: making or reviewing a UI change
---
Check UI by rendering chart states with mock data: `npm run ui:render -- --fixture <name>` (dark/light at 360/430/1440; fails on overflow or a machine off its declared state).
Declare states as data in tests/render/states/*.json (snapshot value + context, never event replays); each shot gets a .state.json of what actually rendered.
