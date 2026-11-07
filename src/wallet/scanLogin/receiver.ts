/**
 * The new device's side of scan-to-login, served by its local peer server
 * (`/handcash-device/v1/scan-login/*`). It needs no wallet: it holds only the
 * one-time key and secret from its own QR.
 */
import type { PrivateKey } from '@bsv/sdk'
import { signIdentityText } from '../messageboxAuth'
import { freshLoginKey, openVaultTransfer, randomHex, type VaultTransfer } from '../deviceTransfer'
import {
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  SCAN_LOGIN_KIND,
  SCAN_LOGIN_TTL_MS,
  pairingConfirmProof,
  pairingReceiptText,
  proofMatches,
  scanLoginProof,
  sha256Hex,
  type ScanLoginPayload,
} from './payload'

export type ScanLoginEvent =
  /** An approver reached us. `code` is for this screen only: a person types it on the approver. */
  | { type: 'connected'; approverLabel: string; code: string; codeExpiresAt: number }
  /** The approver proved the typed code. Only now will it be sent the vault. */
  | { type: 'confirmed' }
  | { type: 'vault'; transfer: VaultTransfer; acknowledge: () => Promise<void>; fail: () => void }
  | { type: 'refused' }
  /** The session ended without a vault: too many wrong codes, or the code ran out. */
  | { type: 'failed'; reason: 'locked' | 'expired' }

export type Session = {
  payload: ScanLoginPayload
  key: PrivateKey
  approverKey: string | null
  done: boolean
  /** Pairing code shown on this screen; set when an approver connects. Never sent anywhere. */
  code: string | null
  codeExpiresAt: number
  attempts: number
  confirmed: boolean
  usedNonces: Set<string>
  completion?: Promise<{ status: number; body: string }>
}

/** A uniform random code of PAIRING_CODE_LENGTH digits (rejection sampling, no modulo bias). */
export function freshPairingCode(): string {
  const webCrypto: Crypto = globalThis.crypto
  const limit = 4_294_967_296 - (4_294_967_296 % 10)
  let out = ''
  const buf = new Uint32Array(1)
  while (out.length < PAIRING_CODE_LENGTH) {
    webCrypto.getRandomValues(buf)
    if (buf[0]! >= limit) continue
    out += String(buf[0]! % 10)
  }
  return out
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
  session = {
    payload,
    key,
    approverKey: null,
    done: false,
    code: null,
    codeExpiresAt: 0,
    attempts: 0,
    confirmed: false,
    usedNonces: new Set(),
  }
  return payload
}

/** The live session's one-time key, for the mailbox relay. */
export function getScanLoginSession(): Session | null {
  return session
}

export function endScanLoginSession(): void {
  session = null
}

export function subscribeScanLoginSession(listener: (event: ScanLoginEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const reply = (status: number, body: Record<string, unknown>) => ({ status, body: JSON.stringify(body) })

/** Transport success waits for durable installation AND the wallet runtime, not decryption. */
export async function handleScanLoginRequestAsync(event: { method: string; path: string; body: string }) {
  const live = session
  const out = handleScanLoginRequest(event)
  return out.status === 202 && live?.completion ? live.completion : out
}

export function isScanLoginPath(path: string): boolean {
  return /\/handcash-device\/v1\/scan-login\/(hello|confirm|vault|refuse)$/.test(path.replace(/\/+$/, ''))
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
  // approverKey comes from the transport: the mailbox sender is authenticated.
  const approverKey = typeof body.approverKey === 'string' ? body.approverKey.toLowerCase() : ''
  if (!/^(02|03)[0-9a-f]{64}$/.test(approverKey)) return reply(400, { error: 'invalid-body' })
  const { secret, loginKey } = live.payload
  const step = event.path.replace(/\/+$/, '').split('/').pop()

  if (step === 'hello') {
    if (!proofMatches(scanLoginProof(secret, 'hello', approverKey), body.proof)) return reply(401, { error: 'bad-proof' })
    if (live.approverKey && live.approverKey !== approverKey) return reply(409, { error: 'already-paired' })
    // A repeated hello from the paired device changes nothing: the code and attempts stay.
    if (!live.approverKey) {
      live.approverKey = approverKey
      live.code = freshPairingCode()
      live.codeExpiresAt = now + PAIRING_CODE_TTL_MS
      const approverLabel = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : 'Your other device'
      emit({ type: 'connected', approverLabel, code: live.code, codeExpiresAt: live.codeExpiresAt })
    }
    return reply(200, { ok: true, loginKey, label: live.payload.label, codeLength: PAIRING_CODE_LENGTH, receiptVersion: 1 })
  }

  if (approverKey !== live.approverKey) return reply(409, { error: 'not-paired' })

  if (step === 'confirm') {
    const nonce = typeof body.nonce === 'string' ? body.nonce : ''
    if (!/^[0-9a-f]{32}$/.test(nonce)) return reply(400, { error: 'invalid-body' })
    // A replayed request never counts as a fresh guess and never succeeds, confirmed or not.
    if (live.usedNonces.has(nonce)) return reply(409, { error: 'replayed' })
    if (live.confirmed) return reply(409, { error: 'replayed' })
    if (live.codeExpiresAt <= now) {
      live.done = true
      emit({ type: 'failed', reason: 'expired' })
      return reply(410, { error: 'code-expired' })
    }
    live.usedNonces.add(nonce)
    const expected = pairingConfirmProof(secret, approverKey, nonce, live.code ?? '')
    if (!live.code || !proofMatches(expected, body.proof)) {
      live.attempts += 1
      if (live.attempts >= PAIRING_MAX_ATTEMPTS) {
        live.done = true
        emit({ type: 'failed', reason: 'locked' })
        return reply(423, { error: 'locked', attemptsLeft: 0 })
      }
      return reply(401, { error: 'wrong-code', attemptsLeft: PAIRING_MAX_ATTEMPTS - live.attempts })
    }
    live.confirmed = true
    live.code = null
    emit({ type: 'confirmed' })
    return reply(200, { ok: true })
  }

  if (step === 'vault') {
    // The vault is released only to a device whose person typed the code shown here.
    if (!live.confirmed) return reply(403, { error: 'not-confirmed' })
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
    live.completion = new Promise((resolve) => {
      let settled = false
      const finish = (result: { status: number; body: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => finish(reply(504, { error: 'setup-unverified' })), 90_000)
      emit({
        type: 'vault', transfer,
        acknowledge: async () => {
          if (Date.now() >= live.payload.expiresAt) {
            finish(reply(410, { error: 'no-scan-login' }))
            return
          }
          const { signature } = signIdentityText(live.key.toHex(), pairingReceiptText(loginKey, approverKey, sha256Hex(sealed)))
          finish(reply(200, { ok: true, signature }))
        },
        fail: () => finish(reply(503, { error: 'setup-failed' })),
      })
    })
    return reply(202, { pending: true })
  }

  if (step === 'refuse') {
    if (!proofMatches(scanLoginProof(secret, 'refuse', approverKey), body.proof)) return reply(401, { error: 'bad-proof' })
    live.done = true
    emit({ type: 'refused' })
    return reply(200, { ok: true })
  }

  return reply(404, { error: 'not-found' })
}
