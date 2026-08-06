import { useEffect, useRef, useState } from 'react'
import { formatBsvSignificant } from '../wallet/session'
import { refreshFromChain } from '../wallet/chainIngest'
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
import { clearAppActivity } from '../wallet/appActivity'
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
  revokeOrigin,
  subscribeConnectedApps,
  type ConnectedApp,
} from '../wallet/permissions'
import { openReceiveFlow, openScanFlow, openSendFlow } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { WhatIsBsvPanel } from './WhatIsBsvPanel'
import { WalletNav } from './WalletNav'
import { RecentActivityPanel } from './RecentActivity'
import { pollDeviceMeshOnce, startDeviceMesh } from '../wallet/deviceMesh'
import { isDeviceParityEnabled } from '../wallet/paymentPolicy'
import { softPullHistoryIfRemoteNewer } from '../wallet/deviceSync'
import { getSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { ADD_MONEY_URL } from '../wallet/walletConfig'
import { identityQrDataUrl } from '../wallet/identityQr'

/** Cloud history is merged far less often than the chain poll — it is a network round trip. */
const HISTORY_PULL_INTERVAL_MS = 60_000

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
  const balanceSlotRef = useRef<HTMLDivElement>(null)
  const balanceBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => subscribeConnectedApps(setConnectedApps), [])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => startDeviceMesh(profile.identityKey), [profile.identityKey])
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

    // Defer the first poll so unlock + first nav taps are not fighting BEEF
    // internalization on the main thread (latest freeze log: latch import mid-tap).
    let idleHandle: number | null = null
    let deferTimer: number | null = null
    const startFirst = () => {
      if (cancelled) return
      void sync()
    }
    if (typeof requestIdleCallback === 'function') {
      idleHandle = requestIdleCallback(startFirst, { timeout: 2500 }) as unknown as number
    } else {
      deferTimer = window.setTimeout(startFirst, 1200)
    }

    const intervalMs = isDeviceParityEnabled() ? 12_000 : 30_000
    const id = window.setInterval(() => {
      void sync()
    }, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
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
            clearAppActivity(origin)
            setConnectedApps(listConnectedApps())
          }}
        />
      </div>

      <aside className="dashboard-side">
        <WhatIsBsvPanel />
        <RecentActivityPanel chain={profile.chain} />
      </aside>
    </section>
  )
}
