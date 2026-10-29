import { keccak_256 } from '@noble/hashes/sha3.js'
import { BigNumber, ECDSA, Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { encodeCashAddr } from '../bch/bitcoincash'
import { BTC_HRP } from '../btc/bitcoin'
import {
  bip143Preimage,
  bip143ScriptSighash,
  concat,
  encodeSegwitAddress,
  fromHex,
  hash160,
  LTC_HRP,
  ltcTxid,
  sameBytes,
  serializeLtcTx,
  serializeLtcTxNoWitness,
  sha256d,
  toHex,
  type Bytes,
  type LtcTx,
} from '../ltc/litecoin'
import { legacySighash } from '../doge/dogecoin'
import type { SwapAsset } from './assets'

/**
 * Hash-locked outputs (HTLCs) for wallet-to-wallet swaps.
 *
 * An HTLC pays whoever shows the preimage of `hash` and signs with `claimPub`;
 * after `locktime` it returns to its payer. On Litecoin, Bitcoin, Bitcoin
 * Cash and Dogecoin the return is enforced by OP_CHECKLOCKTIMEVERIFY, and the
 * payer alone signs it. BSV has no time lock opcode. A BSV lock's return path
 * instead reads the spending transaction's own signature preimage, checks
 * that its nLockTime is at least `locktime` and its sequence is not final,
 * and proves the preimage genuine with a signature the script builds itself
 * (private key 1, nonce 1), so nobody has to pre-sign anything. Locks made
 * before 1.3.609 name a co-signer instead (`cosignPub`), who pre-signed the
 * refund with nLockTime = `locktime` before the output was funded.
 *
 * Arc USDC (`arc-usd`) is EVM: the lock encoding is a canonical parameter
 * blob (hash ‖ claim ‖ refund ‖ locktime) that both wallets compare and that
 * funds an ERC-20 hashed-timelock contract — not a Bitcoin script.
 *
 * The preimage must be exactly 32 bytes on every chain, so a secret that
 * opens one leg of a swap always opens the other.
 */

export type HtlcTerms = {
  /** sha256 of the 32-byte secret. */
  hash: Bytes
  claimPub: Bytes
  refundPub: Bytes
  /** Unix seconds; the payer may take the output back at and after it. */
  locktime: number
  /** BSV locks before 1.3.609 only: signs the refund with the payer. */
  cosignPub?: Bytes
}

export type HtlcKind = 'p2wsh' | 'p2sh' | 'bare' | 'erc20'

const OP = {
  0: 0x00,
  1: 0x51,
  4: 0x54,
  8: 0x58,
  VERIFY: 0x69,
  NIP: 0x77,
  SWAP: 0x7c,
  CAT: 0x7e,
  SPLIT: 0x7f,
  NUM2BIN: 0x80,
  BIN2NUM: 0x81,
  NOT: 0x91,
  ADD: 0x93,
  SUB: 0x94,
  MOD: 0x97,
  GREATERTHANOREQUAL: 0xa2,
  HASH256: 0xaa,
  IF: 0x63,
  ELSE: 0x67,
  ENDIF: 0x68,
  DROP: 0x75,
  DUP: 0x76,
  SIZE: 0x82,
  EQUAL: 0x87,
  EQUALVERIFY: 0x88,
  SHA256: 0xa8,
  HASH160: 0xa9,
  CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad,
  CLTV: 0xb1,
} as const

const SIGHASH_ALL = 0x01
const SIGHASH_ALL_FORKID = 0x41
/** Smallest unix time nLockTime reads as a time, not a height. */
const LOCKTIME_THRESHOLD = 500_000_000
const SECRET_BYTES = 32

const fail = (message: string): never => {
  throw new Error(`HTLC: ${message}`)
}

export function htlcKind(chain: SwapAsset): HtlcKind {
  if (chain === 'arc-usd') return 'erc20'
  return chain === 'ltc' || chain === 'btc' ? 'p2wsh' : chain === 'bsv' ? 'bare' : 'p2sh'
}

/** EIP-55-ready 20-byte address from a compressed secp256k1 pubkey (same curve as Arc). */
function ethAddressOfPub(pub: Bytes): Bytes {
  const uncompressed = Uint8Array.from(PublicKey.fromString(toHex(pub)).encode(false) as number[])
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) fail('claim/refund keys must decompress')
  return keccak_256(uncompressed.subarray(1)).subarray(12)
}

