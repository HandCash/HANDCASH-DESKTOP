import { decodeDagCborMap } from '../token/decode162'

/** Shortest silence period a deploy may declare: 7 days. */
export const MIN_SILENCE_SECONDS = 604_800

export type CountersignKind = 'token' | 'item'

export type CountersignDeployFields = {
  kind: CountersignKind
  /** Seconds of beacon silence before the successors may take over. */
  sil: number
  sym?: string
  dec?: number
  icon?: { mediaType: string; bytes: Uint8Array }
  name?: string
  /** Media type of an item's content (deploy output 2). */
  ctype?: string
  col?: string
  hdl?: string
  shdl?: string
}

type CborValue = string | number | Uint8Array | CborValue[] | Map<string, CborValue>

function head(major: number, n: number): number[] {
  const hi = major << 5
  if (n < 24) return [hi | n]
  if (n < 0x100) return [hi | 24, n]
  if (n < 0x10000) return [hi | 25, n >> 8, n & 0xff]
  if (n <= 0xffffffff) return [hi | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  throw new Error('CBOR value out of range')
}

function compareKeys(a: number[], b: number[]): number {
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return 0
}

/** DAG-CBOR: definite lengths, minimal heads, map keys length-first then bytewise. */
function encode(value: CborValue): number[] {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Only unsigned integers are encoded')
    return head(0, value)
  }
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

export function encodeCountersignPayload(fields: CountersignDeployFields): number[] {
  if (!Number.isSafeInteger(fields.sil) || fields.sil < MIN_SILENCE_SECONDS) {
    throw new Error(`Silence period must be at least ${MIN_SILENCE_SECONDS} seconds`)
  }
  const map = new Map<string, CborValue>([
    ['req', new Map<string, CborValue>([['countersign', 1]])],
    ['sil', fields.sil],
    ['kind', fields.kind],
  ])
  if (fields.sym) map.set('sym', fields.sym)
  if (fields.dec != null) {
    if (fields.kind === 'item') throw new Error('An item has no decimals')
    if (!Number.isInteger(fields.dec) || fields.dec < 0 || fields.dec > 18) throw new Error('dec must be 0–18')
    map.set('dec', fields.dec)
  }
  if (fields.icon) map.set('icon', [fields.icon.mediaType, fields.icon.bytes])
  if (fields.name) map.set('name', fields.name)
  if (fields.ctype) map.set('ctype', fields.ctype)
  if (fields.col) map.set('col', fields.col)
  if (fields.hdl) map.set('hdl', fields.hdl)
  if (fields.shdl) map.set('shdl', fields.shdl)
  return encode(map)
}

function text(map: Map<string, unknown>, key: string): string | undefined {
  const value = map.get(key)
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * A countersigned deploy payload, or null. `req` must be exactly
 * `{"countersign": 1}` and `sil` at least seven days; a URL anywhere is refused.
 */
export function decodeCountersignPayload(bytes: Uint8Array): CountersignDeployFields | null {
  const map = decodeDagCborMap(bytes)
  if (!map) return null
  const req = map.get('req')
  if (!(req instanceof Map) || req.size !== 1 || req.get('countersign') !== 1) return null
  const sil = map.get('sil')
  if (typeof sil !== 'number' || !Number.isSafeInteger(sil) || sil < MIN_SILENCE_SECONDS) return null
  const kindRaw = map.get('kind')
  if (kindRaw != null && kindRaw !== 'token' && kindRaw !== 'item') return null
  const kind: CountersignKind = kindRaw === 'item' ? 'item' : 'token'
  const strings = ['sym', 'name', 'ctype', 'col', 'hdl', 'shdl'].map((key) => text(map, key))
  if (strings.some((value) => value && /:\/\//.test(value))) return null
  const [sym, name, ctype, col, hdl, shdl] = strings
  const dec = map.get('dec')
  if (dec != null && (kind === 'item' || typeof dec !== 'number' || !Number.isInteger(dec) || dec < 0 || dec > 18)) {
    return null
  }
  const iconRaw = map.get('icon')
  const icon =
    Array.isArray(iconRaw) &&
    iconRaw.length === 2 &&
    typeof iconRaw[0] === 'string' &&
    iconRaw[0].trim() &&
    iconRaw[1] instanceof Uint8Array &&
    iconRaw[1].length > 0
      ? { mediaType: iconRaw[0].trim(), bytes: iconRaw[1] }
      : undefined
  return {
    kind,
    sil,
    ...(sym ? { sym } : {}),
    ...(typeof dec === 'number' ? { dec } : {}),
    ...(icon ? { icon } : {}),
    ...(name ? { name } : {}),
    ...(ctype ? { ctype } : {}),
    ...(col ? { col } : {}),
    ...(hdl ? { hdl } : {}),
    ...(shdl ? { shdl } : {}),
  }
}
