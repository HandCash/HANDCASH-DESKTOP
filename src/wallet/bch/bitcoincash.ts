import { BigNumber, ECDSA, type PrivateKey } from '@bsv/sdk'
import {
  bip143Sighash,
  concat,
  hash160,
  LtcFormatError,
  parseLtcTx,
  reversed,
  sha256d,
  serializeLtcTxNoWitness,
  targetFromBits,
  toHex,
  varBytes,
  type Bytes,
  type LtcTx,
} from '../ltc/litecoin'
import { compactFromTarget } from '../ltc/headers'

/**
 * Bitcoin Cash mainnet primitives: CashAddr, pay-to-pubkey-hash coins,
 * signatures under `SIGHASH_ALL | SIGHASH_FORKID`, and the ASERT difficulty
 * rule (aserti3-2d). Transactions, txids, headers and merkle proofs have
 * Bitcoin's formats, so they come from the shared parsers; Bitcoin Cash has no
 * segwit, so a transaction carrying a segwit marker is refused.
 */

const fail = (message: string): never => {
  throw new LtcFormatError(message)
}

/** Satoshis as a BCH decimal string, trailing zeros dropped. */
export function formatBch(sats: bigint): string {
  const whole = sats / 100_000_000n
  const frac = (sats % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

// ── CashAddr ───────────────────────────────────────────────────────────────

export const BCH_PREFIX = 'bitcoincash'
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n]

function polymod(values: readonly number[]): bigint {
  let c = 1n
  for (const d of values) {
    const c0 = c >> 35n
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d)
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i]!
  }
  return c ^ 1n
}

const prefixData = (prefix: string): number[] => [...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0]

function convertBits(data: readonly number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const max = (1 << to) - 1
  for (const v of data) {
    if (v < 0 || v >> from) return null
    acc = ((acc << from) | v) & 0xffffff
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

/** CashAddr types this wallet pays: plain and token-aware forms of P2PKH and P2SH. */
export type CashAddrKind = 'p2pkh' | 'p2sh'

const SIZE_BITS: Record<number, number> = { 0: 160, 1: 192, 2: 224, 3: 256, 4: 320, 5: 384, 6: 448, 7: 512 }

export function encodeCashAddr(kind: CashAddrKind, hash: Bytes, opts: { tokenAware?: boolean } = {}): string {
  const sizeCode = hash.length === 20 ? 0 : hash.length === 32 ? 3 : fail('a CashAddr hash is 20 or 32 bytes')
  const type = (kind === 'p2pkh' ? 0 : 1) + (opts.tokenAware ? 2 : 0)
  const payload = convertBits([(type << 3) | sizeCode, ...hash], 8, 5, true)!
  const mod = polymod([...prefixData(BCH_PREFIX), ...payload, 0, 0, 0, 0, 0, 0, 0, 0])
  const checksum = Array.from({ length: 8 }, (_, i) => Number((mod >> BigInt(5 * (7 - i))) & 31n))
  return `${BCH_PREFIX}:${[...payload, ...checksum].map((d) => CHARSET[d]).join('')}`
}

/** A mainnet CashAddr; the `bitcoincash:` prefix may be left off. Mixed case, other prefixes and bad checksums are refused. */
export function decodeCashAddr(address: string): { kind: CashAddrKind; hash: Bytes; tokenAware: boolean } {
  const text = address.trim()
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) fail('mixed case')
  const lower = text.toLowerCase()
  const colon = lower.lastIndexOf(':')
  const prefix = colon === -1 ? BCH_PREFIX : lower.slice(0, colon)
  if (prefix !== BCH_PREFIX) fail(`not a Bitcoin Cash mainnet address (prefix "${prefix}")`)
  const body = colon === -1 ? lower : lower.slice(colon + 1)
  const data = [...body].map((ch) => {
    const v = CHARSET.indexOf(ch)
    if (v === -1) fail('not a CashAddr character')
    return v
  })
  if (data.length < 8 + 34) fail('too short for a CashAddr')
  if (polymod([...prefixData(BCH_PREFIX), ...data]) !== 0n) fail('bad CashAddr checksum')
  const bytes = convertBits(data.slice(0, -8), 5, 8, false)
  if (!bytes) fail('bad CashAddr padding')
  const [version, ...hashBytes] = bytes!
  if (version! & 0x80) fail('reserved CashAddr version bit')
  const type = version! >> 3
  const size = SIZE_BITS[version! & 7]!
  if (hashBytes.length * 8 !== size) fail('CashAddr hash length does not match its version')
  if (type > 3) fail(`unknown CashAddr type ${type}`)
  const kind: CashAddrKind = type % 2 === 0 ? 'p2pkh' : 'p2sh'
  if (kind === 'p2pkh' && size !== 160) fail('a P2PKH address carries a 20-byte hash')
  if (kind === 'p2sh' && size !== 160 && size !== 256) fail('a P2SH address carries a 20- or 32-byte hash')
  return { kind, hash: Uint8Array.from(hashBytes), tokenAware: type >= 2 }
}

// ── Scripts ────────────────────────────────────────────────────────────────

export function p2pkhScript(pubkeyHash: Bytes): Bytes {
  return concat(Uint8Array.of(0x76, 0xa9, 0x14), pubkeyHash, Uint8Array.of(0x88, 0xac))
}

export const bchCoinScript = (pubkey: Bytes): Bytes => p2pkhScript(hash160(pubkey))
export const bchCoinAddress = (pubkey: Bytes): string => encodeCashAddr('p2pkh', hash160(pubkey))

/** The output script a payment to `address` locks. Only CashAddr: a legacy `1…` address is also a BSV address. */
export function bchOutputScript(address: string): Bytes {
  const { kind, hash } = decodeCashAddr(address)
  if (kind === 'p2pkh') return p2pkhScript(hash)
  return hash.length === 20
    ? concat(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87))
    : concat(Uint8Array.of(0xaa, 0x20), hash, Uint8Array.of(0x87))
}

