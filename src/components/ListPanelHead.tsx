import type { ReactNode } from 'react'

type Props = {
  title: string
  count: number
  countLabel: string
  actions: ReactNode
  /** The panel's search, placed directly under the title row. */
  search?: ReactNode
}

/** Shared head for list screens (Apps, Friends): title and count, icon actions, then search. */
export function ListPanelHead({ title, count, countLabel, actions, search }: Props) {
  return (
    <div className="list-panel-top" data-aeon-part="head">
      <div className="connected-panel-head list-panel-head">
        <h2>
          {title}
          <span className="list-panel-count" aria-label={countLabel}>
            {count}
          </span>
        </h2>
        <div className="panel-icon-toolbar list-panel-actions">{actions}</div>
      </div>
      {search ? (
        <div className="list-panel-search" data-aeon-part="search">
          {search}
        </div>
      ) : null}
    </div>
  )
}
