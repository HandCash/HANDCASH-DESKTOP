# @aeon-ui/core

**DOM contract and anatomy** — no React, no XState runtime in components.

Agents: read [AGENTS.md](../../AGENTS.md) and [docs/FILE_MAP.md](../../docs/FILE_MAP.md).

## Install

```bash
pnpm add @aeon-ui/core
```

Usually consumed via `@aeon-ui/react` or `@aeon-ui/ui`.

## Exports

| Module | Purpose |
|--------|---------|
| `philosophy` | `UI_IS_FUNCTION_OF_STATE`, `AEON_PRINCIPLE` |
| `anatomy` | `buttonAnatomy`, `asyncAnatomy`, `fieldAnatomy`, … |
| `attrs` | `partAttrs`, `scopeAttrs`, `partOnlyAttrs`, `stateToAttr` |
| `machine` | `createAeonMachine` — XState `setup` helper |
| `scroll` | `getScrollSnapshot(element)` |
| `layout` | Normalized coords, `ResponsiveLayoutSpec`, `layoutModeAttrs` |
| `types` | Shared types |

### Play-surface layout (coordinates)

```ts
import {
  playSurfaceAnatomy,
  normFromClient,
  layoutModeAttrs,
  type ResponsiveLayoutSpec,
} from '@aeon-ui/core'
```

See [docs/LAYOUT_COORDINATES.md](../../docs/LAYOUT_COORDINATES.md).

## Anatomy

```ts
import { asyncAnatomy, partAttrs } from '@aeon-ui/core'

partAttrs(asyncAnatomy.scope, asyncAnatomy.readout, {
  state: 'loading',
})
// → data-aeon-scope="async" data-aeon-part="readout" data-aeon-state="loading"
```

## Parallel regions

```ts
import { fieldFace, fieldRegions, stateToAttr } from '@aeon-ui/core'

// Debug / serialization — not product UI labels
stateToAttr({ interaction: 'dirty', validation: 'invalid', submission: 'idle' })
// → "interaction:dirty validation:invalid submission:idle"

// Field DOM face (same hierarchy as Button status)
fieldFace({ interaction: 'dirty', validation: 'invalid', submission: 'idle' }) // "invalid"
fieldRegions({ interaction: 'dirty', validation: 'invalid', submission: 'idle' })
// → { interaction: "dirty", validation: "invalid", submission: "idle" }
```

## Adding a scope

1. Add `myAnatomy = anatomy('my', ['root', ...] as const)` in `src/anatomy.ts`.
2. Use in React via `partAttrs`.
3. Follow [docs/COMPONENT_CHECKLIST.md](../../docs/COMPONENT_CHECKLIST.md).

## Related

- [STATES.md](../../STATES.md) — attribute contract
- [packages/primitives/README.md](../primitives/README.md) — machines
