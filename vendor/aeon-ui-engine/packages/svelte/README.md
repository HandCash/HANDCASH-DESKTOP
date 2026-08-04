# @aeon-ui/svelte

Headless **Svelte** bindings for [Aeon UI](https://github.com/GenericCPU/aeon-ui). Machines live in `@aeon-ui/primitives`; anatomy in `@aeon-ui/core`.

## Install

```bash
pnpm add @aeon-ui/svelte @aeon-ui/core @aeon-ui/primitives xstate
```

Peer: `svelte` ^4 or ^5 (Svelte 5 runes used in shipped components).

## Usage

```svelte
<script lang="ts">
  import Switch from '@aeon-ui/svelte/Switch.svelte'
  import SwitchControl from '@aeon-ui/svelte/SwitchControl.svelte'
  import SwitchThumb from '@aeon-ui/svelte/SwitchThumb.svelte'
  import SwitchLabel from '@aeon-ui/svelte/SwitchLabel.svelte'

  let on = $state(true)
</script>

<Switch checked={on} onCheckedChange={(v) => (on = v)}>
  <SwitchControl><SwitchThumb /></SwitchControl>
  <SwitchLabel>Notifications</SwitchLabel>
</Switch>
```

## `useAeonMachine`

For custom components, subscribe with `$effect`:

```ts
import { useAeonMachine } from '@aeon-ui/svelte'

const { send, subscribe, getSnapshot } = useAeonMachine(myMachine)
let snap = $state(getSnapshot())
$effect(() => subscribe((s) => (snap = s)))
```

## v0.1 scope

Reference **Switch** port + hook. More components follow [FRAMEWORKS.md](../../FRAMEWORKS.md).
