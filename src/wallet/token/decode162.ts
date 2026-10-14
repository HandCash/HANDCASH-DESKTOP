/**
 * BRC-162 token prefix — encode / decode.
 *
 * Current layout (BRC-162 as merged, written for every new token):
 *   <push id | OP_0> <push amount | OP_0> OP_2DROP [<push payload> OP_DROP] <rest>
 *   id is 32 bytes (deploy at output 0) or 36 bytes (txid ‖ uint32 LE vout,
 *   vout ≠ 0). The payload never affects validity; attributes are read only
 *   from a strict DAG-CBOR map. `icon` is `[mediaType, bytes]`.
 *
 * Draft-tagged layout (BRC-162 drafts before #273), read and spent only:
 *   <push "BSV21"> <push 36-byte id | OP_0> OP_2DROP
 *   <push amount | OP_0> <push payload | OP_0> OP_2DROP <rest>
 *   A token deployed this way is not a BRC-162 token; its outputs stay in this
 *   layout for life (BRC-251 §Compatibility). The current decoder reads a
 *   tagged script as invalid (a 5-byte id), so the layouts never collide.
 */
import { LockingScript, OP, Script, type ScriptChunk } from '@bsv/sdk'

export const BSV21_TAG = 'BSV21'
export const BSV21_TAG_HEX = '4253563231'
export const BSV21_MAX_AMOUNT = (1n << 64n) - 1n
/** Embedded icons ride in the deploy script; keep them ticker-sized. */
export const BSV21_MAX_ICON_BYTES = 96 * 1024

const TAG_BYTES = [0x42, 0x53, 0x56, 0x32, 0x31]
const TOKEN_ID_RE = /^[0-9a-f]{64}_(\d+)$/i

export type Bsv21BinaryLayout = 'brc162' | 'draft-tagged'

export type Bsv21BinaryRole = 'deploy' | 'value' | 'authority'

export type Bsv21IconImage = { mediaType: string; bytes: Uint8Array }

export type Bsv21BinaryPayload = {
  /** Ticker / name. Not unique — key tokens by deploy outpoint. */
  sym?: string
  /** Draft-tagged only: 4-byte same-tx vout or 36-byte outpoint pointer. */
  icon?: Uint8Array
  /** Current layout only: the image embedded in the deploy. */
  iconImage?: Bsv21IconImage
  /** Display decimals 0–18. */
  dec?: number
  /**
   * The deploy names processing a later document requires before holders may
   * spend (`req` other than an empty array or map). BRC-251: unsupported.
   */
  requiresProcessing?: true
}

export type Bsv21Binary = {
  layout: Bsv21BinaryLayout
  role: Bsv21BinaryRole
  /**
   * Display `txid_vout` (display txid byte order). Empty on deploy until the
   * output's own outpoint is known.
   */
  tokenId?: string
  /** Id bytes as written: 32 or 36 (current), 36 (draft-tagged). */
  tokenIdWire?: Uint8Array
  amount: bigint
  payload?: Bsv21BinaryPayload
  /** Remainder locking script after the prefix, lowercase hex. */
  restScriptHex: string
}

export type EncodeBsv21BinaryArgs = {
  /** Defaults to the current layout. Draft-tagged only to spend held tokens. */
  layout?: Bsv21BinaryLayout
  /** Display `txid_vout`. Omit / empty = deploy (OP_0 id). */
  tokenId?: string | null
  amount: bigint | number | string
  /** Deploy display fields only; ignored on later outputs. */
  payload?: Bsv21BinaryPayload | null
  /** Remainder lock (hex or Script). P2PKH is fine. */
  rest?: Script | string
}

export function parseDisplayOutpoint(
  raw: string,
): { txid: string; vout: number } | null {
  const n = raw.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
  const m = n.match(/^([0-9a-f]{64})_(\d+)$/)
  if (!m) return null
  const vout = Number(m[2])
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) return null
  return { txid: m[1]!, vout }
}

function hexToBytes(hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    out.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  return out
}

function bytesToHex(bytes: ArrayLike<number>): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

