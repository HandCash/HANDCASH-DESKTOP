/**
 * The new device's side of scan-to-login, served by its local peer server
 * (`/handcash-device/v1/scan-login/*`). It needs no wallet: it holds only the
 * one-time key and secret from its own QR.
 */
import type { PrivateKey } from '@bsv/sdk'
import { freshLoginKey, openVaultTransfer, randomHex, type VaultTransfer } from '../deviceTransfer'
import {
  SCAN_LOGIN_KIND,
  SCAN_LOGIN_TTL_MS,
  proofMatches,
  scanLoginCode,
  scanLoginProof,
  sha256Hex,
  type ScanLoginPayload,
} from './payload'

export type ScanLoginEvent =
  | { type: 'connected'; approverLabel: string; code: string }
  | { type: 'vault'; transfer: VaultTransfer }
  | { type: 'refused' }

type Session = {
  payload: ScanLoginPayload
  key: PrivateKey
  approverKey: string | null
  done: boolean
}

let session: Session | null = null
const listeners = new Set<(event: ScanLoginEvent) => void>()

function emit(event: ScanLoginEvent): void {
  for (const listener of listeners) listener(event)
}

export function startScanLoginSession(args: { urls: string[]; label: string; now?: number }): ScanLoginPayload {
  const key = freshLoginKey()
  const payload: ScanLoginPayload = {
    kind: SCAN_LOGIN_KIND,
    v: 1,
    urls: args.urls.map((url) => url.replace(/\/+$/, '')),
    loginKey: key.toPublicKey().toString().toLowerCase(),
    secret: randomHex(32),
    label: args.label,
    expiresAt: (args.now ?? Date.now()) + SCAN_LOGIN_TTL_MS,
  }
  session = { payload, key, approverKey: null, done: false }
  return payload
}

export function endScanLoginSession(): void {
  session = null
}

export function subscribeScanLoginSession(listener: (event: ScanLoginEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const reply = (status: number, body: Record<string, unknown>) => ({ status, body: JSON.stringify(body) })

export function isScanLoginPath(path: string): boolean {
  return /\/handcash-device\/v1\/scan-login\/(hello|vault|refuse)$/.test(path.replace(/\/+$/, ''))
}

export function handleScanLoginRequest(
  event: { method: string; path: string; body: string },
  now = Date.now(),
): { status: number; body: string } {
  if (event.method !== 'POST') return reply(405, { error: 'method-not-allowed' })
  const live = session
  if (!live || live.done || live.payload.expiresAt <= now) return reply(404, { error: 'no-scan-login' })
  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>
  } catch {
    return reply(400, { error: 'invalid-body' })
  }
  const approverKey = typeof body.approverKey === 'string' ? body.approverKey.toLowerCase() : ''
  if (!/^(02|03)[0-9a-f]{64}$/.test(approverKey)) return reply(400, { error: 'invalid-body' })
  const { secret, loginKey } = live.payload
  const step = event.path.replace(/\/+$/, '').split('/').pop()

  if (step === 'hello') {
    if (!proofMatches(scanLoginProof(secret, 'hello', approverKey), body.proof)) return reply(401, { error: 'bad-proof' })
    if (live.approverKey && live.approverKey !== approverKey) return reply(409, { error: 'already-paired' })
    live.approverKey = approverKey
    const approverLabel = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : 'Your other device'
    emit({ type: 'connected', approverLabel, code: scanLoginCode(secret, loginKey, approverKey) })
    return reply(200, { ok: true, loginKey, label: live.payload.label })
  }

  if (approverKey !== live.approverKey) return reply(409, { error: 'not-paired' })

  if (step === 'vault') {
    const sealed = typeof body.sealedVault === 'string' ? body.sealedVault : ''
    if (!sealed || !proofMatches(scanLoginProof(secret, 'vault', sha256Hex(sealed)), body.proof)) {
      return reply(401, { error: 'bad-proof' })
    }
    let transfer: VaultTransfer
    try {
      transfer = openVaultTransfer(sealed, live.key)
    } catch {
      return reply(400, { error: 'bad-vault' })
    }
    live.done = true
    emit({ type: 'vault', transfer })
    return reply(200, { ok: true })
  }

  if (step === 'refuse') {
    if (!proofMatches(scanLoginProof(secret, 'refuse', approverKey), body.proof)) return reply(401, { error: 'bad-proof' })
    live.done = true
    emit({ type: 'refused' })
    return reply(200, { ok: true })
  }

  return reply(404, { error: 'not-found' })
}
