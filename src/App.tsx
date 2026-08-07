import { useCallback, useEffect, useState } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { appMachine } from './machines/appMachine'
import { hasVault, hasOrphanedToolboxWallet } from './wallet/vault'
import { clearActiveWallet } from './wallet/session'
import { finishPendingWalletWipe } from './wallet/wipeWallet'
import { handleBrc100Request } from './wallet/brc100Handler'
import { handleDevicePeerRequest } from './wallet/devicePeerHandler'
import { clearRemoteSnapshots } from './wallet/deviceMesh'
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
import { WalletStatusPill, sessionFromMachine } from './components/WalletStatusPill'
import { ConnectPermissionDialog } from './components/ConnectPermissionDialog'
import { ActionPermissionDialog } from './components/ActionPermissionDialog'
import { UpdatePrompt } from './components/UpdatePrompt'
import { ScreenshotToast } from './components/ScreenshotToast'
import { AppToastHost } from './components/AppToastHost'
import { setAutoPaySettings } from './wallet/autoPay'
import { isMobileWalletPlatform } from './wallet/isMobilePlatform'
import { UpdateProvider } from './wallet/updateProvider'
import { playWalletSound } from './wallet/soundService'
import { showToast, toastError } from './wallet/toast'
import { refreshFromChain } from './wallet/chainIngest'
import { softPullHistoryIfRemoteNewer } from './wallet/deviceSync'
import { isDeviceParityEnabled } from './wallet/paymentPolicy'
import { getSessionBackupPassword } from './wallet/sessionBackupAuth'
import { refreshCloudBackupHealth } from './wallet/cloudBackupHealth'
import { isVaultStoredUnsealed } from './wallet/vaultSealStatus'
import { setSyncHealth } from './wallet/walletHealth'

