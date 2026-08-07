import { useEffect, useState } from 'react'
import {
  getSyncHealth,
  subscribeSyncHealth,
  type SyncHealth,
} from '../wallet/walletHealth'
import {
  getCloudBackupHealth,
  refreshCloudBackupHealth,
  subscribeCloudBackupHealth,
  type CloudBackupHealth,
} from '../wallet/cloudBackupHealth'
import {
  getPaymentProgress,
  subscribePaymentProgress,
  type PaymentProgress,
} from '../wallet/paymentProgress'

export type WalletSession =
  | 'boot'
  | 'onboarding'
  | 'locked'
  | 'ready'
  | 'sending'
  | 'failure'

type Props = {
  session: WalletSession
  /** Local BRC-100 HTTP bridge is listening. */
  bridgeOnline: boolean
  /** Tap the status pill — chain refresh (+ optional history pull from App). */
  onManualSync?: () => void | Promise<void>
}

type Tone = 'ok' | 'busy' | 'warn' | 'error' | 'muted'

export type StatusView = {
  label: string
  tone: Tone
  detail: string | null
}

/** Strip trailing ellipsis so uppercase pill labels stay uniform. */
function pillLabel(raw: string): string {
  return raw.replace(/[…\.]+$/u, '').trim()
}

function resolveStatus(
  session: WalletSession,
  health: SyncHealth,
  cloud: CloudBackupHealth,
  networkOnline: boolean,
  bridgeOnline: boolean,
  payment: PaymentProgress,
): StatusView {
  if (session === 'boot') {
    return { label: 'Opening', tone: 'busy', detail: 'Starting HandCash' }
  }
  if (session === 'failure') {
    return { label: 'Failed', tone: 'error', detail: 'App hit an error — retry' }
  }
  if (!networkOnline) {
    return {
      label: 'No network',
      tone: 'error',
      detail: 'Device is offline — sends and sync need a connection',
    }
  }
  // Soft in-flight sync / backup probes stay quiet — only terminal outcomes matter.
  // "Chain failed" read as though the blockchain itself had broken. This is only
  // the read path: local funds and keys are untouched, the balance is just stale.
  if (health.phase === 'error') {
    return {
      label: 'Sync failed',
      tone: 'error',
      detail: `${
        health.message ?? 'Couldn’t reach the network to refresh funds.'
      } Balance may be out of date — your coins and keys are safe. Retrying.`,
    }
  }
  if (cloud.phase === 'error') {
    return {
      label: 'Backup failed',
      tone: 'error',
      detail: `${
        cloud.message ?? 'History backup host (BRC-39) is not responding.'
      } This device is fine — only the off-device history copy is behind.`,
    }
  }
  // Live payment phases outrank the generic "Sending" session bit.
  if (payment.phase !== 'idle' && payment.label) {
    return {
      label: pillLabel(payment.label),
      tone: 'busy',
      detail: payment.detail,
    }
  }
  if (session === 'sending') {
    return { label: 'Sending', tone: 'busy', detail: 'Broadcasting payment' }
  }
  if (health.phase === 'syncing') {
    return {
      label: 'Syncing',
      tone: 'busy',
      detail: health.message ?? 'Refreshing funds against the network',
    }
  }
  if (session === 'locked') {
    return { label: 'Locked', tone: 'muted', detail: 'Unlock to spend or connect apps' }
  }
  if (session === 'onboarding') {
    return { label: 'Setup', tone: 'muted', detail: 'Create or restore a wallet' }
  }
  if (!bridgeOnline) {
    return {
      label: 'Bridge off',
      tone: 'warn',
      detail: 'Local BRC-100 bridge is not listening — apps cannot connect',
    }
  }

  // A latch-proven tip we cannot name yet is an item that has definitely landed.
  // Reporting "Synced" while it is missing from Collectables is exactly how a
  // transfer looks lost to the person who sent it.
  if (health.pendingTips > 0) {
    return {
      label: health.pendingTips === 1 ? 'Item arriving' : `${health.pendingTips} arriving`,
      tone: 'busy',
      detail:
        health.pendingTips === 1
          ? 'Collectable received — identifying it with the indexer'
          : `${health.pendingTips} collectables received — identifying them with the indexer`,
    }
  }

  // Chain ingest wins. History replica (BRC-39) is optional parity — never alarm as
  // "Out of sync" when funds/items are healthy on this device. See wallet/layers.ts.
  if (health.phase === 'ok') {
    return {
      label: 'Synced',
      tone: 'ok',
      detail:
        cloud.phase === 'ok'
          ? (cloud.message ?? health.message ?? 'Chain ingest and history replica look healthy')
          : health.message ??
            (cloud.phase === 'pending'
              ? 'Chain OK — history replica (BRC-39) still uploading'
              : cloud.phase === 'off'
                ? 'Chain OK — history replica not configured'
                : 'Chain OK'),
    }
  }

  if (cloud.phase === 'ok') {
    return {
      label: 'Synced',
      tone: 'ok',
      detail: cloud.message ?? 'History replica looks healthy',
    }
  }
  return {
    label: 'Ready',
    tone: 'ok',
    detail:
      cloud.phase === 'pending'
        ? (cloud.message ??
          'Wallet unlocked — history replica pending (does not affect local balance)')
        : 'Wallet unlocked — chain ingest only, no history replica',
  }
}

