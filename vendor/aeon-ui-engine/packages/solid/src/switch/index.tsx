import { partAttrs, switchAnatomy } from '@aeon-ui/core'
import { toggleMachine } from '@aeon-ui/primitives'
import {
  createContext,
  createEffect,
  createMemo,
  useContext,
  type JSX,
  type ParentProps,
} from 'solid-js'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface SwitchContextValue {
  checked: () => boolean
  disabled: () => boolean
  controlled: () => boolean
  onCheckedChange?: (checked: boolean) => void
  send: ReturnType<typeof useAeonMachine<typeof toggleMachine>>[1]
  pressState: () => string
}

const SwitchCtx = createContext<SwitchContextValue>()

function useSwitchCtx() {
  const ctx = useContext(SwitchCtx)
  if (!ctx) throw new Error('Switch parts must be used within Switch.Root')
  return ctx
}

export type SwitchRootProps = ParentProps<{
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  onCheckedChange?: (checked: boolean) => void
  class?: string
}>

function Root(props: SwitchRootProps) {
  const [snapshot, send] = useAeonMachine(toggleMachine, {
    input: { checked: props.defaultChecked ?? false, disabled: props.disabled ?? false },
  })

  const controlled = () => props.checked !== undefined
  const resolvedChecked = createMemo(() => props.checked ?? snapshot.context.checked)
  const pressState = createMemo(() =>
    snapshot.matches({ interaction: 'pressed' }) ? 'pressed' : 'idle',
  )

  createEffect(() => {
    if (props.checked !== undefined) send({ type: 'SET_CHECKED', checked: props.checked })
  })

  createEffect(() => {
    if (!controlled()) props.onCheckedChange?.(resolvedChecked())
  })

  const toggle = () => {
    if (props.disabled) return
    const next = !resolvedChecked()
    if (controlled()) props.onCheckedChange?.(next)
    else send({ type: 'TOGGLE' })
  }

  const value: SwitchContextValue = {
    checked: resolvedChecked,
    disabled: () => props.disabled ?? false,
    controlled,
    onCheckedChange: props.onCheckedChange,
    send,
    pressState,
  }

  return (
    <SwitchCtx.Provider value={value}>
      <label
        class={props.class}
        {...mergeProps(
          partAttrs(switchAnatomy.scope, switchAnatomy.root, {
            state: `${resolvedChecked() ? 'checked' : 'unchecked'} ${pressState()}`,
            disabled: props.disabled,
          }) as Record<string, unknown>,
          {
            onClick: (e: MouseEvent) => {
              const target = e.target as HTMLElement
              if (target.closest(`[data-aeon-part="${switchAnatomy.control}"]`)) return
              toggle()
            },
          },
        )}
      >
        {props.children}
      </label>
    </SwitchCtx.Provider>
  )
}

type ControlProps = JSX.LabelHTMLAttributes<HTMLSpanElement>

function Control(props: ControlProps) {
  const ctx = useSwitchCtx()
  const toggle = () => {
    if (ctx.disabled()) return
    const next = !ctx.checked()
    if (ctx.controlled()) ctx.onCheckedChange?.(next)
    else ctx.send({ type: 'TOGGLE' })
  }
  const { class: className, ...rest } = props
  return (
    <span
      role="switch"
      aria-checked={ctx.checked()}
      tabIndex={ctx.disabled() ? -1 : 0}
      class={className}
      {...mergeProps(
        partAttrs(switchAnatomy.scope, switchAnatomy.control, {
          state: `${ctx.checked() ? 'checked' : 'unchecked'} ${ctx.pressState()}`,
          disabled: ctx.disabled(),
        }) as Record<string, unknown>,
        rest as Record<string, unknown>,
        {
          onClick: (e: MouseEvent) => {
            toggle()
            e.stopPropagation()
          },
          onPointerDown: () => {
            if (!ctx.disabled()) ctx.send({ type: 'POINTER_DOWN' })
          },
          onPointerUp: () => ctx.send({ type: 'POINTER_UP' }),
          onPointerLeave: () => ctx.send({ type: 'POINTER_LEAVE' }),
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              toggle()
            }
          },
        },
      )}
    />
  )
}

function Thumb(props: JSX.HTMLAttributes<HTMLSpanElement>) {
  const ctx = useSwitchCtx()
  const { class: className, ...rest } = props
  return (
    <span
      class={className}
      {...mergeProps(
        partAttrs(switchAnatomy.scope, switchAnatomy.thumb, {
          state: `${ctx.checked() ? 'checked' : 'unchecked'} ${ctx.pressState()}`,
        }) as Record<string, unknown>,
        rest as Record<string, unknown>,
      )}
    />
  )
}

function Label(props: JSX.HTMLAttributes<HTMLSpanElement>) {
  const { class: className, ...rest } = props
  return (
    <span
      class={className}
      {...mergeProps(
        partAttrs(switchAnatomy.scope, switchAnatomy.label) as Record<string, unknown>,
        rest as Record<string, unknown>,
      )}
    />
  )
}

function HiddenInput(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const ctx = useSwitchCtx()
  const { class: className, ...rest } = props
  return (
    <input
      type="checkbox"
      checked={ctx.checked()}
      readOnly
      tabIndex={-1}
      aria-hidden
      class={className}
      {...mergeProps(
        partAttrs(switchAnatomy.scope, switchAnatomy.hiddenInput) as Record<string, unknown>,
        rest as Record<string, unknown>,
      )}
    />
  )
}

export const Switch = { Root, Control, Thumb, Label, HiddenInput }
