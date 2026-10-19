import { BigNumber, ECDSA, Hash, PrivateKey, Utils } from '@bsv/sdk'
import { scrypt } from '@noble/hashes/scrypt.js'

/**
 * Litecoin mainnet primitives the wallet checks received coins and signs
 * payments with: addresses, segwit transactions, BIP143 signature hashes,
 * block headers with scrypt proof of work, and merkle proofs. Every parser is
 * strict: trailing bytes, unknown address versions and MWEB transactions are
 * refused rather than guessed at.
 */

export type Bytes = Uint8Array

export class LtcFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LtcFormatError'
  }
}

const fail = (message: string): never => {
  throw new LtcFormatError(message)
}

export const toHex = (b: Bytes): string => Utils.toHex(Array.from(b))

export function fromHex(hex: string): Bytes {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) fail('not hex')
  return Uint8Array.from(Utils.toArray(clean, 'hex'))
}

export const reversed = (b: Bytes): Bytes => Uint8Array.from(b).reverse()
export const sha256d = (b: Bytes): Bytes => Uint8Array.from(Hash.hash256(Array.from(b)))
export const hash160 = (b: Bytes): Bytes => Uint8Array.from(Hash.hash160(Array.from(b)))

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function sameBytes(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Litoshi as an LTC decimal string, trailing zeros dropped. */
export function formatLtc(litoshi: bigint): string {
  const whole = litoshi / 100_000_000n
  const frac = (litoshi % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

// ── Bech32 / bech32m (BIP173, BIP350) ──────────────────────────────────────

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32 = 1
const BECH32M = 0x2bc830a3
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!
  }
  return chk >>> 0
}

const hrpExpand = (hrp: string): number[] => [
  ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
]

function convertBits(data: readonly number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const max = (1 << to) - 1
  for (const v of data) {
    if (v < 0 || v >> from) return null
    acc = (acc << from) | v
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & max)
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & max)
  } else if (bits >= from || (acc << (to - bits)) & max) {
    return null
  }
  return out
}

