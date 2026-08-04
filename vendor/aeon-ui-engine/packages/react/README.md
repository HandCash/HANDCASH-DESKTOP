# @aeon-ui/react

**Headless compound components** — snapshot/props → DOM + accessibility.

Agents: [docs/MACHINES.md](../../docs/MACHINES.md) before editing state wiring.

## Install

```bash
pnpm add @aeon-ui/react @aeon-ui/core @aeon-ui/primitives
```

Style yourself with `[data-aeon-*]` or use `@aeon-ui/ui`.

## Usage

```tsx
import { Dialog, Button, useAeonMachine } from '@aeon-ui/react'
import { buttonLifecycleMachine } from '@aeon-ui/primitives'

<Dialog.Root>
  <Dialog.Trigger>Open</Dialog.Trigger>
  <Dialog.Backdrop />
  <Dialog.Positioner>
    <Dialog.Content>
      <Dialog.Title>Title</Dialog.Title>
      <Dialog.CloseTrigger>Close</Dialog.CloseTrigger>
    </Dialog.Content>
  </Dialog.Positioner>
</Dialog.Root>

<Button.Root status="pending">Save</Button.Root>
```

## Catalog

`Button`, `Switch`, `Checkbox`, `Dialog`, `Tabs`, `Accordion`, `Select`, `Combobox`, `Async`, `Field`, `Scroll`, `Menu`, `Popover`, `Tooltip`, `Toast`, `useAeonMachine`, `useLayoutMode`.

See [COMPONENTS.md](../../COMPONENTS.md).

## Patterns

| Pattern | Components |
|---------|------------|
| `useAeonMachine` + primitives | Dialog, Switch, Async, Field, Tabs, … |
| `status` prop | Button |
| `useState` | Select, Combobox, Tooltip |
| `getScrollSnapshot` | Scroll |

## Custom wrapper

```tsx
import { partAttrs, dialogAnatomy } from '@aeon-ui/core'

<button {...partAttrs(dialogAnatomy.scope, dialogAnatomy.trigger, { state: 'closed' })} />
```

## File layout

`src/<component>/index.tsx` — see [docs/FILE_MAP.md](../../docs/FILE_MAP.md).

## Related

- [INTEGRATION.md](../../INTEGRATION.md)
- [FRAMEWORKS.md](../../FRAMEWORKS.md)
