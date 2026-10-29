/**
 * Minimal RLP for legacy (type-0) Ethereum transactions.
 * Only encodes lists of byte strings / nested lists — enough for EIP-155.
 */

export type RlpItem = Uint8Array | RlpItem[]

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) return rlpEncodeBytes(item)
  const parts = item.map(rlpEncode)
  const payload = concat(parts)
  if (payload.length <= 55) return concat([Uint8Array.of(0xc0 + payload.length), payload])
  const len = encodeLength(payload.length)
  return concat([Uint8Array.of(0xf7 + len.length), len, payload])
}

function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0]! < 0x80) return bytes
  if (bytes.length <= 55) return concat([Uint8Array.of(0x80 + bytes.length), bytes])
  const len = encodeLength(bytes.length)
  return concat([Uint8Array.of(0xb7 + len.length), len, bytes])
}

function encodeLength(n: number): Uint8Array {
  if (n === 0) return new Uint8Array([0])
  const hex = n.toString(16)
  const body = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Unsigned integer as the shortest big-endian byte string (empty for 0). */
export function rlpUint(value: bigint | number): Uint8Array {
  let n = typeof value === 'bigint' ? value : BigInt(value)
  if (n < 0n) throw new Error('RLP: negative')
  if (n === 0n) return new Uint8Array()
  let hex = n.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
