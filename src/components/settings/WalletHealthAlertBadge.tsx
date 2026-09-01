import { WarningIcon } from '../icons'

type Props = {
  tone: 'warn' | 'error'
}

/** Caution icon in the same trailing pill as Settings icon toggles. */
export function WalletHealthAlertBadge({ tone }: Props) {
  return (
    <div className="settings-icon-toggle wallet-health-trailing" aria-hidden>
      <span
        className="settings-icon-toggle-btn wallet-health-alert"
        data-tone={tone}
        data-selected
      >
        <WarningIcon size={16} />
      </span>
    </div>
  )
}
