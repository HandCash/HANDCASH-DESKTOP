import { useEffect, useState } from 'react'
import {
  getSyncHealth,
  subscribeSyncHealth,
  type SyncHealth,
} from '../wallet/walletHealth'

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
  if (health.phase === 'syncing') {
    return {
      label: 'Syncing',
      tone: 'busy',
      detail: health.message ?? 'Refreshing funds against the network',
    }
  }
  if (health.phase === 'error') {
    return {
      label: 'Sync failed',
      tone: 'error',
      detail: health.message ?? 'Refresh to retry chain sync',
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
  // Unlocked wallet — prefer chain truth over vague “online”.
  if (!bridgeOnline) {
    return {
      label: 'Bridge off',
      tone: 'warn',
      detail: 'Local BRC-100 bridge is not listening — apps cannot connect',
    }
  }
  if (health.phase === 'ok') {
    return {
      label: 'Synced',
      tone: 'ok',
      detail: health.message ?? 'Balance matches the network',
    }
  }
  return {
    label: 'Ready',
    tone: 'ok',
    detail: 'Wallet unlocked — tap Refresh to sync the chain',
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

/** Titlebar status — precise wallet/network state, not a vague Online/Offline. */
export function WalletStatusPill({ session, bridgeOnline }: Props) {
  const [health, setHealth] = useState<SyncHealth>(() => getSyncHealth())
  const [networkOnline, setNetworkOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  )

  useEffect(() => subscribeSyncHealth(setHealth), [])

  useEffect(() => {
    const sync = () => setNetworkOnline(navigator.onLine)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  const view = resolveStatus(session, health, networkOnline, bridgeOnline)

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
