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
  toHex,
  type Bytes,
  type LtcHeader,
} from './litecoin'

/**
 * Litecoin facts behind wLTC. A deposit is credited when it is first seen
 * paying the reserve, as BSV credits an unproven payment. Its wLTC cannot move
 * until a burial proof exists (BRC-255 backed tokens): the deposit sits in a
 * block by merkle proof, under enough linked scrypt headers that forging them
 * costs more than the deposit is worth. Every receiver checks that proof
 * offline; the explorer only supplies bytes.
 */

/**
 * Easiest target any header may claim. Mainnet sits near 2^198; a forged
 * header must still carry about a fifth of a real block's work, and a
 * difficulty drop past this stalls proofs rather than trusting cheaper headers.
 */
export const LTC_TARGET_FLOOR = 1n << 200n
export const LTC_MIN_CONFIRMATIONS = 2
/** About a day of Litecoin blocks: the most headers one proof may carry. */
export const LTC_MAX_CONFIRMATIONS = 576
const LITOSHI_PER_LTC = 100_000_000n

/**
 * Headers a deposit must be buried under before its wLTC moves: two, or one
 * per whole LTC if that is more, so a forged chain (each header at least a
 * fifth of a block's work, a block paying 6.25 LTC) costs more than the deposit.
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
  | 'under-backed'
  | 'shallow'
  | 'merkle'
  | 'header-hash'
  | 'chain-link'
  | 'pow'
  | 'difficulty-floor'

/** A deposit's burial: the raw transaction, its merkle path (display-hex siblings), and the headers from its block up, oldest first. */
export type LtcBurialProof = { tx: string; path: string[]; pos: number; headers: string[] }

export type BurialCheck = { ok: true; litoshi: bigint } | { ok: false; reason: DepositRefusal; detail: string }

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

type DepositOutput = { ok: true; litoshi: bigint } | { ok: false; reason: DepositRefusal; detail: string }

/** The transaction hashes to `txid`, is not a coinbase or 64 bytes, and output `vout` pays `reserveScript`. */
function depositOutput(raw: Bytes, outpoint: { txid: string; vout: number }, reserveScript: Bytes): DepositOutput {
  let tx
  try {
    tx = parseLtcTx(raw)
  } catch (err) {
    if (err instanceof LtcFormatError) return { ok: false, reason: 'malformed', detail: err.message }
    throw err
  }
  if (ltcTxid(tx) !== outpoint.txid) return { ok: false, reason: 'tx-mismatch', detail: 'the transaction bytes do not hash to the txid' }
  // A 64-byte transaction can pose as an inner merkle node (CVE-2017-12842).
  if (serializeLtcTxNoWitness(tx).length === 64) return { ok: false, reason: 'malformed', detail: 'a 64-byte transaction cannot be proven by merkle path' }
  if (isCoinbase(tx)) return { ok: false, reason: 'coinbase', detail: 'coinbase outputs are not deposits' }
  const output = tx.outputs[outpoint.vout]
  if (!output) return { ok: false, reason: 'no-output', detail: `the transaction has no output ${outpoint.vout}` }
  if (!sameBytes(output.script, reserveScript)) return { ok: false, reason: 'wrong-script', detail: 'the output does not pay the reserve address' }
  return { ok: true, litoshi: output.value }
}

/**
 * Offline check of a burial proof: the deposit pays the reserve at least
 * `minted` litoshi, the merkle path reaches the first header's root, and the
 * headers carry the depth `confirmationsFor` asks of its value.
 */
