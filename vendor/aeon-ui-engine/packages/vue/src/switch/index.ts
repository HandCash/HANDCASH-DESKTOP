import { partAttrs, switchAnatomy } from '@aeon-ui/core'
import { toggleMachine } from '@aeon-ui/primitives'
import {
  defineComponent,
  h,
  inject,
  provide,
  watch,
  type HTMLAttributes,
  type InjectionKey,
  type PropType,
} from 'vue'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { partProps } from '../utils/part-props.js'

interface SwitchContext {
  checked: boolean
  disabled: boolean
  controlled: boolean
  onCheckedChange?: (checked: boolean) => void
  send: ReturnType<typeof useAeonMachine<typeof toggleMachine>>['send']
  pressState: string
}

const SwitchKey: InjectionKey<SwitchContext> = Symbol('aeon-switch')

export const SwitchRoot = defineComponent({
  name: 'AeonSwitchRoot',
  props: {
    checked: { type: Boolean as PropType<boolean | undefined>, default: undefined },
    defaultChecked: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    onCheckedChange: { type: Function as PropType<(checked: boolean) => void>, default: undefined },
  },
  setup(props, { slots, attrs }) {
    const { snapshot, send } = useAeonMachine(toggleMachine, {
      input: { checked: props.defaultChecked, disabled: props.disabled },
    })

    const controlled = props.checked !== undefined
    const resolvedChecked = () => props.checked ?? snapshot.value.context.checked
    const pressState = () => (snapshot.value.matches({ interaction: 'pressed' }) ? 'pressed' : 'idle')

    watch(
      () => props.checked,
      (v) => {
        if (v !== undefined) send({ type: 'SET_CHECKED', checked: v })
      },
    )

    watch(
      () => resolvedChecked(),
      (v) => {
        if (!controlled) props.onCheckedChange?.(v)
      },
    )

    const toggle = () => {
      if (props.disabled) return
      const next = !resolvedChecked()
      if (controlled) props.onCheckedChange?.(next)
      else send({ type: 'TOGGLE' })
    }

    provide(SwitchKey, {
      get checked() {
        return resolvedChecked()
      },
      get disabled() {
        return props.disabled
      },
      get controlled() {
        return controlled
      },
      onCheckedChange: props.onCheckedChange,
      send,
      get pressState() {
        return pressState()
      },
    })

    return () =>
      h(
        'label',
        partProps(
          partAttrs(switchAnatomy.scope, switchAnatomy.root, {
            state: `${resolvedChecked() ? 'checked' : 'unchecked'} ${pressState()}`,
            disabled: props.disabled,
          }) as Record<string, unknown>,
          {
            ...attrs,
            onClick: (e: MouseEvent) => {
              const target = e.target as HTMLElement
              if (target.closest(`[data-aeon-part="${switchAnatomy.control}"]`)) return
              toggle()
            },
          } as HTMLAttributes,
        ),
        slots.default?.() ?? undefined,
      )
  },
})

function useSwitchCtx(): SwitchContext {
  const ctx = inject(SwitchKey)
  if (!ctx) throw new Error('Switch parts must be used within SwitchRoot')
  return ctx
}

export const SwitchControl = defineComponent({
  name: 'AeonSwitchControl',
  setup(_, { attrs }) {
    const ctx = useSwitchCtx()
    const toggle = () => {
      if (ctx.disabled) return
      const next = !ctx.checked
      if (ctx.controlled) ctx.onCheckedChange?.(next)
      else ctx.send({ type: 'TOGGLE' })
    }
    return () =>
      h('span', {
        role: 'switch',
        'aria-checked': ctx.checked,
        tabindex: ctx.disabled ? -1 : 0,
        ...partProps(
          partAttrs(switchAnatomy.scope, switchAnatomy.control, {
            state: `${ctx.checked ? 'checked' : 'unchecked'} ${ctx.pressState}`,
            disabled: ctx.disabled,
          }) as Record<string, unknown>,
          attrs as HTMLAttributes,
        ),
        onClick: (e: MouseEvent) => {
          toggle()
          e.stopPropagation()
        },
        onPointerdown: () => {
          if (!ctx.disabled) ctx.send({ type: 'POINTER_DOWN' })
        },
        onPointerup: () => ctx.send({ type: 'POINTER_UP' }),
        onPointerleave: () => ctx.send({ type: 'POINTER_LEAVE' }),
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            toggle()
          }
        },
      })
  },
})

export const SwitchThumb = defineComponent({
  name: 'AeonSwitchThumb',
  setup(_, { attrs }) {
    const ctx = useSwitchCtx()
    return () =>
      h(
        'span',
        partProps(
          partAttrs(switchAnatomy.scope, switchAnatomy.thumb, {
            state: `${ctx.checked ? 'checked' : 'unchecked'} ${ctx.pressState}`,
          }) as Record<string, unknown>,
          attrs as HTMLAttributes,
        ),
      )
  },
})

export const SwitchLabel = defineComponent({
  name: 'AeonSwitchLabel',
  setup(_, { slots, attrs }) {
    return () =>
      h(
        'span',
        partProps(
          partAttrs(switchAnatomy.scope, switchAnatomy.label) as Record<string, unknown>,
          attrs as HTMLAttributes,
        ),
        slots.default?.(),
      )
  },
})

export const SwitchHiddenInput = defineComponent({
  name: 'AeonSwitchHiddenInput',
  setup(_, { attrs }) {
    const ctx = useSwitchCtx()
    return () =>
      h('input', {
        type: 'checkbox',
        checked: ctx.checked,
        readonly: true,
        tabindex: -1,
        'aria-hidden': true,
        ...partProps(
          partAttrs(switchAnatomy.scope, switchAnatomy.hiddenInput) as Record<string, unknown>,
          attrs as HTMLAttributes,
        ),
      })
  },
})

export const Switch = {
  Root: SwitchRoot,
  Control: SwitchControl,
  Thumb: SwitchThumb,
  Label: SwitchLabel,
  HiddenInput: SwitchHiddenInput,
}