export function App() {
  const [snapshot, send] = useMachine(appMachine)
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const stateAttr = stateToAttr(snapshot.value)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await finishPendingWalletWipe()
        if (cancelled) return
        const info = window.handcash
          ? await window.handcash.getAppInfo()
          : { version: '1.0.0-web', name: 'HandCash', isPackaged: false, platform: 'web' }
        if (cancelled) return
        const orphanedToolbox = !hasVault() ? await hasOrphanedToolboxWallet() : false
        if (cancelled) return
        const vaultPresent = hasVault()
        send({
          type: 'BOOTSTRAPPED',
          hasVault: vaultPresent,
          version: info.version,
          orphanedToolbox,
        })

        if (vaultPresent && isVaultStoredUnsealed()) {
          showToast({
            title: 'Vault not OS-sealed',
            body: 'This device could not seal the vault with the OS keychain. Your password still encrypts keys; keep the machine locked.',
            tone: 'error',
            durationMs: 9000,
          })
        }

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

  useEffect(() => {
    if (!window.handcash?.onDevicePeerHttpRequest || !window.handcash.respondDevicePeerHttp) {
      return
    }
    const respond = window.handcash.respondDevicePeerHttp.bind(window.handcash)
    const off = window.handcash.onDevicePeerHttpRequest((event) => {
      void (async () => {
        try {
          const result = await handleDevicePeerRequest(event)
          respond({
            request_id: event.request_id,
            status: result.status,
            body: result.body,
          })
        } catch (err) {
          const description = err instanceof Error ? err.message : String(err)
          respond({
            request_id: event.request_id,
            status: 500,
            body: JSON.stringify({
              status: 'error',
              code: 'DEVICE_PEER_HANDLER_ERROR',
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

  const walletUnlocked = snapshot.matches('ready') || snapshot.matches('sending')

  const handleManualSync = useCallback(async () => {
    if (!walletUnlocked) return
    playWalletSound('soft')
    try {
      if (isDeviceParityEnabled() && getSessionBackupPassword()) {
        setSyncHealth({
          phase: 'syncing',
          label: 'Syncing history',
          message: 'Checking for a newer history backup',
        })
        await softPullHistoryIfRemoteNewer()
      }
      const sats = await refreshFromChain({ forceReview: true, announceReceive: true })
      if (sats != null) send({ type: 'REFRESHED', balanceSats: sats })
      void refreshCloudBackupHealth()
    } catch (err) {
      toastError('Refresh failed', err instanceof Error ? err.message : String(err))
    }
  }, [send, walletUnlocked])

  return (
    <UpdateProvider>
      <div className="app-shell" data-aeon-scope="app" data-aeon-state={stateAttr}>
        <header className="titlebar aeon-titlebar">
          <BrandLogo variant="green" />
          <WalletStatusPill
            session={sessionFromMachine(snapshot.value)}
            bridgeOnline={snapshot.context.bridgeOnline}
            onManualSync={walletUnlocked ? handleManualSync : undefined}
          />
        </header>

        <main className="stage">
          {snapshot.matches('boot') && (
            <section className="auth-screen" data-aeon-state="loading">
              <div className="auth-copy">
                <h1 className="auth-title">Opening…</h1>
                <p className="auth-lede">Getting your wallet ready.</p>
              </div>
            </section>
          )}

          {snapshot.matches('failure') && (
            <section className="auth-screen" data-aeon-state="failure">
              <div className="auth-copy">
                <h1 className="auth-title">Something broke</h1>
                <p className="error auth-error">{snapshot.context.error}</p>
              </div>
              <button className="btn btn-primary auth-submit" onClick={() => send({ type: 'CLEAR_ERROR' })}>
                Retry
              </button>
            </section>
          )}

          {(snapshot.matches('onboarding') || snapshot.matches('locked')) && (
            <AuthScreen
              mode={snapshot.matches('onboarding') ? 'onboarding' : 'locked'}
              error={snapshot.context.error}
              recoveryOnly={snapshot.context.recoveryOnly}
              onCreated={(profile, balanceSats) => send({ type: 'CREATED', profile, balanceSats })}
              onUnlocked={(profile, balanceSats) => send({ type: 'UNLOCKED', profile, balanceSats })}
              onFail={(error) => send({ type: 'FAIL', error })}
            />
          )}

          {(snapshot.matches('ready') || snapshot.matches('sending')) && snapshot.context.profile && (
            <Dashboard
              profile={snapshot.context.profile}
              balanceSats={snapshot.context.balanceSats}
              onSent={(balanceSats) => send({ type: 'SENT', balanceSats })}
              onRefreshBalance={(balanceSats) => send({ type: 'REFRESHED', balanceSats })}
              onLock={() => {
                clearActiveWallet()
                clearRemoteSnapshots()
                cancelPendingPermissions('lock')
                clearPermissionSession()
                send({ type: 'LOCK' })
              }}
              onFail={(error) => {
                playWalletSound('error')
                toastError('Something went wrong', error)
              }}
            />
          )}
        </main>

        <AppToastHost />
        <UpdatePrompt />
        <ScreenshotToast />

        {/*
          Desktop: modal prompts.
          Mobile unlocked: Activity + bottom Accept/Decline (WalletNav).
          Mobile locked: keep modals so a request can still be decided after unlock UI.
        */}
        {(!isMobileWalletPlatform() || !walletUnlocked) && (
          <>
            <ConnectPermissionDialog
              pending={pendingConnect}
              onAllow={() => {
                if (pendingConnect) {
                  resolvePermission(pendingConnect.id, 'allow')
                  playWalletSound('connect')
                }
              }}
              onDeny={() => {
                if (pendingConnect) {
                  resolvePermission(pendingConnect.id, 'deny')
                  playWalletSound('deny')
                }
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
                playWalletSound('connect')
              }}
              onDeny={() => {
                if (pendingAction) {
                  resolvePermission(pendingAction.id, 'deny')
                  playWalletSound('deny')
                }
              }}
            />
          </>
        )}
      </div>
    </UpdateProvider>
  )
}
