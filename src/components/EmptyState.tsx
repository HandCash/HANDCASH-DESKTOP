import type { ReactNode } from 'react'

type Props = {
  title: string
  body: string
  icon?: ReactNode
  action?: ReactNode
}

/** Centered empty section — one title, one line, optional CTA. */
export function EmptyState({ title, body, icon, action }: Props) {
  return (
    <div className="empty-state" data-aeon-scope="empty-state" role="status">
      {icon ? (
        <div className="empty-state-icon" aria-hidden>
          {icon}
        </div>
      ) : null}
      <h3 className="empty-state-title">{title}</h3>
      <p className="empty-state-body">{body}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  )
}
