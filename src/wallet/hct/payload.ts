import { Utils } from '@bsv/sdk'
import { encodeDagCbor, type CborValue } from '../countersign/payload'
import { decodeDagCborMap } from '../token/decode162'
import { HCT_MAX_AMOUNT, type HctMode } from './script'

/** Shortest silence period a countersigned deploy may declare: 7 days. */
export const HCT_MIN_SILENCE_SECONDS = 604_800
export const HCT_MAX_ICON_BYTES = 96 * 1024
export const HCT_MAX_CONTENT_BYTES = 1024 * 1024

export type HctKind = 'token' | 'item'

/** A decoded BRC-255 §2 payload. Keys are identity keys and outpoints as lowercase hex. */
export type HctDeployFields = {
  mode: HctMode
  kind: HctKind
  /** Issuer identity keys, one per cosigner. */
  iss: string[]
  m: number
  /** Countersigned: the beacon's first outpoint, `txid_vout`. */
  bcn?: string
  /** Countersigned: `HASH160(release secret)`. */
  rel?: string
  relk?: string[]
  k?: number
  /** Countersigned: seconds between mined beacons before the asset has lapsed. */
  sil?: number
  auth?: boolean
  /** A minted token: the most units that may ever exist, the deploy's supply included. */
  max?: bigint
  /** A minted collection: the most member items it may ever deploy. */
  size?: bigint
  sym?: string
  name?: string
  dec?: number
  icon?: { mediaType: string; bytes: Uint8Array }
  ctype?: string
  c?: Uint8Array
  /** An item's collection asset id. */
  col?: string
  hdl?: string
}

const KNOWN = new Set([
  'v', 'mode', 'kind', 'iss', 'm', 'bcn', 'rel', 'relk', 'k', 'sil', 'auth', 'max', 'size',
  'sym', 'name', 'dec', 'icon', 'ctype', 'c', 'col', 'hdl', 'crit',
])
const KEY_RE = /^0[23][0-9a-f]{64}$/
const URL_RE = /[a-z][a-z0-9+.-]*:\/\//i
const MAX_TEXT = 256

/**
 * How many units can ever exist (§5). `fixed`: the deploy's supply, never
 * more. `open`: the authority mints without limit. `capped`: the authority
 * mints up to `max` units and/or `size` collection members, and every
 * authority output carries what has been issued so far.
 */
export type HctSupplyPolicy =
  | { kind: 'fixed' }
  | { kind: 'open' }
  | { kind: 'capped'; max?: bigint; size?: bigint }

export function hctSupplyPolicy(fields: Pick<HctDeployFields, 'auth' | 'max' | 'size'>): HctSupplyPolicy {
  if (!fields.auth) return { kind: 'fixed' }
  if (fields.max == null && fields.size == null) return { kind: 'open' }
  return {
    kind: 'capped',
    ...(fields.max != null ? { max: fields.max } : {}),
    ...(fields.size != null ? { size: fields.size } : {}),
  }
}

