/**
 * Sealing for private notes. Each note has its own AES-GCM key, taken from the
 * account key alone (an HMAC under the BRC-42 key this identity shares with
 * itself, protocol [2, 'handcash private notes'], keyID the note id), so only
 * this account can open it. The note id and save time are bound as additional
 * data: a sealed body can't be moved to another note or passed off as an
 * older or newer save.
 */

import type { WalletInterface } from '@bsv/sdk'

const PROTOCOL: [2, string] = [2, 'handcash private notes']
const IV_BYTES = 12

const text = (s: string) => new TextEncoder().encode(s)

export function newNoteId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function noteKey(wallet: Pick<WalletInterface, 'createHmac'>, id: string): Promise<CryptoKey> {
  const { hmac } = await wallet.createHmac({
    data: Array.from(text(`hc-note/1 key ${id}`)),
    protocolID: PROTOCOL,
    keyID: id,
    counterparty: 'self',
  })
  return crypto.subtle.importKey('raw', Uint8Array.from(hmac), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function place(id: string, savedAt: number) {
  return text(`hc-note/1 ${id} ${savedAt}`)
}

/** IV, then ciphertext and tag. */
export async function sealNote(key: CryptoKey, id: string, savedAt: number, body: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: place(id, savedAt) }, key, text(body)),
  )
  const out = new Uint8Array(IV_BYTES + sealed.byteLength)
  out.set(iv)
  out.set(sealed, IV_BYTES)
  return out
}

/** Throws when the body was not sealed by this key for this note and save. */
export async function openNote(key: CryptoKey, id: string, savedAt: number, sealed: Uint8Array): Promise<string> {
  if (sealed.byteLength <= IV_BYTES) throw new Error('Note is too short')
  const iv = new Uint8Array(sealed.subarray(0, IV_BYTES))
  const body = new Uint8Array(sealed.subarray(IV_BYTES))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: place(id, savedAt) }, key, body)
  return new TextDecoder().decode(plain)
}
