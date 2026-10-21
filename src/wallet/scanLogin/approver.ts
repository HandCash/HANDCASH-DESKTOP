/**
 * The signed-in device's side of scan-to-login: reach the new device on the
 * local network, show the shared code, then send the vault sealed to the key
 * from the QR. No HandCash server is in the path.
 */
import { PrivateKey } from '@bsv/sdk'
import { sealVaultTransfer, type VaultTransfer } from '../deviceTransfer'
import { scanLoginCode, scanLoginProof, sha256Hex, type ScanLoginPayload } from './payload'

export const SCAN_LOGIN_REACH_MS = 3_000

export type ScanLoginConnection = {
  payload: ScanLoginPayload
  url: string
  approverKey: PrivateKey
  code: string
}

/** No address in the QR answered: the devices are not on one local network. */
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
    case 'no-scan-login':
      return 'This code expired. Ask the new device for a fresh one.'
    default:
      return `The new device refused the connection (${String(error)}).`
  }
}

export async function helloScanLogin(
  payload: ScanLoginPayload,
  args: { label: string; fetchImpl?: Fetch; timeoutMs?: number },
): Promise<ScanLoginConnection> {
  const fetchImpl = args.fetchImpl ?? fetch
  const approverKey = PrivateKey.fromRandom()
  const pub = approverKey.toPublicKey().toString().toLowerCase()
  const body = { approverKey: pub, label: args.label, proof: scanLoginProof(payload.secret, 'hello', pub) }
  const attempts = payload.urls.map(async (base) => {
    const res = await postJson(fetchImpl, `${base}/handcash-device/v1/scan-login/hello`, body, args.timeoutMs ?? SCAN_LOGIN_REACH_MS)
    return { base, res }
  })
  let refusal: string | null = null
  for (const settled of await Promise.allSettled(attempts)) {
    if (settled.status !== 'fulfilled') continue
    const { base, res } = settled.value
    if (res.status !== 200) {
      refusal ??= refusalText(res.body.error)
      continue
    }
    if (String(res.body.loginKey ?? '').toLowerCase() !== payload.loginKey) {
      refusal ??= 'The device that answered is not the one in the code.'
      continue
    }
    return { payload, url: base, approverKey, code: scanLoginCode(payload.secret, payload.loginKey, pub) }
  }
  if (refusal) throw new Error(refusal)
  throw new ScanLoginUnreachable()
}

export async function sendScanLoginVault(
  conn: ScanLoginConnection,
  transfer: VaultTransfer,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const sealedVault = sealVaultTransfer(transfer, conn.approverKey, conn.payload.loginKey)
  const pub = conn.approverKey.toPublicKey().toString().toLowerCase()
  const res = await postJson(
    fetchImpl,
    `${conn.url}/handcash-device/v1/scan-login/vault`,
    { approverKey: pub, sealedVault, proof: scanLoginProof(conn.payload.secret, 'vault', sha256Hex(sealedVault)) },
    30_000,
  )
  if (res.status !== 200) throw new Error(refusalText(res.body.error))
}

export async function refuseScanLogin(conn: ScanLoginConnection, fetchImpl: Fetch = fetch): Promise<void> {
  const pub = conn.approverKey.toPublicKey().toString().toLowerCase()
  await postJson(
    fetchImpl,
    `${conn.url}/handcash-device/v1/scan-login/refuse`,
    { approverKey: pub, proof: scanLoginProof(conn.payload.secret, 'refuse', pub) },
    SCAN_LOGIN_REACH_MS,
  )
}
