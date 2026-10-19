import { BigNumber, ECDSA, Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { encodeCashAddr } from '../bch/bitcoincash'
import { BTC_HRP } from '../btc/bitcoin'
import {
  bip143ScriptSighash,
  concat,
  encodeSegwitAddress,
  hash160,
  LTC_HRP,
  ltcTxid,
  sameBytes,
  serializeLtcTx,
  serializeLtcTxNoWitness,
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
 * payer alone signs it. BSV has no time lock opcode, so the return path needs
 * the payer and a co-signer (the counterparty, who pre-signs the refund with
 * nLockTime = `locktime` before the output is funded): the counterparty can
 * never take it back early, and the payer cannot either.
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
  /** BSV only: signs the refund with the payer. */
  cosignPub?: Bytes
}

export type HtlcKind = 'p2wsh' | 'p2sh' | 'bare'

const OP = {
  0: 0x00,
  1: 0x51,
  IF: 0x63,
  ELSE: 0x67,
  ENDIF: 0x68,
  DROP: 0x75,
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
  return chain === 'ltc' || chain === 'btc' ? 'p2wsh' : chain === 'bsv' ? 'bare' : 'p2sh'
}

export const sha256 = (b: Bytes): Bytes => Uint8Array.from(Hash.sha256(Array.from(b)))

function push(data: Bytes): Bytes {
  if (data.length <= 75) return concat(Uint8Array.of(data.length), data)
  if (data.length <= 255) return concat(Uint8Array.of(0x4c, data.length), data)
  return fail('push too long')
}

/** A script number, minimally encoded. */
function scriptNum(n: number): Bytes {
  if (!Number.isSafeInteger(n) || n <= 0) return fail('bad script number')
  const out: number[] = []
  let v = n
  while (v > 0) {
    out.push(v & 0xff)
    v = Math.floor(v / 256)
  }
  if (out[out.length - 1]! & 0x80) out.push(0)
  return Uint8Array.from(out)
}

function checkTerms(chain: SwapAsset, t: HtlcTerms): void {
  if (t.hash.length !== 32) fail('hash is 32 bytes')
  for (const k of [t.claimPub, t.refundPub, ...(t.cosignPub ? [t.cosignPub] : [])]) {
    if (k.length !== 33 || (k[0] !== 2 && k[0] !== 3)) fail('keys are compressed')
  }
  if (!Number.isSafeInteger(t.locktime) || t.locktime < LOCKTIME_THRESHOLD || t.locktime > 0xffffffff) fail('locktime is a unix time')
  if (chain === 'bsv' && !t.cosignPub) fail('a BSV HTLC names its refund co-signer')
  if (chain !== 'bsv' && t.cosignPub) fail('only a BSV HTLC has a refund co-signer')
}

/** The script that holds the coins (the witness or redeem script on the coin chains, the locking script on BSV). */
export function htlcScript(chain: SwapAsset, t: HtlcTerms): Bytes {
  checkTerms(chain, t)
  const secretCheck = concat(Uint8Array.of(OP.SIZE), push(Uint8Array.of(SECRET_BYTES)), Uint8Array.of(OP.EQUALVERIFY, OP.SHA256), push(t.hash), Uint8Array.of(OP.EQUALVERIFY))
  if (chain === 'bsv') {
    return concat(
      Uint8Array.of(OP.IF),
      secretCheck,
      push(t.claimPub),
      Uint8Array.of(OP.CHECKSIG, OP.ELSE),
      push(t.refundPub),
      Uint8Array.of(OP.CHECKSIGVERIFY),
      push(t.cosignPub!),
      Uint8Array.of(OP.CHECKSIG, OP.ENDIF),
    )
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

export type HtlcPath = { kind: 'claim'; preimage: Bytes; sig: Bytes } | { kind: 'refund'; sig: Bytes; cosig?: Bytes }

/** The unlocking data of an HTLC spend, as a scriptSig (P2SH, bare) or witness (P2WSH). */
export function htlcUnlock(chain: SwapAsset, script: Bytes, path: HtlcPath): { scriptSig: Bytes; witness: Bytes[] } {
  if (path.kind === 'claim' && path.preimage.length !== SECRET_BYTES) fail('the secret is 32 bytes')
  const kind = htlcKind(chain)
  if (kind === 'p2wsh') {
    const items = path.kind === 'claim' ? [path.sig, path.preimage, Uint8Array.of(1)] : [path.sig, new Uint8Array()]
    return { scriptSig: new Uint8Array(), witness: [...items, script] }
  }
  let body: Bytes
  if (path.kind === 'claim') body = concat(push(path.sig), push(path.preimage), Uint8Array.of(OP[1]))
  else if (chain === 'bsv') {
    if (!path.cosig) return fail('a BSV refund carries the co-signature')
    body = concat(push(path.cosig), push(path.sig), Uint8Array.of(OP[0]))
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
  const { coins, to, key, path } = args
  const total = coins.reduce((s, c) => s + c.amount, 0n)
  const locktime = path.kind === 'refund' ? path.locktime : 0
  const complete = (value: bigint): LtcTx => {
    const tx = htlcSpendTx(chain, coins, to, value, path.kind, locktime)
    coins.forEach((c, vin) => {
      const sig = htlcSignature(chain, tx, vin, c.script, c.amount, key)
      const unlock = htlcUnlock(chain, c.script, path.kind === 'claim' ? { kind: 'claim', preimage: path.preimage, sig } : { kind: 'refund', sig, ...(path.cosigs ? { cosig: path.cosigs[vin]! } : {}) })
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
