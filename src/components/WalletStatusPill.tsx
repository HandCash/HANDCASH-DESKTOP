import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { useEffect } from 'react'
import { getSyncHealth, subscribeSyncHealth } from '../wallet/walletHealth'
import {
  getCloudBackupHealth,
  refreshCloudBackupHealth,
  subscribeCloudBackupHealth,
} from '../wallet/cloudBackupHealth'
import {
  getWalletProgress,
  isWalletProgressBusy,
  subscribeWalletProgress,
  walletProgressDetail,
  walletProgressLabel,
} from '../wallet/walletProgress'
import {
  describeWalletCoordinator,
  subscribeWalletCoordinator,
} from '../wallet/walletCoordinator'
import {
  isUnlockedSession,
  refreshBlocked,
  walletStatusFor,
  walletStatusMachine,
  type WalletSession,
  type WalletStatusContext,
  type WalletStatusState,
} from '../machines/walletStatusMachine'

export type { WalletSession }

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

function statusView(state: WalletStatusState, c: WalletStatusContext): StatusView {
  const { health, cloud, coordinator } = c
  switch (state) {
    case 'opening':
      return { label: 'Opening', tone: 'busy', detail: 'Starting HandCash' }
    case 'failed':
      return { label: 'Failed', tone: 'error', detail: 'App hit an error — retry' }
    case 'offline':
      return {
        label: 'No network',
        tone: 'error',
        detail: 'Device is offline — sends and sync need a connection',
      }
    case 'refreshing':
      return {
        label: 'Syncing',
        tone: 'busy',
        detail: 'Refreshing funds and history against the network',
      }
    case 'catchingUp':
      if (isWalletProgressBusy(c.progress)) {
        return {
          label: walletProgressLabel(c.progress),
          tone: 'busy',
          detail: walletProgressDetail(c.progress) ?? 'Still catching up with the network',
        }
      }
      if (coordinator.chainIngest === 'active') {
        return { label: 'Catching up', tone: 'busy', detail: coordinator.summary }
      }
      return { label: 'Catching up', tone: 'busy', detail: health.message }
    case 'syncFailed':
      // "Chain failed" read as though the blockchain itself had broken. This is
      // only the read path: local funds and keys are untouched.
      return {
        label: 'Sync failed',
        tone: 'error',
        detail: `${
          health.message ?? 'Couldn’t reach the network to refresh funds.'
        } Balance may be out of date — your coins and keys are safe. Retrying.`,
      }
    case 'backupFailed':
      return {
        label: 'Backup failed',
        tone: 'error',
        detail: `${
          cloud.message ?? 'History backup host (BRC-39) is not responding.'
        } This device is fine — only the off-device history copy is behind.`,
      }
    case 'backupDelayed':
      return {
        label: cloud.label,
        tone: 'warn',
        detail: `${cloud.message ?? 'Backup host is busy.'} This device is fine — the off-device copy catches up automatically.`,
      }
    case 'waitingToSend':
      return { label: 'Waiting to send', tone: 'busy', detail: coordinator.summary }
    case 'syncing':
      return {
        label: 'Syncing',
        tone: 'busy',
        detail: `${health.message ?? 'Refreshing funds against the network'} · ${
          coordinator.summary
        }`,
      }
    case 'locked':
      return { label: 'Locked', tone: 'muted', detail: 'Unlock to spend or connect apps' }
    case 'setup':
      return { label: 'Setup', tone: 'muted', detail: 'Create or restore a wallet' }
    case 'bridgeOff':
      return {
        label: 'Bridge off',
        tone: 'warn',
        detail: 'Local BRC-100 bridge is not listening — apps cannot connect',
      }
    case 'itemArriving':
      return {
        label: health.pendingTips === 1 ? 'Item arriving' : `${health.pendingTips} arriving`,
        tone: 'busy',
        detail:
          health.pendingTips === 1
            ? 'Collectable received — identifying it with the indexer'
            : `${health.pendingTips} collectables received — identifying them with the indexer`,
      }
    case 'networkSlow':
      return { label: 'Network slow', tone: 'warn', detail: health.message }
    case 'synced':
      // Chain ingest wins. The history replica (BRC-39) is an optional backup —
      // never alarm when funds and items are healthy here. See wallet/layers.ts.
      if (health.phase !== 'ok') {
        return {
          label: 'Synced',
          tone: 'ok',
          detail: cloud.message ?? 'History replica looks healthy',
        }
      }
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
    case 'ready':
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
}

function resolveStatus(c: WalletStatusContext): StatusView {
  return statusView(walletStatusFor(c), c)
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

/** Titlebar status — one pill, one typeface. Tap when unlocked to refresh. */
export function WalletStatusPill({ session, bridgeOnline, onManualSync }: Props) {
  const [snapshot, send] = useMachine(walletStatusMachine, {
    input: {
      session,
      bridgeOnline,
      health: getSyncHealth(),
      cloud: getCloudBackupHealth(),
      networkOnline: typeof navigator === 'undefined' || navigator.onLine,
      progress: getWalletProgress(),
      coordinator: describeWalletCoordinator(),
    },
  })

  useEffect(() => send({ type: 'SESSION', session }), [send, session])
  useEffect(() => send({ type: 'BRIDGE', online: bridgeOnline }), [send, bridgeOnline])
  useEffect(() => subscribeSyncHealth((health) => send({ type: 'SYNC_HEALTH', health })), [send])
  useEffect(
    () => subscribeCloudBackupHealth((cloud) => send({ type: 'BACKUP_HEALTH', cloud })),
    [send],
  )
  useEffect(
    () => subscribeWalletProgress((progress) => send({ type: 'WALLET_PROGRESS', progress })),
    [send],
  )
  useEffect(
    () =>
      subscribeWalletCoordinator((coordinator) => send({ type: 'COORDINATOR', coordinator })),
    [send],
  )

  useEffect(() => {
    const sync = () => send({ type: 'NETWORK', online: navigator.onLine })
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [send])

  useEffect(() => {
    if (!isUnlockedSession(session)) return
    void refreshCloudBackupHealth()
    const id = window.setInterval(() => void refreshCloudBackupHealth(), 60_000)
    return () => window.clearInterval(id)
  }, [session])

  const context = snapshot.context
  const display = statusView(snapshot.value as WalletStatusState, context)
  const stateAttr = stateToAttr(snapshot.value)

  // Always the same control when a refresh handler exists — never swap to a
  // <div> mid-session (that flipped fonts and dropped the click target).
  const tapEnabled =
    Boolean(onManualSync) && isUnlockedSession(context.session) && context.networkOnline
  const tapBusy = refreshBlocked(context)

  const handleManualSync = () => {
    if (!tapEnabled || !onManualSync || !snapshot.can({ type: 'REFRESH' })) return
    send({ type: 'REFRESH' })
    void Promise.resolve(onManualSync()).finally(() => send({ type: 'REFRESH_DONE' }))
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
        data-aeon-state={stateAttr}
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
      data-aeon-state={stateAttr}
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
