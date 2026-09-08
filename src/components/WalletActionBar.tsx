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

type Props = {
  primary: WalletAction
  secondary?: WalletAction
  ariaLabel: string
  placement?: 'inline' | 'nav'
  className?: string
}

function buttonClass(action: WalletAction, placement: Props['placement']): string {
  if (placement === 'nav') {
    return `wallet-nav-tab ${
      action.tone === 'primary' ? 'wallet-nav-tab-accept' : 'wallet-nav-tab-deny'
    }`
  }
  if (action.tone === 'primary') return 'btn btn-primary'
  if (action.tone === 'danger') return 'btn btn-danger'
  return 'btn btn-ghost'
}

export function WalletActionBar({
  primary,
  secondary,
  ariaLabel,
  placement = 'inline',
  className = '',
}: Props) {
  const actions = secondary ? [secondary, primary] : [primary]
  return (
    <footer
      className={`wallet-action-bar wallet-action-bar--${placement} ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
    >
      {actions.map((action, index) => (
        <button
          key={`${action.label}-${index}`}
          type="button"
          className={buttonClass(action, placement)}
          data-selected={placement === 'nav' && action === primary ? '' : undefined}
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
      ))}
    </footer>
  )
}
