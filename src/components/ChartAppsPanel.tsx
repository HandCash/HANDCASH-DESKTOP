import { Button } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { useMemo } from 'react'
import { chartAppsMachine } from '../machines/chartAppsMachine'
import { builtinApps, type BuiltinApp } from '../apps/builtin'
import { describeEffect, effectNeedsApproval } from '../apps/chartEffects'
import { CHART_APPS_DESCRIPTION, shortIdentityKey } from '../apps/chartFormat'
import type { ChartApp } from '../apps/chartTypes'
import { chartNetworkFor, desktopChartSupport, desktopEffectPorts } from '../apps/desktopEffectPorts'
import { getActiveWallet } from '../wallet/session'
import { playWalletSound } from '../wallet/soundService'
import { SettingsNavRow, settingIconFor } from './settings'
import { ChartAppView } from './ChartAppView'

const REFUSAL: Record<string, string> = {
  invalid: 'Not a valid app',
  hash: 'Changed since it was shared',
  signature: 'Signature does not match',
  unsupported: 'Needs something this wallet does not offer',
}

function appName(app: BuiltinApp): string {
  return app.verification.ok ? app.verification.chart.name : String((app.raw as { name?: unknown }).name ?? app.id)
}

function effectLines(chart: ChartApp): Array<{ asks: boolean; text: string }> {
  const lines = new Map<string, { asks: boolean; text: string }>()
  for (const effect of Object.values(chart.effects)) {
    const line = { asks: effectNeedsApproval(effect.kind), text: describeEffect(effect) }
    lines.set(`${line.asks}-${line.text}`, line)
  }
  return [...lines.values()]
}

function AppReview({ app, onRun, onBack }: { app: BuiltinApp; onRun: () => void; onBack: () => void }) {
  const v = app.verification
  return (
    <div className="settings-form" data-aeon-part="review" data-aeon-state={v.ok ? 'verified' : 'refused'}>
      <div className="confirm-password-copy">
        <h2 className="permission-request-title">{appName(app)}</h2>
        {v.ok ? (
          <>
            <p className="confirm-password-lede">{v.chart.summary}</p>
            <p className="permission-note">
              By {v.chart.author.name} · signature verified ({shortIdentityKey(v.chart.author.identityKey)}) · version {v.chart.version}
            </p>
          </>
        ) : (
          <p className="permission-note" role="alert">
            This app won't run. {REFUSAL[v.reason]}: {v.errors.slice(0, 3).join('; ')}
          </p>
        )}
      </div>
      {v.ok ? (
        <dl className="permission-meta" data-aeon-part="effects">
          {effectLines(v.chart).map(({ asks, text }) => (
            <div key={`${asks}-${text}`}>
              <dt>{asks ? 'Asks you first' : 'Can'}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="actions">
        <Button.Root variant="ghost" className="btn btn-ghost" onClick={onBack}>
          <Button.Label>Back</Button.Label>
        </Button.Root>
        <Button.Root
          variant="solid"
          className="btn btn-primary"
          data-aeon-part="run"
          disabled={!v.ok}
          onClick={onRun}
        >
          <Button.Label>Open app</Button.Label>
        </Button.Root>
      </div>
    </div>
  )
}

/** Settings → Apps: the built-in chart apps, what each can do, and the app itself in place. */
export function ChartAppsPanel() {
  const chain = getActiveWallet()?.chain ?? 'main'
  const apps = useMemo(() => builtinApps(desktopChartSupport(chain)), [chain])
  const [snapshot, send] = useMachine(chartAppsMachine)
  const open = apps.find((a) => a.id === snapshot.context.appId) ?? null
  const { icon } = settingIconFor('chart-apps')

  return (
    <div
      className="nav-section-body settings-detail settings-scroll"
      data-aeon-scope="chart-apps"
      data-aeon-state={stateToAttr(snapshot.value)}
    >
      {snapshot.matches('list') ? (
        <>
          <p className="settings-section-lede">{CHART_APPS_DESCRIPTION}</p>
          <ul className="settings-list">
            {apps.map((app) => (
              <SettingsNavRow
                key={app.id}
                label={appName(app)}
                icon={icon}
                description={app.verification.ok ? `${app.verification.chart.author.name} · Verified` : undefined}
                status={app.verification.ok ? undefined : `Won't run: ${REFUSAL[app.verification.reason]}`}
                statusTone="warn"
                onClick={() => send({ type: 'OPEN', appId: app.id, verified: app.verification.ok })}
              />
            ))}
          </ul>
        </>
      ) : null}
      {snapshot.matches('reviewing') && open ? (
        <AppReview
          app={open}
          onBack={() => send({ type: 'BACK' })}
          onRun={() => {
            playWalletSound('soft')
            send({ type: 'RUN' })
          }}
        />
      ) : null}
      {snapshot.matches('running') && open?.verification.ok ? (
        <>
          <div className="actions" data-aeon-part="app-bar">
            <Button.Root variant="ghost" className="btn btn-ghost btn-compact" onClick={() => send({ type: 'BACK' })}>
              <Button.Label>Close {open.verification.chart.name}</Button.Label>
            </Button.Root>
          </div>
          <ChartAppView
            chart={open.verification.chart}
            ports={desktopEffectPorts}
            network={chartNetworkFor(chain)}
            onClose={() => send({ type: 'BACK' })}
          />
        </>
      ) : null}
    </div>
  )
}
