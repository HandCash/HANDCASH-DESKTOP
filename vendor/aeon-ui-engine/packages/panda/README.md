# @aeon-ui/panda

**Design tokens and Panda CSS recipes** — workspace-private; ships CSS with `@aeon-ui/ui`.

Agents: run `pnpm codegen` from repo root after any edit here.

## Role

- `defineRecipe` / `defineSlotRecipe` aligned with `@aeon-ui/core` anatomy
- Generated `styled-system/` (do not hand-edit)
- Theme moods in `src/theme/themes.config.ts` → `theme-runtime.css`

## Consumption in apps

```tsx
import '@aeon-ui/panda/styles.css'
import '@aeon-ui/panda/theme-runtime.css'
import '@aeon-ui/panda/scrollbars.css'
import '@aeon-ui/panda/chrome.css'

import { aeonDialog } from '@aeon-ui/panda/styled-system/recipes'
import { applyAeonTheme, AEON_THEMES } from '@aeon-ui/panda/themes'

applyAeonTheme('ocean', 'dark')
const styles = aeonDialog()
```

## Recipe registry

Ground truth: `panda.config.ts` — keys like `aeonButton`, `aeonAsync`, `aeonField`.

Source files: `src/recipes/*.ts` → exported from `src/recipes/index.ts`.

## Conditions (state styling)

Extended conditions in config:

- `aeonOpen`, `aeonClosed`, `aeonPending`, `aeonSuccess`, `aeonFailure`
- `aeonChecked`, `aeonSelected`, `aeonInvalid`

Target `data-aeon-state` in recipes — not arbitrary product class names.

## Codegen

```bash
# from repo root
pnpm codegen
# or
pnpm --filter @aeon-ui/panda codegen
```

Scans: `packages/ui`, `packages/react`, `apps/demo`.

## Add a recipe

1. `src/recipes/<component>.ts` — slot names = anatomy parts
2. Register in `src/recipes/index.ts` and `panda.config.ts`
3. `pnpm codegen`
4. Use in `packages/ui/src/<component>.tsx`

Checklist: [docs/COMPONENT_CHECKLIST.md](../../docs/COMPONENT_CHECKLIST.md).

## Related

- [README.md](../../README.md) — themes section
- [packages/ui/README.md](../ui/README.md)
