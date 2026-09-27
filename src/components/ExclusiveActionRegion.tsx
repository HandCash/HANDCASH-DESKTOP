import type { FormEvent, ReactNode } from 'react'
import { exclusiveActionWidget, host, interpret } from '@aeon-ui/tree'
import type { AsyncActionHandle } from '../hooks/useAsyncAction'
import { AsyncActionPrompt } from './AsyncActionPrompt'

type Props = {
  action: Pick<
    AsyncActionHandle<string>,
    'stateAttr' | 'busy' | 'confirm' | 'confirmPending' | 'cancelPending'
  >
  scope: string
  part: string
  className?: string
  actionsClassName?: string
  error: string | null
  idleLabel: string
  pendingLabel: string
  /** Extra disable on top of `action.busy`, which the tree already applies. */
  primaryDisabled?: boolean
  onSubmit: (event: FormEvent) => void
  secondary?: { label: string; onClick: () => void }
  children: ReactNode
}

/**
 * The mutation face, once. Projects `asyncAction` (`idle | confirming | busy |
 * failure`) through `@aeon-ui/tree` instead of each panel restating the form,
 * the pending label, and the confirm Prompt.
 */
export function ExclusiveActionRegion({
  action,
  scope,
  part,
  className,
  actionsClassName = 'actions',
  error,
  idleLabel,
  pendingLabel,
  primaryDisabled,
  onSubmit,
  secondary,
  children,
}: Props) {
  const tree = exclusiveActionWidget({
    scope,
    part,
    state: action.stateAttr,
    busy: action.busy,
    error,
    className,
    body: host('body'),
    idleLabel,
    pendingLabel,
    primaryClassName: 'btn btn-primary',
    primaryDisabled,
    actionsClassName,
    onSubmit: (event) => onSubmit(event as FormEvent),
    secondary: secondary
      ? { label: secondary.label, className: 'btn btn-ghost', onClick: secondary.onClick }
      : undefined,
    confirm: action.confirm != null,
  })

  return interpret(tree, {
    body: () => children,
    confirm: () => <AsyncActionPrompt action={action} />,
  })
}
