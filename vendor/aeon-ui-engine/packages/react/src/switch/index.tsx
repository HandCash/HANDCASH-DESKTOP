import { partAttrs, switchAnatomy } from '@aeon-ui/core'
import { toggleMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface SwitchContextValue {
  checked: boolean
  disabled: boolean
  controlled: boolean
  onCheckedChange?: (checked: boolean) => void
  send: ReturnType<typeof useAeonMachine<typeof toggleMachine>>[1]
  pressState: string
}

const SwitchCtx = createContext<SwitchContextValue | null>(null)

function useSwitchCtx() {
  const ctx = useContext(SwitchCtx)
  if (!ctx) throw new Error('Switch parts must be used within Switch.Root')
  return ctx
}

export interface SwitchRootProps {
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  onCheckedChange?: (checked: boolean) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLLabelElement, SwitchRootProps>(function SwitchRoot(
  { checked, defaultChecked = false, disabled = false, onCheckedChange, children, className, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(toggleMachine, {
    input: { checked: defaultChecked, disabled },
  })

  const controlled = checked !== undefined
  const resolvedChecked = checked ?? snapshot.context.checked
  const pressState = snapshot.matches({ interaction: 'pressed' }) ? 'pressed' : 'idle'

  useEffect(() => {
    if (checked === undefined) onCheckedChange?.(resolvedChecked)
  }, [resolvedChecked, onCheckedChange, checked])

  useEffect(() => {
    if (checked !== undefined) send({ type: 'SET_CHECKED', checked })
  }, [checked, send])

  const value = useMemo(
    () => ({
      checked: resolvedChecked,
      disabled,
      controlled,
      onCheckedChange,
      send,
      pressState,
    }),
    [resolvedChecked, disabled, controlled, onCheckedChange, send, pressState],
  )

  const toggle = () => {
    if (disabled) return
    const next = !resolvedChecked
    if (controlled) onCheckedChange?.(next)
    else send({ type: 'TOGGLE' })
  }

  return (
    <SwitchCtx.Provider value={value}>
      <label
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(switchAnatomy.scope, switchAnatomy.root, {
            state: `${resolvedChecked ? 'checked' : 'unchecked'} ${pressState}`,
            disabled,
          }),
          {
            onClick: (e: MouseEvent<HTMLLabelElement>) => {
              const target = e.target as HTMLElement
              if (target.closest(`[data-aeon-part="${switchAnatomy.control}"]`)) return
              toggle()
            },
          },
          rest as ButtonHTMLAttributes<HTMLLabelElement>,
        )}
      >
        {children ?? (
          <>
            <Control>
              <Thumb />
            </Control>
          </>
        )}
      </label>
    </SwitchCtx.Provider>
  )
})

const Control = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function SwitchControl(
  { className, onClick, onPointerDown, onPointerUp, onPointerLeave, ...rest },
  ref,
) {
  const { checked, disabled, controlled, onCheckedChange, send, pressState } = useSwitchCtx()

  const toggle = () => {
    if (disabled) return
    const next = !checked
    if (controlled) onCheckedChange?.(next)
    else send({ type: 'TOGGLE' })
  }

  return (
    <span
      ref={ref}
      role="switch"
      aria-checked={checked}
      tabIndex={disabled ? -1 : 0}
      className={className}
      {...mergeProps(
        partAttrs(switchAnatomy.scope, switchAnatomy.control, {
          state: `${checked ? 'checked' : 'unchecked'} ${pressState}`,
          disabled,
        }),
        {
          onClick: (e: MouseEvent<HTMLSpanElement>) => {
            onClick?.(e)
            toggle()
            e.stopPropagation()
          },
          onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
            onPointerDown?.(e)
            if (!disabled) send({ type: 'POINTER_DOWN' })
          },
          onPointerUp: (e: PointerEvent<HTMLSpanElement>) => {
            onPointerUp?.(e)
            send({ type: 'POINTER_UP' })
          },
          onPointerLeave: (e: PointerEvent<HTMLSpanElement>) => {
            onPointerLeave?.(e)
            send({ type: 'POINTER_LEAVE' })
          },
          onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              toggle()
            }
          },
        },
        rest,
      )}
    />
  )
})

const Thumb = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function SwitchThumb(
  { className, ...rest },
  ref,
) {
  const { checked, pressState } = useSwitchCtx()
  return (
    <span
      ref={ref}
      className={className}
      {...mergeProps(
        partAttrs(switchAnatomy.scope, switchAnatomy.thumb, {
          state: `${checked ? 'checked' : 'unchecked'} ${pressState}`,
        }),
        rest,
      )}
    />
  )
})

const Label = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function SwitchLabel(
  props,
  ref,
) {
  return (
    <span
      ref={ref}
      {...mergeProps(partAttrs(switchAnatomy.scope, switchAnatomy.label), props)}
    />
  )
})

const HiddenInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function SwitchHiddenInput(
  props,
  ref,
) {
  const { checked } = useSwitchCtx()
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      readOnly
      tabIndex={-1}
      aria-hidden
      {...mergeProps(partAttrs(switchAnatomy.scope, switchAnatomy.hiddenInput), props)}
    />
  )
})

export const Switch = { Root, Control, Thumb, Label, HiddenInput }
