/**
 * BRC-162 BSV-21 binary prefix — encode / decode.
 *
 * New tokens use this prefix, not 1sat-ft MIME and not BRC-161 JSON
 * inscriptions. Fixed-supply deploy only (empty id, amount > 0). Authority
 * outputs (amount 0) are not created here.
 *
 * Wire:
 *   <push "BSV21"> <push token id | OP_0> OP_2DROP
 *   <push amount | OP_0> <push payload | OP_0> OP_2DROP
 *   <rest of lock>
 */
import { LockingScript, OP, Script, type ScriptChunk } from '@bsv/sdk'

export const BSV21_TAG = 'BSV21'
export const BSV21_TAG_HEX = '4253563231'
export const BSV21_MAX_AMOUNT = (1n << 64n) - 1n

const TAG_BYTES = [0x42, 0x53, 0x56, 0x32, 0x31]
const TOKEN_ID_RE = /^[0-9a-f]{64}_(\d+)$/i

export type Bsv21BinaryRole = 'deploy' | 'value' | 'authority'

export type Bsv21BinaryPayload = {
  /** Ticker / name. Not unique — key tokens by deploy outpoint. */
  sym?: string
  /**
   * Outpoint pointer only — 4-byte same-tx vout or 36-byte wire id.
   * Not an ord envelope and not a 1sat / image/* sibling on the deploy.
   */
  icon?: Uint8Array
  /** Display decimals 0–18. */
  dec?: number
}

export type Bsv21Binary = {
  role: Bsv21BinaryRole
  /**
   * Display `txid_vout` (display txid byte order). Empty on deploy until the
   * output's own outpoint is known.
   */
  tokenId?: string
  /** 36-byte wire id when present (internal txid + uint32 LE vout). */
  tokenIdWire?: Uint8Array
  amount: bigint
  payload?: Bsv21BinaryPayload
  /** Remainder locking script after the six-chunk prefix, lowercase hex. */
  restScriptHex: string
}