// ── Transactions ───────────────────────────────────────────────────────────

/** Bitcoin Cash has no segwit: a marker after the version is refused, not stripped. */
export function parseBchTx(raw: Bytes): LtcTx {
  if (raw.length > 4 && raw[4] === 0x00) fail('Bitcoin Cash transactions carry no segwit marker')
  return parseLtcTx(raw)
}

export const SIGHASH_ALL_FORKID = 0x41

/** Sign every input as a P2PKH spend by `key`, the signature and key in its scriptSig; `amounts[vin]` is what each spent output holds. */
/** `keys`: the key each input's coin pays, one per input. */
export function signP2pkhForkIdInputs(tx: LtcTx, keys: readonly PrivateKey[], amounts: readonly bigint[]): LtcTx {
  if (amounts.length !== tx.inputs.length) fail('one amount per input')
  if (keys.length !== tx.inputs.length) fail('one key per input')
  const unsigned: LtcTx = { ...tx, inputs: tx.inputs.map((i) => ({ ...i, script: new Uint8Array(), witness: [] })) }
  return {
    ...unsigned,
    inputs: unsigned.inputs.map((input, vin) => {
      const key = keys[vin]!
      const pubkey = Uint8Array.from(key.toPublicKey().encode(true) as number[])
      const digest = bip143Sighash(unsigned, vin, pubkey, amounts[vin]!, SIGHASH_ALL_FORKID)
      const sig = ECDSA.sign(new BigNumber(toHex(digest), 16), key, true)
      const der = concat(Uint8Array.from(sig.toDER() as number[]), Uint8Array.of(SIGHASH_ALL_FORKID))
      return { ...input, script: concat(varBytes(der), varBytes(pubkey)) }
    }),
  }
}

export const serializeBchTx = serializeLtcTxNoWitness

// ── Proof of work: ASERT (aserti3-2d) ──────────────────────────────────────

/** Bitcoin Cash proof-of-work limit (`0x1d00ffff`). */
export const BCH_POW_LIMIT = (1n << 224n) - 1n
const IDEAL_BLOCK_TIME = 600n
const HALF_LIFE = 172_800n

/** The ASERT anchor: block 661647, the first after the November 2020 upgrade, and its parent's time. */
export const ASERT_ANCHOR = { height: 661_647, bits: 0x1804dafe, parentTime: 1_605_447_844 } as const

/**
 * Bits of the block at `height`, whose parent has time `parentTime`. This is
 * Bitcoin Cash Node's integer algorithm exactly: the exponent uses truncating
 * division, the shift a flooring one, and 2^frac a cubic approximation.
 */
export function nextBchBits(height: number, parentTime: number, anchor = ASERT_ANCHOR): number {
  const anchorTarget = targetFromBits(anchor.bits)
  if (anchorTarget === null) throw new Error('bad anchor bits')
  const heightDiff = BigInt(height - 1 - anchor.height)
  const timeDiff = BigInt(parentTime - anchor.parentTime)
  const exponent = ((timeDiff - IDEAL_BLOCK_TIME * (heightDiff + 1n)) * 65536n) / HALF_LIFE
  let shifts = exponent >> 16n
  const frac = exponent - shifts * 65536n
  const factor =
    65536n + ((195_766_423_245_049n * frac + 971_821_376n * frac * frac + 5_127n * frac * frac * frac + (1n << 47n)) >> 48n)
  let target = anchorTarget * factor
  shifts -= 16n
  if (shifts <= 0n) target >>= -shifts
  else {
    const shifted = target << shifts
    target = shifted >> 256n ? BCH_POW_LIMIT : shifted
  }
  if (target === 0n) target = 1n
  else if (target > BCH_POW_LIMIT) target = BCH_POW_LIMIT
  return compactFromTarget(target)
}

/** Bitcoin Cash proof of work: the block hash itself, read as a number. */
export function sha256dPowHash(raw: Bytes): bigint {
  return BigInt(`0x${toHex(reversed(sha256d(raw)))}`)
}
