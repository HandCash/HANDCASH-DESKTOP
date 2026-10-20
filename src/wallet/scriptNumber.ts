import { OP, type ScriptChunk } from '@bsv/sdk'

/** Largest token amount: an unsigned 64-bit integer. */
export const MAX_AMOUNT = (1n << 64n) - 1n

/**
 * Minimally encoded non-negative Bitcoin script number, domain 0..2^64-1.
 * 0 → OP_0; 1..16 → OP_1..OP_16; else little-endian with a high-zero sign byte
 * when the last value byte has its high bit set.
 */
export function encodeScriptNumber(amount: bigint): { op: number; data?: number[] } {
  if (amount < 0n || amount > MAX_AMOUNT) {
    throw new Error('Amount out of range (0..2^64-1)')
  }
  if (amount === 0n) return { op: OP.OP_0 }
  if (amount <= 16n) return { op: OP.OP_1 - 1 + Number(amount) }
  const bytes: number[] = []
  let n = amount
  while (n > 0n) {
    bytes.push(Number(n & 0xffn))
    n >>= 8n
  }
  if ((bytes[bytes.length - 1]! & 0x80) !== 0) bytes.push(0)
  return { op: bytes.length, data: bytes }
}

export function decodeScriptNumber(chunk: ScriptChunk): bigint | null {
  if (chunk.op === OP.OP_0 && (chunk.data == null || chunk.data.length === 0)) {
    return 0n
  }
  if (
    chunk.op >= OP.OP_1 &&
    chunk.op <= OP.OP_16 &&
    (chunk.data == null || chunk.data.length === 0)
  ) {
    return BigInt(chunk.op - OP.OP_1 + 1)
  }
  const data = chunk.data
  if (!data || data.length === 0 || data.length > 9) return null
  if ((data[data.length - 1]! & 0x80) !== 0) return null
  if (
    data.length > 1 &&
    data[data.length - 1] === 0 &&
    (data[data.length - 2]! & 0x80) === 0
  ) {
    return null
  }
  let n = 0n
  for (let i = 0; i < data.length; i++) {
    n |= BigInt(data[i]!) << (8n * BigInt(i))
  }
  if (n > MAX_AMOUNT) return null
  if (n === 0n) return null
  if (n <= 16n) return null
  return n
}