/** Display `txid_vout` → 36-byte outpoint (internal txid order + uint32 LE vout). */
export function tokenIdToWire(tokenId: string): Uint8Array {
  const parsed = parseDisplayOutpoint(tokenId)
  if (!parsed) throw new Error(`Invalid BSV-21 token id: ${tokenId}`)
  const internal = hexToBytes(parsed.txid).reverse()
  const wire = new Uint8Array(36)
  wire.set(internal, 0)
  wire[32] = parsed.vout & 0xff
  wire[33] = (parsed.vout >>> 8) & 0xff
  wire[34] = (parsed.vout >>> 16) & 0xff
  wire[35] = (parsed.vout >>> 24) & 0xff
  return wire
}

/** 36-byte outpoint → display `txid_vout` (reverses the 32 txid bytes only). */
export function tokenIdFromWire(bytes: ArrayLike<number>): string | null {
  if (bytes.length !== 36) return null
  const internal: number[] = []
  for (let i = 0; i < 32; i++) internal.push(bytes[i]!)
  const txid = bytesToHex(internal.reverse())
  const vout =
    bytes[32]! + (bytes[33]! << 8) + (bytes[34]! << 16) + (bytes[35]! << 24)
  return `${txid}_${vout >>> 0}`
}

/** BRC-162 canonical id: 32-byte txid when the deploy is output 0, else 36 bytes. */
export function tokenIdToCanonicalWire(tokenId: string): Uint8Array {
  const wire = tokenIdToWire(tokenId)
  return parseDisplayOutpoint(tokenId)!.vout === 0 ? wire.slice(0, 32) : wire
}

/** Canonical id bytes → display id. A 36-byte id with vout 0 is invalid. */
export function tokenIdFromCanonicalWire(bytes: ArrayLike<number>): string | null {
  if (bytes.length === 32) {
    const padded = new Uint8Array(36)
    for (let i = 0; i < 32; i++) padded[i] = bytes[i]!
    return tokenIdFromWire(padded)
  }
  const id = tokenIdFromWire(bytes)
  if (!id || id.endsWith('_0')) return null
  return id
}

/**
 * Outpoint holding a deploy's icon. An embedded image is the deploy output
 * itself; a draft pointer is a 36-byte outpoint or a 4-byte same-tx vout.
 */
export function iconOutpointFromPayload(
  payload: Bsv21BinaryPayload | undefined | null,
  tokenId: string,
): string | null {
  if (!payload) return null
  if (payload.iconImage) return parseDisplayOutpoint(tokenId) ? tokenId.trim().toLowerCase() : null
  const icon = payload.icon
  if (!icon) return null
  if (icon.length === 36) return tokenIdFromWire(icon)
  if (icon.length === 4) {
    const parsed = parseDisplayOutpoint(tokenId)
    if (!parsed) return null
    const vout =
      icon[0]! + (icon[1]! << 8) + (icon[2]! << 16) + (icon[3]! << 24)
    return `${parsed.txid}_${vout >>> 0}`
  }
  return null
}

function asAmount(raw: bigint | number | string): bigint {
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      throw new Error('BSV-21 amount must be a non-negative integer')
    }
    return BigInt(raw)
  }
  const s = raw.trim()
  if (!/^\d{1,20}$/.test(s)) {
    throw new Error('BSV-21 amount must be a decimal integer')
  }
  return BigInt(s)
}

/**
 * Minimally encoded non-negative Bitcoin script number, domain 0..2^64-1.
 * 0 → OP_0; 1..16 → OP_1..OP_16; else little-endian with a high-zero sign byte
 * when the last value byte has its high bit set.
 */
export function encodeScriptNumber(amount: bigint): { op: number; data?: number[] } {
  if (amount < 0n || amount > BSV21_MAX_AMOUNT) {
    throw new Error('BSV-21 amount out of range (0..2^64-1)')
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
  if (n > BSV21_MAX_AMOUNT) return null
  if (n === 0n) return null
  if (n <= 16n) return null
  return n
}

function cborUintHeader(major: number, n: number): number[] {
  const hi = major << 5
  if (n < 24) return [hi | n]
  if (n < 256) return [hi | 24, n]
  if (n < 65536) return [hi | 25, n >> 8, n & 0xff]
  return [
    hi | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]
}

function cborText(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)]
  return cborUintHeader(3, bytes.length).concat(bytes)
}

function cborBytes(data: Uint8Array): number[] {
  return cborUintHeader(2, data.length).concat([...data])
}

function cborUnsigned(n: number): number[] {
  return cborUintHeader(0, n)
}

function compareBytes(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

function assertDec(dec: number): void {
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) {
    throw new Error('BSV-21 dec must be an integer 0–18')
  }
}

