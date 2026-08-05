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
  WarningIcon,
  ScanQrIcon,
} from './icons'
import { useFitFontSize } from './FitSlot'
import {
  listConnectedApps,
  revokeOrigin,
  subscribeConnectedApps,
  type ConnectedApp,
} from '../wallet/permissions'
import { openReceiveFlow, openScanFlow, openSendFlow, openSetting } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { WhatIsBsvPanel } from './WhatIsBsvPanel'
import { WalletNav } from './WalletNav'
import { RecentActivityPanel } from './RecentActivity'
import {
  getMissingBackupStep,
  isBackupConfirmed,
  subscribeBackupConfirmed,
} from '../wallet/backupStatus'
import { pollDeviceMeshOnce, startDeviceMesh } from '../wallet/deviceMesh'
import { isDeviceParityEnabled } from '../wallet/paymentPolicy'
import { softPullHistoryIfRemoteNewer } from '../wallet/deviceSync'
import { getSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { ADD_MONEY_URL } from '../wallet/walletConfig'

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
  const [backupConfirmed, setBackupConfirmed] = useState(() => isBackupConfirmed())
  const [missingBackup, setMissingBackup] = useState(() => getMissingBackupStep())
  const balanceSlotRef = useRef<HTMLDivElement>(null)
  const balanceBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => subscribeConnectedApps(setConnectedApps), [])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => startDeviceMesh(profile.identityKey), [profile.identityKey])
  useEffect(
    () =>
      subscribeBackupConfirmed(() => {
        setBackupConfirmed(isBackupConfirmed())
        setMissingBackup(getMissingBackupStep())
      }),
    [],
  )

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

    const sync = async () => {
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
      const sats = await refreshFromChain()
      if (cancelled) return
      if (sats != null) onRefreshBalance(sats)
      void pollDeviceMeshOnce()
    }

    void sync()
    const intervalMs = isDeviceParityEnabled() ? 12_000 : 30_000
    const id = window.setInterval(() => {
      void sync()
    }, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.address])

  return (
    <section className="dashboard" data-aeon-scope="dashboard" data-aeon-state="ready">
      <div className="dashboard-main">
        <div className="panel wallet-hero">
          <div className="connected-panel-head wallet-hero-head">
            <h2 className="wallet-hero-title">Your balance</h2>
            {!backupConfirmed ? (
              <button
                type="button"
                className="wallet-backup-warn"
                data-aeon-scope="backup-reminder"
                data-aeon-state={missingBackup ?? 'needed'}
                onClick={() => {
                  playWalletSound('soft')
                  openSetting(missingBackup === 'history' ? 'history-backup' : 'backup')
                }}
              >
                <span className="wallet-backup-warn-mark" aria-hidden>
                  <WarningIcon size={14} />
                </span>
                {missingBackup === 'history' ? 'Backup history' : 'Backup key slices'}
              </button>
            ) : null}
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
