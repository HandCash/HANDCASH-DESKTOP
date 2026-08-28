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
  onClick: () => void
  trailing?: ReactNode
}

/** Navigable Settings row — ListRow button with optional live status. */
export function SettingsNavRow({
  label,
  description,
  status,
  statusTone = 'muted',
  icon,
  iconTone = 'default',
  onClick,
  trailing,
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
        {icon ? (
          <ListRow.Leading aria-hidden>
            <SettingsRowIcon tone={iconTone}>{icon}</SettingsRowIcon>
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
      </ListRow.Root>
    </li>
  )
}
