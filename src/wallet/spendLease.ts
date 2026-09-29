import { getActiveWallet } from './session'

/**
 * Cross-device advisory spend lease on the shared BRC-39 backup host.
 * Mirrors cloud UTXO reservation at device scope: one install spends at a time.
 */
import { getOrCreateDeviceId, listDeviceWallets } from './deviceWallets'
import {
  assertDeviceLinkBackupUrl,
  hasDeviceLinkBackupUrl,
} from './deviceSync'
import { getHistoryBackupPrefs, resolveHistoryBackupBaseUrl } from './historyBackupPrefs'


const LEASE_TTL_MS = 45_000
/** Backup host fetch cannot sit in front of createAction with no deadline. */
const LEASE_FETCH_MS = 8_000
/** Lease cleanup must never keep the local spend coordinator active. */
const LEASE_RELEASE_MS = 2_000
/**
 * A lease this device still holds with this much TTL left is reused as-is.
 * Every acquire is three sequential backup-host round trips; an app paying in
 * a burst (one bet, one tip per click) paid them on every payment.
 */
const LEASE_REUSE_MIN_REMAINING_MS = 15_000
/** How long a finished spend keeps the lease for the next one before dropping it. */
const LEASE_LINGER_MS = 3_000
const SLOW_ACQUIRE_MS = 250

type HeldLease = { url: string; deviceId: string }

let held: (HeldLease & { until: number }) | null = null
let lingerTimer: ReturnType<typeof setTimeout> | null = null
let dropping: Promise<void> | null = null

function mergeAbortSignals(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onOuter = () => ctrl.abort()
  outer?.addEventListener('abort', onOuter)
  if (outer?.aborted) ctrl.abort()
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
    },
  }
}

export type SpendLease = {
  v: 1
  identityKey: string
  deviceId: string
  label: string
  until: number
}

export function spendLeaseObjectUrl(
  identityKey: string,
  prefs = getHistoryBackupPrefs(),
): string {
  const base = resolveHistoryBackupBaseUrl(prefs)
  if (!base) throw new Error('Set a backup URL first')
  const id = encodeURIComponent(identityKey.trim())
  return `${base}/v1/wallets/${id}/spend-lease.json`
}

function localLabel(): string {
  return listDeviceWallets().find((w) => w.isLocal)?.label ?? 'This device'
}