export type EncodeBsv21BinaryArgs = {
  /** Display `txid_vout`. Omit / empty = deploy (OP_0 id). */
  tokenId?: string | null
  amount: bigint | number | string
  /** Deploy display fields only. Later outputs force payload OP_0. */
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

/** Display `txid_vout` → 36-byte wire (internal txid order + uint32 LE vout). */
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

/** 36-byte wire → display `txid_vout` (reverses the 32 txid bytes only). */
export function tokenIdFromWire(bytes: ArrayLike<number>): string | null {
  if (bytes.length !== 36) return null
  const internal: number[] = []
  for (let i = 0; i < 32; i++) internal.push(bytes[i]!)
  const txid = bytesToHex(internal.reverse())
  const vout =
    bytes[32]! + (bytes[33]! << 8) + (bytes[34]! << 16) + (bytes[35]! << 24)
  return `${txid}_${vout >>> 0}`
}

/** 36-byte wire id, or 4-byte LE vout on the deploy txid from tokenId. */
export function iconOutpointFromPayload(
  icon: Uint8Array | undefined | null,
  tokenId: string,
): string | null {
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

function compareBytes(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

/** Deterministic CBOR map (RFC 8949 §4.2) for deploy display keys. */
export function encodeDeployCbor(payload: Bsv21BinaryPayload): number[] {
  const entries: [number[], number[]][] = []
  if (payload.sym != null && payload.sym !== '') {
    entries.push([cborText('sym'), cborText(payload.sym)])
  }
  if (payload.dec != null) {
    if (!Number.isInteger(payload.dec) || payload.dec < 0 || payload.dec > 18) {
      throw new Error('BSV-21 dec must be an integer 0–18')
    }
    entries.push([cborText('dec'), cborUnsigned(payload.dec)])
  }
  if (payload.icon != null) {
    if (payload.icon.length !== 4 && payload.icon.length !== 36) {
      throw new Error('BSV-21 icon must be 4 or 36 bytes')
    }
    entries.push([cborText('icon'), cborBytes(payload.icon)])
  }
  if (entries.length === 0) return []
  entries.sort((a, b) => compareBytes(a[0], b[0]))
  const body: number[] = []
  for (const [k, v] of entries) body.push(...k, ...v)
  return cborUintHeader(5, entries.length).concat(body)
}

type CborRead = { value: unknown; next: number }

function readCborLen(bytes: Uint8Array, at: number, addl: number): { len: number; next: number } | null {
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
  return null
}

function readCbor(bytes: Uint8Array, at: number): CborRead | null {
  if (at >= bytes.length) return null
  const ib = bytes[at]!
  const major = ib >> 5
  const addl = ib & 0x1f
  const len = readCborLen(bytes, at + 1, addl)
  if (!len) return null
  if (major === 0) return { value: len.len, next: len.next }
  if (major === 2) {
    const end = len.next + len.len
    if (end > bytes.length) return null
    return { value: bytes.slice(len.next, end), next: end }
  }
  if (major === 3) {
    const end = len.next + len.len
    if (end > bytes.length) return null
    return {
      value: new TextDecoder().decode(bytes.slice(len.next, end)),
      next: end,
    }
  }
  if (major === 5) {
    const map = new Map<string, unknown>()
    let pos = len.next
    for (let i = 0; i < len.len; i++) {
      const key = readCbor(bytes, pos)
      if (!key || typeof key.value !== 'string') return null
      const val = readCbor(bytes, key.next)
      if (!val) return null
      map.set(key.value, val.value)
      pos = val.next
    }
    return { value: map, next: pos }
  }
  return null
}

/** Parse a CBOR map. Non-map / invalid CBOR → null (not a BSV-21 payload). */
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

function isTagChunk(chunk: ScriptChunk): boolean {
  const data = chunkData(chunk)
  if (data.length !== TAG_BYTES.length) return false
  return TAG_BYTES.every((b, i) => data[i] === b)
}

/**
 * Encode a BRC-162 prefix + remainder lock. Amount must be > 0 (no authority).
 */
export function encodeBsv21Binary(args: EncodeBsv21BinaryArgs): LockingScript {
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

  const script = new LockingScript()
  script.writeBin(TAG_BYTES)
  if (isDeploy) script.writeOpCode(OP.OP_0)
  else script.writeBin([...tokenIdToWire(idRaw)])
  script.writeOpCode(OP.OP_2DROP)
  writeAmount(script, amount)
  if (isDeploy && args.payload) {
    const cbor = encodeDeployCbor(args.payload)
    if (cbor.length) script.writeBin(cbor)
    else script.writeOpCode(OP.OP_0)
  } else {
    script.writeOpCode(OP.OP_0)
  }
  script.writeOpCode(OP.OP_2DROP)
  const rest = asScript(args.rest)
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

/**
 * Decode a BRC-162 prefix. Returns null when the script is not BSV-21 binary.
 * Leaves the remainder lock in `restScriptHex`.
 */
export function decodeBsv21Binary(script: Script | string): Bsv21Binary | null {
  const parsed = asLockingScript(script)
  if (!parsed) return null
  const chunks = parsed.chunks
  if (chunks.length < 6) return null
  const [tag, idChunk, drop1, amtChunk, payloadChunk, drop2] = chunks
  if (!tag || !isTagChunk(tag)) return null
  if (!drop1 || drop1.op !== OP.OP_2DROP) return null
  if (!drop2 || drop2.op !== OP.OP_2DROP) return null
  if (!idChunk || !amtChunk || !payloadChunk) return null

  let tokenId: string | undefined
  let tokenIdWire: Uint8Array | undefined
  if (isOp0(idChunk)) {
    tokenId = undefined
  } else {
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
  if (isOp0(payloadChunk)) {
    payload = undefined
  } else {
    const data = chunkData(payloadChunk)
    if (data.length === 0) return null
    const decoded = decodeDeployCbor(Uint8Array.from(data))
    if (!decoded) return null
    payload = decoded
  }

  const rest = new LockingScript(chunks.slice(6))
  const restScriptHex = rest.toHex().toLowerCase()

  const role: Bsv21BinaryRole =
    tokenId == null
      ? amount === 0n
        ? 'authority'
        : 'deploy'
      : amount === 0n
        ? 'authority'
        : 'value'

  return {
    role,
    amount,
    restScriptHex,
    ...(tokenId ? { tokenId, tokenIdWire } : {}),
    ...(payload && (payload.sym || payload.icon || payload.dec != null)
      ? { payload }
      : {}),
  }
}

export function isBsv21BinaryScript(script: Script | string): boolean {
  return decodeBsv21Binary(script) != null
}
