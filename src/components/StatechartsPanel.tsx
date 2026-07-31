import { useState } from 'react'
import { APP_STATECHART_PAGES } from '../wallet/appStatecharts'
import { MermaidDiagram } from './MermaidDiagram'

export function StatechartsPanel() {
  const [pageId, setPageId] = useState(APP_STATECHART_PAGES[0]!.id)
  const page = APP_STATECHART_PAGES.find((p) => p.id === pageId) ?? APP_STATECHART_PAGES[0]!

  return (
    <div
      className="nav-child-panel statecharts-panel"
      data-aeon-scope="statecharts"
      data-aeon-part="panel"
    >
      <header className="statecharts-head">
        <h3 className="statecharts-title">Software statecharts</h3>
        <p className="statecharts-lead">
          Master map of HandCash Desktop — navigate each XState chart that drives the UI.
        </p>
      </header>

      <nav className="statecharts-nav" aria-label="Statechart pages">
        {APP_STATECHART_PAGES.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`statecharts-nav-btn${p.id === page.id ? ' is-active' : ''}`}
            aria-current={p.id === page.id ? 'page' : undefined}
            onClick={() => setPageId(p.id)}
          >
            {p.label}
          </button>
        ))}
      </nav>

      <p className="statecharts-caption">{page.caption}</p>

      <div className="statecharts-viewport" data-aeon-part="chart">
        <MermaidDiagram key={page.id} source={page.source} title={page.label} />
      </div>
    </div>
  )
}
