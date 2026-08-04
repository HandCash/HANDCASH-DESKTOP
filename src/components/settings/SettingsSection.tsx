import type { ReactNode } from 'react'

type Props = {
  title: string
  children: ReactNode
  part?: string
  groupKey?: string
  className?: string
}

/** Compact Settings group shell — Aeon data attrs, shared chrome. */
export function SettingsSection({ title, children, part, groupKey, className }: Props) {
  return (
    <section
      className={`settings-group${className ? ` ${className}` : ''}`}
      data-aeon-part={part}
      data-settings-group={groupKey ?? title}
    >
      <h3 className="settings-group-title">{title}</h3>
      {children}
    </section>
  )
}
