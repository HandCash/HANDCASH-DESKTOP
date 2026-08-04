import { buttonAnatomy, partAttrs } from '@aeon-ui/core'
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

/** Action button lifecycle — see STATES.md and `buttonLifecycleMachine`. */
export type ButtonStatus = 'idle' | 'pending' | 'success' | 'failure' | 'disabled'

export interface ButtonRootProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'solid' | 'outline' | 'ghost'
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** Machine-aligned lifecycle; `disabled` prop overrides to `disabled`. */
  status?: ButtonStatus
  children?: ReactNode
}

const Root = forwardRef<HTMLButtonElement, ButtonRootProps>(function ButtonRoot(
  { variant = 'solid', size = 'md', disabled, status = 'idle', children, className, ...rest },
  ref,
) {
  const resolvedStatus: ButtonStatus = disabled ? 'disabled' : status
  const isBusy = resolvedStatus === 'pending'
  // Success is terminal until RESET — keep data-aeon-state="success" but block input.
  const isLocked = resolvedStatus === 'success'

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || isBusy || isLocked || resolvedStatus === 'disabled'}
      aria-busy={isBusy || undefined}
      className={className}
      data-aeon-variant={variant}
      data-aeon-size={size}
      {...mergeProps(
        partAttrs(buttonAnatomy.scope, buttonAnatomy.root, {
          state: resolvedStatus,
          disabled: Boolean(disabled || resolvedStatus === 'disabled' || isLocked),
        }),
        rest,
      )}
    >
      {children}
    </button>
  )
})

const Label = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function ButtonLabel(
  props,
  ref,
) {
  return <span ref={ref} {...partAttrs(buttonAnatomy.scope, buttonAnatomy.label)} {...props} />
})

const Icon = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function ButtonIcon(
  props,
  ref,
) {
  return <span ref={ref} {...partAttrs(buttonAnatomy.scope, buttonAnatomy.icon)} {...props} />
})

const Group = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ButtonGroup(
  { children, ...rest },
  ref,
) {
  return (
    <div ref={ref} {...partAttrs(buttonAnatomy.scope, buttonAnatomy.group)} {...rest}>
      {children}
    </div>
  )
})

export const Button = { Root, Label, Icon, Group }
