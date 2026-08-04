import type { ReactNode } from 'react'
import { playWalletSound } from '../../wallet/soundService'

type Props = {
  label: string
  description?: string
  status?: string
  statusTone?: 'ok' | 'warn' | 'muted'
  onClick: () => void
  trailing?: ReactNode
}

/** Navigable Settings list row with optional live status subtitle. */
export function SettingsNavRow({
  label,
  description,
  status,
  statusTone = 'muted',
  onClick,
  trailing,
}: Props) {
  const desc = status || description
  return (
    <li className="settings-row">
      <button
        type="button"
        className="settings-row-main"
        onClick={() => {
          playWalletSound('soft')
          onClick()
        }}
      >
        <span className="settings-row-body">
          <strong className="settings-row-label">
            {label}
            {trailing}
          </strong>
          {desc ? (
            <span
              className="settings-row-desc"
              data-aeon-part="row-status"
              data-aeon-state={status ? statusTone : 'idle'}
            >
              {desc}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  )
}
