import { useEffect, useRef, useState } from 'react'
import { formatBsvSignificant } from '../wallet/session'
import { syncLegacyFunds } from '../wallet/syncFunds'
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
import { SendIcon, ReceiveIcon, LockIcon, RefreshIcon } from './icons'
import { useFitFontSize } from './FitSlot'
import {
  listConnectedApps,
  revokeOrigin,
  subscribeConnectedApps,
  type ConnectedApp,
} from '../wallet/permissions'
import { openReceiveFlow, openSendFlow, openSetting } from '../wallet/navStore'
import { WhatIsBsvPanel } from './WhatIsBsvPanel'
import { WalletNav } from './WalletNav'
import { RecentActivityPanel } from './RecentActivity'
import {
  isBackupConfirmed,
  subscribeBackupConfirmed,
} from '../wallet/backupStatus'

type Props = {
  profile: WalletProfile
  balanceSats: number
  error: string | null
  onSent: (balanceSats: number) => void
  onRefreshBalance: (balanceSats: number) => void
  onLock: () => void
  onFail: (error: string) => void
}

export function Dashboard({
  profile,
  balanceSats,
  error,
  onSent,
  onRefreshBalance,
  onLock,
  onFail,
}: Props) {
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>(() => listConnectedApps())
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [refreshing, setRefreshing] = useState(false)
  const [backupConfirmed, setBackupConfirmed] = useState(() => isBackupConfirmed())
  const balanceSlotRef = useRef<HTMLDivElement>(null)
  const balanceBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => subscribeConnectedApps(setConnectedApps), [])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => subscribeBackupConfirmed(setBackupConfirmed), [])

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

  const refreshWallet = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refreshUsdPerBsv(true)
      const sats = await syncLegacyFunds()
      if (sats != null) onRefreshBalance(sats)
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const sync = async () => {
      const sats = await syncLegacyFunds()
      if (!cancelled && sats != null) onRefreshBalance(sats)
    }

    void sync()
    const id = window.setInterval(() => {
      void sync()
    }, 30_000)
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
            <h2>Your wallet</h2>
            {!backupConfirmed ? (
              <button
                type="button"
                className="wallet-backup-warn"
                data-aeon-scope="backup-reminder"
                data-aeon-state="needed"
                onClick={() => openSetting('backup-phrase')}
              >
                <span className="wallet-backup-warn-mark" aria-hidden>
                  !
                </span>
                Backup your wallet
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
                onClick={() => toggleDisplayCurrency()}
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
              <button className="btn btn-primary btn-icon" onClick={() => openSendFlow()}>
                <SendIcon size={16} />
                <span className="wallet-action-label">Send</span>
              </button>
              <button className="btn btn-ghost btn-icon" onClick={() => openReceiveFlow()}>
                <ReceiveIcon size={16} />
                <span className="wallet-action-label">Receive</span>
              </button>
              <button className="btn btn-ghost btn-icon" onClick={onLock}>
                <LockIcon size={16} />
                <span className="wallet-action-label">Lock</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon wallet-refresh"
                aria-label="Refresh balance"
                title="Refresh"
                disabled={refreshing}
                data-spinning={refreshing ? true : undefined}
                onClick={() => void refreshWallet()}
              >
                <RefreshIcon size={16} />
                <span className="wallet-action-label">Refresh</span>
              </button>
            </div>
          </div>

          {error && (
            <p className="error" role="status" style={{ marginTop: 10 }}>
              {error}
            </p>
          )}
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
