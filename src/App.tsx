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
  noteInboundWalletRequest,
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
import { UpdateProvider } from './wallet/updateProvider'
import { playWalletSound } from './wallet/soundService'
import { showToast, toastError, toastSuccess } from './wallet/toast'
import { appDisplayName } from './wallet/appIdentity'
import { refreshFromChain } from './wallet/chainIngest'
import { softPullHistoryIfRemoteNewer } from './wallet/deviceSync'
import { isDeviceParityEnabled } from './wallet/paymentPolicy'
import { getSessionBackupPassword } from './wallet/sessionBackupAuth'
import { refreshCloudBackupHealth } from './wallet/cloudBackupHealth'
import { isVaultStoredUnsealed } from './wallet/vaultSealStatus'
import { setSyncHealth } from './wallet/walletHealth'
import { isRecomposeInFlight } from './wallet/recompose'
import {
  shouldKeepTrustedBalance,
  shouldKeepDisplayBalanceOnConfirmedRead,
  writeTrustedBalance,
} from './wallet/balanceSnapshot'
import { DISPLAY_BALANCE_REFRESH_EVENT, publishDisplayBalanceRefresh } from './wallet/displayBalanceRefresh'
import { shouldAutoUnlock } from './wallet/deviceLockPrefs'

const AUTO_LOCK_IDLE_MS = 15 * 60 * 1000

