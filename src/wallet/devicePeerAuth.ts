import { PrivateKey, ProtoWallet, Random, Utils } from '@bsv/sdk'

/**
 * Proof that a LAN device-peer caller holds this wallet's root key.
 *
 * The device-peer port listens on the LAN and any website can aim a fetch at
 * it, so a public identity key is no credential. Same-identity devices share
 * the root key, so each request carries a BRC-2 HMAC over method, path, time
 * and a single-use nonce, and every answer is sealed to that nonce: a caller
 * without the key learns nothing, and a passive listener sees only ciphertext.
 */

export const DEVICE_PEER_PROTOCOL: [2, string] = [2, 'handcash device peer']
export const DEVICE_PEER_AUTH_HEADER = 'x-handcash-device-auth'
export const DEVICE_PEER_AUTH_WINDOW_MS = 60_000

const AUTH_KEY_ID = 'request v1'
const NONCE_RE = /^[0-9a-f]{32}$/
const HMAC_RE = /^[0-9a-f]{64}$/

export type DeviceAuthProof = { header: string; nonce: string }

function walletOf(rootKeyHex: string): ProtoWallet {
  return new ProtoWallet(PrivateKey.fromHex(rootKeyHex.trim()))
}

function proofData(method: string, path: string, ts: number, nonce: string): number[] {
  return Utils.toArray(`${method.toUpperCase()} ${path} ${ts} ${nonce}`, 'utf8')
}

export async function createDeviceAuth(
  rootKeyHex: string,
  method: string,
  path: string,
  now = Date.now(),
): Promise<DeviceAuthProof> {
  const nonce = Utils.toHex(Random(16))
  const { hmac } = await walletOf(rootKeyHex).createHmac({
    data: proofData(method, path, now, nonce),
    protocolID: DEVICE_PEER_PROTOCOL,
    keyID: AUTH_KEY_ID,
    counterparty: 'self',
  })
  return { header: `${now}.${nonce}.${Utils.toHex(hmac)}`, nonce }
}

/** Nonces already accepted, kept until they fall out of the time window. */
export class DeviceAuthReplayCache {
  private readonly seen = new Map<string, number>()

  has(nonce: string, now: number): boolean {
    for (const [n, ts] of this.seen) {
      if (Math.abs(now - ts) > DEVICE_PEER_AUTH_WINDOW_MS) this.seen.delete(n)
    }
    return this.seen.has(nonce)
  }

  add(nonce: string, ts: number): void {
    this.seen.set(nonce, ts)
  }
}

/** The request's nonce when the proof holds, else null. */
export async function verifyDeviceAuth(
  rootKeyHex: string,
  header: string | undefined,
  method: string,
  path: string,
  replay: DeviceAuthReplayCache,
  now = Date.now(),
): Promise<string | null> {
  if (typeof header !== 'string') return null
  const [tsText, nonce, hmacHex, extra] = header.trim().split('.')
  if (extra !== undefined || !tsText || !nonce || !hmacHex) return null
  if (!/^\d{1,15}$/.test(tsText) || !NONCE_RE.test(nonce) || !HMAC_RE.test(hmacHex)) return null
  const ts = Number(tsText)
  if (Math.abs(now - ts) > DEVICE_PEER_AUTH_WINDOW_MS) return null
  if (replay.has(nonce, now)) return null
  try {
    const { valid } = await walletOf(rootKeyHex).verifyHmac({
      data: proofData(method, path, ts, nonce),
      hmac: Utils.toArray(hmacHex, 'hex'),
      protocolID: DEVICE_PEER_PROTOCOL,
      keyID: AUTH_KEY_ID,
      counterparty: 'self',
    })
    if (!valid) return null
  } catch {
    return null
  }
  replay.add(nonce, ts)
  return nonce
}

export async function sealForPeer(rootKeyHex: string, nonce: string, value: unknown): Promise<string> {
  const { ciphertext } = await walletOf(rootKeyHex).encrypt({
    plaintext: Utils.toArray(JSON.stringify(value), 'utf8'),
    protocolID: DEVICE_PEER_PROTOCOL,
    keyID: nonce,
    counterparty: 'self',
  })
  return Utils.toBase64(ciphertext)
}

export async function openFromPeer<T>(rootKeyHex: string, nonce: string, sealed: string): Promise<T> {
  const { plaintext } = await walletOf(rootKeyHex).decrypt({
    ciphertext: Utils.toArray(sealed, 'base64'),
    protocolID: DEVICE_PEER_PROTOCOL,
    keyID: nonce,
    counterparty: 'self',
  })
  return JSON.parse(Utils.toUTF8(plaintext)) as T
}
