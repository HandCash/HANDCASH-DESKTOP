# Using `aeon-ui-engine` from npm

One package. Install once. `@aeon-ui/*` resolves automatically.

Aeon is **React-first** (Next.js included). Vue / Solid / Svelte adapters are thin — not the main product.

## 0. Existing app? Migrate first

```bash
npx aeon-ui migrate
```

Scans for known local workarounds (custom dropzones, range sliders, toast bridges, hand-rolled link buttons) and writes `AEON_MIGRATION_CHECKLIST.md`. Use `--check` to print findings only. New projects can skip straight to install + `npx aeon-ui init`.

## 1. Install

```bash
npm install aeon-ui-engine react react-dom xstate @xstate/react
```

**Postinstall** runs `scripts/link-scoped-packages.mjs`, which symlinks:

`node_modules/@aeon-ui/*` → `node_modules/aeon-ui-engine/packages/*`

Re-run manually anytime:

```bash
npx aeon-ui link
# or
node node_modules/aeon-ui-engine/scripts/link-scoped-packages.mjs
```

No bundler aliases are required for `@aeon-ui/ui` / `@aeon-ui/react` imports.

## 2. Import CSS (one line)

```tsx
// app/layout.tsx (Next.js) or main.tsx (Vite)
import 'aeon-ui-engine/aeon.css'
```

## 3. Use components

```tsx
import { Button, Dialog, Menu, Toast } from '@aeon-ui/ui'
```

---

## Next.js

```js
// next.config.mjs
export default {
  transpilePackages: [
    '@aeon-ui/ui',
    '@aeon-ui/react',
    '@aeon-ui/core',
    '@aeon-ui/primitives',
    '@aeon-ui/panda',
  ],
}
```

Mark interactive surfaces as Client Components:

```tsx
'use client'
import { Button } from '@aeon-ui/ui'
```

No `resolve.alias` / webpack alias block. If Turbopack mis-resolves after install, run `npx aeon-ui link` and prefer `next dev --webpack` while evaluating.

---

## Vite (optional plugin)

Scoped imports already work via the link step. The Vite plugin is optional — it still helps with `optimizeDeps` and monorepo `packagesRoot`:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { aeonUiVitePlugin } from 'aeon-ui-engine/vite'

export default defineConfig({
  plugins: [react(), aeonUiVitePlugin()],
})
```

---

## Optional: TypeScript

Linked packages usually typecheck via each package’s `types` field. If needed:

```json
{
  "extends": "aeon-ui-engine/tsconfig.base.json"
}
```

## Optional: Brand palette (skip catalog themes)

If your product already has tokens, map them onto Aeon CSS vars once at boot:

```ts
import { applyBrandPalette } from '@aeon-ui/core'

applyBrandPalette(
  {
    bg: '#000000',
    surface: '#0a0a0a',
    border: '#262626',
    text: '#fafafa',
    muted: '#a1a1aa',
    accent: '#57ff97',
    font: "'Archivo', system-ui, sans-serif",
  },
  { mode: 'dark' },
)
```

Then use `@aeon-ui/ui` without maintaining a parallel `--product-*` token sheet
for Aeon components. See [docs/PRODUCT_SHELL.md](./docs/PRODUCT_SHELL.md).

## Optional: Product shell compounds

```tsx
import { AppNav, Prompt, StatusBanner, AppShell } from '@aeon-ui/ui'

// Section + detail stack (replaces ad-hoc nav stores)
<AppNav.Root defaultSection="home">...</AppNav.Root>

// Confirm / permission style dialog (portal + focus trap via Dialog)
<Prompt.Root open={open} status="pending">...</Prompt.Root>

// Non-blocking top banner (updates, sync, offline)
<StatusBanner.Root status="ready">...</StatusBanner.Root>
```

Electron titlebar helpers (drag regions, traffic-light padding):

```ts
import '@aeon-ui/panda/electron.css'
```

## Optional: Headless only

Skip the styled layer and import headless components directly:

```tsx
import { Menu, Dialog, useAeonMachine } from '@aeon-ui/react'
```

Style with any CSS system using `data-aeon-scope`, `data-aeon-part`, `data-aeon-state` attributes.

## Optional: Local monorepo

Point the Vite plugin at a local checkout (or set `AEON_UI_ROOT` before `aeon-ui link`):

```ts
aeonUiVitePlugin({ packagesRoot: '/path/to/aeon-ui/packages' })
```

## Reference consumer

[Casino-games](https://github.com/GenericCPU/Casino-games) uses the engine install pattern. Next.js consumers: install + link + `transpilePackages` (see above).