/**
 * Deploy display map. Current layout: DAG-CBOR with `icon` as
 * `[mediaType, bytes]`. Draft-tagged: `icon` as a 4- or 36-byte pointer.
 * Keys sort length-first then bytewise; the encoded-key byte order is exactly
 * that for keys under 24 bytes.
 */
export function encodeDeployCbor(
  payload: Bsv21BinaryPayload,
  layout: Bsv21BinaryLayout = 'brc162',
): number[] {
  if (payload.requiresProcessing) {
    throw new Error('BSV-21 deploys with required processing are not issued here')
  }
  const entries: [number[], number[]][] = []
  if (payload.sym != null && payload.sym !== '') {
    entries.push([cborText('sym'), cborText(payload.sym)])
  }
  if (payload.dec != null) {
    assertDec(payload.dec)
    entries.push([cborText('dec'), cborUnsigned(payload.dec)])
  }
  if (layout === 'brc162') {
    if (payload.icon != null) {
      throw new Error('BRC-162 icons are embedded [mediaType, bytes], not pointers')
    }
    if (payload.iconImage != null) {
      const { mediaType, bytes } = payload.iconImage
      if (!mediaType.trim() || bytes.length === 0) {
        throw new Error('BRC-162 icon needs a media type and image bytes')
      }
      if (bytes.length > BSV21_MAX_ICON_BYTES) {
        throw new Error(`BRC-162 icon over ${BSV21_MAX_ICON_BYTES} bytes`)
      }
      entries.push([
        cborText('icon'),
        cborUintHeader(4, 2).concat(cborText(mediaType.trim()), cborBytes(bytes)),
      ])
    }
  } else {
    if (payload.iconImage != null) {
      throw new Error('Draft-tagged deploys carry an icon pointer, not an image')
    }
    if (payload.icon != null) {
      if (payload.icon.length !== 4 && payload.icon.length !== 36) {
        throw new Error('BSV-21 icon must be 4 or 36 bytes')
      }
      entries.push([cborText('icon'), cborBytes(payload.icon)])
    }
  }
  if (entries.length === 0) return []
  entries.sort((a, b) => compareBytes(a[0], b[0]))
  const body: number[] = []
  for (const [k, v] of entries) body.push(...k, ...v)
  return cborUintHeader(5, entries.length).concat(body)
}

type CborRead = { value: unknown; next: number }

/** Opaque stand-in for a well-formed CBOR item this reader does not model. */
const CBOR_IGNORED: unique symbol = Symbol('cbor-ignored')
const CBOR_BREAK: unique symbol = Symbol('cbor-break')

/**
 * Argument of a CBOR head. `null` when the buffer ends inside it. Indefinite
 * length (addl 31) returns `len: -1`.
 */
function readCborLen(
  bytes: Uint8Array,
  at: number,
  addl: number,
): { len: number; next: number } | null {
  if (addl < 24) return { len: addl, next: at }
  if (addl === 24) {
    const n = bytes[at]
    return n == null ? null : { len: n, next: at + 1 }
  }
  if (addl === 25) {
    const hi = bytes[at]
    const lo = bytes[at + 1]
    if (hi == null || lo == null) return null
    return { len: (hi << 8) | lo, next: at + 2 }
  }
  if (addl === 26) {
    const b0 = bytes[at]
    const b1 = bytes[at + 1]
    const b2 = bytes[at + 2]
    const b3 = bytes[at + 3]
    if (b0 == null || b1 == null || b2 == null || b3 == null) return null
    return { len: ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0, next: at + 4 }
  }
  if (addl === 27) {
    if (at + 8 > bytes.length) return null
    let n = 0n
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bytes[at + i]!)
    // Lengths and small ints fit; anything larger is well-formed but ignored.
    return { len: n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : -2, next: at + 8 }
  }
  if (addl === 31) return { len: -1, next: at }
  return null
}

/**
 * Draft-tagged payload reader: lenient CBOR, as the draft wallets wrote it.
 * Every well-formed item is consumed; unmodelled shapes read as ignored.
 */