function sessionFromMachine(value: unknown): WalletSession {
  if (typeof value === 'string') {
    if (
      value === 'boot' ||
      value === 'onboarding' ||
      value === 'locked' ||
      value === 'ready' ||
      value === 'sending' ||
      value === 'failure'
    ) {
      return value
    }
  }
  return 'boot'
}

function isUnlocked(session: WalletSession): boolean {
  return session === 'ready' || session === 'sending'
}

/** Titlebar status — one pill, one typeface. Tap when unlocked to refresh. */
export function WalletStatusPill({ session, bridgeOnline, onManualSync }: Props) {
  const [health, setHealth] = useState<SyncHealth>(() => getSyncHealth())
  const [cloud, setCloud] = useState<CloudBackupHealth>(() => getCloudBackupHealth())
  const [payment, setPayment] = useState<PaymentProgress>(() => getPaymentProgress())
  const [networkOnline, setNetworkOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  )
  const [manualBusy, setManualBusy] = useState(false)

  useEffect(() => subscribeSyncHealth(setHealth), [])
  useEffect(() => subscribeCloudBackupHealth(setCloud), [])
  useEffect(() => subscribePaymentProgress(setPayment), [])

  useEffect(() => {
    const sync = () => setNetworkOnline(navigator.onLine)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  useEffect(() => {
    if (!isUnlocked(session)) return
    void refreshCloudBackupHealth()
    const id = window.setInterval(() => void refreshCloudBackupHealth(), 60_000)
    return () => window.clearInterval(id)
  }, [session])

  const view = resolveStatus(
    session,
    health,
    cloud,
    networkOnline,
    bridgeOnline,
    payment,
  )
  const display =
    manualBusy && health.phase !== 'syncing' && payment.phase === 'idle'
      ? {
          label: 'Syncing',
          tone: 'busy' as const,
          detail: 'Refreshing funds and history against the network',
        }
      : view

  // Always the same control when a refresh handler exists — never swap to a
  // <div> mid-session (that flipped fonts and dropped the click target).
  const tapEnabled = Boolean(onManualSync) && isUnlocked(session) && networkOnline
  const tapBusy =
    manualBusy || health.phase === 'syncing' || payment.phase !== 'idle'

  const handleManualSync = () => {
    if (!tapEnabled || tapBusy || !onManualSync) return
    setManualBusy(true)
    void Promise.resolve(onManualSync()).finally(() => setManualBusy(false))
  }

  const label = pillLabel(display.label)
  const title =
    tapEnabled && !tapBusy
      ? `${display.detail ?? label} — tap to refresh`
      : (display.detail ?? undefined)

  if (tapEnabled) {
    return (
      <button
        type="button"
        className="status-pill status-pill-btn"
        data-aeon-no-drag
        data-tone={display.tone}
        title={title}
        aria-live="polite"
        aria-label={
          tapBusy ? label : `${label} — tap to refresh wallet`
        }
        disabled={tapBusy}
        onClick={handleManualSync}
      >
        <span className="status-dot" data-tone={display.tone} aria-hidden />
        <span className="status-pill-label">{label}</span>
      </button>
    )
  }

  return (
    <div
      className="status-pill"
      data-aeon-no-drag
      data-tone={display.tone}
      title={title}
      aria-live="polite"
    >
      <span className="status-dot" data-tone={display.tone} aria-hidden />
      <span className="status-pill-label">{label}</span>
    </div>
  )
}

export { sessionFromMachine, resolveStatus, pillLabel }
