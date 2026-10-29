/**
 * Arc / EVM address from a secp256k1 key (same curve as BSV).
 * Address = last 20 bytes of keccak256(uncompressed pubkey without 0x04).
 */
import { PrivateKey } from '@bsv/sdk'
import { keccak_256 } from '@noble/hashes/sha3.js'

const HEX = /^0x[0-9a-fA-F]{40}$/

export function ethAddressFromPrivateKey(key: PrivateKey): string {
  const pub = Uint8Array.from(key.toPublicKey().encode(false) as number[])
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('ARC_USD_KEY: expected uncompressed secp256k1 public key')
  }
  const hash = keccak_256(pub.subarray(1))
  return toChecksumAddress(`0x${bytesToHex(hash.subarray(12))}`)
}

/** EIP-55 checksum address; throws unless `value` is 0x + 40 hex. */
export function toChecksumAddress(value: string): string {
  if (!HEX.test(value)) throw new Error('ARC_USD_ADDRESS: need 0x + 40 hex characters')
  const lower = value.slice(2).toLowerCase()
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)))
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]
  }
  return out
}

export function isEthAddress(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

export function assertEthAddress(value: unknown): string {
  if (!isEthAddress(value)) throw new Error('ARC_USD_ADDRESS: need 0x + 40 hex characters')
  return toChecksumAddress(value)
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error('ARC_USD_HEX: expected even-length hex')
  }
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}