function outpointBytes(outpoint: string): number[] {
  const [txid, vout] = outpoint.split('_')
  const n = Number(vout)
  if (!/^[0-9a-f]{64}$/.test(txid ?? '') || !Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error('bcn is a txid_vout outpoint')
  }
  return [...Utils.toArray(txid!, 'hex').reverse(), n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

function outpointOf(bytes: Uint8Array): string {
  const txid = Utils.toHex([...bytes.slice(0, 32)].reverse())
  const vout = bytes[32]! | (bytes[33]! << 8) | (bytes[34]! << 16) | (bytes[35]! << 24)
  return `${txid}_${vout >>> 0}`
}

function checkText(name: string, value: string | undefined): void {
  if (value == null) return
  if (!value.trim() || value.length > MAX_TEXT) throw new Error(`${name} is 1 to ${MAX_TEXT} characters`)
  if (URL_RE.test(value)) throw new Error(`${name} may not contain a URL`)
}

/** Check fields a deploy may carry together; throws with the first problem. */
export function assertHctFields(fields: HctDeployFields): void {
  if (fields.mode !== 'open' && fields.mode !== 'countersign') throw new Error('mode is "open" or "countersign"')
  if (fields.kind !== 'token' && fields.kind !== 'item') throw new Error('kind is "token" or "item"')
  const n = fields.iss.length
  if (n < 1 || n > 5 || !fields.iss.every((k) => KEY_RE.test(k)) || new Set(fields.iss).size !== n) {
    throw new Error('iss names 1 to 5 distinct identity keys')
  }
  if (!Number.isInteger(fields.m) || fields.m < 1 || fields.m > n || (n > 1 && 2 * fields.m <= n)) {
    throw new Error('m is a majority of iss (2m > n)')
  }
  if (fields.mode === 'open') {
    if (fields.bcn != null || fields.rel != null || fields.relk != null || fields.k != null || fields.sil != null) {
      throw new Error('An open asset has no beacon, release or silence period')
    }
  } else {
    if (!fields.bcn) throw new Error('A countersigned asset names its beacon (bcn)')
    outpointBytes(fields.bcn)
    if (fields.sil == null || !Number.isSafeInteger(fields.sil) || fields.sil < HCT_MIN_SILENCE_SECONDS) {
      throw new Error(`sil is at least ${HCT_MIN_SILENCE_SECONDS} seconds`)
    }
    const hash = fields.rel != null
    const keys = fields.relk != null || fields.k != null
    if (hash === keys) throw new Error('A countersigned asset has exactly one release: rel, or relk with k')
    if (hash && !/^[0-9a-f]{40}$/.test(fields.rel!)) throw new Error('rel is 20 bytes')
    if (keys) {
      const relk = fields.relk ?? []
      const j = relk.length
      if (j < 1 || j > 5 || !relk.every((r) => KEY_RE.test(r)) || new Set(relk).size !== j) {
        throw new Error('relk names 1 to 5 distinct keys')
      }
      if (!Number.isInteger(fields.k) || fields.k! < 1 || fields.k! > j) throw new Error('k is 1 to the number of release keys')
    }
  }
  if (fields.kind === 'item') {
    if (fields.dec != null) throw new Error('An item has no decimals')
    if (fields.auth) throw new Error('An item is never a mint authority')
  } else if (fields.c != null || fields.ctype != null || fields.col != null) {
    throw new Error('Only an item carries content or a collection')
  }
  for (const [name, cap] of [['max', fields.max], ['size', fields.size]] as const) {
    if (cap == null) continue
    if (!fields.auth) throw new Error(`${name} caps minting, so it needs a mint authority (auth)`)
    if (typeof cap !== 'bigint' || cap < 1n || cap > HCT_MAX_AMOUNT) throw new Error(`${name} is 1 to 2^64-1`)
  }
  if (fields.dec != null && (!Number.isInteger(fields.dec) || fields.dec < 0 || fields.dec > 18)) {
    throw new Error('dec is 0 to 18')
  }
  for (const [name, value] of [['sym', fields.sym], ['name', fields.name], ['ctype', fields.ctype], ['hdl', fields.hdl]] as const) {
    checkText(name, value)
  }
  if (fields.icon) {
    checkText('icon media type', fields.icon.mediaType)
    if (fields.icon.bytes.length === 0 || fields.icon.bytes.length > HCT_MAX_ICON_BYTES) throw new Error('icon is 1 byte to 96 KiB')
  }
  if (fields.c != null && (fields.c.length === 0 || fields.c.length > HCT_MAX_CONTENT_BYTES)) {
    throw new Error('content is 1 byte to 1 MiB')
  }
  if (fields.c != null && !fields.ctype) throw new Error('content needs its media type (ctype)')
  if (fields.col != null && !/^[0-9a-f]{40}$/.test(fields.col)) throw new Error('col is a 20-byte asset id')
}

export function encodeHctPayload(fields: HctDeployFields): number[] {
  assertHctFields(fields)
  const bytes = (hex: string) => Uint8Array.from(Utils.toArray(hex, 'hex'))
  const map = new Map<string, CborValue>([
    ['v', 1],
    ['mode', fields.mode],
    ['iss', fields.iss.length === 1 ? bytes(fields.iss[0]!) : fields.iss.map(bytes)],
  ])
  if (fields.kind !== 'token') map.set('kind', fields.kind)
  if (fields.m !== 1) map.set('m', fields.m)
  if (fields.bcn) map.set('bcn', Uint8Array.from(outpointBytes(fields.bcn)))
  if (fields.rel) map.set('rel', bytes(fields.rel))
  if (fields.relk) map.set('relk', fields.relk.map(bytes))
  if (fields.k != null) map.set('k', fields.k)
  if (fields.sil != null) map.set('sil', fields.sil)
  if (fields.auth) map.set('auth', true)
  if (fields.max != null) map.set('max', fields.max)
  if (fields.size != null) map.set('size', fields.size)
  if (fields.sym) map.set('sym', fields.sym)
  if (fields.name) map.set('name', fields.name)
  if (fields.dec != null) map.set('dec', fields.dec)
  if (fields.icon) map.set('icon', [fields.icon.mediaType, fields.icon.bytes])
  if (fields.ctype) map.set('ctype', fields.ctype)
  if (fields.c) map.set('c', fields.c)
  if (fields.col) map.set('col', bytes(fields.col))
  if (fields.hdl) map.set('hdl', fields.hdl)
  return encodeDagCbor(map)
}

function keyHex(value: unknown): string | null {
  return value instanceof Uint8Array && value.length === 33 ? Utils.toHex([...value]) : null
}

/** A BRC-255 payload, or null: wrong shape, an unknown critical key, a URL, or fields that cannot go together. */
export function decodeHctPayload(bytes: Uint8Array): HctDeployFields | null {
  const map = decodeDagCborMap(bytes)
  if (!map || map.get('v') !== 1) return null
  const crit = map.get('crit')
  if (crit != null) {
    if (!Array.isArray(crit) || !crit.every((c) => typeof c === 'string' && KNOWN.has(c))) return null
  }
  const mode = map.get('mode')
  if (mode !== 'open' && mode !== 'countersign') return null
  const kindRaw = map.get('kind')
  if (kindRaw != null && kindRaw !== 'token' && kindRaw !== 'item') return null
  const issRaw = map.get('iss')
  const iss = (Array.isArray(issRaw) ? issRaw : [issRaw]).map(keyHex)
  if (iss.some((k) => k == null) || (Array.isArray(issRaw) && issRaw.length < 2)) return null
  const text = (key: string): string | undefined => {
    const value = map.get(key)
    return typeof value === 'string' ? value : undefined
  }
  const uint = (key: string): number | undefined => {
    const value = map.get(key)
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  const count = (key: string): bigint | undefined => {
    const value = map.get(key)
    if (typeof value === 'bigint') return value >= 0n ? value : undefined
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
  }
  for (const key of ['m', 'k', 'sil', 'dec']) {
    if (map.has(key) && uint(key) == null) return null
  }
  for (const key of ['max', 'size']) {
    if (map.has(key) && count(key) == null) return null
  }
  for (const key of ['sym', 'name', 'ctype', 'hdl']) {
    if (map.has(key) && text(key) == null) return null
  }
  const bcnRaw = map.get('bcn')
  if (bcnRaw != null && !(bcnRaw instanceof Uint8Array && bcnRaw.length === 36)) return null
  const relRaw = map.get('rel')
  if (relRaw != null && !(relRaw instanceof Uint8Array && relRaw.length === 20)) return null
  const relkRaw = map.get('relk')
  const relk = relkRaw == null ? undefined : Array.isArray(relkRaw) ? relkRaw.map(keyHex) : null
  if (relk === null || relk?.some((k) => k == null)) return null
  const auth = map.get('auth')
  if (auth != null && typeof auth !== 'boolean') return null
  const iconRaw = map.get('icon')
  let icon: HctDeployFields['icon']
  if (iconRaw != null) {
    if (!Array.isArray(iconRaw) || iconRaw.length !== 2 || typeof iconRaw[0] !== 'string' || !(iconRaw[1] instanceof Uint8Array)) return null
    icon = { mediaType: iconRaw[0], bytes: iconRaw[1] }
  }
  const c = map.get('c')
  if (c != null && !(c instanceof Uint8Array)) return null
  const colRaw = map.get('col')
  if (colRaw != null && !(colRaw instanceof Uint8Array && colRaw.length === 20)) return null
  const fields: HctDeployFields = {
    mode,
    kind: kindRaw === 'item' ? 'item' : 'token',
    iss: iss as string[],
    m: uint('m') ?? 1,
    ...(bcnRaw instanceof Uint8Array ? { bcn: outpointOf(bcnRaw) } : {}),
    ...(relRaw instanceof Uint8Array ? { rel: Utils.toHex([...relRaw]) } : {}),
    ...(relk ? { relk: relk as string[] } : {}),
    ...(uint('k') != null ? { k: uint('k') } : {}),
    ...(uint('sil') != null ? { sil: uint('sil') } : {}),
    ...(auth === true ? { auth: true } : {}),
    ...(count('max') != null ? { max: count('max') } : {}),
    ...(count('size') != null ? { size: count('size') } : {}),
    ...(text('sym') != null ? { sym: text('sym') } : {}),
    ...(text('name') != null ? { name: text('name') } : {}),
    ...(uint('dec') != null ? { dec: uint('dec') } : {}),
    ...(icon ? { icon } : {}),
    ...(text('ctype') != null ? { ctype: text('ctype') } : {}),
    ...(c instanceof Uint8Array ? { c } : {}),
    ...(colRaw instanceof Uint8Array ? { col: Utils.toHex([...colRaw]) } : {}),
    ...(text('hdl') != null ? { hdl: text('hdl') } : {}),
  }
  try {
    assertHctFields(fields)
  } catch {
    return null
  }
  return fields
}
