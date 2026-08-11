import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBsvSignificant } from '../wallet/session'
import { refreshFromChain } from '../wallet/chainIngest'
import { isPhoneShell } from '../wallet/runtimePlatform'
import { isMobileWalletPlatform } from '../wallet/isMobilePlatform'
import {
  formatUsdFromSats,
  getCachedUsdPerBsv,
  refreshUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  toggleDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import type { WalletProfile } from '../machines/appMachine'
import {
  SendIcon,
  ReceiveIcon,
  LockIcon,
  AddMoneyIcon,
  ScanQrIcon,
} from './icons'
import { useFitFontSize } from './FitSlot'
import {
  listConnectedApps,
  resolvePermission,
  revokeOrigin,
  subscribeConnectedApps,
  subscribePermissionRequests,
  type ConnectedApp,
  type PendingPrompt,
} from '../wallet/permissions'
import { openReceiveFlow, openScanFlow, openSendFlow } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastSuccess } from '../wallet/toast'
import { appDisplayName } from '../wallet/appIdentity'
import { setAutoPaySettings } from '../wallet/autoPay'
import { WhatIsBsvPanel } from './WhatIsBsvPanel'
import { WalletNav } from './WalletNav'
import { RecentActivityPanel } from './RecentActivity'
import { PermissionRequestPanel } from './PermissionRequestPanel'
import {
  getPaymentProgress,
  setPaymentProgress,
  subscribePaymentProgress,
  type PaymentProgress,
} from '../wallet/paymentProgress'
import { pollDeviceMeshOnce, startDeviceMesh } from '../wallet/deviceMesh'
import { isDeviceParityEnabled } from '../wallet/paymentPolicy'
import { softPullHistoryIfRemoteNewer } from '../wallet/deviceSync'
import { getSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { ADD_MONEY_URL } from '../wallet/walletConfig'
import { identityQrDataUrl } from '../wallet/identityQr'
import { getSyncHealth, subscribeSyncHealth } from '../wallet/walletHealth'

/** Cloud history is merged far less often than the chain poll — it is a network round trip. */
const HISTORY_PULL_INTERVAL_MS = 60_000
/** Quiet steady-state chain poll. */
const CHAIN_POLL_MS = 30_000
/** Device-parity steady-state poll. */
const CHAIN_POLL_PARITY_MS = 12_000
/**
 * While latch-proven tips are waiting on GorillaPool / BEEF, poll hard so the
 * ordinal lands in Collectables as soon as the indexer catches up — not after
 * another quiet 30s tick.
 */
const CHAIN_POLL_PENDING_MS = 8_000

function nextChainPollMs(pendingTips: number): number {
  if (pendingTips > 0) return CHAIN_POLL_PENDING_MS
  return isDeviceParityEnabled() ? CHAIN_POLL_PARITY_MS : CHAIN_POLL_MS
}

type Props = {
  profile: WalletProfile
  balanceSats: number
  onSent: (balanceSats: number) => void
  onRefreshBalance: (balanceSats: number) => void
  onLock: () => void
  onFail: (error: string) => void
}

/** One identity / one pot (BRC-75). */
export function Dashboard({
  profile,
  balanceSats,
  onSent,
  onRefreshBalance,
  onLock,
  onFail,
}: Props) {
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>(() => listConnectedApps())
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const [paymentProgress, setPaymentProgressState] = useState<PaymentProgress>(() =>
    getPaymentProgress(),
  )
  const [lastApproved, setLastApproved] = useState<PendingPrompt | null>(null)
  const balanceSlotRef = useRef<HTMLDivElement>(null)
  const balanceBtnRef = useRef<HTMLButtonElement>(null)
  const sideRef = useRef<HTMLElement>(null)
  const sideBusy =
    !isMobileWalletPlatform() &&
    (pendingPrompt != null || paymentProgress.phase !== 'idle')
  const sideApproval = !isMobileWalletPlatform() && pendingPrompt != null

  useEffect(() => subscribeConnectedApps(setConnectedApps), [])
  useEffect(() => {
    if (isMobileWalletPlatform()) return
    return subscribePermissionRequests(setPendingPrompt)
  }, [])
  useEffect(() => {
    if (isMobileWalletPlatform()) return
    return subscribePaymentProgress(setPaymentProgressState)
  }, [])
  useEffect(() => {
    if (pendingPrompt) setLastApproved(null)
  }, [pendingPrompt?.id])
  useEffect(() => {
    if (!sideBusy || !sideRef.current) return
    sideRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [sideBusy, pendingPrompt?.id, paymentProgress.phase])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])

  const onPermissionAllow = useCallback(
    (autoPay?: { enabled: boolean; maxUsd: number; windowHours: number }) => {
      if (!pendingPrompt) return
      if (autoPay) setAutoPaySettings(pendingPrompt.origin, autoPay)
      const name = appDisplayName(pendingPrompt.origin)
      if (pendingPrompt.kind === 'action') {
        setLastApproved(pendingPrompt)
        setPaymentProgress('preparing', 'Starting…')
      }
      resolvePermission(pendingPrompt.id, 'allow')
      playWalletSound('connect')
      if (pendingPrompt.kind === 'connect') {
        toastSuccess('Connected', `${name} can use your wallet`)
      } else {
        toastSuccess('Approved', pendingPrompt.title || name)
      }
    },
    [pendingPrompt],
  )

  const onPermissionDeny = useCallback(() => {
    if (!pendingPrompt) return
    resolvePermission(pendingPrompt.id, 'deny')
    playWalletSound('deny')
  }, [pendingPrompt])
  useEffect(() => startDeviceMesh(profile.identityKey), [profile.identityKey])
  useEffect(() => {
    // Mobile uses this lifecycle to keep the unlocked wallet's foreground
    // service alive while Android backgrounds the WebView.
    document.dispatchEvent(new Event('handcash:wallet-unlocked'))
    return () => {
      document.dispatchEvent(new Event('handcash:wallet-locked'))
    }
  }, [])
  useEffect(() => {
    // First Identity tab visit used to block ~3s generating this QR on a phone.
    void identityQrDataUrl(profile.identityKey)
  }, [profile.identityKey])

  useEffect(() => {
    void refreshUsdPerBsv()
    const id = window.setInterval(() => {
      void refreshUsdPerBsv()
    }, 5 * 60_000)
    return () => window.clearInterval(id)
  }, [])

  const usdLabel = formatUsdFromSats(balanceSats, usdPerBsv)
  const bsvLabel = formatBsvSignificant(balanceSats, 5)

  useFitFontSize(balanceSlotRef, balanceBtnRef, {
    maxPx: 28,
    minPx: 8,
    watch: `${currency}|${usdLabel}|${bsvLabel}`,
  })

  const addMoney = () => {
    playWalletSound('soft')
    void window.handcash?.openExternal?.(ADD_MONEY_URL)
  }

  useEffect(() => {
    const onOnline = () => {
      void refreshFromChain({ forceReview: true, announceReceive: false }).then((sats) => {
        if (sats != null) onRefreshBalance(sats)
      })
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.address])

  useEffect(() => {
    let cancelled = false
    let lastHistoryPull = 0
    let tickInFlight = false
    let pollTimer: number | null = null
    let scheduledDelayMs = 0

    const scheduleNext = (delayMs?: number) => {
      if (cancelled) return
      if (pollTimer != null) window.clearTimeout(pollTimer)
      const delay = delayMs ?? nextChainPollMs(getSyncHealth().pendingTips)
      scheduledDelayMs = delay
      pollTimer = window.setTimeout(() => {
        void sync().finally(() => scheduleNext())
      }, delay)
    }

    const sync = async (opts?: { forceReview?: boolean }) => {
      // Skip overlapping poll ticks — prior soft-pull + chain sync must finish.
      if (tickInFlight) return
      tickInFlight = true
      try {
        // Parity devices merge strictly-newer cloud history before reading the chain,
        // so the balance stays current without an explicit Refresh.
        if (
          isDeviceParityEnabled() &&
          getSessionBackupPassword() &&
          Date.now() - lastHistoryPull >= HISTORY_PULL_INTERVAL_MS
        ) {
          lastHistoryPull = Date.now()
          await softPullHistoryIfRemoteNewer()
          if (cancelled) return
        }
        // Background polls never audit: reviewSpendableOutputs is report-only and
        // was colliding with nav taps right after unlock. Manual Refresh / online
        // recovery still force the audit.
        const sats = await refreshFromChain({
          audit: opts?.forceReview === true,
          forceReview: opts?.forceReview === true,
        })
        if (cancelled) return
        if (sats != null) onRefreshBalance(sats)
        void pollDeviceMeshOnce()
      } finally {
        tickInFlight = false
      }
    }

    // Phone shells defer the first poll so unlock taps are not fighting BEEF
    // internalization. Desktop starts immediately — yieldToUi already keeps the
    // UI live, and the old idle wait made desktop sync feel slower than mobile.
    let idleHandle: number | null = null
    let deferTimer: number | null = null
    const startFirst = () => {
      if (cancelled) return
      void sync().finally(() => scheduleNext())
    }
    if (isPhoneShell()) {
      if (typeof requestIdleCallback === 'function') {
        idleHandle = requestIdleCallback(startFirst, { timeout: 2500 }) as unknown as number
      } else {
        deferTimer = window.setTimeout(startFirst, 1200)
      }
    } else {
      deferTimer = window.setTimeout(startFirst, 0)
    }

    // If a tip becomes pending mid-wait, collapse a quiet interval immediately.
    const unsubHealth = subscribeSyncHealth((health) => {
      if (cancelled || tickInFlight || health.pendingTips <= 0) return
      if (pollTimer == null) return
      if (scheduledDelayMs <= CHAIN_POLL_PENDING_MS) return
      scheduleNext(CHAIN_POLL_PENDING_MS)
    })

    // Web timers can be suspended while Android backgrounds the WebView. The
    // native shell emits this on resume so we catch up immediately instead of
    // waiting for the old timeout to become runnable again.
    const onAppActive = () => {
      if (cancelled) return
      void sync({ forceReview: true }).finally(() => scheduleNext())
    }
    document.addEventListener('handcash:app-active', onAppActive)

    return () => {
      cancelled = true
      unsubHealth()
      document.removeEventListener('handcash:app-active', onAppActive)
      if (pollTimer != null) window.clearTimeout(pollTimer)
      if (idleHandle != null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleHandle)
      }
      if (deferTimer != null) window.clearTimeout(deferTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.address])

  return (
    <section className="dashboard" data-aeon-scope="dashboard" data-aeon-state="ready">
      <div className="dashboard-main">
        <div className="panel wallet-hero">
          <div className="connected-panel-head wallet-hero-head">
            <h2 className="wallet-hero-title">Your balance</h2>
          </div>
          <div className="wallet-hero-main">
            <div className="wallet-balance-slot" ref={balanceSlotRef}>
              <button
                ref={balanceBtnRef}
                type="button"
                className="wallet-balance"
                data-aeon-part="balance"
                data-aeon-state={currency}
                aria-label={
                  currency === 'usd'
                    ? 'Balance in USD. Click to show BSV first.'
                    : 'Balance in BSV. Click to show USD first.'
                }
                title="Click to swap currency"
                onClick={() => {
                  playWalletSound('soft')
                  toggleDisplayCurrency()
                }}
              >
                {currency === 'usd' ? (
                  <>
                    <span className="balance balance-primary balance-fiat">{usdLabel}</span>
                    <span className="balance-secondary balance-bsv">{bsvLabel}</span>
                  </>
                ) : (
                  <>
                    <span className="balance balance-primary balance-bsv">{bsvLabel}</span>
                    <span className="balance-secondary balance-fiat">{usdLabel}</span>
                  </>
                )}
              </button>
            </div>

            <div className="actions wallet-actions">
              <button
                className="btn btn-primary btn-icon"
                onClick={() => {
                  playWalletSound('soft')
                  openSendFlow()
                }}
              >
                <SendIcon size={16} />
                <span className="wallet-action-label">Send</span>
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  playWalletSound('soft')
                  openReceiveFlow()
                }}
              >
                <ReceiveIcon size={16} />
                <span className="wallet-action-label">Receive</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Add money — buy BSV with other crypto"
                title="Buy BSV with other crypto (opens handcash.io in your browser)"
                onClick={addMoney}
              >
                <AddMoneyIcon size={16} />
                <span className="wallet-action-label">Add money</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Scan QR code"
                title="Scan PeerPay, identity, or address QR"
                onClick={() => {
                  playWalletSound('soft')
                  openScanFlow()
                }}
              >
                <ScanQrIcon size={16} />
                <span className="wallet-action-label">Scan</span>
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  playWalletSound('soft')
                  onLock()
                }}
              >
                <LockIcon size={16} />
                <span className="wallet-action-label">Lock</span>
              </button>
            </div>
          </div>
        </div>

        <WalletNav
          profile={profile}
          apps={connectedApps}
          balanceSats={balanceSats}
          onSent={onSent}
          onFail={onFail}
          onRevoke={(origin) => {
            revokeOrigin(origin)
            setConnectedApps(listConnectedApps())
          }}
        />
      </div>

      <aside
        ref={sideRef}
        className="dashboard-side"
        data-aeon-scope="dashboard-side"
        data-aeon-state={sideBusy ? 'permission' : 'idle'}
      >
        {sideApproval && pendingPrompt ? (
          <section
            className="panel permission-side-panel"
            aria-label="Permission request"
          >
            <PermissionRequestPanel
              pending={pendingPrompt}
              onAllow={onPermissionAllow}
              onDeny={onPermissionDeny}
              actions="inline"
            />
          </section>
        ) : sideBusy ? (
          <section
            className="panel permission-side-panel permission-side-panel--processing"
            aria-label="Processing payment"
            aria-busy="true"
          >
            <p className="permission-eyebrow">Working</p>
            <h2 className="permission-request-title">
              {paymentProgress.label || 'Sending…'}
            </h2>
            <p className="lede permission-lede-compact">
              {paymentProgress.detail ||
                (lastApproved
                  ? `Finishing ${lastApproved.title} for ${appDisplayName(lastApproved.origin)}.`
                  : 'Broadcasting the approved payment.')}
            </p>
          </section>
        ) : (
          <>
            <WhatIsBsvPanel />
            <RecentActivityPanel chain={profile.chain} />
          </>
        )}
      </aside>
    </section>
  )
}
