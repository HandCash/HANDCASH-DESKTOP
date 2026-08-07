/**
 * Tiny hex helpers that must not touch Node `Buffer` — hardened send loads in
 * the Vite renderer / Capacitor WebView, where `Buffer is not defined` used to
 * abort the covenant path and fall through to soft-latch.
 */

const HEX = '0123456789abcdef'

function byteToHex(n: number): string {
  return HEX[(n >>> 4) & 0xf]! + HEX[n & 0xf]!
}

export function hexToBytes(hex: string): Uint8Array {
  const raw = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(raw.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += byteToHex(bytes[i]!)
  return out
}

/** Little-endian u32 → 8 hex chars. */
export function u32LeToHex(value: number): string {
  const n = value >>> 0
  const bytes = new Uint8Array(4)
  bytes[0] = n & 0xff
  bytes[1] = (n >>> 8) & 0xff
  bytes[2] = (n >>> 16) & 0xff
  bytes[3] = (n >>> 24) & 0xff
  return bytesToHex(bytes)
}

/** 8 hex chars → little-endian u32. */
export function hexToU32Le(hex: string): number {
  const bytes = hexToBytes(hex.slice(0, 8))
  return (
    (bytes[0] ?? 0) |
    ((bytes[1] ?? 0) << 8) |
    ((bytes[2] ?? 0) << 16) |
    ((bytes[3] ?? 0) << 24)
  ) >>> 0
}

/** Reverse each byte pair of a 64-char txid hex (display ↔ internal). */
export function reverseTxidHex(txid: string): string {
  const bytes = hexToBytes(txid)
  bytes.reverse()
  return bytesToHex(bytes)
}
