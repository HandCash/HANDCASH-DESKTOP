import type { ReactNode } from 'react'
import { playWalletSound } from '../../wallet/soundService'
import { SettingsRowIcon, type SettingIconTone } from './settingIcons'

type Props = {
  label: string
  description?: string
  status?: string
  statusTone?: 'ok' | 'warn' | 'muted'
  icon?: ReactNode
  iconTone?: SettingIconTone
  onClick: () => void
}

/** Settings destination as a grid tile (list/grid toggle). */
export function SettingsGridRow({
  label,
  description,
  status,
  statusTone = 'muted',
  icon,
  iconTone = 'default',
  onClick,
}: Props) {
  const desc = status || description
  return (
    <li className="collection-grid-card settings-grid-card">
      <button
        type="button"
        className="collection-grid-main settings-grid-main"
        onClick={() => {
          playWalletSound('soft')
          onClick()
        }}
      >
        {icon ? <SettingsRowIcon tone={iconTone}>{icon}</SettingsRowIcon> : null}
        <strong className="collection-grid-name">{label}</strong>
        {desc ? (
          <span
            className="collection-grid-host settings-grid-desc"
            data-aeon-part="row-status"
            data-aeon-state={status ? statusTone : 'idle'}
          >
            {desc}
          </span>
        ) : null}
      </button>
    </li>
  )
}