/**
 * Canonical Arc USDC HTLC lock encoding: version ‖ hash ‖ claimAddr ‖ refundAddr ‖ locktime.
 * Peers compare these bytes; the funded contract is derived from them.
 */
function arcUsdcHtlcScript(t: HtlcTerms): Bytes {
  const lock = new Uint8Array(4)
  lock[0] = (t.locktime >>> 24) & 0xff
  lock[1] = (t.locktime >>> 16) & 0xff
  lock[2] = (t.locktime >>> 8) & 0xff
  lock[3] = t.locktime & 0xff
  return concat(Uint8Array.of(0x01), t.hash, ethAddressOfPub(t.claimPub), ethAddressOfPub(t.refundPub), lock)
}

export const sha256 = (b: Bytes): Bytes => Uint8Array.from(Hash.sha256(Array.from(b)))

function push(data: Bytes): Bytes {
  if (data.length <= 75) return concat(Uint8Array.of(data.length), data)
  if (data.length <= 255) return concat(Uint8Array.of(0x4c, data.length), data)
  if (data.length <= 0xffff) return concat(Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8), data)
  return fail('push too long')
}

/** A positive script number, minimally encoded. */
function scriptNum(n: number | bigint): Bytes {
  let v = BigInt(n)
  if (v <= 0n || (typeof n === 'number' && !Number.isSafeInteger(n))) return fail('bad script number')
  const out: number[] = []
  while (v > 0n) {
    out.push(Number(v & 0xffn))
    v >>= 8n
  }
  if (out[out.length - 1]! & 0x80) out.push(0)
  return Uint8Array.from(out)
}

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SECP_GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const G_PUB = fromHex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
/** DER of a signature with r = Gx, up to its 32-byte s: SEQUENCE(68) INTEGER(32) r INTEGER(32). */
const PREIMAGE_SIG_PREFIX = fromHex('3044022079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817980220')

/** Reverse the 32 bytes on top of the stack. */
const REVERSE_32 = concat(...Array.from({ length: 31 }, () => Uint8Array.of(OP[1], OP.SPLIT)), ...Array.from({ length: 31 }, () => Uint8Array.of(OP.SWAP, OP.CAT)))

/**
 * BSV refund path: [sig, preimage] → checks the preimage's nLockTime ≥
 * `locktime` and sequence ≠ 0xffffffff, proves the preimage is this
 * transaction's own (a signature by key 1 with nonce 1, whose s the script
 * computes as hash256(preimage) + Gx mod n), then checks `sig` by `refundPub`.
 */
function bsvRefundPath(t: HtlcTerms): Bytes {
  return concat(
    Uint8Array.of(OP.DUP, OP.SIZE, OP[8], OP.SUB, OP.SPLIT, OP[4], OP.SPLIT, OP.DROP),
    push(Uint8Array.of(0)),
    Uint8Array.of(OP.CAT, OP.BIN2NUM),
    push(scriptNum(t.locktime)),
    Uint8Array.of(OP.GREATERTHANOREQUAL, OP.VERIFY, OP.SIZE),
    push(Uint8Array.of(32)),
    Uint8Array.of(OP.SUB, OP.SPLIT, OP.DROP, OP.SIZE, OP[4], OP.SUB, OP.SPLIT, OP.NIP),
    push(fromHex('ffffffff')),
    Uint8Array.of(OP.EQUAL, OP.NOT, OP.VERIFY, OP.HASH256),
    REVERSE_32,
    push(Uint8Array.of(0)),
    Uint8Array.of(OP.CAT, OP.BIN2NUM),
    push(scriptNum(SECP_GX)),
    Uint8Array.of(OP.ADD),
    push(scriptNum(SECP_N)),
    Uint8Array.of(OP.MOD),
    push(Uint8Array.of(32)),
    Uint8Array.of(OP.NUM2BIN),
    REVERSE_32,
    push(PREIMAGE_SIG_PREFIX),
    Uint8Array.of(OP.SWAP, OP.CAT),
    push(Uint8Array.of(SIGHASH_ALL_FORKID)),
    Uint8Array.of(OP.CAT),
    push(G_PUB),
    Uint8Array.of(OP.CHECKSIGVERIFY),
    push(t.refundPub),
    Uint8Array.of(OP.CHECKSIG),
  )
}

