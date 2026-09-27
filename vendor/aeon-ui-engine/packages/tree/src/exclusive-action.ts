import { host, text, type Widget } from './widget.js'

/**
 * The chart every "click, maybe confirm, await, succeed or fail" region
 * shares. One region, four faces — not a `busy` boolean beside the markup.
 */
export const EXCLUSIVE_ACTION_STATES = ['idle', 'confirming', 'busy', 'failure'] as const

export type ExclusiveActionState = (typeof EXCLUSIVE_ACTION_STATES)[number]

export type ExclusiveActionInput = {
  scope: string
  part: string
  /** Active snapshot token, usually `stateToAttr(snapshot.value)`. */
  state: string
  busy: boolean
  error: string | null
  className?: string
  tag?: 'form' | 'div'
  /** Panel-specific fields. A host, so the tree stays generic. */
  body: Widget
  idleLabel: string
  pendingLabel: string
  primaryClassName?: string
  primaryDisabled?: boolean
  onSubmit?: (event: { preventDefault(): void }) => void
  secondary?: {
    label: string
    className?: string
    disabled?: boolean
    onClick: () => void
  }
  actionsClassName?: string
  /** When set, the `confirm` host is mounted. The app renders its Prompt there. */
  confirm?: boolean
}

/**
 * One widget for an exclusive mutation. The root carries the chart state;
 * the primary label and the disabled set are functions of `busy`, and the
 * failure copy is a child that exists only when `error` is set.
 */
export function exclusiveActionWidget(input: ExclusiveActionInput): Widget {
  const children: Widget[] = [input.body]

  if (input.error) {
    children.push({
      type: 'el',
      tag: 'p',
      part: 'error',
      className: 'error',
      role: 'alert',
      children: [text(input.error)],
    })
  }

  const actions: Widget[] = [
    {
      type: 'el',
      tag: 'button',
      part: 'primary',
      buttonType: input.tag === 'div' ? 'button' : 'submit',
      disabled: input.busy || input.primaryDisabled,
      className: input.primaryClassName,
      onClick: input.tag === 'div' ? () => input.onSubmit?.({ preventDefault() {} }) : undefined,
      children: [text(input.busy ? input.pendingLabel : input.idleLabel)],
    },
  ]

  if (input.secondary) {
    actions.push({
      type: 'el',
      tag: 'button',
      part: 'secondary',
      buttonType: 'button',
      disabled: input.busy || input.secondary.disabled,
      className: input.secondary.className,
      onClick: input.secondary.onClick,
      children: [text(input.secondary.label)],
    })
  }

  children.push({
    type: 'el',
    tag: 'div',
    part: 'actions',
    className: input.actionsClassName,
    state: input.state,
    children: actions,
  })

  if (input.confirm) children.push(host('confirm'))

  return {
    type: 'el',
    tag: input.tag ?? 'form',
    scope: input.scope,
    part: input.part,
    state: input.state,
    className: input.className,
    onSubmit: input.tag === 'div' ? undefined : input.onSubmit,
    children,
  }
}