export function App() {
  const [snapshot, send] = useMachine(appMachine)
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const stateAttr = stateToAttr(snapshot.value)
  const lockWallet = useCallback(
    (reason: 'manual' | 'idle' = 'manual') => {
      clearActiveWallet()
      clearRemoteSnapshots()
      cancelPendingPermissions(reason)
      clearPermissionSession()
      send({ type: 'LOCK' })
    },
    [send],
  )

  const walletReady = snapshot.matches('ready')

  useEffect(() => {
    // Never interrupt a legal spend phase. Once the chart returns to ready, a
    // fresh idle window begins and unattended keys are removed from memory.
    if (!walletReady) return
    if (shouldAutoUnlock()) return
    let timer = 0
    let hideTimer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => lockWallet('idle'), AUTO_LOCK_IDLE_MS)
    }
    // Locking on every hide (alt-tab / close) remounts the lock screen which
    // auto-prompts Touch ID — fingerprint while the user is leaving. Grace the
    // hide; idle timeout still covers a long background.
    const HIDE_LOCK_GRACE_MS = 5 * 60 * 1000
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        window.clearTimeout(hideTimer)
        hideTimer = window.setTimeout(() => lockWallet('idle'), HIDE_LOCK_GRACE_MS)
        return
      }
      window.clearTimeout(hideTimer)
      arm()
    }
    const events: Array<keyof WindowEventMap> = [
      'pointerdown',
      'keydown',
      'touchstart',
      'focus',
    ]
    for (const event of events) window.addEventListener(event, arm, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    arm()
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(hideTimer)
      for (const event of events) window.removeEventListener(event, arm)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [walletReady, lockWallet])

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
      const releaseInbound = noteInboundWalletRequest()
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
        } finally {
          releaseInbound()
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
  useEffect(() => {
    const { profile, balanceSats } = snapshot.context
    if (!walletUnlocked || !profile) return
    // Persist every balance the session chart actually accepts — refreshes and
    // sends included. Cold launch can then paint this identity's last confirmed
    // UI value before IndexedDB/history work finishes.
    writeTrustedBalance(profile.identityKey, profile.chain, balanceSats)
  }, [
    walletUnlocked,
    snapshot.context.profile,
    snapshot.context.balanceSats,
  ])

  useEffect(() => {
    if (!walletUnlocked) return
    publishDisplayBalanceRefresh(snapshot.context.balanceSats)
  }, [walletUnlocked, snapshot.context.balanceSats])

  const onSent = useCallback(
    (balanceSats: number) => send({ type: 'SENT', balanceSats }),
    [send],
  )

  const onWalletFail = useCallback((error: string) => {
    playWalletSound('error')
    toastError('Something went wrong', error)
  }, [])

  const handleBalanceRefresh = useCallback(
    (balanceSats: number) => {
      // A BRC-39 pull temporarily replaces local state. An empty read in that
      // window is not proof the wallet was spent; keep the trusted figure until
      // recompose completes and reports its final Toolbox balance.
      if (
        shouldKeepTrustedBalance(
          snapshot.context.balanceSats,
          balanceSats,
          isRecomposeInFlight(),
        )
      ) {
        console.info('[balance] kept trusted balance during recompose')
        return
      }
      // Confirmed-only reads omit pending change from live local sends. They must
      // not paint a lower hero while the display total still includes that change.
      if (
        shouldKeepDisplayBalanceOnConfirmedRead(
          snapshot.context.balanceSats,
          balanceSats,
        )
      ) {
        console.info('[balance] kept display total — confirmed read omitted pending change')
        return
      }
      send({ type: 'REFRESHED', balanceSats })
    },
    [send, snapshot.context.balanceSats],
  )

  useEffect(() => {
    const onBalanceRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceSats?: number }>).detail
      if (typeof detail?.balanceSats !== 'number') return
      handleBalanceRefresh(detail.balanceSats)
    }
    document.addEventListener(DISPLAY_BALANCE_REFRESH_EVENT, onBalanceRefreshed)
    return () =>
      document.removeEventListener(
        DISPLAY_BALANCE_REFRESH_EVENT,
        onBalanceRefreshed,
      )
  }, [handleBalanceRefresh])

  const handleManualSync = useCallback(async () => {
    if (!walletUnlocked) return
    playWalletSound('soft')
    try {
      if (isDeviceParityEnabled() && getSessionBackupPassword()) {
        setSyncHealth({
          phase: 'syncing',
          message: 'Checking for a newer history backup',
        })
        try {
          await softPullHistoryIfRemoteNewer()
        } finally {
          // History pull can outlive the syncing watchdog; never leave its
          // message (or a cleared-but-stuck Syncing phase) for chain ingest.
          setSyncHealth({ phase: 'idle', message: null })
        }
      }
      const sats = await refreshFromChain({ forceReview: true, announceReceive: true })
      if (sats != null) handleBalanceRefresh(sats)
      void refreshCloudBackupHealth()
    } catch (err) {
      toastError('Refresh failed', err instanceof Error ? err.message : String(err))
    }
  }, [handleBalanceRefresh, walletUnlocked])

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
              onBalanceRefreshed={handleBalanceRefresh}
              onFail={(error) => send({ type: 'FAIL', error })}
            />
          )}

          {(snapshot.matches('ready') || snapshot.matches('sending')) && snapshot.context.profile && (
            <Dashboard
              profile={snapshot.context.profile}
              balanceSats={snapshot.context.balanceSats}
              onSent={onSent}
              onRefreshBalance={handleBalanceRefresh}
              onLock={() => lockWallet('manual')}
              onFail={onWalletFail}
            />
          )}
        </main>

        <AppToastHost />
        <UpdatePrompt />
        <ScreenshotToast />

        {/*
          Unlocked desktop: right column (Dashboard).
          Unlocked mobile: Activity + bottom Accept/Decline (WalletNav).
          Locked (any): modal prompts so a request can still be decided.
        */}
        {!walletUnlocked && (
          <>
            <ConnectPermissionDialog
              pending={pendingConnect}
              onAllow={() => {
                if (pendingConnect) {
                  if (!resolvePermission(pendingConnect.id, 'allow')) return
                  playWalletSound('connect')
                  toastSuccess(
                    'Connected',
                    `${appDisplayName(pendingConnect.origin)} can use your wallet`,
                  )
                }
              }}
              onDeny={() => {
                if (pendingConnect) {
                  if (!resolvePermission(pendingConnect.id, 'deny')) return
                  playWalletSound('deny')
                }
              }}
            />

            <ActionPermissionDialog
              pending={pendingAction}
              onAllow={(autoPay) => {
                if (!pendingAction) return false
                if (!resolvePermission(pendingAction.id, 'allow')) return false
                if (autoPay) {
                  setAutoPaySettings(pendingAction.origin, autoPay)
                }
                playWalletSound('connect')
                toastSuccess(
                  'Approved',
                  pendingAction.title || appDisplayName(pendingAction.origin),
                )
                return true
              }}
              onDeny={() => {
                if (!pendingAction) return false
                if (!resolvePermission(pendingAction.id, 'deny')) return false
                playWalletSound('deny')
                return true
              }}
            />
          </>
        )}
      </div>
    </UpdateProvider>
  )
}
