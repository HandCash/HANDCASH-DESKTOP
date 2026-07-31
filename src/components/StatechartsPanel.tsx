import { useCallback, useMemo, useState } from 'react'
import {
  APP_STATECHART_PAGES,
  STATECHART_NAVIGABLE_IDS,
} from '../wallet/appStatecharts'
import { MermaidDiagram } from './MermaidDiagram'
import { playWalletSound } from '../wallet/soundService'

export function StatechartsPanel() {
  const [pageId, setPageId] = useState(APP_STATECHART_PAGES[0]!.id)
  const page = APP_STATECHART_PAGES.find((p) => p.id === pageId) ?? APP_STATECHART_PAGES[0]!

  const navigableIds = useMemo(() => {
    // Don't link the page you're already on.
    const next = new Set(STATECHART_NAVIGABLE_IDS)
    next.delete(page.id)
    return next
  }, [page.id])

  const onNavigateState = useCallback((id: string) => {
    if (!STATECHART_NAVIGABLE_IDS.has(id) || id === pageId) return
    playWalletSound('soft')
    setPageId(id)
  }, [pageId])

  return (
    <div
      className="nav-child-panel statecharts-panel"
      data-aeon-scope="statecharts"
      data-aeon-part="panel"
    >
      <div className="statecharts-toolbar">
        <nav className="statecharts-nav" aria-label="Statechart pages">
          {APP_STATECHART_PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`statecharts-nav-btn${p.id === page.id ? ' is-active' : ''}`}
              aria-current={p.id === page.id ? 'page' : undefined}
              title={p.caption}
              onClick={() => {
                if (p.id !== pageId) playWalletSound('soft')
                setPageId(p.id)
              }}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <p className="statecharts-caption">{page.caption}</p>
      </div>

      <div className="statecharts-viewport" data-aeon-part="chart">
        <MermaidDiagram
          key={page.id}
          source={page.source}
          title={page.label}
          navigableIds={navigableIds}
          onNavigateState={onNavigateState}
        />
      </div>
    </div>
  )
}
