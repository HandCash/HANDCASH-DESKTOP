# Using `aeon-ui-engine` from npm

One package. One plugin. Done.

## 1. Install

```bash
npm install aeon-ui-engine react react-dom xstate @xstate/react
```

## 2. Vite plugin

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { aeonUiVitePlugin } from 'aeon-ui-engine/vite'

export default defineConfig({
  plugins: [react(), aeonUiVitePlugin()],
})
```

## 3. Import CSS (one line)

```tsx
// main.tsx or app entry
import 'aeon-ui-engine/aeon.css'
```

## 4. Use components

```tsx
import { Button, Dialog, Menu, Toast } from '@aeon-ui/ui'
```

That's it. The plugin handles all `@aeon-ui/*` aliases, TypeScript paths, and optimizeDeps.

---

## Optional: TypeScript

If your tsconfig doesn't extend the engine base:

```json
{
  "compilerOptions": {
    "paths": {
      "@aeon-ui/*": ["./node_modules/aeon-ui-engine/packages/*/src"]
    }
  }
}
```

Or extend directly:

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

Point the plugin at a local checkout:

```ts
aeonUiVitePlugin({ packagesRoot: '/path/to/aeon-ui/packages' })
```

## Reference consumer

[Casino-games](https://github.com/GenericCPU/Casino-games) uses this exact pattern.
