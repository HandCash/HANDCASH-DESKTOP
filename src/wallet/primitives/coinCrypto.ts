import { CURVE, etc, getPublicKey, getSharedSecret, Point, sign, verify } from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { decodeHex, encodeHex } from '../../meridian/encoding'

// Narrow serialized boundary: an SDK key may be passed by BSV callers, but
// other-coin cryptography never delegates operations to that object.
export type KeyMaterial = { toHex(): string }

etc.hmacSha256Sync = (key, ...messages) => hmac(sha256, key, concatBytes(...messages))

export class CoinPrivateKey {
  private readonly hex: string
  constructor(hex: string) {
    const bytes = decodeHex(hex.padStart(64, '0'))
    if (bytes.length !== 32 || !etc.bytesToNumberBE(bytes) || etc.bytesToNumberBE(bytes) >= CURVE.n) {
      throw new Error('Invalid coin private key')
    }
    this.hex = encodeHex(bytes)
  }
  static fromHex(hex: string): CoinPrivateKey { return new CoinPrivateKey(hex) }
  toHex(): string { return this.hex }
  toArray(): number[] { return Array.from(decodeHex(this.hex)) }
  toPublicKey() {
    const bytes = getPublicKey(this.hex, true)
    return {
      encode: (compressed = true): number[] => Array.from(Point.fromHex(bytes).toRawBytes(compressed)),
      toString: (): string => encodeHex(bytes),
    }
  }
}

export const coinPublicKey = (key: KeyMaterial, compressed = true): Uint8Array =>
  getPublicKey(new CoinPrivateKey(key.toHex()).toHex(), compressed)

const scalar = (bytes: Uint8Array): bigint => etc.bytesToNumberBE(bytes)
const modN = (n: bigint): bigint => ((n % CURVE.n) + CURVE.n) % CURVE.n

// BRC-42 "Key Derivation": compressed ECDH point, HMAC-SHA256, scalar addition.
// BRC-43 "Specification": retain the existing invoice bytes and self semantics.
// Implementation inputs/provenance and review limits: docs/restricted-component-replacement.md.
export function deriveInvoicePrivateKey(root: KeyMaterial, peer: string, invoice: string): CoinPrivateKey {
  const key = new CoinPrivateKey(root.toHex())
  const shared = getSharedSecret(key.toHex(), peer, true)
  const tweak = scalar(hmac(sha256, shared, new TextEncoder().encode(invoice)))
  const child = modN(BigInt('0x' + key.toHex()) + tweak)
  if (child === 0n) throw new Error('Invalid derived coin key')
  return new CoinPrivateKey(child.toString(16).padStart(64, '0'))
}

function invoiceNumber(protocol: readonly [number, string], keyId: string): string {
  const name = protocol[1].trim().toLowerCase()
  if (![0, 1, 2].includes(protocol[0]) || !/^[a-z0-9]+(?: [a-z0-9]+)*$/.test(name) ||
      name.length < 5 || name.length > 280 || name.endsWith(' protocol') ||
      !keyId || new TextEncoder().encode(keyId).length > 1033) throw new Error('Invalid coin derivation path')
  return `${protocol[0]}-${name}-${keyId}`
}

const peerKey = (root: KeyMaterial, peer: string): string =>
  peer === 'self' ? encodeHex(coinPublicKey(root)) : peer === 'anyone' ? encodeHex(getPublicKey(1n)) : peer

export function deriveCoinPrivateKey(root: KeyMaterial, protocol: readonly [number, string], keyId: string, peer = 'self'): CoinPrivateKey {
  return deriveInvoicePrivateKey(root, peerKey(root, peer), invoiceNumber(protocol, keyId))
}

export function deriveCoinPublicKey(root: KeyMaterial, protocol: readonly [number, string], keyId: string, peer: string): Uint8Array {
  const shared = getSharedSecret(new CoinPrivateKey(root.toHex()).toHex(), peerKey(root, peer), true)
  const tweak = modN(scalar(hmac(sha256, shared, new TextEncoder().encode(invoiceNumber(protocol, keyId)))))
  const point = Point.fromHex(peerKey(root, peer))
  return (tweak === 0n ? point : point.add(Point.BASE.multiply(tweak))).toRawBytes(true)
}

// ASN.1 DER INTEGER/SEQUENCE framing only. ECDSA and RFC6979 are noble's.
function derInteger(value: bigint): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = '0' + hex
  let bytes = decodeHex(hex)
  if (bytes[0]! & 0x80) bytes = concatBytes(Uint8Array.of(0), bytes)
  return concatBytes(Uint8Array.of(2, bytes.length), bytes)
}

export function signCoinDigest(digest: Uint8Array, key: KeyMaterial): Uint8Array {
  if (digest.length !== 32) throw new Error('Expected 32-byte signature digest')
  const sig = sign(digest, new CoinPrivateKey(key.toHex()).toHex(), { lowS: true })
  const body = concatBytes(derInteger(sig.r), derInteger(sig.s))
  return concatBytes(Uint8Array.of(0x30, body.length), body)
}

export function verifyCoinDigest(digest: Uint8Array, pub: Uint8Array, der: Uint8Array): boolean {
  try {
    if (digest.length !== 32 || der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) return false
    let at = 2
    const read = (): bigint => {
      if (der[at++] !== 2) throw new Error('Not a DER integer')
      const size = der[at++]!
      const bytes = der.subarray(at, at + size)
      if (!size || size > 33 || bytes.length !== size || bytes[0]! & 0x80 ||
          (size > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80))) throw new Error('Noncanonical DER integer')
      at += size
      return scalar(bytes)
    }
    const r = read()
    const s = read()
    return at === der.length && verify({ r, s }, digest, pub, { lowS: false })
  } catch { return false }
}
