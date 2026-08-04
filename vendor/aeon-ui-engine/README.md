# Aeon UI

**Statechart-driven UI — clear for humans, precise for agents.**

**State is defined first. UI represents the totality of that definition.**

> **Coding agents:** read **[AGENTS.md](./AGENTS.md)** first, then [docs/AI.md](./docs/AI.md) and [docs/INDEX.md](./docs/INDEX.md). Human overview below.

Aeon UI models interactive behavior as executable [statecharts](https://www.theseus.fi/bitstream/handle/10024/334118/Thanh_Nguyen.pdf?sequence=2&isAllowed=y), publishes **deterministic JSON schemas** for Generative UI, exposes production-ready headless compound components, and ships a styled layer powered by **[Panda CSS](https://panda-css.com)** slot recipes aligned with `@aeon-ui/core` anatomy. Every primitive projects a full machine snapshot onto the DOM — structure, copy, and `data-aeon-state` stay in sync.

## Packages

| Package | Purpose |
|---------|---------|
| `@aeon-ui/core` | Anatomy tokens, `data-aeon-*` attributes, machine helpers |
| `@aeon-ui/primitives` | XState machines (toggle, dialog, tabs, accordion, async, button lifecycle, field) |
| `@aeon-ui/react` | React headless bindings |
| `@aeon-ui/schemas` | JSON Schema catalog + agent system prompts |
| `@aeon-ui/cli` | `npx aeon-ui init` — Cursor rules, schemas, starter |
| `@aeon-ui/panda` | Design tokens, `defineSlotRecipe` styles, generated `styled-system` |
| `@aeon-ui/ui` | Styled components (`aeonButton`, `aeonAccordion`, …) |
| `@aeon-ui/vue` | Vue 3 headless adapter (v0.1: Switch + `useAeonMachine`) |
| `@aeon-ui/solid` | Solid headless adapter (v0.1: Switch + `useAeonMachine`) |
| `@aeon-ui/svelte` | Svelte headless adapter (v0.1: Switch + `useAeonMachine`) |

**Catalog (React):** Button, Switch, Checkbox, Dialog, Tabs, Accordion, Select, Combobox, Async, Field, Scroll, Menu, Popover, Tooltip, Toast, **Separator**, **Progress**, **RadioGroup**, **Slider**, **PinInput** — see [COMPONENTS.md](./COMPONENTS.md).

## Quick start

Teach an AI agent first (optional but recommended):

```bash
npx aeon-ui init
```

The monorepo is published on npm as **`aeon-ui-engine`** (bundles all `@aeon-ui/*` workspace packages):

```bash
npm install aeon-ui-engine react react-dom xstate @xstate/react
```

Add the Vite plugin and import CSS:

```ts
// vite.config.ts
import { aeonUiVitePlugin } from 'aeon-ui-engine/vite'
export default defineConfig({
  plugins: [react(), aeonUiVitePlugin()],
})
```

```tsx
// main.tsx
import 'aeon-ui-engine/aeon.css'
```

Full setup guide: **[CONSUMER.md](./CONSUMER.md)**.

Open [https://github.com/GenericCPU/aeon-ui](https://github.com/GenericCPU/aeon-ui) for the repo. The marketing demo lives at [https://aeon-ui.com](https://aeon-ui.com) — set `VITE_SITE_ORIGIN` to that origin in Vercel so Open Graph previews resolve the social image in `apps/demo/public/` correctly.

After changing recipes or tokens in `packages/panda`:

```bash
pnpm codegen
```

## Styling (Panda CSS)

Recipes live in `packages/panda/src/recipes/` and map to core anatomy parts (`accordion`, `dialog`, `tabs`, …). The styled layer applies them:

```tsx
import { aeonAccordion } from '@aeon-ui/panda/styled-system/recipes'

const styles = aeonAccordion()
// styles.root, styles.itemTrigger, …
```

Apps import generated CSS once, then runtime theme overrides (required for light/dark):

```tsx
import '@aeon-ui/panda/styles.css'
import '@aeon-ui/panda/theme-runtime.css'
import '@aeon-ui/panda/scrollbars.css'
import '@aeon-ui/panda/chrome.css'
```

Legacy `--aeon-*` CSS variables are still emitted on `:root` for landing layout and gradual migration.

## Themes (light / dark × mood)

Edit **`packages/panda/src/theme/themes.config.ts`** — one entry per mood (`default`, `signal`, `berry`, `slate`, `neon`, …), each with `light` + `dark` palette fields. Run `pnpm codegen` in `packages/panda` to regenerate `theme-runtime.css`.

```ts
// themes.config.ts — add a mood
{
  id: 'brand',
  label: 'Brand',
  description: 'Your product',
  light: { bg: '#f5f5f5', surface: '#fff', border: '#ddd', text: '#111', muted: '#666', accent: '#3366ff' },
  dark: { bg: '#0a0a0a', surface: '#141414', border: '#333', text: '#eee', muted: '#999', accent: '#6699ff' },
}
```

Runtime API:

```ts
import { applyAeonTheme, AEON_THEMES } from '@aeon-ui/panda/themes'

applyAeonTheme('ocean', 'light')
```

Built-in moods: **Aeon**, **Signal**, **Dusk**, **Calm**, **Ocean**, **Ember**, **Frost**, **Dawn**, **Forest**, **Noir**. The demo uses a custom **Select** (not the OS dropdown) plus a Light/Dark rail.

**Focus policy:** `chrome.css` shows focus rings only for keyboard (`:focus-visible`). Selected tabs, pressed buttons, and open selects use surface tint — not a focus “circle” on click.

## Docs

| Doc | Purpose |
|-----|---------|
| **[AGENTS.md](./AGENTS.md)** | **LLM/agent entry — rules, workflows, naming** |
| [docs/INDEX.md](./docs/INDEX.md) | Full documentation map |
| [docs/MACHINES.md](./docs/MACHINES.md) | Machine vs prop vs `useState` (ground truth) |
| [docs/LAYOUT_COORDINATES.md](./docs/LAYOUT_COORDINATES.md) | Responsive play surfaces — normalized coordinate plane |
| [docs/COMPONENT_CHECKLIST.md](./docs/COMPONENT_CHECKLIST.md) | Add or change a component (ordered steps) |
| [COMPONENTS.md](./COMPONENTS.md) | What ships today vs planned |
| [INTEGRATION.md](./INTEGRATION.md) | Headless, Panda, Tailwind |
| [PUBLISHING.md](./PUBLISHING.md) | npm release checklist |
| [FRAMEWORKS.md](./FRAMEWORKS.md) | React now; adapter contract |
| [ACCESSIBILITY.md](./ACCESSIBILITY.md) | Roles, focus, checklist |

## Philosophy & state catalog

Read [PHILOSOPHY.md](./PHILOSOPHY.md) and **[STATES.md](./STATES.md)** — gaps traditional UI leaves implicit (empty vs idle, button pending/success, orthogonal field regions) and how Aeon models them.

**UI = f(state).** Define every stable condition in the chart; build UI that expresses the whole definition, not a fragment of it.

### Async region (Content faces)

```tsx
import { Async, Content, Button, Progress } from '@aeon-ui/ui'
import { asyncStatusToContentState, useAsyncContext } from '@aeon-ui/react'

function AsyncSurface() {
  const { status, send } = useAsyncContext()
  return (
    <Content.Root state={asyncStatusToContentState(status)} align="center">
      <Content.Pending>
        <Progress.Root indeterminate>
          <Progress.Track>
            <Progress.Range />
          </Progress.Track>
        </Progress.Root>
      </Content.Pending>
      <Content.Empty>Nothing here</Content.Empty>
      <Content.Error>Failed</Content.Error>
      <Content.Success>Done</Content.Success>
      {status === 'idle' ? <Content.Body>Ready when you are</Content.Body> : null}
      <Button.Root onClick={() => send({ type: 'FETCH' })}>Load</Button.Root>
    </Content.Root>
  )
}

<Async.Root>
  <AsyncSurface />
</Async.Root>
```

See [docs/PRIMITIVE_COVERAGE.md](./docs/PRIMITIVE_COVERAGE.md).

## Example

```tsx
import { Dialog, Button, Switch } from '@aeon-ui/ui'

<Switch.Root defaultChecked>
  <Switch.Control><Switch.Thumb /></Switch.Control>
  <Switch.Label>Notifications</Switch.Label>
</Switch.Root>

<Dialog.Root>
  <Dialog.Trigger><Button.Root>Open</Button.Root></Dialog.Trigger>
  <Dialog.Backdrop />
  <Dialog.Positioner>
    <Dialog.Content>
      <Dialog.Title>Title</Dialog.Title>
      <Dialog.CloseTrigger>Close</Dialog.CloseTrigger>
    </Dialog.Content>
  </Dialog.Positioner>
</Dialog.Root>
```

Headless usage:

```tsx
import { Dialog } from '@aeon-ui/react'
```

## License

MIT
