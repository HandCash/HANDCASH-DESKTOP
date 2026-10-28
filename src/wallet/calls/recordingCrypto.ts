/**
 * Sealing for call recordings. Each recording has its own AES-GCM key, taken
 * from the account key alone (an HMAC under the BRC-42 key this identity
 * shares with itself, protocol [2, 'handcash call recording'], keyID the
 * recording id), so only this account can open what it recorded. Every part
 * carries its own IV and is bound to its place in its recording, so parts
 * can't be swapped, reordered or moved between recordings unnoticed.
 */

import type { WalletInterface } from '@bsv/sdk'

const PROTOCOL: [2, string] = [2, 'handcash call recording']
const IV_BYTES = 12

export type RecordingMeta = {
  v: 1
  callId: string
  peers: string[]
  startedAt: number
  endedAt: number
  mime: string
  video: boolean
}

const text = (s: string) => new TextEncoder().encode(s)

export function newRecordingId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function recordingKey(wallet: Pick<WalletInterface, 'createHmac'>, id: string): Promise<CryptoKey> {
  const { hmac } = await wallet.createHmac({
    data: Array.from(text(`hc-recording/1 key ${id}`)),
    protocolID: PROTOCOL,
    keyID: id,
    counterparty: 'self',
  })
  return crypto.subtle.importKey('raw', Uint8Array.from(hmac), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function place(id: string, at: number | 'meta') {
  return text(`hc-recording/1 ${id} ${at}`)
}

/** IV, then ciphertext and tag. */
export async function sealPart(key: CryptoKey, id: string, at: number | 'meta', plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: place(id, at) }, key, new Uint8Array(plain)))
  const out = new Uint8Array(IV_BYTES + sealed.byteLength)
  out.set(iv)
  out.set(sealed, IV_BYTES)
  return out
}

/** Throws when the part was not sealed by this key for this place. */
export async function openPart(key: CryptoKey, id: string, at: number | 'meta', sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.byteLength <= IV_BYTES) throw new Error('Recording part is too short')
  const iv = new Uint8Array(sealed.subarray(0, IV_BYTES))
  const body = new Uint8Array(sealed.subarray(IV_BYTES))
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: place(id, at) }, key, body))
}

export function sealMeta(key: CryptoKey, id: string, meta: RecordingMeta): Promise<Uint8Array> {
  return sealPart(key, id, 'meta', text(JSON.stringify(meta)))
}

export async function openMeta(key: CryptoKey, id: string, sealed: Uint8Array): Promise<RecordingMeta | null> {
  try {
    const m = JSON.parse(new TextDecoder().decode(await openPart(key, id, 'meta', sealed))) as Partial<RecordingMeta>
    if (
      m.v !== 1 ||
      typeof m.callId !== 'string' ||
      !Array.isArray(m.peers) ||
      !m.peers.every((p) => typeof p === 'string') ||
      typeof m.startedAt !== 'number' ||
      typeof m.endedAt !== 'number' ||
      typeof m.mime !== 'string' ||
      typeof m.video !== 'boolean'
    ) {
      return null
    }
    return m as RecordingMeta
  } catch {
    return null
  }
}
