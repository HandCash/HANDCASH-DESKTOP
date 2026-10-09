/**
 * The holder record on the backup host (`accountHolding.ts` decides what it means).
 */
import {
  parseHolderRecord,
  signHolderRecord,
  type AccountKeys,
  type HolderCondition,
  type HolderRead,
  type HolderState,
  type HolderWrite,
} from './accountHolding'
import { resolveHistoryBackupBaseUrl } from './historyBackupPrefs'
import { signedIdentityFetch } from './identityRequestAuth'

const REQUEST_TIMEOUT_MS = 8_000

export function holderObjectUrl(identityKey: string): string | null {
  const base = resolveHistoryBackupBaseUrl()
  return base ? `${base}/v1/wallets/${encodeURIComponent(identityKey.trim())}/holder.json` : null
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function readHolderRecord(account: AccountKeys): Promise<HolderRead> {
  const url = holderObjectUrl(account.identityKey)
  if (!url) return { kind: 'unsupported' }
  let res: Response
  try {
    res = await signedIdentityFetch(account.rootKeyHex, 'history', url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: timeoutSignal(),
    })
  } catch (error) {
    return { kind: 'unreachable', reason: messageOf(error) }
  }
  if (res.status === 404) return { kind: 'absent' }
  if (res.status === 405) return { kind: 'unsupported' }
  if (!res.ok) return { kind: 'unreachable', reason: `holder read ${res.status}` }
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return { kind: 'unreachable', reason: 'holder record is not JSON' }
  }
  const record = parseHolderRecord(raw, account.identityKey)
  if (!record) return { kind: 'unreachable', reason: 'holder record failed verification' }
  return { kind: 'record', record, etag: res.headers.get('ETag') }
}

export async function writeHolderRecord(
  account: AccountKeys,
  fields: { deviceId: string; state: HolderState; seq: number },
  condition: HolderCondition,
): Promise<HolderWrite> {
  const url = holderObjectUrl(account.identityKey)
  if (!url) return { kind: 'unsupported' }
  const record = signHolderRecord(account.rootKeyHex, fields)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (condition.create) headers['If-None-Match'] = '*'
  else if (condition.etag) headers['If-Match'] = condition.etag
  let res: Response
  try {
    res = await signedIdentityFetch(account.rootKeyHex, 'history', url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(record),
      signal: timeoutSignal(),
    })
  } catch (error) {
    return { kind: 'unreachable', reason: messageOf(error) }
  }
  if (res.ok) return { kind: 'written', record }
  if (res.status === 412 || res.status === 409) return { kind: 'conflict' }
  if (res.status === 404 || res.status === 405) return { kind: 'unsupported' }
  return { kind: 'unreachable', reason: `holder write ${res.status}` }
}