function readCbor(bytes: Uint8Array, at: number, depth = 0): CborRead | null {
  if (at >= bytes.length || depth > 32) return null
  const ib = bytes[at]!
  const major = ib >> 5
  const addl = ib & 0x1f
  if (major === 7 && addl === 31) return { value: CBOR_BREAK, next: at + 1 }
  const len = readCborLen(bytes, at + 1, addl)
  if (!len) return null
  const indefinite = len.len === -1
  if (indefinite && (major === 0 || major === 1 || major === 6)) return null

  if (major === 0) return { value: len.len, next: len.next }
  if (major === 1) return { value: CBOR_IGNORED, next: len.next }
  if (major === 6) return readCbor(bytes, len.next, depth + 1)
  if (major === 7) {
    const width = addl < 24 ? 0 : addl === 24 ? 1 : addl === 25 ? 2 : addl === 26 ? 4 : 8
    const next = at + 1 + width
    return next > bytes.length ? null : { value: CBOR_IGNORED, next }
  }
  if (major === 2 || major === 3) {
    if (indefinite) {
      let pos = len.next
      const chunks: Uint8Array[] = []
      let text = ''
      let clean = true
      for (;;) {
        const chunk = readCbor(bytes, pos, depth + 1)
        if (!chunk) return null
        pos = chunk.next
        if (chunk.value === CBOR_BREAK) break
        if (major === 2 && chunk.value instanceof Uint8Array) chunks.push(chunk.value)
        else if (major === 3 && typeof chunk.value === 'string') text += chunk.value
        else clean = false
      }
      if (!clean) return { value: CBOR_IGNORED, next: pos }
      if (major === 3) return { value: text, next: pos }
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let off = 0
      for (const c of chunks) {
        joined.set(c, off)
        off += c.length
      }
      return { value: joined, next: pos }
    }
    if (len.len < 0) return null
    const end = len.next + len.len
    if (end > bytes.length) return null
    if (major === 2) return { value: bytes.slice(len.next, end), next: end }
    return { value: new TextDecoder().decode(bytes.slice(len.next, end)), next: end }
  }
  if (major === 4 || major === 5) {
    if (len.len < -1) return null
    const map = major === 5 ? new Map<string, unknown>() : null
    let pos = len.next
    const perEntry = major === 5 ? 2 : 1
    for (let i = 0; indefinite || i < len.len; i++) {
      const first = readCbor(bytes, pos, depth + 1)
      if (!first) return null
      if (first.value === CBOR_BREAK) {
        if (!indefinite) return null
        pos = first.next
        break
      }
      if (perEntry === 1) {
        pos = first.next
        continue
      }
      const val = readCbor(bytes, first.next, depth + 1)
      if (!val || val.value === CBOR_BREAK) return null
      if (typeof first.value === 'string') map!.set(first.value, val.value)
      pos = val.next
    }
    return { value: map ?? CBOR_IGNORED, next: pos }
  }
  return null
}

/** Draft-tagged payload: lenient CBOR map. Non-map / invalid CBOR → null. */
export function decodeDeployCbor(bytes: Uint8Array): Bsv21BinaryPayload | null {
  if (bytes.length === 0) return {}
  const parsed = readCbor(bytes, 0)
  if (!parsed || parsed.next !== bytes.length) return null
  if (!(parsed.value instanceof Map)) return null
  const out: Bsv21BinaryPayload = {}
  const sym = parsed.value.get('sym')
  if (typeof sym === 'string' && sym) out.sym = sym
  const dec = parsed.value.get('dec')
  if (typeof dec === 'number' && Number.isInteger(dec) && dec >= 0 && dec <= 18) {
    out.dec = dec
  }
  const icon = parsed.value.get('icon')
  if (icon instanceof Uint8Array && (icon.length === 4 || icon.length === 36)) {
    out.icon = icon
  }
  return out
}

/** A tag-42 link: DAG-CBOR allows it, BRC-162 defines no attribute that uses one. */
const DAG_LINK: unique symbol = Symbol('dag-link')
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })
/** Smallest argument each head width (addl 24–27) may carry. */
const MINIMAL_HEAD_FLOOR = [24n, 1n << 8n, 1n << 16n, 1n << 32n]

/**
 * Strict DAG-CBOR reader (BRC-162 §Payload): definite lengths, minimal heads,
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

/**
 * Current-layout attributes. A payload that is not a valid DAG-CBOR map
 * carries none; it never invalidates the output.
 */
