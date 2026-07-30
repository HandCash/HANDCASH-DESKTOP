import { useEffect, useState } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { appMachine } from './machines/appMachine'
import { hasVault } from './wallet/vault'
import { clearActiveWallet } from './wallet/session'
import { handleBrc100Request } from './wallet/brc100Handler'
import {
  resolvePermission,
  cancelPendingPermissions,
  clearPermissionSession,
  subscribePermissionRequests,
  type PendingPrompt,
} from './wallet/permissions'
import { AuthScreen } from './components/AuthScreen'
import { Dashboard } from './components/Dashboard'
import { BrandLogo } from './components/BrandLogo'
import { ConnectPermissionDialog } from './components/ConnectPermissionDialog'
import { ActionPermissionDialog } from './components/ActionPermissionDialog'
import { setAutoPaySettings } from './wallet/autoPay'

export function App() {
  const [snapshot, send] = useMachine(appMachine)
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const stateAttr = stateToAttr(snapshot.value)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const info = window.handcash
          ? await window.handcash.getAppInfo()
          : { version: '1.0.0-web', name: 'HandCash', isPackaged: false, platform: 'web' }
        if (cancelled) return
        send({ type: 'BOOTSTRAPPED', hasVault: hasVault(), version: info.version })

        if (window.handcash?.getBridgeStatus) {
          const status = await window.handcash.getBridgeStatus()
          if (!cancelled) send({ type: 'BRIDGE', online: status.online })
        } else {
          send({ type: 'BRIDGE', online: Boolean(window.handcash) })
        }
      } catch (err) {
        send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [send])

  useEffect(() => {
    if (!window.handcash?.onBridgeStatus) return
    return window.handcash.onBridgeStatus((status) => {
      send({ type: 'BRIDGE', online: status.online })
    })
  }, [send])

  useEffect(() => subscribePermissionRequests(setPendingPrompt), [])

  useEffect(() => {
    if (!window.handcash?.onHttpRequestCancelled) return
    return window.handcash.onHttpRequestCancelled(() => {
      cancelPendingPermissions('http-cancelled')
    })
  }, [])

  useEffect(() => {
    if (!window.handcash) return
    const off = window.handcash.onHttpRequest((event) => {
      void (async () => {
        try {
          const result = await handleBrc100Request(event)
          window.handcash?.respondHttp({
            request_id: event.request_id,
            status: result.status,
            body: result.body,
          })
        } catch (err) {
          const description = err instanceof Error ? err.message : String(err)
          window.handcash?.respondHttp({
            request_id: event.request_id,
            status: 500,
            body: JSON.stringify({
              status: 'error',
              code: 'WALLET_HANDLER_ERROR',
              description,
            }),
          })
        }
      })()
    })
    return off
  }, [])

  const pendingConnect = pendingPrompt?.kind === 'connect' ? pendingPrompt : null
  const pendingAction = pendingPrompt?.kind === 'action' ? pendingPrompt : null

  return (
    <div className="app-shell" data-aeon-scope="app" data-aeon-state={stateAttr}>
      <header className="titlebar">
        <BrandLogo variant="green" />
        <div className="status-pill">
          <span className="status-dot" {...(!snapshot.context.bridgeOnline ? { 'data-offline': true } : {})} />
          {snapshot.context.bridgeOnline ? 'Online' : 'Offline'}
        </div>
      </header>

      <main className="stage">
        {snapshot.matches('boot') && (
          <section className="hero-panel" data-aeon-state="loading">
            <h1 className="display">Opening HandCash…</h1>
            <p className="lede">Getting your wallet ready.</p>
          </section>
        )}

        {snapshot.matches('failure') && (
          <section className="hero-panel" data-aeon-state="failure">
            <h1 className="display">Something broke.</h1>
            <p className="error">{snapshot.context.error}</p>
            <button className="btn btn-primary" onClick={() => send({ type: 'CLEAR_ERROR' })}>
              Retry
            </button>
          </section>
        )}

        {(snapshot.matches('onboarding') || snapshot.matches('locked')) && (
          <AuthScreen
            mode={snapshot.matches('onboarding') ? 'onboarding' : 'locked'}
            error={snapshot.context.error}
            onCreated={(profile, balanceSats) => send({ type: 'CREATED', profile, balanceSats })}
            onUnlocked={(profile, balanceSats) => send({ type: 'UNLOCKED', profile, balanceSats })}
            onFail={(error) => send({ type: 'FAIL', error })}
          />
        )}

        {(snapshot.matches('ready') || snapshot.matches('sending')) && snapshot.context.profile && (
          <Dashboard
            profile={snapshot.context.profile}
            balanceSats={snapshot.context.balanceSats}
            error={snapshot.context.error}
            onSent={(balanceSats) => send({ type: 'SENT', balanceSats })}
            onRefreshBalance={(balanceSats) => send({ type: 'REFRESHED', balanceSats })}
            onLock={() => {
              clearActiveWallet()
              cancelPendingPermissions('lock')
              clearPermissionSession()
              send({ type: 'LOCK' })
            }}
            onFail={(error) => send({ type: 'FAIL', error })}
          />
        )}
      </main>

      <ConnectPermissionDialog
        pending={pendingConnect}
        onAllow={() => {
          if (pendingConnect) resolvePermission(pendingConnect.id, 'allow')
        }}
        onDeny={() => {
          if (pendingConnect) resolvePermission(pendingConnect.id, 'deny')
        }}
      />

      <ActionPermissionDialog
        pending={pendingAction}
        onAllow={(autoPay) => {
          if (!pendingAction) return
          if (autoPay) {
            setAutoPaySettings(pendingAction.origin, autoPay)
          }
          resolvePermission(pendingAction.id, 'allow')
        }}
        onDeny={() => {
          if (pendingAction) resolvePermission(pendingAction.id, 'deny')
        }}
      />
    </div>
  )
}
