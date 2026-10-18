import type { LtcChain } from './chain'
import {
  fromHex,
  isCoinbase,
  LtcFormatError,
  ltcTxid,
  merkleRootFromProof,
  parseLtcHeader,
  parseLtcTx,
  sameBytes,
  scryptPowHash,
  serializeLtcTxNoWitness,
  targetFromBits,
  type Bytes,
  type LtcHeader,
} from './litecoin'

/**
 * Wallet-side SPV check of one Litecoin deposit. The explorer only supplies
 * bytes; the wallet itself proves the output pays the reserve, sits in a block
 * by merkle proof, and is buried under enough scrypt work that forging the
 * chain costs more than the deposit is worth.
 */

/**
 * Easiest target any header may claim. Mainnet sits near 2^198; a forged
 * header must still carry about a fifth of a real block's work, and a
 * difficulty drop past this stalls deposits (pending) rather than trusting
 * cheaper headers.
 */
export const LTC_TARGET_FLOOR = 1n << 200n
export const LTC_MIN_CONFIRMATIONS = 6
/** About a day of Litecoin blocks: the most headers one deposit is checked against. */
export const LTC_MAX_CONFIRMATIONS = 576
const LITOSHI_PER_LTC = 100_000_000n

/**
 * Headers a deposit must be buried under: six, plus one per whole LTC, so a
 * forged chain (each header at least a fifth of a block's work, a block paying
 * 6.25 LTC) costs more than the deposit it would mint.
 */
export function confirmationsFor(litoshi: bigint): number {
  const perLtc = Number((litoshi + LITOSHI_PER_LTC - 1n) / LITOSHI_PER_LTC)
  return Math.min(LTC_MAX_CONFIRMATIONS, Math.max(LTC_MIN_CONFIRMATIONS, perLtc))
}

export type DepositRefusal =
  | 'tx-mismatch'
  | 'malformed'
  | 'no-output'
  | 'wrong-script'
  | 'coinbase'
  | 'merkle'
  | 'header-hash'
  | 'chain-link'
  | 'pow'
  | 'difficulty-floor'

export type DepositVerdict =
  | { kind: 'credit'; txid: string; vout: number; litoshi: bigint; height: number; confirmations: number }
  | { kind: 'pending'; txid: string; vout: number; litoshi: bigint; confirmations: number; needed: number }
  | { kind: 'refuse'; txid: string; vout: number; reason: DepositRefusal; detail: string }

export type VerifyOptions = { floor?: bigint }

/**
 * Check `headers` (consecutive, oldest first) carry real work: each links to
 * the one before, meets its own bits, and claims no easier target than `floor`.
 */
export function checkHeaderRun(headers: readonly LtcHeader[], floor = LTC_TARGET_FLOOR): { ok: true } | { ok: false; reason: DepositRefusal; detail: string } {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!
    if (i > 0 && h.prevHash !== headers[i - 1]!.hash) return { ok: false, reason: 'chain-link', detail: `header ${i} does not build on header ${i - 1}` }
    const target = targetFromBits(h.bits)
    if (target === null) return { ok: false, reason: 'pow', detail: `header ${h.hash} has invalid bits` }
    if (target > floor) return { ok: false, reason: 'difficulty-floor', detail: `header ${h.hash} claims a target easier than the floor` }
    if (scryptPowHash(h.raw) > target) return { ok: false, reason: 'pow', detail: `header ${h.hash} does not meet its target` }
  }
  return { ok: true }
}

export async function verifyLtcDeposit(
  chain: LtcChain,
  outpoint: { txid: string; vout: number },
  reserveScript: Bytes,
  opts: VerifyOptions = {},
): Promise<DepositVerdict> {
  const { txid, vout } = outpoint
  const refuse = (reason: DepositRefusal, detail: string): DepositVerdict => {
    console.warn(`[wltc] refuse deposit ${txid}:${vout} ${reason} — ${detail}`)
    return { kind: 'refuse', txid, vout, reason, detail }
  }
  let tx
  try {
    tx = parseLtcTx(fromHex(await chain.txHex(txid)))
  } catch (err) {
    if (err instanceof LtcFormatError) return refuse('malformed', err.message)
    throw err
  }
  if (ltcTxid(tx) !== txid) return refuse('tx-mismatch', 'the transaction bytes do not hash to the txid')
  // A 64-byte transaction can pose as an inner merkle node (CVE-2017-12842).
  if (serializeLtcTxNoWitness(tx).length === 64) return refuse('malformed', 'a 64-byte transaction cannot be proven by merkle path')
  if (isCoinbase(tx)) return refuse('coinbase', 'coinbase outputs are not deposits')
  const output = tx.outputs[vout]
  if (!output) return refuse('no-output', `the transaction has no output ${vout}`)
  if (!sameBytes(output.script, reserveScript)) return refuse('wrong-script', 'the output does not pay the reserve address')
  const litoshi = output.value
  const needed = confirmationsFor(litoshi)

  const status = await chain.txStatus(txid)
  if (!status.confirmed) return { kind: 'pending', txid, vout, litoshi, confirmations: 0, needed }
  const proof = await chain.merkleProof(txid)
  const tip = await chain.tipHeight()
  const confirmations = tip - proof.blockHeight + 1
  if (confirmations < needed) return { kind: 'pending', txid, vout, litoshi, confirmations: Math.max(0, confirmations), needed }

  let root: Bytes
  try {
    root = merkleRootFromProof(txid, proof.merkle, proof.pos)
  } catch (err) {
    if (err instanceof LtcFormatError) return refuse('merkle', err.message)
    throw err
  }
  const headers: LtcHeader[] = []
  for (let i = 0; i < needed; i++) {
    const height = proof.blockHeight + i
    const expected = await chain.blockHashAt(height)
    let header: LtcHeader
    try {
      header = parseLtcHeader(await chain.header(expected))
    } catch (err) {
      if (err instanceof LtcFormatError) return refuse('header-hash', err.message)
      throw err
    }
    if (header.hash !== expected) return refuse('header-hash', `the header at ${height} does not hash to its block`)
    headers.push(header)
  }
  if (!sameBytes(headers[0]!.merkleRoot, root)) return refuse('merkle', "the proof does not reach the block's merkle root")
  const run = checkHeaderRun(headers, opts.floor)
  if (!run.ok) return refuse(run.reason, run.detail)
  return { kind: 'credit', txid, vout, litoshi, height: proof.blockHeight, confirmations }
}
