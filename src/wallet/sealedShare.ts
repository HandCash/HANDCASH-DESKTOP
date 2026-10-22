/**
 * Opens a recovery share a holder sealed to a key this device made for the
 * release: ECDH with the holder's ephemeral key, HKDF-SHA256, AES-GCM.
 * The HKDF info label is part of the envelope format the holder seals with.
 */
import { PrivateKey, PublicKey, Utils } from '@bsv/sdk'

export const SEALED_SHARE_INFO = 'brc250-host-share-v1'

export type SealedShare = {
  v: 1
  ephemeralKey: string
  iv: string
  ciphertext: string
}

export async function sealedShareKey(
  own: PrivateKey,
  peer: PublicKey,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const encoded = own.deriveSharedSecret(peer).encode(true)
  const compressed = typeof encoded === 'string' ? Utils.toArray(encoded, 'hex') : encoded
  const material = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(compressed.slice(1)),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(SEALED_SHARE_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

export async function openSealedShare(key: PrivateKey, sealed: SealedShare): Promise<string> {
  if (sealed.v !== 1) throw new Error('Unsupported recovery-share envelope')
  const aes = await sealedShareKey(key, PublicKey.fromString(sealed.ephemeralKey), 'decrypt')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bufferOf(base64urlBytes(sealed.iv)) },
    aes,
    bufferOf(base64urlBytes(sealed.ciphertext)),
  )
  return new TextDecoder().decode(plain)
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function base64urlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '=',
  )
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))
}
