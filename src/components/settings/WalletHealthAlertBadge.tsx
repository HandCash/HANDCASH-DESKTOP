import { WarningIcon } from '../icons'

type Props = {
  tone: 'warn' | 'error'
}

/** Caution circle on Wallet health row when a probe is degraded or down. */
export function WalletHealthAlertBadge({ tone }: Props) {
  return (
    <span className="wallet-health-alert" data-tone={tone} aria-hidden>
      <WarningIcon size={13} />
    </span>
  )
}