export function decodeBrc162Payload(bytes: Uint8Array): Bsv21BinaryPayload {
  const parsed = bytes.length ? readDagCbor(bytes, 0, 0) : null
  if (!parsed || parsed.next !== bytes.length || !(parsed.value instanceof Map)) return {}
  const map = parsed.value
  const out: Bsv21BinaryPayload = {}
  const sym = map.get('sym')
  if (typeof sym === 'string' && sym) out.sym = sym
  const dec = map.get('dec')
  if (typeof dec === 'number' && Number.isInteger(dec) && dec >= 0 && dec <= 18) {
    out.dec = dec
  }
  const icon = map.get('icon')
  if (
    Array.isArray(icon) &&
    icon.length === 2 &&
    typeof icon[0] === 'string' &&
    icon[0].trim() &&
    icon[1] instanceof Uint8Array &&
    icon[1].length > 0
  ) {
    out.iconImage = { mediaType: icon[0].trim(), bytes: icon[1] }
  }
  if (map.has('req')) {
    const req = map.get('req')
    const empty =
      (Array.isArray(req) && req.length === 0) || (req instanceof Map && req.size === 0)
    if (!empty) out.requiresProcessing = true
  }
  return out
}

function writeAmount(script: LockingScript, amount: bigint): void {
  const encoded = encodeScriptNumber(amount)
  if (encoded.data) script.writeBin(encoded.data)
  else script.writeOpCode(encoded.op)
}

function asScript(rest: Script | string | undefined): Script | null {
  if (rest == null) return null
  if (typeof rest === 'string') {
    const hex = rest.trim()
    if (!hex) return null
    return LockingScript.fromHex(hex)
  }
  return rest
}

function chunkData(chunk: ScriptChunk): number[] {
  return chunk.data ?? []
}

function isOp0(chunk: ScriptChunk): boolean {
  return chunk.op === OP.OP_0 && chunkData(chunk).length === 0
}

/** BRC-162: OP_0, OP_1NEGATE, OP_1–OP_16, or a data push. */
function isPushOp(chunk: ScriptChunk | undefined): boolean {
  if (!chunk) return false
  return chunk.op <= OP.OP_PUSHDATA4 || chunk.op === OP.OP_1NEGATE ||
    (chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16)
}

function isTagChunk(chunk: ScriptChunk): boolean {
  const data = chunkData(chunk)
  if (data.length !== TAG_BYTES.length) return false
  return TAG_BYTES.every((b, i) => data[i] === b)
}

function hasPayloadFields(payload: Bsv21BinaryPayload | undefined): payload is Bsv21BinaryPayload {
  return !!payload && !!(payload.sym || payload.icon || payload.iconImage || payload.dec != null || payload.requiresProcessing)
}

/**
 * Encode a token prefix + remainder lock. Amount must be > 0 (no authority).
 * A current-layout deploy must be output 0 of its transaction — the caller
 * places it.
 */
export function encodeBsv21Binary(args: EncodeBsv21BinaryArgs): LockingScript {
  const layout = args.layout ?? 'brc162'
  const amount = asAmount(args.amount)
  if (amount <= 0n) {
    throw new Error('BSV-21 encode refuses amount 0 (authority)')
  }
  if (amount > BSV21_MAX_AMOUNT) {
    throw new Error('BSV-21 amount out of range (0..2^64-1)')
  }

  const idRaw = (args.tokenId ?? '').trim()
  const isDeploy = idRaw === ''
  if (!isDeploy && !TOKEN_ID_RE.test(idRaw.replace(/\.(\d+)$/, '_$1'))) {
    throw new Error(`Invalid BSV-21 token id: ${args.tokenId}`)
  }
  const cbor = isDeploy && args.payload ? encodeDeployCbor(args.payload, layout) : []
  const rest = asScript(args.rest)

  const script = new LockingScript()
  if (layout === 'draft-tagged') {
    script.writeBin(TAG_BYTES)
    if (isDeploy) script.writeOpCode(OP.OP_0)
    else script.writeBin([...tokenIdToWire(idRaw)])
    script.writeOpCode(OP.OP_2DROP)
    writeAmount(script, amount)
    if (cbor.length) script.writeBin(cbor)
    else script.writeOpCode(OP.OP_0)
    script.writeOpCode(OP.OP_2DROP)
  } else {
    if (isDeploy) script.writeOpCode(OP.OP_0)
    else script.writeBin([...tokenIdToCanonicalWire(idRaw)])
    writeAmount(script, amount)
    script.writeOpCode(OP.OP_2DROP)
    if (cbor.length) {
      script.writeBin(cbor)
      script.writeOpCode(OP.OP_DROP)
    } else if (rest && isPushOp(rest.chunks[0]) && rest.chunks[1]?.op === OP.OP_DROP) {
      // The remainder's own `<push> OP_DROP` must not read as the payload.
      script.writeOpCode(OP.OP_0)
      script.writeOpCode(OP.OP_DROP)
    }
  }
  if (rest) script.writeScript(rest)
  return script
}

