# @aeon-ui/solid

Headless **SolidJS** bindings for [Aeon UI](https://github.com/GenericCPU/aeon-ui).

## Install

```bash
pnpm add @aeon-ui/solid @aeon-ui/core @aeon-ui/primitives xstate solid-js
```

## Usage

```tsx
import { Switch } from '@aeon-ui/solid'
import { createSignal } from 'solid-js'

function Demo() {
  const [on, setOn] = createSignal(true)
  return (
    <Switch.Root checked={on()} onCheckedChange={setOn}>
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
      <Switch.Label>Notifications</Switch.Label>
    </Switch.Root>
  )
}
```

See [FRAMEWORKS.md](../../FRAMEWORKS.md).
