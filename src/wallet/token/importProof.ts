/**
 * What a BSV-21 tip import may record: the tip's own bytes and its BRC-176
 * walk, never the classifier's word alone.
 *
 * Chain ingest names tips through an indexer and files what it cannot prove
 * yet as unproven — the held-tip heal binds it later. A claim by txid
 * (`recoverFromTx`, reconcile restores) has no index behind it, so it
 * requires the walk, exactly like an inbound settle.
 */
import type { Beef } from '@bsv/sdk'
import { decodeTokenOutput, fillTokenParentBodies, prove } from './prove176'
import { provenTokenDeployOf } from './lineage'
import { normalizeTokenId, type Bsv21Op } from './types'

export type TokenImportVerdict =
  | { kind: 'proven'; deployOutpoint: string }
  /** Bytes agree with the claim; the walk is left to the held-tip heal. */
  | { kind: 'unproven'; reason: string }
  | { kind: 'refused'; reason: string }

export async function judgeTokenImport(args: {
  beef: Beef
  txid: string
  vout: number
  tokenId: string
  amt: string
  op: Bsv21Op
  requireLineage: boolean
  fetchBody: (txid: string) => Promise<Beef | null | undefined>
}): Promise<TokenImportVerdict> {
  const tip = `${args.txid}_${args.vout}`
  const script = args.beef.findTxid(args.txid)?.tx?.outputs[args.vout]?.lockingScript
  const decoded = decodeTokenOutput(script)
  if (!decoded) {
    return args.requireLineage
      ? { kind: 'refused', reason: 'not-bsv21' }
      : { kind: 'unproven', reason: 'tip bytes not decoded' }
  }

  const expectedId = args.op === 'deploy+mint' ? tip : normalizeTokenId(args.tokenId)
  const decodedId = decoded.role === 'deploy' ? tip : decoded.tokenId ? normalizeTokenId(decoded.tokenId) : null
  if (decoded.role === 'authority' || !decodedId || decodedId !== expectedId) {
    return { kind: 'refused', reason: `token-id-mismatch:${(decodedId ?? decoded.role).slice(0, 16)}` }
  }
  let claimed: bigint
  try {
    claimed = BigInt(args.amt)
  } catch {
    return { kind: 'refused', reason: 'amount-unreadable' }
  }
  if (decoded.amount !== claimed) return { kind: 'refused', reason: 'amount-mismatch' }

  let proof = prove(tip, args.beef, provenTokenDeployOf)
  if (!proof.ok && args.requireLineage) {
    const filled = await fillTokenParentBodies(args.beef, args.fetchBody, [args.txid], provenTokenDeployOf)
    proof = prove(tip, filled, provenTokenDeployOf)
  }
  if (!proof.ok) {
    const reason = proof.reason.slice(0, 120)
    return args.requireLineage
      ? { kind: 'refused', reason: `lineage-unproven:${reason}` }
      : { kind: 'unproven', reason }
  }
  if (proof.tokenId !== expectedId) {
    return { kind: 'refused', reason: `token-id-mismatch:${proof.tokenId.slice(0, 16)}` }
  }
  return { kind: 'proven', deployOutpoint: proof.deployOutpoint }
}