/** Whether the script's own preimage signature over `preimage` is a strict-DER, low-S signature. */
function preimageSigEncodes(preimage: Bytes): boolean {
  const z = BigInt('0x' + toHex(sha256d(preimage)))
  const sv = (z + SECP_GX) % SECP_N
  return sv > 0n && sv <= SECP_N / 2n && sv >= 1n << 248n
}

function checkTerms(chain: SwapAsset, t: HtlcTerms): void {
  if (t.hash.length !== 32) fail('hash is 32 bytes')
  for (const k of [t.claimPub, t.refundPub, ...(t.cosignPub ? [t.cosignPub] : [])]) {
    if (k.length !== 33 || (k[0] !== 2 && k[0] !== 3)) fail('keys are compressed')
  }
  if (!Number.isSafeInteger(t.locktime) || t.locktime < LOCKTIME_THRESHOLD || t.locktime > 0xffffffff) fail('locktime is a unix time')
  if (chain !== 'bsv' && t.cosignPub) fail('only a BSV HTLC has a refund co-signer')
}

/** The script that holds the coins (the witness or redeem script on the coin chains, the locking script on BSV, the ERC-20 HTLC encoding on Arc). */
export function htlcScript(chain: SwapAsset, t: HtlcTerms): Bytes {
  checkTerms(chain, t)
  if (chain === 'arc-usd') return arcUsdcHtlcScript(t)
  const secretCheck = concat(Uint8Array.of(OP.SIZE), push(Uint8Array.of(SECRET_BYTES)), Uint8Array.of(OP.EQUALVERIFY, OP.SHA256), push(t.hash), Uint8Array.of(OP.EQUALVERIFY))
  if (chain === 'bsv') {
    const refund = t.cosignPub ? concat(push(t.refundPub), Uint8Array.of(OP.CHECKSIGVERIFY), push(t.cosignPub), Uint8Array.of(OP.CHECKSIG)) : bsvRefundPath(t)
    return concat(Uint8Array.of(OP.IF), secretCheck, push(t.claimPub), Uint8Array.of(OP.CHECKSIG, OP.ELSE), refund, Uint8Array.of(OP.ENDIF))
  }
  return concat(
    Uint8Array.of(OP.IF),
    secretCheck,
    push(t.claimPub),
    Uint8Array.of(OP.ELSE),
    push(scriptNum(t.locktime)),
    Uint8Array.of(OP.CLTV, OP.DROP),
    push(t.refundPub),
    Uint8Array.of(OP.ENDIF, OP.CHECKSIG),
  )
}

/** The output script that locks `script`, and the address that pays it (none on BSV, where the script is the output). */
export function htlcOutput(chain: SwapAsset, script: Bytes): { scriptPubKey: Bytes; address: string | null } {
  switch (htlcKind(chain)) {
    case 'bare':
      return { scriptPubKey: script, address: null }
    case 'erc20': {
      // Deterministic lock id (0x + 20 bytes) from the encoding — funds land at the HTLC contract derived from these terms.
      const id = keccak_256(script).subarray(12)
      return { scriptPubKey: script, address: `0x${toHex(id)}` }
    }
    case 'p2wsh': {
      const program = sha256(script)
      return { scriptPubKey: concat(Uint8Array.of(0x00, 0x20), program), address: encodeSegwitAddress(chain === 'ltc' ? LTC_HRP : BTC_HRP, 0, program) }
    }
    case 'p2sh': {
      const h = hash160(script)
      const scriptPubKey = concat(Uint8Array.of(OP.HASH160), push(h), Uint8Array.of(OP.EQUAL))
      const address = chain === 'bch' ? encodeCashAddr('p2sh', h) : Utils.toBase58Check(Array.from(h), [0x16])
      return { scriptPubKey, address }
    }
  }
}

const hashTypeOf = (chain: SwapAsset) => (chain === 'bsv' || chain === 'bch' ? SIGHASH_ALL_FORKID : SIGHASH_ALL)

/** The digest a signature over input `vin` of `tx`, spending `amount` held by `script`, commits to. */
export function htlcSighash(chain: SwapAsset, tx: LtcTx, vin: number, script: Bytes, amount: bigint): Bytes {
  if (chain === 'doge') return legacySighash(tx, vin, script, SIGHASH_ALL)
  return bip143ScriptSighash(tx, vin, script, amount, hashTypeOf(chain))
}

