<script lang="ts">
  import { setContext } from 'svelte'
  import { partAttrs, switchAnatomy } from '@aeon-ui/core'
  import { toggleMachine } from '@aeon-ui/primitives'
  import { useAeonMachine } from './hooks/use-aeon-machine.js'
  import { SWITCH_CTX, type SwitchContext } from './switch-context.js'

  let {
    checked = undefined,
    defaultChecked = false,
    disabled = false,
    onCheckedChange = undefined,
    class: className = '',
    children,
  }: {
    checked?: boolean
    defaultChecked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
    class?: string
    children?: import('svelte').Snippet
  } = $props()

  const { send, subscribe, getSnapshot } = useAeonMachine(toggleMachine, {
    input: { checked: defaultChecked, disabled },
  })

  let snap = $state(getSnapshot())
  $effect(() => subscribe((s) => (snap = s)))

  const controlled = $derived(checked !== undefined)
  const resolvedChecked = $derived(checked ?? snap.context.checked)
  const pressState = $derived(snap.matches({ interaction: 'pressed' }) ? 'pressed' : 'idle')

  $effect(() => {
    if (checked !== undefined) send({ type: 'SET_CHECKED', checked })
  })

  $effect(() => {
    if (!controlled) onCheckedChange?.(resolvedChecked)
  })

  function toggle() {
    if (disabled) return
    const next = !resolvedChecked
    if (controlled) onCheckedChange?.(next)
    else send({ type: 'TOGGLE' })
  }

  setContext<SwitchContext>(SWITCH_CTX, {
    get checked() {
      return resolvedChecked
    },
    get disabled() {
      return disabled
    },
    get controlled() {
      return controlled
    },
    onCheckedChange,
    send,
    get pressState() {
      return pressState
    },
  })

  const rootAttrs = $derived(
    partAttrs(switchAnatomy.scope, switchAnatomy.root, {
      state: `${resolvedChecked ? 'checked' : 'unchecked'} ${pressState}`,
      disabled,
    }),
  )
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<label
  {...rootAttrs}
  class={className}
  onclick={(e) => {
    const target = e.target as HTMLElement
    if (target.closest(`[data-aeon-part="${switchAnatomy.control}"]`)) return
    toggle()
  }}
>
  {@render children?.()}
</label>
