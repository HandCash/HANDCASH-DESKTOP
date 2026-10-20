/** Strict DAG-CBOR, the payload encoding of compact-format deploys. */

export type CborValue = string | number | bigint | boolean | Uint8Array | CborValue[] | Map<string, CborValue>

function head(major: number, n: number | bigint): number[] {
  const hi = major << 5
  const v = BigInt(n)
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error('CBOR value out of range')
  const be = (width: number) => Array.from({ length: width }, (_, i) => Number((v >> BigInt(8 * (width - 1 - i))) & 0xffn))
  if (v < 24n) return [hi | Number(v)]
  if (v < 0x100n) return [hi | 24, ...be(1)]
  if (v < 0x10000n) return [hi | 25, ...be(2)]
  if (v <= 0xffffffffn) return [hi | 26, ...be(4)]
  return [hi | 27, ...be(8)]
}

function compareKeys(a: number[], b: number[]): number {
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return 0
}

/** DAG-CBOR: definite lengths, minimal heads, map keys length-first then bytewise. */
export function encodeDagCbor(value: CborValue): number[] {
  return encode(value)
}

function encode(value: CborValue): number[] {
  if (typeof value === 'boolean') return [value ? 0xf5 : 0xf4]
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Only unsigned integers are encoded')
    return head(0, value)
  }
  if (typeof value === 'bigint') return head(0, value)
  if (typeof value === 'string') {
    const bytes = [...new TextEncoder().encode(value)]
    return head(3, bytes.length).concat(bytes)
  }
  if (value instanceof Uint8Array) return head(2, value.length).concat([...value])
  if (Array.isArray(value)) {
    return (value as CborValue[]).reduce<number[]>((out, item) => out.concat(encode(item)), head(4, value.length))
  }
  const entries = [...value.entries()]
    .map(([key, item]) => [encode(key), encode(item)] as const)
    .sort((a, b) => compareKeys(a[0], b[0]))
  return entries.reduce<number[]>((out, [key, item]) => out.concat(key, item), head(5, entries.length))
}

type CborRead = { value: unknown; next: number }

function compareBytes(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

/** A tag-42 link: DAG-CBOR allows it, no payload attribute uses one. */
const DAG_LINK: unique symbol = Symbol('dag-link')
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })
/** Smallest argument each head width (addl 24–27) may carry. */
const MINIMAL_HEAD_FLOOR = [24n, 1n << 8n, 1n << 16n, 1n << 32n]

/**
 * Strict DAG-CBOR reader : definite lengths, minimal heads,
 * text map keys in length-first order without duplicates, 64-bit floats only
 * and never NaN / ±Infinity, simple values false / true / null, tag 42 only,
 * valid UTF-8. Anything else is `null` — the payload carries no attributes.
 */
function readDagCbor(bytes: Uint8Array, at: number, depth: number): CborRead | null {
  if (at >= bytes.length || depth > 32) return null
  const ib = bytes[at]!
  const major = ib >> 5
  const addl = ib & 0x1f
  let pos = at + 1
  if (major === 7) {
    if (addl === 20) return { value: false, next: pos }
    if (addl === 21) return { value: true, next: pos }
    if (addl === 22) return { value: null, next: pos }
    if (addl !== 27 || pos + 8 > bytes.length) return null
    const f = new DataView(bytes.buffer, bytes.byteOffset + pos, 8).getFloat64(0)
    return Number.isFinite(f) ? { value: f, next: pos + 8 } : null
  }
  let arg: bigint
  if (addl < 24) {
    arg = BigInt(addl)
  } else if (addl <= 27) {
    const width = 1 << (addl - 24)
    if (pos + width > bytes.length) return null
    arg = 0n
    for (let i = 0; i < width; i++) arg = (arg << 8n) | BigInt(bytes[pos + i]!)
    pos += width
    if (arg < MINIMAL_HEAD_FLOOR[addl - 24]!) return null
  } else {
    return null
  }
  if (major === 0) {
    return { value: arg <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(arg) : arg, next: pos }
  }
  if (major === 1) return { value: -1n - arg, next: pos }
  if (major === 6) {
    if (arg !== 42n) return null
    const link = readDagCbor(bytes, pos, depth + 1)
    if (!link || !(link.value instanceof Uint8Array) || link.value[0] !== 0) return null
    return { value: DAG_LINK, next: link.next }
  }
  const remaining = BigInt(bytes.length - pos)
  if (major === 2 || major === 3) {
    if (arg > remaining) return null
    const end = pos + Number(arg)
    const slice = bytes.slice(pos, end)
    if (major === 2) return { value: slice, next: end }
    try {
      return { value: UTF8_STRICT.decode(slice), next: end }
    } catch {
      return null
    }
  }
  if (major === 4) {
    if (arg > remaining) return null
    const items: unknown[] = []
    for (let i = 0n; i < arg; i++) {
      const item = readDagCbor(bytes, pos, depth + 1)
      if (!item) return null
      items.push(item.value)
      pos = item.next
    }
    return { value: items, next: pos }
  }
  if (major === 5) {
    if (arg * 2n > remaining) return null
    const map = new Map<string, unknown>()
    let lastKey: Uint8Array | null = null
    for (let i = 0n; i < arg; i++) {
      if (((bytes[pos] ?? 0) >> 5) !== 3) return null
      const key = readDagCbor(bytes, pos, depth + 1)
      if (!key || typeof key.value !== 'string') return null
      const keyBytes = new TextEncoder().encode(key.value)
      if (
        lastKey &&
        (keyBytes.length < lastKey.length ||
          (keyBytes.length === lastKey.length && compareBytes(keyBytes, lastKey) <= 0))
      ) {
        return null
      }
      lastKey = keyBytes
      const val = readDagCbor(bytes, key.next, depth + 1)
      if (!val) return null
      map.set(key.value, val.value)
      pos = val.next
    }
    return { value: map, next: pos }
  }
  return null
}

/** Strict DAG-CBOR map , or null. */
export function decodeDagCborMap(bytes: Uint8Array): Map<string, unknown> | null {
  const parsed = bytes.length ? readDagCbor(bytes, 0, 0) : null
  if (!parsed || parsed.next !== bytes.length || !(parsed.value instanceof Map)) return null
  return parsed.value
}
