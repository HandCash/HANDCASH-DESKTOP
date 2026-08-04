<script lang="ts">
  import { getContext } from 'svelte'
  import { partAttrs, switchAnatomy } from '@aeon-ui/core'
  import { SWITCH_CTX, type SwitchContext } from './switch-context.js'

  let { ...rest }: Record<string, unknown> = $props()
  const ctx = getContext<SwitchContext>(SWITCH_CTX)

  const attrs = partAttrs(switchAnatomy.scope, switchAnatomy.hiddenInput)
</script>

<input type="checkbox" checked={ctx.checked} readonly tabindex={-1} aria-hidden {...attrs} {...rest} />
