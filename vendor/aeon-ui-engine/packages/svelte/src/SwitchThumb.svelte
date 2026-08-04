<script lang="ts">
  import { getContext } from 'svelte'
  import { partAttrs, switchAnatomy } from '@aeon-ui/core'
  import { SWITCH_CTX, type SwitchContext } from './switch-context.js'

  let { ...rest }: Record<string, unknown> = $props()
  const ctx = getContext<SwitchContext>(SWITCH_CTX)

  const attrs = $derived(
    partAttrs(switchAnatomy.scope, switchAnatomy.thumb, {
      state: `${ctx.checked ? 'checked' : 'unchecked'} ${ctx.pressState}`,
    }),
  )
</script>

<span {...attrs} {...rest}></span>
