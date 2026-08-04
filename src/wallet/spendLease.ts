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
import { getActiveWallet } from './session'

const LEASE_TTL_MS = 45_000

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

async function readLease(url: string): Promise<SpendLease | null> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json, */*' },
    cache: 'no-store',
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
}

async function writeLease(url: string, lease: SpendLease | null): Promise<void> {
  const body = lease
    ? JSON.stringify(lease)
    : JSON.stringify({ v: 1, deviceId: '', until: 0, released: true })
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, */*',
    },
    body,
  })
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

/**
 * Acquire cross-device spend lease when parity backup URL is set.
 * No-op without a backup URL. If the host can’t store leases, degrades to
 * local-only serialization (still safer than nothing).
 * Returns a release fn (always call in finally).
 */
export async function acquireSpendLease(): Promise<() => Promise<void>> {
  const noop = async () => undefined
  if (!hasDeviceLinkBackupUrl()) return noop

  const active = getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  try {
    assertDeviceLinkBackupUrl()
    const deviceId = getOrCreateDeviceId()
    const url = spendLeaseObjectUrl(active.identityKey)
    const existing = await readLease(url)
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
    await writeLease(url, lease)

    const confirmed = await readLease(url)
    if (isActiveForeign(confirmed, deviceId, active.identityKey)) {
      throw new Error(
        `${confirmed!.label} took the spend lock. Wait a moment, then try again.`,
      )
    }
    if (!confirmed || confirmed.deviceId !== deviceId) {
      console.warn('[spend-lease] could not confirm lease; continuing local-only')
      return noop
    }

    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        const cur = await readLease(url)
        if (cur?.deviceId === deviceId) {
          await writeLease(url, null)
        }
      } catch (err) {
        console.warn('[spend-lease] release failed', err)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/is sending right now|took the spend lock/i.test(msg)) throw err
    console.warn('[spend-lease] coordinator unavailable; local-only lock', err)
    return noop
  }
}
