<script lang="ts">
  import { getContext } from 'svelte'
  import { partAttrs, switchAnatomy } from '@aeon-ui/core'
  import { SWITCH_CTX, type SwitchContext } from './switch-context.js'

  let { ...rest }: Record<string, unknown> = $props()
  const ctx = getContext<SwitchContext>(SWITCH_CTX)

  function toggle() {
    if (ctx.disabled) return
    const next = !ctx.checked
    if (ctx.controlled) ctx.onCheckedChange?.(next)
    else ctx.send({ type: 'TOGGLE' })
  }

  const attrs = $derived(
    partAttrs(switchAnatomy.scope, switchAnatomy.control, {
      state: `${ctx.checked ? 'checked' : 'unchecked'} ${ctx.pressState}`,
      disabled: ctx.disabled,
    }),
  )
</script>

<span
  {...attrs}
  {...rest}
  role="switch"
  aria-checked={ctx.checked}
  tabindex={ctx.disabled ? -1 : 0}
  onclick={(e) => {
    toggle()
    e.stopPropagation()
  }}
  onpointerdown={() => {
    if (!ctx.disabled) ctx.send({ type: 'POINTER_DOWN' })
  }}
  onpointerup={() => ctx.send({ type: 'POINTER_UP' })}
  onpointerleave={() => ctx.send({ type: 'POINTER_LEAVE' })}
  onkeydown={(e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      toggle()
    }
  }}
></span>
