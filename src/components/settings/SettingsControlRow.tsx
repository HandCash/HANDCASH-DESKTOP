import type { ReactNode } from 'react'
import { SettingsRowIcon } from './settingIcons'

type Props = {
  label: string
  labelFor?: string
  description?: ReactNode
  icon?: ReactNode
  children: ReactNode
}

/** Inline preference row — label on the left, control on the right. */
export function SettingsControlRow({ label, labelFor, description, icon, children }: Props) {
  return (
    <li className="settings-row settings-row-static">
      <div className="settings-control-row">
        {icon ? <SettingsRowIcon>{icon}</SettingsRowIcon> : null}
        <span className="settings-row-body">
          {labelFor ? (
            <label className="settings-row-label" htmlFor={labelFor}>
              {label}
            </label>
          ) : (
            <strong className="settings-row-label">{label}</strong>
          )}
          {description ? <span className="settings-row-desc">{description}</span> : null}
        </span>
        {children}
      </div>
    </li>
  )
}
