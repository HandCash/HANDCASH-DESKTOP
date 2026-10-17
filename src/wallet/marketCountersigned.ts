import type { Transaction } from '@bsv/sdk'
import type { CountersignDeploy } from './countersign/resolve'
import { readCountersigned, sameKeySets } from './countersign/script'

/**
 * Listing proof of a countersigned asset (csft units, a csnft item). The
 * offer token commits to its hash. The listed output itself proves the rest:
 * it is output 0 of a listing transaction the issuer countersigned, so the
 * asset, its units and its key sets are read from the script against the
 * deploy, and the issuer answers again at the sale.
 */
export type CountersignedListingProof = {
  v: 253
  assetId: string
  kind: 'token' | 'item'
  amt: string
}

const ASSET_ID_RE = /^[0-9a-f]{64}_\d+$/

export function parseCountersignedListingProof(raw: unknown): CountersignedListingProof | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 253) return null
  const assetId = typeof o.assetId === 'string' ? o.assetId.trim().toLowerCase().replace('.', '_') : ''
  const kind = o.kind === 'token' || o.kind === 'item' ? o.kind : null
  const amt = typeof o.amt === 'string' ? o.amt.trim() : ''
  if (!ASSET_ID_RE.test(assetId) || !kind || !/^[1-9]\d*$/.test(amt)) return null
  if (kind === 'item' && amt !== '1') return null
  return { v: 253, assetId, kind, amt }
}

export type CountersignedListingRefusal =
  | 'proof'
  | 'profile'
  | 'listed-output'
  | 'asset'
  | 'amount'
  | 'key-sets'
  | 'offer-output'

/**
 * Offline check of a countersigned listing before a buyer pays or an index
 * files it: output 0 is a held output of the advertised asset carrying the
 * advertised units under the deploy's key sets, and output 1 is the offer.
 */
export function checkCountersignedListing(args: {
  assetType: 'csft' | 'csnft'
  origin: string
  amt: number | undefined
  offerLockingScript: string
  proof: CountersignedListingProof
  listingTx: Transaction
  deploy: CountersignDeploy
}): { ok: true } | { ok: false; reason: CountersignedListingRefusal } {
  const origin = args.origin.trim().toLowerCase().replace('.', '_')
  if (args.proof.assetId !== origin || args.deploy.assetId !== origin) return { ok: false, reason: 'proof' }
  const kind = args.assetType === 'csnft' ? 'item' : 'token'
  if (args.deploy.kind !== kind || args.proof.kind !== kind) return { ok: false, reason: 'profile' }
  const listed = args.listingTx.outputs[0]
  const read = listed?.lockingScript ? readCountersigned(listed.lockingScript) : null
  if (!read || listed?.satoshis !== 1) return { ok: false, reason: 'listed-output' }
  if (read.assetId !== origin) return { ok: false, reason: 'asset' }
  if (read.amount.toString() !== args.proof.amt || String(args.amt ?? '') !== args.proof.amt) {
    return { ok: false, reason: 'amount' }
  }
  if (!sameKeySets(read.sets, args.deploy.sets)) return { ok: false, reason: 'key-sets' }
  const offer = args.listingTx.outputs[1]
  if (offer?.lockingScript?.toHex().toLowerCase() !== args.offerLockingScript.trim().toLowerCase()) {
    return { ok: false, reason: 'offer-output' }
  }
  return { ok: true }
}
