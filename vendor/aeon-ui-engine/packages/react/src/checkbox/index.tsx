import { checkboxAnatomy, partAttrs } from '@aeon-ui/core'
import { toggleMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface CheckboxContextValue {
  checked: boolean
  disabled: boolean
  controlled: boolean
  onCheckedChange?: (checked: boolean) => void
  send: ReturnType<typeof useAeonMachine<typeof toggleMachine>>[1]
}

const CheckboxCtx = createContext<CheckboxContextValue | null>(null)

function useCheckboxCtx() {
  const ctx = useContext(CheckboxCtx)
  if (!ctx) throw new Error('Checkbox parts must be used within Checkbox.Root')
  return ctx
}

export interface CheckboxRootProps {
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  onCheckedChange?: (checked: boolean) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLLabelElement, CheckboxRootProps>(function CheckboxRoot(
  { checked, defaultChecked = false, disabled = false, onCheckedChange, children, className, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(toggleMachine, {
    input: { checked: defaultChecked, disabled },
  })

  const resolvedChecked = checked ?? snapshot.context.checked

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
      controlled: checked !== undefined,
      onCheckedChange,
      send,
    }),
    [resolvedChecked, disabled, checked, onCheckedChange, send],
  )

  const toggle = () => {
    if (disabled) return
    const next = !resolvedChecked
    if (checked !== undefined) onCheckedChange?.(next)
    else send({ type: 'TOGGLE' })
  }

  return (
    <CheckboxCtx.Provider value={value}>
      <label
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(checkboxAnatomy.scope, checkboxAnatomy.root, {
            state: resolvedChecked ? 'checked' : 'unchecked',
            disabled,
          }),
          {
            onClick: (e: MouseEvent<HTMLLabelElement>) => {
              const target = e.target as HTMLElement
              if (target.closest(`[data-aeon-part="${checkboxAnatomy.control}"]`)) return
              toggle()
            },
          },
          rest as ButtonHTMLAttributes<HTMLLabelElement>,
        )}
      >
        {children}
      </label>
    </CheckboxCtx.Provider>
  )
})

const Control = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function CheckboxControl(
  { className, onClick, ...rest },
  ref,
) {
  const { checked, disabled, controlled, onCheckedChange, send } = useCheckboxCtx()

  return (
    <span
      ref={ref}
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={className}
      {...mergeProps(
        partAttrs(checkboxAnatomy.scope, checkboxAnatomy.control, {
          state: checked ? 'checked' : 'unchecked',
          disabled,
        }),
        {
          onClick: (e: MouseEvent<HTMLSpanElement>) => {
            onClick?.(e)
            if (!disabled) {
              const next = !checked
              if (controlled) onCheckedChange?.(next)
              else send({ type: 'TOGGLE' })
            }
          },
          onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              if (!disabled) {
                const next = !checked
                if (controlled) onCheckedChange?.(next)
                else send({ type: 'TOGGLE' })
              }
            }
          },
        },
        rest,
      )}
    />
  )
})

const Indicator = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function CheckboxIndicator(
  props,
  ref,
) {
  const { checked } = useCheckboxCtx()
  if (!checked) return null
  return (
    <span
      ref={ref}
      {...mergeProps(
        partAttrs(checkboxAnatomy.scope, checkboxAnatomy.indicator, { state: 'checked' }),
        props,
      )}
    />
  )
})

const Label = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function CheckboxLabel(
  props,
  ref,
) {
  return (
    <span ref={ref} {...mergeProps(partAttrs(checkboxAnatomy.scope, checkboxAnatomy.label), props)} />
  )
})

const HiddenInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function CheckboxHiddenInput(
  props,
  ref,
) {
  const { checked } = useCheckboxCtx()
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      readOnly
      tabIndex={-1}
      aria-hidden
      {...mergeProps(partAttrs(checkboxAnatomy.scope, checkboxAnatomy.hiddenInput), props)}
    />
  )
})

export const Checkbox = { Root, Control, Indicator, Label, HiddenInput }
