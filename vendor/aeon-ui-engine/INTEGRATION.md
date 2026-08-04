# Integration guide

**Agents:** [AGENTS.md](./AGENTS.md) · [docs/API_PATTERNS.md](./docs/API_PATTERNS.md)

**npm consumers:** start with **[CONSUMER.md](./CONSUMER.md)** — install `aeon-ui-engine`, peer deps, and `aeonUiViteAliases()` before any `@aeon-ui/*` import works.

Aeon UI is **three layers**. You can use one or all.

## 1. Headless only (`@aeon-ui/react`)

No Panda required. Machines drive behavior; you style with any system.

```tsx
import { Menu } from '@aeon-ui/react'

<Menu.Root>
  <Menu.Trigger>Actions</Menu.Trigger>
  <Menu.Positioner>
    <Menu.Content>
      <Menu.Item onClick={save}>Save</Menu.Item>
    </Menu.Content>
  </Menu.Positioner>
</Menu.Root>
```

Target stable hooks:

```css
[data-aeon-scope="menu"][data-aeon-part="content"][data-aeon-state="open"] {
  /* your panel */
}
[data-aeon-scope="menu"][data-aeon-part="item"]:hover {
  background: var(--panel-hover);
}
```

Use `partAttrs` / anatomy from `@aeon-ui/core` if you build wrappers.

## 2. Panda recipes (`@aeon-ui/panda`)

Slot recipes align with anatomy parts. Run `pnpm codegen` after recipe changes.

```tsx
import { aeonMenu } from '@aeon-ui/panda/styled-system/recipes'
const styles = aeonMenu()
```

Import CSS once:

```tsx
import '@aeon-ui/panda/styles.css'
import '@aeon-ui/panda/theme-runtime.css'
```

## 3. Styled components (`@aeon-ui/ui`)

Batteries included — recipes applied for you.

```tsx
import { Menu, Button } from '@aeon-ui/ui'
```

## Tailwind example

```html
<button
  data-aeon-scope="button"
  data-aeon-part="root"
  data-aeon-state="pending"
  class="opacity-80 cursor-wait"
>
  Saving…
</button>
```

## Styling stacks (Chakra, Park UI, Tark UI, Shark UI)

Aeon is **headless** like Ark UI — it does not ship adapters for Chakra v3, Park UI, Tark UI, or Shark UI, and that is intentional:

| Stack | Built on | Relationship to Aeon |
|-------|----------|----------------------|
| **Chakra UI v3** | Ark UI + Zag | Different primitive layer. Migrating **from** Ark **to** Aeon → [docs/MIGRATION_FROM_ARK.md](./docs/MIGRATION_FROM_ARK.md). |
| **Park UI** | Panda CSS + Ark | Aeon already pairs **Panda slot recipes + headless** in one repo (`@aeon-ui/ui`). Use Aeon styled or copy recipe patterns. |
| **Tark UI / Shark UI** | Ark + Tailwind | Style Aeon headless with Tailwind the same way — target `data-aeon-scope` / `data-aeon-part` / `data-aeon-state` (see Tailwind example above). |

**What works today:** `@aeon-ui/react` with any CSS system; `@aeon-ui/ui` for Panda-native defaults; thin wrappers in your repo (same pattern as Shark UI’s shadcn-style files).

**What we do not maintain:** drop-in replacement exports for Ark or Chakra recipe APIs — different anatomy prefix, machines, and compound part names.

## XState in your app

Primitives use XState; your features can too. `useAeonMachine` is exported from `@aeon-ui/react` for shared machines.

```tsx
import { useAeonMachine } from '@aeon-ui/react'
import { sicBoMachine } from './machines/sic-bo'
```

## Vite + custom CSS (no Panda)

For apps that keep their own theme (Tailwind, plain CSS, etc.): [docs/VITE_CONSUMER.md](./docs/VITE_CONSUMER.md) — local clone aliases, `build:headless`, `ensure-headless-built.mjs`, and Ark → Aeon mapping.

## Frameworks

React is supported today. **Vue, Solid, and Svelte** ship v0.1 adapter packages (`@aeon-ui/vue`, `@aeon-ui/solid`, `@aeon-ui/svelte`) with `useAeonMachine` and a reference **Switch** port. See [FRAMEWORKS.md](./FRAMEWORKS.md) for the headless contract and install commands.
