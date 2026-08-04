# @aeon-ui/vue

Headless **Vue 3** bindings for [Aeon UI](https://github.com/GenericCPU/aeon-ui). Behavior lives in `@aeon-ui/primitives` (XState); this package wires snapshots to Vue and applies `@aeon-ui/core` anatomy attributes.

## Install

```bash
pnpm add @aeon-ui/vue @aeon-ui/core @aeon-ui/primitives xstate
```

Peer: `vue` ^3.4.

## Usage

```vue
<script setup lang="ts">
import { Switch } from '@aeon-ui/vue'
import { ref } from 'vue'

const on = ref(true)
</script>

<template>
  <Switch.Root :checked="on" @update:checked="(v) => (on = v)">
    <Switch.Control>
      <Switch.Thumb />
    </Switch.Control>
    <Switch.Label>Notifications</Switch.Label>
  </Switch.Root>
</template>
```

Use `checked` + `@update:checked` or `onCheckedChange` for controlled mode (see `SwitchRoot` props).

## v0.1 scope

- `useAeonMachine` — `@xstate/vue` wrapper
- `Switch` — full compound port (reference adapter)

More components follow the same pattern as React stabilizes. See [FRAMEWORKS.md](../../FRAMEWORKS.md).