async function readLease(
  url: string,
  signal?: AbortSignal,
): Promise<SpendLease | null> {
  const wait = mergeAbortSignals(signal, LEASE_FETCH_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json, */*' },
      cache: 'no-store',
      signal: wait.signal,
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 120)
      throw new Error(`Spend lease read failed (${res.status})${detail ? `: ${detail}` : ''}`)
    }
    const data = (await res.json()) as Partial<SpendLease>
    if (data?.v !== 1 || typeof data.deviceId !== 'string' || typeof data.until !== 'number') {
      return null
    }
    return {
      v: 1,
      identityKey: typeof data.identityKey === 'string' ? data.identityKey : '',
      deviceId: data.deviceId,
      label: typeof data.label === 'string' ? data.label : 'Other device',
      until: data.until,
    }
  } finally {
    wait.cancel()
  }
}

async function writeLease(
  url: string,
  lease: SpendLease | null,
  signal?: AbortSignal,
): Promise<void> {
  const body = lease
    ? JSON.stringify(lease)
    : JSON.stringify({ v: 1, deviceId: '', until: 0, released: true })
  const wait = mergeAbortSignals(signal, LEASE_FETCH_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, */*',
      },
      body,
      signal: wait.signal,
    })
  } finally {
    wait.cancel()
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 120)
    throw new Error(`Spend lease write failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
}

function isActiveForeign(lease: SpendLease | null, localId: string, identityKey: string): boolean {
  if (!lease || !lease.deviceId || lease.until <= Date.now()) return false
  if (lease.identityKey && lease.identityKey !== identityKey) return false
  return lease.deviceId !== localId
}

function cancelLinger(): void {
  if (lingerTimer == null) return
  clearTimeout(lingerTimer)
  lingerTimer = null
}

async function clearRemoteLease(lease: HeldLease): Promise<void> {
  const cleanup = mergeAbortSignals(undefined, LEASE_RELEASE_MS)
  try {
    const cur = await readLease(lease.url, cleanup.signal)
    if (cur?.deviceId === lease.deviceId) {
      await writeLease(lease.url, null, cleanup.signal)
    }
  } catch (err) {
    console.warn('[spend-lease] release failed', err)
  } finally {
    cleanup.cancel()
  }
}

/**
 * Drop the lease this device holds now instead of after the linger.
 * The next acquire awaits the drop, so it can never clear a fresher lease.
 */
export function releaseHeldSpendLease(): Promise<void> {
  cancelLinger()
  const lease = held
  held = null
  if (!lease) return dropping ?? Promise.resolve()
  const tracked: Promise<void> = clearRemoteLease(lease).finally(() => {
    if (dropping === tracked) dropping = null
  })
  dropping = tracked
  return tracked
}

/** Release fn for one spend: it never waits on the backup host. */
function lingeringRelease(): () => Promise<void> {
  let released = false
  return async () => {
    if (released) return
    released = true
    cancelLinger()
    lingerTimer = setTimeout(() => {
      lingerTimer = null
      void releaseHeldSpendLease()
    }, LEASE_LINGER_MS)
  }
}

/**
 * Acquire cross-device spend lease when parity backup URL is set.
 * No-op without a backup URL. If the host can’t store leases, degrades to
 * local-only serialization (still safer than nothing).
 * Returns a release fn (always call in finally). Releasing never waits on the
 * host: the lease lingers briefly for the next spend, then drops in the
 * background.
 */
export async function acquireSpendLease(
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const noop = async () => undefined
  if (!hasDeviceLinkBackupUrl()) return noop

  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const started = Date.now()
  try {
    if (signal?.aborted) throw new Error('Aborted')
    assertDeviceLinkBackupUrl()
    const deviceId = getOrCreateDeviceId()
    const url = spendLeaseObjectUrl(active.identityKey)
    if (
      held?.url === url &&
      held.deviceId === deviceId &&
      held.until - Date.now() > LEASE_REUSE_MIN_REMAINING_MS
    ) {
      cancelLinger()
      return lingeringRelease()
    }
    if (held?.url === url) {
      // Near expiry: the rewrite below replaces it — dropping it first would
      // only add round trips.
      cancelLinger()
      held = null
    } else if (held) {
      void releaseHeldSpendLease()
    }
    if (dropping) await dropping
    const existing = await readLease(url, signal)
    if (isActiveForeign(existing, deviceId, active.identityKey)) {
      const secs = Math.max(1, Math.ceil((existing!.until - Date.now()) / 1000))
      throw new Error(
        `${existing!.label} is sending right now. Wait ~${secs}s, then try again.`,
      )
    }

    const lease: SpendLease = {
      v: 1,
      identityKey: active.identityKey,
      deviceId,
      label: localLabel(),
      until: Date.now() + LEASE_TTL_MS,
    }
    await writeLease(url, lease, signal)

    const confirmed = await readLease(url, signal)
    if (isActiveForeign(confirmed, deviceId, active.identityKey)) {
      throw new Error(
        `${confirmed!.label} took the spend lock. Wait a moment, then try again.`,
      )
    }
    if (!confirmed || confirmed.deviceId !== deviceId) {
      console.warn('[spend-lease] could not confirm lease; continuing local-only')
      return noop
    }

    held = { url, deviceId, until: lease.until }
    const ms = Date.now() - started
    if (ms >= SLOW_ACQUIRE_MS) console.info(`[spend] lease done ${ms}ms`)
    return lingeringRelease()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (signal?.aborted || /abort/i.test(msg)) throw err
    if (/is sending right now|took the spend lock/i.test(msg)) throw err
    console.warn('[spend-lease] coordinator unavailable; local-only lock', err)
    return noop
  }
}
