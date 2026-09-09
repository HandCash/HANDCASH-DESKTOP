import type { ReactNode } from 'react'

export type WalletAction = {
  label: string
  shortLabel?: string
  onClick: () => void
  disabled?: boolean
  icon?: ReactNode
  tone?: 'primary' | 'secondary' | 'danger'
  autoFocus?: boolean
  title?: string
}

export type WalletActionBarProps = {
  primary: WalletAction
  secondary?: WalletAction
  tertiary?: WalletAction
  ariaLabel: string
  placement?: 'inline' | 'nav'
  className?: string
}

function buttonClass(action: WalletAction, placement: WalletActionBarProps['placement']): string {
  if (placement === 'nav') {
    if (action.tone === 'primary') return 'wallet-nav-tab wallet-nav-tab-accept'
    if (action.tone === 'danger') return 'wallet-nav-tab wallet-nav-tab-danger'
    return 'wallet-nav-tab wallet-nav-tab-deny'
  }
  if (action.tone === 'primary') return 'btn btn-primary'
  if (action.tone === 'danger') return 'btn btn-danger'
  return 'btn btn-ghost'
}

function actionTone(action: WalletAction | undefined): 'primary' | 'danger' | 'neutral' {
  if (!action || action.disabled) return 'neutral'
  if (action?.tone === 'primary') return 'primary'
  if (action?.tone === 'danger') return 'danger'
  return 'neutral'
}

function slotClass(action: WalletAction, nextAction?: WalletAction): string {
  return [
    'wallet-action-slot',
    `wallet-action-slot--${actionTone(action)}`,
    `wallet-action-slot-next--${actionTone(nextAction ?? action)}`,
  ].join(' ')
}

export function WalletActionBar({
  primary,
  secondary,
  tertiary,
  ariaLabel,
  placement = 'inline',
  className = '',
}: WalletActionBarProps) {
  const actions = [
    ...(tertiary ? [tertiary] : []),
    ...(secondary ? [secondary] : []),
    primary,
  ]
  const selectedAction =
    !primary.disabled
      ? primary
      : secondary && !secondary.disabled
        ? secondary
        : tertiary && !tertiary.disabled
          ? tertiary
          : primary
  return (
    <footer
      className={`wallet-action-bar wallet-action-bar--${placement} ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
    >
      {actions.map((action, index) => {
        const button = (
          <button
          key={placement === 'nav' ? undefined : `${action.label}-${index}`}
          type="button"
          className={buttonClass(action, placement)}
          data-selected={
            placement === 'nav' && action === selectedAction ? '' : undefined
          }
          disabled={action.disabled}
          autoFocus={action.autoFocus}
          title={action.title ?? action.label}
          aria-label={action.label}
          onClick={action.onClick}
        >
          {action.icon}
          <span className={placement === 'nav' ? 'wallet-nav-tab-label' : undefined}>
            {action.label}
          </span>
          {placement === 'nav' ? (
            <span className="wallet-nav-tab-label-short">
              {action.shortLabel ?? action.label}
            </span>
          ) : null}
        </button>
        )
        return placement === 'nav' ? (
          <span
            key={`${action.label}-${index}`}
            className={slotClass(action, actions[index + 1])}
          >
            {button}
          </span>
        ) : button
      })}
    </footer>
  )
}