/** A DER signature plus its hash type byte. */
export function htlcSignature(chain: SwapAsset, tx: LtcTx, vin: number, script: Bytes, amount: bigint, key: PrivateKey): Bytes {
  const digest = htlcSighash(chain, tx, vin, script, amount)
  const sig = ECDSA.sign(new BigNumber(toHex(digest), 16), key, true)
  return concat(Uint8Array.from(sig.toDER() as number[]), Uint8Array.of(hashTypeOf(chain)))
}

/** Does `sig` (DER + hash type) sign input `vin` of `tx` with `pub`? */
export function htlcSignatureValid(chain: SwapAsset, tx: LtcTx, vin: number, script: Bytes, amount: bigint, pub: Bytes, sig: Bytes): boolean {
  if (sig.length < 9 || sig[sig.length - 1] !== hashTypeOf(chain)) return false
  try {
    const digest = htlcSighash(chain, tx, vin, script, amount)
    return ECDSA.verify(new BigNumber(toHex(digest), 16), Signature.fromDER(Array.from(sig.slice(0, -1))), PublicKey.fromString(toHex(pub)))
  } catch {
    return false
  }
}

export type HtlcPath = { kind: 'claim'; preimage: Bytes; sig: Bytes } | { kind: 'refund'; sig: Bytes; cosig?: Bytes; sighashPreimage?: Bytes }

/** The unlocking data of an HTLC spend, as a scriptSig (P2SH, bare) or witness (P2WSH). */
export function htlcUnlock(chain: SwapAsset, script: Bytes, path: HtlcPath): { scriptSig: Bytes; witness: Bytes[] } {
  if (path.kind === 'claim' && path.preimage.length !== SECRET_BYTES) fail('the secret is 32 bytes')
  const kind = htlcKind(chain)
  if (kind === 'erc20') fail('Arc USDC HTLC spends are not a Bitcoin script unlock')
  if (kind === 'p2wsh') {
    const items = path.kind === 'claim' ? [path.sig, path.preimage, Uint8Array.of(1)] : [path.sig, new Uint8Array()]
    return { scriptSig: new Uint8Array(), witness: [...items, script] }
  }
  let body: Bytes
  if (path.kind === 'claim') body = concat(push(path.sig), push(path.preimage), Uint8Array.of(OP[1]))
  else if (chain === 'bsv') {
    if (path.cosig) body = concat(push(path.cosig), push(path.sig), Uint8Array.of(OP[0]))
    else if (path.sighashPreimage) body = concat(push(path.sig), push(path.sighashPreimage), Uint8Array.of(OP[0]))
    else return fail('a BSV refund carries its co-signature or its preimage')
  } else body = concat(push(path.sig), Uint8Array.of(OP[0]))
  return { scriptSig: kind === 'p2sh' ? concat(body, push(script)) : body, witness: [] }
}

/** The bytes broadcast, and the transaction id. */
export function htlcTxBytes(chain: SwapAsset, tx: LtcTx): { hex: string; txid: string } {
  const raw = htlcKind(chain) === 'p2wsh' && tx.inputs.some((i) => i.witness.length) ? serializeLtcTx(tx) : serializeLtcTxNoWitness(tx)
  return { hex: toHex(raw), txid: ltcTxid(tx) }
}

/** Bytes a fee is paid on: virtual bytes where witness data is discounted. */
export function htlcTxSize(chain: SwapAsset, tx: LtcTx): number {
  const base = serializeLtcTxNoWitness(tx).length
  if (htlcKind(chain) !== 'p2wsh' || !tx.inputs.some((i) => i.witness.length)) return base
  const total = serializeLtcTx(tx).length
  return Math.ceil((base * 3 + total) / 4)
}

export type HtlcCoin = { txid: string; vout: number; amount: bigint; script: Bytes }

/** An unsigned spend of `coins` to one output; the refund carries the locktime and a non-final sequence. */
export function htlcSpendTx(chain: SwapAsset, coins: readonly HtlcCoin[], to: Bytes, value: bigint, kind: 'claim' | 'refund', locktime = 0): LtcTx {
  if (coins.length === 0) fail('nothing to spend')
  if (kind === 'refund' && locktime < LOCKTIME_THRESHOLD) fail('a refund carries its locktime')
  return {
    version: chain === 'bsv' ? 1 : 2,
    inputs: coins.map((c) => ({ txid: c.txid, vout: c.vout, script: new Uint8Array(), sequence: 0xfffffffe, witness: [] })),
    outputs: [{ value, script: to }],
    locktime: kind === 'refund' ? locktime : 0,
  }
}

/** BSV miners take 100 satoshis per kB, as the wallet's own builds pay. */
export const BSV_FEE_PER_BYTE = 0.1

