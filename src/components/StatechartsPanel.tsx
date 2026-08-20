import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Accordion } from '@aeon-ui/react'
import {
  APP_STATECHART_PAGES,
  STATECHART_NAVIGABLE_IDS,
} from '../wallet/appStatecharts'
import { getWalletRuntimeStatus } from '../wallet/walletRuntimeStatus'
import { MermaidDiagram } from './MermaidDiagram'
import { playWalletSound } from '../wallet/soundService'

export function StatechartsPanel() {
  const [pageId, setPageId] = useState(APP_STATECHART_PAGES[0]!.id)
  const activeChipRef = useRef<HTMLButtonElement | null>(null)
  const [runtime, setRuntime] = useState(() => getWalletRuntimeStatus())
  const page = APP_STATECHART_PAGES.find((p) => p.id === pageId) ?? APP_STATECHART_PAGES[0]!

  useEffect(() => {
    const tick = () => setRuntime(getWalletRuntimeStatus())
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])

  // The page list scrolls in one row, and following a link inside a chart can
  // select a page whose chip sits off-screen.
  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pageId])

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

  const coord = runtime.coordinator

  return (
    <div
      className="nav-child-panel statecharts-panel"
      data-aeon-scope="statecharts"
      data-aeon-part="panel"
    >
      {/* The live readout is reference material, not the reason this page is
          open — the summary line already carries coordinator, sync, pay and
          activity, so the per-layer grid stays folded until asked for. */}
      <Accordion.Root collapsible className="statecharts-live" aria-live="polite">
        <Accordion.Item value="live">
          <Accordion.ItemTrigger value="live" className="statecharts-live-trigger">
            <Accordion.ItemIndicator aria-hidden />
            <span className="statecharts-live-title">Live</span>
            <span className="statecharts-live-summary mono" title={runtime.summary}>
              {runtime.summary}
            </span>
          </Accordion.ItemTrigger>
          <Accordion.ItemContent value="live" className="statecharts-live-body">
            <dl className="statecharts-live-grid">
              <div>
                <dt>chainIngest</dt>
                <dd data-state={coord.chainIngest}>{coord.chainIngest}</dd>
              </div>
              <div>
                <dt>spend</dt>
                <dd data-state={coord.spend}>{coord.spend}</dd>
              </div>
              <div>
                <dt>historyReplica</dt>
                <dd data-state={coord.historyReplica}>{coord.historyReplica}</dd>
              </div>
              <div>
                <dt>recompose</dt>
                <dd data-state={coord.recompose}>{coord.recompose}</dd>
              </div>
              <div>
                <dt>spend waiting</dt>
                <dd>{coord.spendWaiting}</dd>
              </div>
              <div>
                <dt>sync</dt>
                <dd>
                  {runtime.syncPhase}
                  {runtime.syncAgeMs > 0 ? ` · ${Math.round(runtime.syncAgeMs / 1000)}s` : ''}
                </dd>
              </div>
              <div>
                <dt>payment</dt>
                <dd>{runtime.paymentPhase}</dd>
              </div>
              <div>
                <dt>activity</dt>
                <dd>
                  {runtime.activityRows} rows · gen {runtime.activityGeneration}
                </dd>
              </div>
            </dl>
            {runtime.syncMessage ? (
              <p className="statecharts-live-note">{runtime.syncMessage}</p>
            ) : null}
            {runtime.paymentDetail && runtime.paymentPhase !== 'idle' ? (
              <p className="statecharts-live-note">{runtime.paymentDetail}</p>
            ) : null}
          </Accordion.ItemContent>
        </Accordion.Item>
      </Accordion.Root>

      <nav className="statecharts-nav" aria-label="Statechart pages">
        {APP_STATECHART_PAGES.map((p) => (
          <button
            key={p.id}
            type="button"
            ref={p.id === page.id ? activeChipRef : undefined}
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

      <div className="statecharts-viewport" data-aeon-part="chart">
        {/* Overlaid, not stacked: the caption explains the chart without
            stealing a row from it. */}
        <p className="statecharts-caption" title={page.caption}>
          {page.caption}
        </p>
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
