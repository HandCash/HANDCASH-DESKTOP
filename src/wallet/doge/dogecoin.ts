import { BigNumber, ECDSA, Utils, type PrivateKey } from '@bsv/sdk'
import { compactFromTarget } from '../ltc/headers'
import {
  concat,
  hash160,
  LtcFormatError,
  parseLtcHeader,
  parseLtcTx,
  Reader,
  readLtcTx,
  reversed,
  scryptPowHash,
  serializeLtcTxNoWitness,
  sha256d,
  targetFromBits,
  toHex,
  u32le,
  varBytes,
  type Bytes,
  type LtcHeader,
  type LtcTx,
} from '../ltc/litecoin'

/**
 * Dogecoin mainnet primitives: base58 addresses, pay-to-pubkey-hash coins
 * signed with the original (pre-segwit) signature hash, merge-mined headers
 * (AuxPoW) and the DigiShield difficulty rule. Transactions, txids and merkle
 * proofs have Bitcoin's formats, so they come from the shared parsers.
 * Dogecoin has no segwit, so a transaction carrying a segwit marker is refused.
 */

const fail = (message: string): never => {
  throw new LtcFormatError(message)
}

/** Koinu as a DOGE decimal string, trailing zeros dropped. */
export function formatDoge(koinu: bigint): string {
  const whole = koinu / 100_000_000n
  const frac = (koinu % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

// ── Addresses and scripts ──────────────────────────────────────────────────

const P2PKH_VERSION = 0x1e
const P2SH_VERSION = 0x16

export function p2pkhScript(pubkeyHash: Bytes): Bytes {
  return concat(Uint8Array.of(0x76, 0xa9, 0x14), pubkeyHash, Uint8Array.of(0x88, 0xac))
}

export const dogeCoinScript = (pubkey: Bytes): Bytes => p2pkhScript(hash160(pubkey))
export const dogeCoinAddress = (pubkey: Bytes): string => Utils.toBase58Check(Array.from(hash160(pubkey)), [P2PKH_VERSION])

/** The output script a payment to a Dogecoin mainnet `D…` (P2PKH) or `9…`/`A…` (P2SH) address locks. */
export function dogeOutputScript(address: string): Bytes {
  let parsed: { prefix: number[]; data: number[] }
  try {
    parsed = Utils.fromBase58Check(address.trim()) as { prefix: number[]; data: number[] }
  } catch {
    return fail('not a valid Dogecoin address')
  }
  if (parsed.prefix.length !== 1 || parsed.data.length !== 20) return fail('not a valid Dogecoin address')
  const hash = Uint8Array.from(parsed.data)
  if (parsed.prefix[0] === P2PKH_VERSION) return p2pkhScript(hash)
  if (parsed.prefix[0] === P2SH_VERSION) return concat(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87))
  return fail('not a Dogecoin mainnet address')
}

// ── Transactions ───────────────────────────────────────────────────────────

/** Dogecoin has no segwit: a marker after the version is refused, not stripped. */
export function parseDogeTx(raw: Bytes): LtcTx {
  if (raw.length > 4 && raw[4] === 0x00) fail('Dogecoin transactions carry no segwit marker')
  return parseLtcTx(raw)
}

export const serializeDogeTx = serializeLtcTxNoWitness

const SIGHASH_ALL = 1

/** The original signature hash: the transaction with only input `vin` carrying `scriptCode`, then the hash type. */
export function legacySighash(tx: LtcTx, vin: number, scriptCode: Bytes, hashType = SIGHASH_ALL): Bytes {
  if (!tx.inputs[vin]) fail('no such input')
  const copy: LtcTx = { ...tx, inputs: tx.inputs.map((input, i) => ({ ...input, script: i === vin ? scriptCode : new Uint8Array(), witness: [] })) }
  return sha256d(concat(serializeLtcTxNoWitness(copy), u32le(hashType)))
}

/** Sign every input as a P2PKH spend by `key`, the signature and key in its scriptSig. The legacy hash commits to no amounts. */
/** `keys`: the key each input's coin pays, one per input. */
export function signP2pkhLegacyInputs(tx: LtcTx, keys: readonly PrivateKey[], amounts: readonly bigint[]): LtcTx {
  if (amounts.length !== tx.inputs.length) fail('one amount per input')
  if (keys.length !== tx.inputs.length) fail('one key per input')
  const unsigned: LtcTx = { ...tx, inputs: tx.inputs.map((i) => ({ ...i, script: new Uint8Array(), witness: [] })) }
  return {
    ...unsigned,
    inputs: unsigned.inputs.map((input, vin) => {
      const key = keys[vin]!
      const pubkey = Uint8Array.from(key.toPublicKey().encode(true) as number[])
      const scriptCode = dogeCoinScript(pubkey)
      const digest = legacySighash(unsigned, vin, scriptCode)
      const sig = ECDSA.sign(new BigNumber(toHex(digest), 16), key, true)
      const der = concat(Uint8Array.from(sig.toDER() as number[]), Uint8Array.of(SIGHASH_ALL))
      return { ...input, script: concat(varBytes(der), varBytes(pubkey)) }
    }),
  }
}

// ── Headers: AuxPoW ────────────────────────────────────────────────────────

/** Dogecoin's merged-mining chain id, carried in the high half of the block version. */
export const DOGE_CHAIN_ID = 0x62
const VERSION_AUXPOW = 1 << 8
const MERGED_MINING_HEADER = Uint8Array.of(0xfa, 0xbe, 0x6d, 0x6d)
const MAX_CHAIN_BRANCH = 30

/** A merge-mined block's proof: the parent block's coinbase commits to this block's hash through a chain merkle tree. */
export type AuxPow = {
  coinbase: LtcTx
  coinbaseBranch: Bytes[]
  coinbaseIndex: number
  chainBranch: Bytes[]
  chainIndex: number
  /** The parent chain's 80-byte header, whose scrypt hash carries the work. */
  parent: Bytes
}

const chainIdOf = (version: number) => version >>> 16
const isAuxPow = (version: number) => (version & VERSION_AUXPOW) !== 0

function readBranch(r: Reader): Bytes[] {
  const n = r.varint()
  if (n > 64) fail('merkle branch too long')
  return Array.from({ length: n }, () => Uint8Array.from(r.bytes(32)))
}

function readAuxPow(r: Reader): AuxPow {
  const coinbase = readLtcTx(r)
  r.bytes(32)
  const coinbaseBranch = readBranch(r)
  const coinbaseIndex = r.u32() | 0
  const chainBranch = readBranch(r)
  const chainIndex = r.u32() | 0
  const parent = Uint8Array.from(r.bytes(80))
  return { coinbase, coinbaseBranch, coinbaseIndex, chainBranch, chainIndex, parent }
}

/** Read one header, with its AuxPoW when the version says it has one; the reader is left after it. */
function readDogeHeader(r: Reader): { plain: Bytes; aux: AuxPow | null } {
  const plain = Uint8Array.from(r.bytes(80))
  const version = (plain[0]! | (plain[1]! << 8) | (plain[2]! << 16) | (plain[3]! << 24)) >>> 0
  return { plain, aux: isAuxPow(version) ? readAuxPow(r) : null }
}

/** Split `count` concatenated headers, each 80 bytes plus its AuxPoW when it has one. */
export function splitDogeHeaders(raw: Bytes, count: number): Bytes[] {
  const r = new Reader(raw)
  const out: Bytes[] = []
  for (let i = 0; i < count; i++) {
    const start = r.at
    readDogeHeader(r)
    out.push(raw.slice(start, r.at))
  }
  if (!r.done) fail('trailing bytes after the headers')
  return out
}

/** A header as Dogecoin servers serve it: its fields and hash are the first 80 bytes; `raw` keeps the AuxPoW for the work check. */
export function parseDogeHeader(raw: Bytes): LtcHeader {
  const r = new Reader(raw)
  const { plain } = readDogeHeader(r)
  if (!r.done) fail('trailing bytes after the header')
  return { ...parseLtcHeader(plain), raw }
}

/** `CheckMerkleBranch`: hashes in internal byte order. */
function merkleBranchRoot(leaf: Bytes, branch: readonly Bytes[], index: number): Bytes {
  let node = leaf
  let i = index
  for (const sibling of branch) {
    node = i & 1 ? sha256d(concat(sibling, node)) : sha256d(concat(node, sibling))
    i >>>= 1
  }
  return node
}

/** The chain-tree slot a chain must take for `nonce` (Namecoin's `getExpectedIndex`), in 32-bit arithmetic. */
export function expectedChainIndex(nonce: number, chainId: number, height: number): number {
  let rand = nonce >>> 0
  rand = (Math.imul(rand, 1103515245) + 12345) >>> 0
  rand = (rand + chainId) >>> 0
  rand = (Math.imul(rand, 1103515245) + 12345) >>> 0
  return rand % 2 ** height
}

function indexOf(haystack: Bytes, needle: Bytes, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

export type AuxPowRefusal =
  | 'not-generate'
  | 'parent-chain-id'
  | 'chain-branch'
  | 'coinbase-branch'
  | 'no-root'
  | 'two-headers'
  | 'header-gap'
  | 'root-late'
  | 'no-size'
  | 'size'
  | 'index'

/** Dogecoin Core's `CAuxPow::check`: does `aux` commit the parent block to the block hashing to `blockHash` (internal order)? */
export function checkAuxPow(aux: AuxPow, blockHash: Bytes, chainId = DOGE_CHAIN_ID): AuxPowRefusal | null {
  if (aux.coinbaseIndex !== 0) return 'not-generate'
  const parentVersion = (aux.parent[0]! | (aux.parent[1]! << 8) | (aux.parent[2]! << 16) | (aux.parent[3]! << 24)) >>> 0
  if (chainIdOf(parentVersion) === chainId) return 'parent-chain-id'
  if (aux.chainBranch.length > MAX_CHAIN_BRANCH) return 'chain-branch'
  const root = reversed(merkleBranchRoot(blockHash, aux.chainBranch, aux.chainIndex))
  const coinbaseTxid = sha256d(serializeLtcTxNoWitness(aux.coinbase))
  if (toHex(merkleBranchRoot(coinbaseTxid, aux.coinbaseBranch, aux.coinbaseIndex)) !== toHex(parseLtcHeader(aux.parent).merkleRoot)) return 'coinbase-branch'
  const script = aux.coinbase.inputs[0]?.script ?? new Uint8Array()
  const head = indexOf(script, MERGED_MINING_HEADER)
  const at = indexOf(script, root)
  if (at === -1) return 'no-root'
  if (head !== -1) {
    if (indexOf(script, MERGED_MINING_HEADER, head + 1) !== -1) return 'two-headers'
    if (head + MERGED_MINING_HEADER.length !== at) return 'header-gap'
  } else if (at > 20) {
    return 'root-late'
  }
  const tail = at + root.length
  if (script.length - tail < 8) return 'no-size'
  const word = (o: number) => (script[o]! | (script[o + 1]! << 8) | (script[o + 2]! << 16) | (script[o + 3]! << 24)) >>> 0
  if (word(tail) !== 2 ** aux.chainBranch.length) return 'size'
  if (aux.chainIndex !== expectedChainIndex(word(tail + 4), chainId, aux.chainBranch.length)) return 'index'
  return null
}

/** No header carries this much work: a header that fails its AuxPoW or chain id is refused as `pow`. */
const NO_WORK = 1n << 256n

/**
 * Dogecoin proof of work (`CheckAuxPowProofOfWork`): the header must carry
 * Dogecoin's chain id; a merge-mined header's AuxPoW must check and its parent
 * header's scrypt hash is the work, otherwise the header's own scrypt hash is.
 */
export function dogePowHash(raw: Bytes): bigint {
  const r = new Reader(raw)
  const { plain, aux } = readDogeHeader(r)
  const version = (plain[0]! | (plain[1]! << 8) | (plain[2]! << 16) | (plain[3]! << 24)) >>> 0
  if ((version & 0xff) > 1 && chainIdOf(version) !== DOGE_CHAIN_ID) return NO_WORK
  if (!aux) return scryptPowHash(plain)
  if (checkAuxPow(aux, sha256d(plain)) !== null) return NO_WORK
  return scryptPowHash(aux.parent)
}

// ── Difficulty: DigiShield ─────────────────────────────────────────────────

/** Mainnet `powLimit`: 20 leading zero bits, as Litecoin. */
export const DOGE_POW_LIMIT = (1n << 236n) - 1n
const TARGET_SPACING = 60

/**
 * Bits of the block after `prev`, whose parent has time `prevPrevTime`.
 * DigiShield retargets every block from the last block's span, dampened to an
 * eighth and clamped to [-25%, +50%]; C++ division truncates toward zero.
 */
export function nextDogeBits(prevBits: number, prevTime: number, prevPrevTime: number): number {
  const actual = prevTime - prevPrevTime
  let modulated = TARGET_SPACING + Math.trunc((actual - TARGET_SPACING) / 8)
  modulated = Math.min(TARGET_SPACING + TARGET_SPACING / 2, Math.max(TARGET_SPACING - TARGET_SPACING / 4, modulated))
  const target = targetFromBits(prevBits)
  if (target === null) throw new Error('bad bits')
  const next = (target * BigInt(modulated)) / BigInt(TARGET_SPACING)
  return compactFromTarget(next > DOGE_POW_LIMIT ? DOGE_POW_LIMIT : next)
}
