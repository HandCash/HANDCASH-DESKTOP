import type { ReactNode } from 'react'
import { ListRow } from '@aeon-ui/ui'
import { SettingsRowIcon } from './settingIcons'

type Props = {
  label: string
  description?: ReactNode
  icon?: ReactNode
  children: ReactNode
}

/** Preference row — ListRow leading · label · trailing control. */
export function SettingsControlRow({ label, description, icon, children }: Props) {
  return (
    <li>
      <ListRow.Root as="div">
        {icon ? (
          <ListRow.Leading aria-hidden>
            <SettingsRowIcon>{icon}</SettingsRowIcon>
          </ListRow.Leading>
        ) : null}
        <ListRow.Label>{label}</ListRow.Label>
        {description ? <ListRow.Description>{description}</ListRow.Description> : null}
        <ListRow.Trailing>{children}</ListRow.Trailing>
      </ListRow.Root>
    </li>
  )
}
