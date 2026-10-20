import type { ReactNode } from 'react'
import { ListRow } from '@aeon-ui/ui'
import { playWalletSound } from '../../wallet/soundService'
import { SettingsRowIcon, type SettingIconTone } from './settingIcons'

type Props = {
  label: string
  description?: string
  status?: string
  statusTone?: 'ok' | 'warn' | 'muted'
  icon?: ReactNode
  iconTone?: SettingIconTone
  /** Replaces the icon tile, e.g. a brand mark that brings its own tile. */
  leading?: ReactNode
  onClick: () => void
  trailing?: ReactNode
  trailingEnd?: ReactNode
}

/** Navigable Settings row — ListRow button with optional live status. */
export function SettingsNavRow({
  label,
  description,
  status,
  statusTone = 'muted',
  icon,
  iconTone = 'default',
  leading,
  onClick,
  trailing,
  trailingEnd,
}: Props) {
  const desc = status || description
  return (
    <li>
      <ListRow.Root
        onClick={() => {
          playWalletSound('soft')
          onClick()
        }}
      >
        {leading || icon ? (
          <ListRow.Leading aria-hidden>
            {leading ?? <SettingsRowIcon tone={iconTone}>{icon}</SettingsRowIcon>}
          </ListRow.Leading>
        ) : null}
        <ListRow.Label>
          {label}
          {trailing}
        </ListRow.Label>
        {desc ? (
          <ListRow.Description data-aeon-state={status ? statusTone : 'idle'}>
            {desc}
          </ListRow.Description>
        ) : null}
        {trailingEnd ? <ListRow.Trailing>{trailingEnd}</ListRow.Trailing> : null}
      </ListRow.Root>
    </li>
  )
}
