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
}

type Tone = 'ok' | 'busy' | 'warn' | 'error' | 'muted'

type StatusView = {
  label: string
  tone: Tone
  detail: string | null
}

function resolveStatus(
  session: WalletSession,
  health: SyncHealth,
  cloud: CloudBackupHealth,
  networkOnline: boolean,
  bridgeOnline: boolean,
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
  if (health.phase === 'error') {
    return {
      label: 'Chain failed',
      tone: 'error',
      detail: health.message ?? 'Chain ingest failed — retrying (not history backup)',
    }
  }
  if (cloud.phase === 'error') {
    return {
      label: 'History failed',
      tone: 'error',
      detail: cloud.message ?? 'BRC-39 history backup host error',
    }
  }
  if (session === 'sending') {
    return { label: 'Sending', tone: 'busy', detail: 'Broadcasting payment' }
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

  // Chain ingest wins. History replica (BRC-39) is optional parity — never alarm as
  // "Out of sync" when funds/items are healthy on this device. See wallet/layers.ts.
  if (health.phase === 'ok') {
    if (cloud.phase === 'ok') {
      return {
        label: 'Synced',
        tone: 'ok',
        detail: cloud.message ?? health.message ?? 'Chain ingest and history replica look healthy',
      }
    }
    return {
      label: 'Synced',
      tone: 'ok',
      detail:
        health.message ??
        (cloud.phase === 'pending'
          ? 'Chain OK — history replica (BRC-39) still uploading'
          : cloud.phase === 'off'
            ? 'Chain OK — history replica not configured'
            : 'Chain OK'),
    }
  }

  if (cloud.phase === 'off') {
    return {
      label: 'Ready',
      tone: 'ok',
      detail: 'Wallet unlocked — chain ingest only, no history replica',
    }
  }
  if (cloud.phase === 'ok') {
    return {
      label: 'History synced',
      tone: 'ok',
      detail: cloud.message,
    }
  }
  if (cloud.phase === 'pending') {
    return {
      label: 'Ready',
      tone: 'ok',
      detail:
        cloud.message ??
        'Wallet unlocked — history replica pending (does not affect local balance)',
    }
  }
  return {
    label: 'Ready',
    tone: 'ok',
    detail: 'Wallet unlocked — chain ingest only, no history replica',
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

/** Titlebar status — precise wallet/network/cloud state. */
export function WalletStatusPill({ session, bridgeOnline }: Props) {
  const [health, setHealth] = useState<SyncHealth>(() => getSyncHealth())
  const [cloud, setCloud] = useState<CloudBackupHealth>(() => getCloudBackupHealth())
  const [networkOnline, setNetworkOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  )

  useEffect(() => subscribeSyncHealth(setHealth), [])
  useEffect(() => subscribeCloudBackupHealth(setCloud), [])

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
    if (session !== 'ready' && session !== 'sending') return
    void refreshCloudBackupHealth()
    const id = window.setInterval(() => void refreshCloudBackupHealth(), 60_000)
    return () => window.clearInterval(id)
  }, [session])

  const view = resolveStatus(session, health, cloud, networkOnline, bridgeOnline)

  return (
    <div
      className="status-pill"
      data-aeon-no-drag
      data-tone={view.tone}
      title={view.detail ?? undefined}
      aria-live="polite"
    >
      <span className="status-dot" data-tone={view.tone} />
      {view.label}
    </div>
  )
}

export { sessionFromMachine }