function asLockingScript(script: Script | string): Script | null {
  try {
    if (typeof script === 'string') {
      const hex = script.trim()
      if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
      return LockingScript.fromHex(hex)
    }
    return script
  } catch {
    return null
  }
}

function roleOf(tokenId: string | undefined, amount: bigint): Bsv21BinaryRole {
  if (amount === 0n) return 'authority'
  return tokenId == null ? 'deploy' : 'value'
}

function decodeDraftTagged(chunks: ScriptChunk[]): Bsv21Binary | null {
  if (chunks.length < 6) return null
  const [tag, idChunk, drop1, amtChunk, payloadChunk, drop2] = chunks
  if (!tag || !isTagChunk(tag)) return null
  if (!drop1 || drop1.op !== OP.OP_2DROP) return null
  if (!drop2 || drop2.op !== OP.OP_2DROP) return null
  if (!idChunk || !amtChunk || !payloadChunk) return null

  let tokenId: string | undefined
  let tokenIdWire: Uint8Array | undefined
  if (!isOp0(idChunk)) {
    const data = chunkData(idChunk)
    if (data.length !== 36) return null
    const id = tokenIdFromWire(data)
    if (!id) return null
    tokenId = id
    tokenIdWire = Uint8Array.from(data)
  }

  const amount = decodeScriptNumber(amtChunk)
  if (amount == null) return null

  let payload: Bsv21BinaryPayload | undefined
  if (!isOp0(payloadChunk)) {
    const data = chunkData(payloadChunk)
    if (data.length === 0) return null
    const decoded = decodeDeployCbor(Uint8Array.from(data))
    if (!decoded) return null
    payload = decoded
  }

  return {
    layout: 'draft-tagged',
    role: roleOf(tokenId, amount),
    amount,
    restScriptHex: new LockingScript(chunks.slice(6)).toHex().toLowerCase(),
    ...(tokenId ? { tokenId, tokenIdWire } : {}),
    ...(hasPayloadFields(payload) ? { payload } : {}),
  }
}

function decodeCurrent(chunks: ScriptChunk[]): Bsv21Binary | null {
  const [idChunk, amtChunk, drop] = chunks
  if (!idChunk || !amtChunk || drop?.op !== OP.OP_2DROP) return null

  let tokenId: string | undefined
  let tokenIdWire: Uint8Array | undefined
  if (!isOp0(idChunk)) {
    if (idChunk.op > OP.OP_PUSHDATA4) return null
    const data = chunkData(idChunk)
    if (data.length !== 32 && data.length !== 36) return null
    const id = tokenIdFromCanonicalWire(data)
    if (!id) return null
    tokenId = id
    tokenIdWire = Uint8Array.from(data)
  }

  const amount = decodeScriptNumber(amtChunk)
  if (amount == null) return null

  let restAt = 3
  let payload: Bsv21BinaryPayload | undefined
  if (isPushOp(chunks[3]) && chunks[4]?.op === OP.OP_DROP) {
    restAt = 5
    payload = decodeBrc162Payload(Uint8Array.from(chunkData(chunks[3]!)))
  }

  return {
    layout: 'brc162',
    role: roleOf(tokenId, amount),
    amount,
    restScriptHex: new LockingScript(chunks.slice(restAt)).toHex().toLowerCase(),
    ...(tokenId ? { tokenId, tokenIdWire } : {}),
    ...(hasPayloadFields(payload) ? { payload } : {}),
  }
}

/**
 * Decode a token prefix in either layout. Returns null when the script is
 * neither. Leaves the remainder lock in `restScriptHex`.
 */
export function decodeBsv21Binary(script: Script | string): Bsv21Binary | null {
  const parsed = asLockingScript(script)
  if (!parsed) return null
  const chunks = parsed.chunks
  return decodeDraftTagged(chunks) ?? decodeCurrent(chunks)
}

export function isBsv21BinaryScript(script: Script | string): boolean {
  return decodeBsv21Binary(script) != null
}
