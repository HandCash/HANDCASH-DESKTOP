import type { LtcChain } from './chain'
import { getLtcAnchor, type LtcAnchor } from './headers'
import {
  fromHex,
  isCoinbase,
  LtcFormatError,
  ltcTxid,
  merkleRootFromProof,
  parseLtcHeader,
  parseLtcTx,
  sameBytes,
  serializeLtcTxNoWitness,
  toHex,
  type Bytes,
} from './litecoin'

/**
 * Litecoin facts behind wLTC. A deposit is credited when it is first seen
 * paying the reserve, as BSV credits an unproven payment. Its wLTC cannot move
 * until a burial proof exists (BRC-255 backed tokens): the deposit sits by
 * merkle proof in a block that the checker's own header chain (`headers.ts`)
 * holds at least {@link LTC_BURIAL_DEPTH} deep. The explorer only supplies
 * bytes; every receiver checks the proof against its own chain.
 */

/** Blocks a deposit must be buried under, its own included, before its wLTC moves. */
export const LTC_BURIAL_DEPTH = 6

export type DepositRefusal =
  | 'tx-mismatch'
  | 'malformed'
  | 'no-output'
  | 'wrong-script'
  | 'coinbase'
  | 'under-backed'
  | 'merkle'
  | 'header-hash'
  | 'shallow'
  | 'off-chain'
  | 'unanchored'

/** A deposit's burial: the raw transaction, its merkle path (display-hex siblings), its block's height and 80-byte header. */
export type LtcBurialProof = { tx: string; path: string[]; pos: number; height: number; header: string }

/**
 * `missing`: the proof may still check later (the block is not deep yet on
 * this chain, or the chain could not be read). Otherwise it never will.
 */
export type BurialCheck = { ok: true; litoshi: bigint } | { ok: false; reason: DepositRefusal; detail: string; missing: boolean }

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

const refused = (reason: DepositRefusal, detail: string, missing = false): BurialCheck => ({ ok: false, reason, detail, missing })

/**
 * Check a burial proof: the deposit pays the reserve at least `minted`
 * litoshi, the merkle path reaches the root of the proof's header, and
 * `anchor` holds that header at its height, {@link LTC_BURIAL_DEPTH} deep.
 */
export async function checkLtcBurial(
  proof: LtcBurialProof,
  outpoint: { txid: string; vout: number },
  reserveScript: Bytes,
  minted: bigint,
  anchor: LtcAnchor = getLtcAnchor(),
): Promise<BurialCheck> {
  let raw: Bytes
  try {
    raw = fromHex(proof.tx)
  } catch {
    return refused('malformed', 'the deposit is not hex')
  }
  const output = depositOutput(raw, outpoint, reserveScript)
  if (!output.ok) return refused(output.reason, output.detail)
  if (output.litoshi < minted) return refused('under-backed', `the deposit holds ${output.litoshi} litoshi, under the ${minted} minted`)
  let header
  let root: Bytes
  try {
    header = parseLtcHeader(fromHex(proof.header))
    root = merkleRootFromProof(outpoint.txid, proof.path, proof.pos)
  } catch (err) {
    if (err instanceof LtcFormatError) return refused('merkle', err.message)
    return refused('malformed', err instanceof Error ? err.message : String(err))
  }
  if (!sameBytes(header.merkleRoot, root)) return refused('merkle', "the path does not reach the block's merkle root")
  const anchored = await anchor.check(proof.height, header.hash, LTC_BURIAL_DEPTH)
  switch (anchored.kind) {
    case 'buried':
      return { ok: true, litoshi: output.litoshi }
    case 'shallow':
      return refused('shallow', `the deposit has ${anchored.confirmations} of ${LTC_BURIAL_DEPTH} confirmations on this wallet's Litecoin chain`, true)
    case 'off-chain':
      return refused('off-chain', `block ${proof.height} on this wallet's Litecoin chain is not the proof's block`)
    case 'unavailable':
      return refused('unanchored', `this wallet's Litecoin chain could not be read: ${anchored.detail}`, true)
  }
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
 * Gather the burial proof of a deposit once the explorer reports it deep
 * enough. The caller checks it with `checkLtcBurial`; nothing here is
 * trusted. `gone` means the explorer no longer knows the transaction
 * (replaced or reorganized away).
 */
export async function fetchLtcBurial(chain: LtcChain, txid: string): Promise<BurialFetch> {
  const needed = LTC_BURIAL_DEPTH
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
  const hash = await chain.blockHashAt(merkle.blockHeight)
  const raw = await chain.header(hash)
  if (parseLtcHeader(raw).hash !== hash) throw new Error(`the header at ${merkle.blockHeight} does not hash to its block`)
  return {
    kind: 'buried',
    proof: { tx: (await chain.txHex(txid)).toLowerCase(), path: merkle.merkle, pos: merkle.pos, height: merkle.blockHeight, header: toHex(raw) },
  }
}