/**
 * Sign and complete a spend of HTLC `coins` to `to`, paying `feeRate` per
 * (virtual) byte out of the coins. `cosigs` (BSV refunds) are the
 * counterparty's pre-signatures, one per coin, over exactly this transaction:
 * so a BSV refund is built with the value the pre-signatures committed to.
 */
export function signHtlcSpend(
  chain: SwapAsset,
  args: {
    coins: readonly HtlcCoin[]
    to: Bytes
    key: PrivateKey
    path: { kind: 'claim'; preimage: Bytes } | { kind: 'refund'; locktime: number; cosigs?: Bytes[] }
    /** Fixed output value (a pre-signed BSV refund); otherwise the coins less the fee at `feeRate`. */
    value?: bigint
    feeRate?: number
  },
): { tx: LtcTx; hex: string; txid: string; fee: bigint } {
  if (htlcKind(chain) === 'erc20') fail('Arc USDC HTLC spends are not a Bitcoin script unlock')
  const { coins, to, key, path } = args
  const total = coins.reduce((s, c) => s + c.amount, 0n)
  const locktime = path.kind === 'refund' ? path.locktime : 0
  // A BSV refund with no co-signatures carries its own preimage, which the script turns into a signature: walk
  // nLockTime up from the lock time until every input's comes out strict-DER and low-S (about half of them do).
  const selfProving = chain === 'bsv' && path.kind === 'refund' && !path.cosigs
  const nLockTimeFor = (value: bigint): number => {
    if (!selfProving) return locktime
    for (let lt = locktime; lt < locktime + 4096 && lt <= 0xffffffff; lt++) {
      const tx = htlcSpendTx(chain, coins, to, value, 'refund', lt)
      if (coins.every((c, vin) => preimageSigEncodes(bip143Preimage(tx, vin, c.script, c.amount, SIGHASH_ALL_FORKID)))) return lt
    }
    return fail('no lock time gives an encodable preimage signature')
  }
  const complete = (value: bigint): LtcTx => {
    const tx = htlcSpendTx(chain, coins, to, value, path.kind, nLockTimeFor(value))
    coins.forEach((c, vin) => {
      const sig = htlcSignature(chain, tx, vin, c.script, c.amount, key)
      const unlock = htlcUnlock(
        chain,
        c.script,
        path.kind === 'claim'
          ? { kind: 'claim', preimage: path.preimage, sig }
          : { kind: 'refund', sig, ...(path.cosigs ? { cosig: path.cosigs[vin]! } : selfProving ? { sighashPreimage: bip143Preimage(tx, vin, c.script, c.amount, SIGHASH_ALL_FORKID) } : {}) },
      )
      tx.inputs[vin]!.script = unlock.scriptSig
      tx.inputs[vin]!.witness = unlock.witness
    })
    return tx
  }
  let value = args.value
  if (value === undefined) {
    const rate = args.feeRate ?? 1
    if (!(rate > 0)) fail('a fee rate is positive')
    value = total - BigInt(Math.max(1, Math.ceil(rate * htlcTxSize(chain, complete(total)))))
  }
  if (value <= 0n || value > total) fail('the coins do not cover the fee')
  const tx = complete(value)
  return { tx, ...htlcTxBytes(chain, tx), fee: total - value }
}

/** The 32-byte secret an HTLC claim in input `vin` of `tx` reveals, if it opens `hash`. */
export function readSecret(chain: SwapAsset, tx: LtcTx, vin: number, hash: Bytes): Bytes | null {
  const input = tx.inputs[vin]
  if (!input) return null
  const candidates: Bytes[] = htlcKind(chain) === 'p2wsh' ? input.witness : scriptPushes(input.script)
  for (const c of candidates) if (c.length === SECRET_BYTES && sameBytes(sha256(c), hash)) return c
  return null
}

/** The data pushes of a push-only script. */
function scriptPushes(script: Bytes): Bytes[] {
  const out: Bytes[] = []
  let i = 0
  while (i < script.length) {
    const op = script[i++]!
    let len = 0
    if (op >= 1 && op <= 75) len = op
    else if (op === 0x4c) len = script[i++] ?? 0
    else if (op === 0x4d) {
      len = (script[i] ?? 0) | ((script[i + 1] ?? 0) << 8)
      i += 2
    } else continue
    out.push(script.slice(i, i + len))
    i += len
  }
  return out
}
