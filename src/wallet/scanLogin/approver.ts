/**
 * The signed-in device's side of scan-to-login: reach the new device on the
 * local network, show the shared code, then send the vault sealed to the key
 * from the QR. No HandCash server is in the path.
 */
import { PrivateKey } from '@bsv/sdk'
import { randomHex, sealVaultTransfer, type VaultTransfer } from '../deviceTransfer'
import { relayRequest } from './relay'
import { pairingConfirmProof, scanLoginProof, sha256Hex, type ScanLoginPayload } from './payload'

export const SCAN_LOGIN_REACH_MS = 3_000
export const SCAN_LOGIN_RELAY_MS = 20_000

export type ScanLoginConnection = {
  payload: ScanLoginPayload
  /** The new device's local address, or 'relay' when reached through the mailbox. */
  url: string
  approverKey: PrivateKey
}

/** Neither the local network nor the relay reached the new device. */
export class ScanLoginUnreachable extends Error {
  constructor() {
    super('scan-login-unreachable')
    this.name = 'ScanLoginUnreachable'
  }
}

type Fetch = typeof fetch

async function postJson(
  fetchImpl: Fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  } finally {
    clearTimeout(timer)
  }
}

function refusalText(error: unknown): string {
  switch (error) {
    case 'already-paired':
      return 'Another device already answered this code.'
    case 'not-confirmed':
      return 'Type the code shown on the new device first.'
    case 'no-scan-login':
      return 'This code expired. Ask the new device for a fresh one.'
    default:
      return `The new device refused the connection (${String(error)}).`
  }
}

type Reply = { status: number; body: Record<string, unknown> }

async function viaConn(
  conn: ScanLoginConnection,
  step: 'hello' | 'confirm' | 'vault' | 'refuse',
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: Fetch,
): Promise<Reply> {
  if (conn.url === 'relay') {
    return relayRequest(conn.approverKey, conn.payload.loginKey, step, body, { timeoutMs, fetchImpl })
  }
  return postJson(fetchImpl, `${conn.url}/handcash-device/v1/scan-login/${step}`, body, timeoutMs)
}

export async function helloScanLogin(
  payload: ScanLoginPayload,
  args: { label: string; fetchImpl?: Fetch; timeoutMs?: number; relayMs?: number; relay?: boolean },
): Promise<ScanLoginConnection> {
  const fetchImpl = args.fetchImpl ?? fetch
  const approverKey = PrivateKey.fromRandom()
  const pub = approverKey.toPublicKey().toString().toLowerCase()
  const body = { approverKey: pub, label: args.label, proof: scanLoginProof(payload.secret, 'hello', pub) }
  const routes = [
    ...payload.urls.map((url) => ({ url, timeout: args.timeoutMs ?? SCAN_LOGIN_REACH_MS })),
    ...(args.relay === false ? [] : [{ url: 'relay', timeout: args.relayMs ?? SCAN_LOGIN_RELAY_MS }]),
  ]
  let refusal: string | null = null
  const failures: string[] = []
  // First route to answer wins; the local network is simply usually faster.
  const winner = await new Promise<ScanLoginConnection | null>((resolve) => {
    let pending = routes.length
    const settle = () => {
      if (--pending === 0) resolve(null)
    }
    if (pending === 0) resolve(null)
    for (const route of routes) {
      const conn: ScanLoginConnection = { payload, url: route.url, approverKey }
      viaConn(conn, 'hello', body, route.timeout, fetchImpl)
        .then((res) => {
          if (res.status !== 200) {
            refusal ??= refusalText(res.body.error)
            failures.push(`${route.url}: http-${res.status}`)
          } else if (String(res.body.loginKey ?? '').toLowerCase() !== payload.loginKey) {
            refusal ??= 'The device that answered is not the one in the code.'
          } else {
            resolve(conn)
            return
          }
          settle()
        })
        .catch((error) => {
          failures.push(`${route.url}: ${error instanceof Error ? error.message : String(error)}`)
          settle()
        })
    }
  })
  if (winner) return winner
  console.warn('[scan-login] hello failed', JSON.stringify({ urls: payload.urls, failures, refusal }))
  if (refusal) throw new Error(refusal)
  throw new ScanLoginUnreachable()
}

/** The typed code was not accepted; `attemptsLeft` 0 means the new device ended the session. */
export class PairingCodeRejected extends Error {
  constructor(
    readonly reason: 'wrong' | 'locked' | 'expired' | 'replayed' | 'ended',
    readonly attemptsLeft: number,
  ) {
    super(`pairing-code-${reason}`)
    this.name = 'PairingCodeRejected'
  }
}

/**
 * Prove the digits a person typed from the new device's screen. Each call uses a
 * fresh nonce; the new device counts wrong codes and ends the session at the limit.
 */
export async function confirmPairingCode(
  conn: ScanLoginConnection,
  typed: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const pub = conn.approverKey.toPublicKey().toString().toLowerCase()
  const nonce = randomHex(16)
  const res = await viaConn(
    conn,
    'confirm',
    { approverKey: pub, nonce, proof: pairingConfirmProof(conn.payload.secret, pub, nonce, typed) },
    conn.url === 'relay' ? SCAN_LOGIN_RELAY_MS : SCAN_LOGIN_REACH_MS,
    fetchImpl,
  )
  if (res.status === 200) return
  const left = Number(res.body.attemptsLeft ?? 0)
  switch (res.body.error) {
    case 'wrong-code':
      throw new PairingCodeRejected('wrong', left)
    case 'locked':
      throw new PairingCodeRejected('locked', 0)
    case 'code-expired':
      throw new PairingCodeRejected('expired', 0)
    case 'replayed':
      throw new PairingCodeRejected('replayed', left)
    default:
      throw new PairingCodeRejected('ended', 0)
  }
}

export async function sendScanLoginVault(
  conn: ScanLoginConnection,
  transfer: VaultTransfer,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const sealedVault = sealVaultTransfer(transfer, conn.approverKey, conn.payload.loginKey)
  const pub = conn.approverKey.toPublicKey().toString().toLowerCase()
  const res = await viaConn(
    conn,
    'vault',
    { approverKey: pub, sealedVault, proof: scanLoginProof(conn.payload.secret, 'vault', sha256Hex(sealedVault)) },
    conn.url === 'relay' ? SCAN_LOGIN_RELAY_MS : 30_000,
    fetchImpl,
  )
  if (res.status !== 200) throw new Error(refusalText(res.body.error))
}

export async function refuseScanLogin(conn: ScanLoginConnection, fetchImpl: Fetch = fetch): Promise<void> {
  const pub = conn.approverKey.toPublicKey().toString().toLowerCase()
  await viaConn(
    conn,
    'refuse',
    { approverKey: pub, proof: scanLoginProof(conn.payload.secret, 'refuse', pub) },
    conn.url === 'relay' ? SCAN_LOGIN_RELAY_MS : SCAN_LOGIN_REACH_MS,
    fetchImpl,
  )
}