export function encodeSegwitAddress(hrp: string, version: number, program: Bytes): string {
  const data = [version, ...convertBits(Array.from(program), 8, 5, true)!]
  const constant = version === 0 ? BECH32 : BECH32M
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ constant
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`
}

export function decodeSegwitAddress(hrp: string, address: string): { version: number; program: Bytes } | null {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return null
  const lower = address.toLowerCase()
  const sep = lower.lastIndexOf('1')
  if (sep < 1 || sep + 7 > lower.length || lower.length > 90 || lower.slice(0, sep) !== hrp) return null
  const data: number[] = []
  for (const c of lower.slice(sep + 1)) {
    const d = CHARSET.indexOf(c)
    if (d < 0) return null
    data.push(d)
  }
  const constant = polymod([...hrpExpand(hrp), ...data])
  const version = data[0]!
  if (constant !== (version === 0 ? BECH32 : BECH32M)) return null
  if (version > 16) return null
  const program = convertBits(data.slice(1, -6), 5, 8, false)
  if (!program || program.length < 2 || program.length > 40) return null
  if (version === 0 && program.length !== 20 && program.length !== 32) return null
  return { version, program: Uint8Array.from(program) }
}

// ── Addresses ──────────────────────────────────────────────────────────────

export const LTC_HRP = 'ltc'
const P2PKH_VERSION = 0x30
const P2SH_VERSIONS = new Set([0x32, 0x05])

/** The native segwit (P2WPKH) address of a compressed public key. */
export function p2wpkhAddress(pubkey: Bytes): string {
  if (pubkey.length !== 33) fail('a P2WPKH key is a compressed public key')
  return encodeSegwitAddress(LTC_HRP, 0, hash160(pubkey))
}

export function p2wpkhScript(pubkey: Bytes): Bytes {
  return concat(Uint8Array.of(0x00, 0x14), hash160(pubkey))
}

/** The output script a Litecoin mainnet address pays; refuses testnet and unknown forms. */
export function ltcOutputScript(address: string): Bytes {
  const trimmed = address.trim()
  if (/^ltc1/i.test(trimmed)) {
    const decoded = decodeSegwitAddress(LTC_HRP, trimmed)
    if (!decoded) fail('not a valid ltc1 address')
    const { version, program } = decoded!
    return concat(Uint8Array.of(version === 0 ? 0 : 0x50 + version, program.length), program)
  }
  let parsed: { prefix: number[]; data: number[] }
  try {
    parsed = Utils.fromBase58Check(trimmed) as { prefix: number[]; data: number[] }
  } catch {
    return fail('not a valid Litecoin address')
  }
  const version = parsed.prefix[0]
  if (parsed.prefix.length !== 1 || parsed.data.length !== 20) fail('not a valid Litecoin address')
  const hash = Uint8Array.from(parsed.data)
  if (version === P2PKH_VERSION) return concat(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac))
  if (version !== undefined && P2SH_VERSIONS.has(version)) return concat(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87))
  return fail('not a Litecoin mainnet address')
}

// ── Transactions ───────────────────────────────────────────────────────────

export type LtcInput = { txid: string; vout: number; script: Bytes; sequence: number; witness: Bytes[] }
export type LtcOutput = { value: bigint; script: Bytes }
export type LtcTx = { version: number; inputs: LtcInput[]; outputs: LtcOutput[]; locktime: number }

export class Reader {
  at = 0
  constructor(readonly b: Bytes) {}
  bytes(n: number): Bytes {
    if (n < 0 || this.at + n > this.b.length) fail('truncated')
    const out = this.b.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
  u8(): number {
    return this.bytes(1)[0]!
  }
  u32(): number {
    const b = this.bytes(4)
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0
  }
  u64(): bigint {
    const lo = BigInt(this.u32())
    const hi = BigInt(this.u32())
    return (hi << 32n) | lo
  }
  varint(): number {
    const first = this.u8()
    if (first < 0xfd) return first
    if (first === 0xfd) {
      const b = this.bytes(2)
      return b[0]! | (b[1]! << 8)
    }
    if (first === 0xfe) return this.u32()
    const v = this.u64()
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail('varint too large')
    return Number(v)
  }
  varBytes(): Bytes {
    return this.bytes(this.varint())
  }
  get done(): boolean {
    return this.at === this.b.length
  }
}

export const u32le = (n: number): Bytes => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)

export function u64le(v: bigint): Bytes {
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn)
  return out
}

export function varint(n: number): Bytes {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8)
  return concat(Uint8Array.of(0xfe), u32le(n))
}

export const varBytes = (b: Bytes): Bytes => concat(varint(b.length), b)

/** Parse a raw transaction; MWEB transactions (flag bit 0x08) are refused. */
export function parseLtcTx(raw: Bytes): LtcTx {
  const r = new Reader(raw)
  const tx = readLtcTx(r)
  if (!r.done) fail('trailing bytes after the transaction')
  return tx
}

/** Read one transaction at the reader's position, leaving it just past the transaction. */
export function readLtcTx(r: Reader): LtcTx {
  const version = r.u32()
  let segwit = false
  if (r.b[r.at] === 0x00) {
    r.u8()
    const flag = r.u8()
    if (flag & 0x08) fail('MWEB transactions are not supported')
    if (flag !== 0x01) fail('unknown transaction flag')
    segwit = true
  }
  const inCount = r.varint()
  if (inCount === 0) fail('no inputs')
  const inputs: LtcInput[] = []
  for (let i = 0; i < inCount; i++) {
    const txid = toHex(reversed(r.bytes(32)))
    const vout = r.u32()
    const script = r.varBytes()
    const sequence = r.u32()
    inputs.push({ txid, vout, script, sequence, witness: [] })
  }
  const outCount = r.varint()
  if (outCount === 0) fail('no outputs')
  const outputs: LtcOutput[] = []
  for (let i = 0; i < outCount; i++) outputs.push({ value: r.u64(), script: r.varBytes() })
  if (segwit) {
    for (const input of inputs) {
      const items = r.varint()
      for (let i = 0; i < items; i++) input.witness.push(r.varBytes())
    }
  }
  const locktime = r.u32()
  return { version, inputs, outputs, locktime }
}

function serializeBase(tx: LtcTx): Bytes[] {
  return [
    varint(tx.inputs.length),
    ...tx.inputs.flatMap((i) => [reversed(fromHex(i.txid)), u32le(i.vout), varBytes(i.script), u32le(i.sequence)]),
    varint(tx.outputs.length),
    ...tx.outputs.flatMap((o) => [u64le(o.value), varBytes(o.script)]),
  ]
}

/** The serialization the txid commits to: no marker, flag or witness. */
export function serializeLtcTxNoWitness(tx: LtcTx): Bytes {
  return concat(u32le(tx.version), ...serializeBase(tx), u32le(tx.locktime))
}

export function serializeLtcTx(tx: LtcTx): Bytes {
  if (!tx.inputs.some((i) => i.witness.length)) return serializeLtcTxNoWitness(tx)
  return concat(
    u32le(tx.version),
    Uint8Array.of(0x00, 0x01),
    ...serializeBase(tx),
    ...tx.inputs.map((i) => concat(varint(i.witness.length), ...i.witness.map(varBytes))),
    u32le(tx.locktime),
  )
}

export const ltcTxid = (tx: LtcTx): string => toHex(reversed(sha256d(serializeLtcTxNoWitness(tx))))

export const isCoinbase = (tx: LtcTx): boolean =>
  tx.inputs.length === 1 && /^0{64}$/.test(tx.inputs[0]!.txid) && tx.inputs[0]!.vout === 0xffffffff

// ── BIP143 signing (P2WPKH, SIGHASH_ALL) ───────────────────────────────────

const SIGHASH_ALL = 1

/** BIP143 digest for input `vin` spending a P2WPKH output of `amount` litoshi locked to `pubkey`. */
export function p2wpkhSighash(tx: LtcTx, vin: number, pubkey: Bytes, amount: bigint): Bytes {
  return bip143Sighash(tx, vin, pubkey, amount, SIGHASH_ALL)
}

/**
 * The BIP143 digest over a pay-to-pubkey-hash script code, committing to the
 * spent `amount`. Litecoin P2WPKH signs it with `SIGHASH_ALL`; Bitcoin Cash
 * signs every input with it under `SIGHASH_ALL | SIGHASH_FORKID` (0x41).
 */
export function bip143Sighash(tx: LtcTx, vin: number, pubkey: Bytes, amount: bigint, hashType: number): Bytes {
  return bip143ScriptSighash(tx, vin, concat(Uint8Array.of(0x76, 0xa9, 0x14), hash160(pubkey), Uint8Array.of(0x88, 0xac)), amount, hashType)
}

/**
 * The BIP143 digest over any `script` as the script code: a P2WSH witness
 * script (`SIGHASH_ALL`), or a Bitcoin Cash or BSV locking script
 * (`SIGHASH_ALL | SIGHASH_FORKID`), committing to the spent `amount`.
 */
export function bip143ScriptSighash(tx: LtcTx, vin: number, script: Bytes, amount: bigint, hashType: number): Bytes {
  const input = tx.inputs[vin]
  if (!input) fail('no such input')
  const hashPrevouts = sha256d(concat(...tx.inputs.map((i) => concat(reversed(fromHex(i.txid)), u32le(i.vout)))))
  const hashSequence = sha256d(concat(...tx.inputs.map((i) => u32le(i.sequence))))
  const hashOutputs = sha256d(concat(...tx.outputs.map((o) => concat(u64le(o.value), varBytes(o.script)))))
  const scriptCode = varBytes(script)
  return sha256d(
    concat(
      u32le(tx.version),
      hashPrevouts,
      hashSequence,
      reversed(fromHex(input!.txid)),
      u32le(input!.vout),
      scriptCode,
      u64le(amount),
      u32le(input!.sequence),
      hashOutputs,
      u32le(tx.locktime),
      u32le(hashType),
    ),
  )
}

/** Sign every input as a P2WPKH spend by `key`; `amounts[vin]` is what each spent output holds. */
/** `keys`: the key each input's coin pays, one per input. */
export function signP2wpkhInputs(tx: LtcTx, keys: readonly PrivateKey[], amounts: readonly bigint[]): LtcTx {
  if (amounts.length !== tx.inputs.length) fail('one amount per input')
  if (keys.length !== tx.inputs.length) fail('one key per input')
  const signed: LtcTx = { ...tx, inputs: tx.inputs.map((i) => ({ ...i, script: new Uint8Array(), witness: [] })) }
  signed.inputs.forEach((input, vin) => {
    const key = keys[vin]!
    const pubkey = Uint8Array.from(key.toPublicKey().encode(true) as number[])
    const digest = p2wpkhSighash(signed, vin, pubkey, amounts[vin]!)
    const sig = ECDSA.sign(new BigNumber(toHex(digest), 16), key, true)
    input.witness = [concat(Uint8Array.from(sig.toDER() as number[]), Uint8Array.of(SIGHASH_ALL)), pubkey]
  })
  return signed
}

// ── Headers, proof of work, merkle proofs ─────────────────────────────────

export type LtcHeader = {
  raw: Bytes
  /** Display order (the block hash as explorers show it). */
  hash: string
  prevHash: string
  /** Internal byte order, as the header carries it. */
  merkleRoot: Bytes
  time: number
  bits: number
}

export function parseLtcHeader(raw: Bytes): LtcHeader {
  if (raw.length !== 80) fail('a header is 80 bytes')
  const r = new Reader(raw)
  r.u32()
  const prevHash = toHex(reversed(r.bytes(32)))
  const merkleRoot = Uint8Array.from(r.bytes(32))
  const time = r.u32()
  const bits = r.u32()
  return { raw, hash: toHex(reversed(sha256d(raw))), prevHash, merkleRoot, time, bits }
}

/** The target `bits` encodes; null for a negative or overflowing encoding. */
export function targetFromBits(bits: number): bigint | null {
  const exponent = bits >>> 24
  const mantissa = bits & 0x007fffff
  if (bits & 0x00800000) return null
  if (mantissa === 0) return null
  const target = exponent <= 3 ? BigInt(mantissa >>> (8 * (3 - exponent))) : BigInt(mantissa) << BigInt(8 * (exponent - 3))
  return target >> 256n ? null : target
}

/** Litecoin proof of work: scrypt(N=1024, r=1, p=1) of the header, read little-endian. */
export function scryptPowHash(raw: Bytes): bigint {
  const digest = scrypt(raw, raw, { N: 1024, r: 1, p: 1, dkLen: 32 })
  return BigInt(`0x${toHex(reversed(digest))}`)
}

/** Does the header carry the work its own bits claim? */
export function meetsOwnTarget(header: LtcHeader): boolean {
  const target = targetFromBits(header.bits)
  return target !== null && scryptPowHash(header.raw) <= target
}

/**
 * The merkle root a proof commits `txid` to (both in internal byte order).
 * `siblings` are display-order hashes, leaf upward, as Esplora returns them.
 */
export function merkleRootFromProof(txid: string, siblings: readonly string[], pos: number): Bytes {
  if (!Number.isInteger(pos) || pos < 0 || siblings.length > 32 || pos >= 2 ** siblings.length) fail('bad merkle position')
  let node = reversed(fromHex(txid))
  siblings.forEach((sibling, depth) => {
    const s = reversed(fromHex(sibling))
    if (s.length !== 32) fail('a merkle sibling is 32 bytes')
    node = Math.floor(pos / 2 ** depth) % 2 === 1 ? sha256d(concat(s, node)) : sha256d(concat(node, s))
  })
  return node
}