export function checkLtcBurial(
  proof: LtcBurialProof,
  outpoint: { txid: string; vout: number },
  reserveScript: Bytes,
  minted: bigint,
  floor = LTC_TARGET_FLOOR,
): BurialCheck {
  let raw: Bytes
  try {
    raw = fromHex(proof.tx)
  } catch {
    return { ok: false, reason: 'malformed', detail: 'the deposit is not hex' }
  }
  const output = depositOutput(raw, outpoint, reserveScript)
  if (!output.ok) return output
  if (output.litoshi < minted) return { ok: false, reason: 'under-backed', detail: `the deposit holds ${output.litoshi} litoshi, under the ${minted} minted` }
  const needed = confirmationsFor(output.litoshi)
  if (proof.headers.length < needed) return { ok: false, reason: 'shallow', detail: `the proof carries ${proof.headers.length} headers; ${needed} are needed` }
  if (proof.headers.length > LTC_MAX_CONFIRMATIONS) return { ok: false, reason: 'malformed', detail: `a proof carries at most ${LTC_MAX_CONFIRMATIONS} headers` }
  let root: Bytes
  const headers: LtcHeader[] = []
  try {
    root = merkleRootFromProof(outpoint.txid, proof.path, proof.pos)
    for (const hex of proof.headers) headers.push(parseLtcHeader(fromHex(hex)))
  } catch (err) {
    if (err instanceof LtcFormatError) return { ok: false, reason: 'merkle', detail: err.message }
    return { ok: false, reason: 'malformed', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!sameBytes(headers[0]!.merkleRoot, root)) return { ok: false, reason: 'merkle', detail: "the path does not reach the block's merkle root" }
  const run = checkHeaderRun(headers, floor)
  if (!run.ok) return run
  return { ok: true, litoshi: output.litoshi }
}

export type DepositSighting =
  | { kind: 'seen'; txid: string; vout: number; litoshi: bigint }
  | { kind: 'refuse'; txid: string; vout: number; reason: DepositRefusal; detail: string }

/** First sight of a deposit: its bytes hash to the txid and the output pays the reserve. Nothing about its block. */
export async function readLtcDeposit(chain: LtcChain, outpoint: { txid: string; vout: number }, reserveScript: Bytes): Promise<DepositSighting> {
  const { txid, vout } = outpoint
  let raw: Bytes
  try {
    raw = fromHex(await chain.txHex(txid))
  } catch (err) {
    if (err instanceof LtcFormatError) return { kind: 'refuse', txid, vout, reason: 'malformed', detail: err.message }
    throw err
  }
  const output = depositOutput(raw, outpoint, reserveScript)
  if (!output.ok) {
    console.warn(`[wltc] refuse deposit ${txid}:${vout} ${output.reason} — ${output.detail}`)
    return { kind: 'refuse', txid, vout, reason: output.reason, detail: output.detail }
  }
  return { kind: 'seen', txid, vout, litoshi: output.litoshi }
}

export type BurialFetch =
  | { kind: 'buried'; proof: LtcBurialProof }
  | { kind: 'pending'; confirmations: number; needed: number }
  | { kind: 'gone' }

/**
 * Gather the burial proof of a deposit once it is deep enough. The caller
 * checks it with `checkLtcBurial`; nothing here is trusted. `gone` means the
 * explorer no longer knows the transaction (replaced or reorganized away).
 */
export async function fetchLtcBurial(chain: LtcChain, txid: string, litoshi: bigint): Promise<BurialFetch> {
  const needed = confirmationsFor(litoshi)
  const status = await chain.txStatus(txid).catch((err: unknown) => {
    if (err instanceof Error && /\b404\b|not found/i.test(err.message)) return null
    throw err
  })
  if (!status) return { kind: 'gone' }
  if (!status.confirmed) return { kind: 'pending', confirmations: 0, needed }
  const merkle = await chain.merkleProof(txid)
  const tip = await chain.tipHeight()
  const confirmations = tip - merkle.blockHeight + 1
  if (confirmations < needed) return { kind: 'pending', confirmations: Math.max(0, confirmations), needed }
  const headers: string[] = []
  for (let i = 0; i < needed; i++) {
    const hash = await chain.blockHashAt(merkle.blockHeight + i)
    const raw = await chain.header(hash)
    if (parseLtcHeader(raw).hash !== hash) throw new Error(`the header at ${merkle.blockHeight + i} does not hash to its block`)
    headers.push(toHex(raw))
  }
  return { kind: 'buried', proof: { tx: (await chain.txHex(txid)).toLowerCase(), path: merkle.merkle, pos: merkle.pos, headers } }
}
