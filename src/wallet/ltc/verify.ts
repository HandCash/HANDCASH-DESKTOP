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
  type LtcTx,
} from './litecoin'

/**
 * Coin facts, for Litecoin and every chain with its transaction and header
 * formats ({@link CoinProofRules}). A received coin is recorded when it is
 * first seen paying this wallet's script, and spendable once a burial proof
 * exists: the coin's transaction sits by merkle proof in a block that the
 * checker's own header chain (`headers.ts`) holds at least `depth` deep. The
 * explorer only supplies bytes; the proof is checked against this chain.
 */

/** Blocks a received coin must be buried under, its own included, before it is spent. */
export const LTC_BURIAL_DEPTH = 6

/** What a burial check needs to know of the coin's chain; the checks are the same on every chain. */
export type CoinProofRules = {
  /** "Litecoin", in refusal details. */
  label: string
  /** Log tag. */
  tag: string
  /** The smallest unit's name, in refusal details. */
  unit: string
  /** Blocks a received coin must be buried under, its own included. */
  depth: number
  /** Strict transaction parse for this chain; throws {@link LtcFormatError}. */
  parseTx(raw: Bytes): LtcTx
  /** The wallet's own header chain for this coin. */
  anchor(): LtcAnchor
}

export const LTC_PROOF_RULES: CoinProofRules = {
  label: 'Litecoin',
  tag: 'ltc',
  unit: 'litoshi',
  depth: LTC_BURIAL_DEPTH,
  parseTx: parseLtcTx,
  anchor: getLtcAnchor,
}

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
 * `confirmations` comes with `shallow`: the count on this wallet's own chain.
 */
export type BurialCheck =
  | { ok: true; litoshi: bigint; blockTime: number }
  | { ok: false; reason: DepositRefusal; detail: string; missing: boolean; confirmations?: number }

type DepositOutput = { ok: true; litoshi: bigint } | { ok: false; reason: DepositRefusal; detail: string }

/** The transaction hashes to `txid`, is not a coinbase or 64 bytes, and output `vout` pays `reserveScript`. */
function depositOutput(raw: Bytes, outpoint: { txid: string; vout: number }, reserveScript: Bytes, rules: CoinProofRules): DepositOutput {
  let tx
  try {
    tx = rules.parseTx(raw)
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

const refused = (reason: DepositRefusal, detail: string, missing = false): Extract<BurialCheck, { ok: false }> => ({ ok: false, reason, detail, missing })

/**
 * Check a burial proof: the deposit pays the reserve at least `minted`
 * units, the merkle path reaches the root of the proof's header, and
 * `anchor` (by default the chain's own) holds that header at its height,
 * `rules.depth` deep.
 */
export async function checkLtcBurial(
  proof: LtcBurialProof,
  outpoint: { txid: string; vout: number },
  reserveScript: Bytes,
  minted: bigint,
  anchor?: LtcAnchor,
  rules: CoinProofRules = LTC_PROOF_RULES,
): Promise<BurialCheck> {
  let raw: Bytes
  try {
    raw = fromHex(proof.tx)
  } catch {
    return refused('malformed', 'the deposit is not hex')
  }
  const output = depositOutput(raw, outpoint, reserveScript, rules)
  if (!output.ok) return refused(output.reason, output.detail)
  if (output.litoshi < minted) return refused('under-backed', `the deposit holds ${output.litoshi} ${rules.unit}, under the ${minted} recorded`)
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
  const anchored = await (anchor ?? rules.anchor()).check(proof.height, header.hash, rules.depth)
  switch (anchored.kind) {
    case 'buried':
      return { ok: true, litoshi: output.litoshi, blockTime: header.time }
    case 'shallow':
      return {
        ...refused('shallow', `the deposit has ${anchored.confirmations} of ${rules.depth} confirmations on this wallet's ${rules.label} chain`, true),
        confirmations: anchored.confirmations,
      }
    case 'off-chain':
      return refused('off-chain', `block ${proof.height} on this wallet's ${rules.label} chain is not the proof's block`)
    case 'unavailable':
      return refused('unanchored', `this wallet's ${rules.label} chain could not be read: ${anchored.detail}`, true)
  }
}

export type DepositSighting =
  | { kind: 'seen'; txid: string; vout: number; litoshi: bigint }
  | { kind: 'refuse'; txid: string; vout: number; reason: DepositRefusal; detail: string }

/** First sight of a deposit: its bytes hash to the txid and the output pays the reserve. Nothing about its block. */
export async function readLtcDeposit(
  chain: LtcChain,
  outpoint: { txid: string; vout: number },
  reserveScript: Bytes,
  rules: CoinProofRules = LTC_PROOF_RULES,
): Promise<DepositSighting> {
  const { txid, vout } = outpoint
  let raw: Bytes
  try {
    raw = fromHex(await chain.txHex(txid))
  } catch (err) {
    if (err instanceof LtcFormatError) return { kind: 'refuse', txid, vout, reason: 'malformed', detail: err.message }
    throw err
  }
  const output = depositOutput(raw, outpoint, reserveScript, rules)
  if (!output.ok) {
    console.warn(`[${rules.tag}] refuse coin ${txid}:${vout} ${output.reason} — ${output.detail}`)
    return { kind: 'refuse', txid, vout, reason: output.reason, detail: output.detail }
  }
  return { kind: 'seen', txid, vout, litoshi: output.litoshi }
}

/**
 * Where an explorer says a deposit is. `in-block` carries a burial proof built
 * from its answer, which only `checkLtcBurial` can confirm: the explorer never
 * decides how deep the deposit is. `unconfirmed` is the explorer's word that
 * the transaction waits for a block; `gone`, that it no longer knows it
 * (replaced or reorganized away).
 */
export type DepositLocation = { kind: 'in-block'; proof: LtcBurialProof } | { kind: 'unconfirmed' } | { kind: 'gone' }

export async function locateLtcDeposit(chain: LtcChain, txid: string): Promise<DepositLocation> {
  const status = await chain.txStatus(txid).catch((err: unknown) => {
    if (err instanceof Error && /\b404\b|not found/i.test(err.message)) return null
    throw err
  })
  if (!status) return { kind: 'gone' }
  if (!status.confirmed) return { kind: 'unconfirmed' }
  const merkle = await chain.merkleProof(txid)
  const hash = await chain.blockHashAt(merkle.blockHeight)
  const raw = await chain.header(hash)
  if (parseLtcHeader(raw).hash !== hash) throw new Error(`the header at ${merkle.blockHeight} does not hash to its block`)
  return {
    kind: 'in-block',
    proof: { tx: (await chain.txHex(txid)).toLowerCase(), path: merkle.merkle, pos: merkle.pos, height: merkle.blockHeight, header: toHex(raw) },
  }
}
