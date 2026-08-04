# @aeon-ui/ui

**Styled compound components** — `@aeon-ui/react` + Panda `aeon*` recipes.

Fastest path for apps that want the Aeon look and state-driven styling.

## Install

```bash
pnpm add @aeon-ui/ui @aeon-ui/react
```

Import CSS once (see [INTEGRATION.md](../../INTEGRATION.md)):

```tsx
import '@aeon-ui/panda/styles.css'
import '@aeon-ui/panda/theme-runtime.css'
```

## Usage

```tsx
import { Async, Button, Content } from '@aeon-ui/ui'
import { asyncStatusToContentState, useAsyncContext } from '@aeon-ui/react'

function Surface() {
  const { status, send } = useAsyncContext()
  return (
    <Content.Root state={asyncStatusToContentState(status)}>
      <Content.Pending>Loading…</Content.Pending>
      <Content.Empty>Empty</Content.Empty>
      <Content.Error>Failed</Content.Error>
      <Content.Success>Done</Content.Success>
      {status === 'idle' ? <Content.Body>Ready</Content.Body> : null}
      <Button.Root size="sm" onClick={() => send({ type: 'FETCH' })}>
        Fetch
      </Button.Root>
    </Content.Root>
  )
}

<Async.Root>
  <Surface />
</Async.Root>
```

## Exports

`Button`, `Switch`, `Checkbox`, `Dialog`, `Tabs`, `Accordion`, `Badge`, `Scroll`, `Select`, `Combobox`, `Menu`, `Popover`, `Tooltip`, `Toast`, `useToast`, `Async`, `Field`, `cn`.

## Implementation pattern

Each file in `src/<component>.tsx`:

1. Import headless from `@aeon-ui/react`
2. Import `aeon*` recipe from `@aeon-ui/panda/styled-system/recipes`
3. `className={cn(recipe({ variant, size }), className)}`
4. Forward `status`, `variant`, `size` to headless

Example: `src/button.tsx`.

## Customize

- **Tokens/themes:** `packages/panda/src/theme/themes.config.ts` + codegen
- **Recipes:** edit panda recipes, codegen, rebuild ui
- **Replace styles entirely:** use `@aeon-ui/react` + your CSS on `data-aeon-*`

## Agents

Do not add non-Panda styling inside this package.  
Workflow: [docs/COMPONENT_CHECKLIST.md](../../docs/COMPONENT_CHECKLIST.md).

## Related

- [COMPONENTS.md](../../COMPONENTS.md)
- [STATES.md](../../STATES.md)
