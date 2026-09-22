/**
 * Final pre-sign gate for BSV-21 spends.
 *
 * BRC-176 proves token grammar and conservation. Bitcoin validity is separate:
 * a locally complete token chain can still descend from a transaction Arcade
 * has objectively rejected as a double spend. Check only token ancestors so
 * unrelated funding-history noise cannot veto the send.
 */
import type { Beef } from '@bsv/sdk'
import type { ArcadeTxFate } from '../arcadeV2'
import type { Chain } from '../vault'
import { mapPool } from '../asyncPool'
import { collectBsv21TokenAncestryTxids } from './prove176'

export type Bsv21BroadcastValidity =
  | { kind: 'valid'; ancestryTxids: string[] }
  | {
      kind: 'refuse'
      reason: 'token-proof-invalid' | 'ancestor-rejected' | 'ancestor-pending'
      detail: string
      txid?: string
    }

export async function checkBsv21BroadcastValidity(args: {
  beef: Beef
  outpoints: string[]
  tokenId: string
  chain: Chain
  fetchFate?: (chain: Chain, txid: string) => Promise<ArcadeTxFate>
}): Promise<Bsv21BroadcastValidity> {
  let ancestryTxids: string[]
  try {
    ancestryTxids = collectBsv21TokenAncestryTxids({
      outpoints: args.outpoints,
      tokenId: args.tokenId,
      beef: args.beef,
    })
  } catch (error) {
    return {
      kind: 'refuse',
      reason: 'token-proof-invalid',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const fetchFate =
    args.fetchFate ??
    (await import('../arcadeV2')).fetchArcadeTxFate
  const fates = await mapPool(ancestryTxids, 3, async (txid) => ({
    txid,
    fate: await fetchFate(args.chain, txid),
  }))
  const rejected = fates.find(({ fate }) => fate.kind === 'rejected')
  if (rejected?.fate.kind === 'rejected') {
    return {
      kind: 'refuse',
      reason: 'ancestor-rejected',
      detail: rejected.fate.reason,
      txid: rejected.txid,
    }
  }
  const pending = fates.find(({ fate }) => fate.kind === 'retryable')
  if (pending?.fate.kind === 'retryable') {
    return {
      kind: 'refuse',
      reason: 'ancestor-pending',
      detail: pending.fate.reason,
      txid: pending.txid,
    }
  }
  return { kind: 'valid', ancestryTxids }
}

export function assertBsv21BroadcastValidity(
  validity: Bsv21BroadcastValidity,
): asserts validity is Extract<Bsv21BroadcastValidity, { kind: 'valid' }> {
  if (validity.kind === 'valid') return
  const ancestor = validity.txid ? ` ${validity.txid.slice(0, 12)}` : ''
  throw new Error(
    `BSV-21 send refused (${validity.reason}${ancestor}): ${validity.detail}`,
  )
}
