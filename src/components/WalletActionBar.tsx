import { useState, type ReactNode } from 'react'

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

/**
 * Highlighted CTA chrome: danger stays red; every other actionable choice uses
 * the primary CTA colour (black in light mode) — including Open in-app.
 */
function highlightTone(
  action: WalletAction | undefined,
  highlighted: WalletAction | null,
): 'primary' | 'danger' | 'neutral' {
  if (!action || !highlighted || action !== highlighted || action.disabled) {
    return 'neutral'
  }
  if (action.tone === 'danger') return 'danger'
  return 'primary'
}

function slotClass(action: WalletAction, highlighted: WalletAction | null): string {
  return [
    'wallet-action-slot',
    `wallet-action-slot--${highlightTone(action, highlighted)}`,
  ].join(' ')
}

/** Prefer the primary CTA. Cancel/Back (danger secondaries) never rest selected. */
function defaultSelected(
  primary: WalletAction,
  secondary: WalletAction | undefined,
  tertiary: WalletAction | undefined,
): WalletAction | null {
  if (primary && !primary.disabled) return primary
  for (const action of [secondary, tertiary]) {
    if (action && !action.disabled && action.tone !== 'danger') return action
  }
  return null
}

function ctaAttr(action: WalletAction): 'primary' | 'danger' {
  return action.tone === 'danger' ? 'danger' : 'primary'
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
  const fallback = defaultSelected(primary, secondary, tertiary)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const hovered =
    hoveredIndex != null && !actions[hoveredIndex]?.disabled
      ? actions[hoveredIndex]!
      : null
  const highlighted = hovered ?? fallback

  return (
    <footer
      className={`wallet-action-bar wallet-action-bar--${placement} ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
      data-cta={placement === 'nav' && highlighted ? ctaAttr(highlighted) : undefined}
      onPointerLeave={() => setHoveredIndex(null)}
    >
      {actions.map((action, index) => {
        const button = (
          <button
            key={placement === 'nav' ? undefined : `${action.label}-${index}`}
            type="button"
            className={buttonClass(action, placement)}
            data-selected={
              placement === 'nav' && highlighted && action === highlighted
                ? ''
                : undefined
            }
            disabled={action.disabled}
            autoFocus={action.autoFocus}
            title={action.title ?? action.label}
            aria-label={action.label}
            onClick={action.onClick}
            onPointerEnter={() => {
              if (placement !== 'nav') return
              setHoveredIndex(index)
            }}
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
            className={slotClass(action, highlighted)}
            data-highlighted={
              highlighted && action === highlighted ? '' : undefined
            }
          >
            {button}
          </span>
        ) : (
          button
        )
      })}
    </footer>
  )
}
