import { decodeBsv21Binary, isBsv21Mime, parseBsv21Json } from './token'
import { parseOrdEnvelope } from './ordinalOwnership'

/**
 * Why a tip the seller asked to list as BSV-21 is not listable.
 *
 * Settlement builds the buyer output with `buildBsv21ValueLock`, so a listing
 * only exists for a BRC-162 value lock. Everything else has to refuse — but
 * the reasons are not the same problem and must not share one message:
 * a missing script is a local read to retry, a legacy JSON inscription is
 * read-only forever, and a non-token is the wrong asset type entirely.
 */
export type Bsv21ListingRefusal =
  | 'no-locking-script'
  | 'legacy-json'
  | 'authority-lock'
  | 'not-a-token'

export type Bsv21ListingLock =
  | {
      lock: 'value'
      lockingScriptHex: string
      tokenId: string | null
      amount: bigint
    }
  | { lock: 'refuse'; reason: Bsv21ListingRefusal; message: string }

const BSV21_REFUSAL_MESSAGE: Record<Bsv21ListingRefusal, string> = {
  'no-locking-script':
    'This tip’s locking script is not in the wallet yet. Refresh, then list again.',
  'legacy-json':
    'This is a legacy JSON BSV-21 token. Those are read-only — only BRC-162 tokens can be listed.',
  'authority-lock':
    'A BSV-21 authority output holds no units, so there is nothing to list.',
  'not-a-token': 'BSV-21 listing requires a 162 value lock.',
}

function refuseBsv21Listing(reason: Bsv21ListingRefusal): Bsv21ListingLock {
  return { lock: 'refuse', reason, message: BSV21_REFUSAL_MESSAGE[reason] }
}

/** Does this locking script carry a legacy JSON `bsv-20` holding? */
function holdsLegacyJsonBsv21(lockingScriptHex: string): boolean {
  const env = parseOrdEnvelope(lockingScriptHex)
  if (!env) return false
  const mime = (env.contentType ?? '').toLowerCase().split(';')[0]!.trim()
  if (!env.body?.length) return isBsv21Mime(mime)
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(env.body))
    if (parseBsv21Json(json)) return true
  } catch {
    /* not a JSON body */
  }
  return isBsv21Mime(mime)
}

/**
 * Decide whether a held tip can back a BSV-21 listing, naming the refusal.
 * Pure: the caller supplies the script it read from the basket row.
 */
export function chooseBsv21ListingLock(
  lockingScriptHex: string | undefined,
): Bsv21ListingLock {
  const hex = lockingScriptHex?.trim().toLowerCase()
  if (!hex) return refuseBsv21Listing('no-locking-script')
  const decoded = decodeBsv21Binary(hex)
  if (decoded) {
    if (decoded.role === 'authority' || decoded.amount <= 0n) {
      return refuseBsv21Listing('authority-lock')
    }
    return {
      lock: 'value',
      lockingScriptHex: hex,
      tokenId: decoded.tokenId?.toLowerCase() ?? null,
      amount: decoded.amount,
    }
  }
  if (holdsLegacyJsonBsv21(hex)) return refuseBsv21Listing('legacy-json')
  return refuseBsv21Listing('not-a-token')
}

export type MarketListingPath =
  | { path: 'createOffer'; itemOutpoint: string }
  | {
      path: 'refuse'
      reason: 'not-one-sat' | 'not-ordinal' | 'unproven-origin' | 'invalid-terms'
    }

export type MarketCancelPath =
  | { path: 'spendOffer'; offerOutpoint: string }
  | {
      path: 'refuse'
      reason: 'offer-not-held' | 'offer-invalid' | 'listing-not-active'
    }

export function chooseMarketListingPath(args: {
  itemOutpoint: string
  satoshis: number
  ordinal: boolean
  provenanceProven: boolean
  termsValid: boolean
}): MarketListingPath {
  if (args.satoshis !== 1) return { path: 'refuse', reason: 'not-one-sat' }
  if (!args.ordinal) return { path: 'refuse', reason: 'not-ordinal' }
  if (!args.provenanceProven) return { path: 'refuse', reason: 'unproven-origin' }
  if (!args.termsValid) return { path: 'refuse', reason: 'invalid-terms' }
  return { path: 'createOffer', itemOutpoint: args.itemOutpoint }
}

export function chooseMarketCancelPath(args: {
  offerOutpoint: string
  held: boolean
  valid: boolean
  active: boolean
}): MarketCancelPath {
  if (!args.held) return { path: 'refuse', reason: 'offer-not-held' }
  if (!args.valid) return { path: 'refuse', reason: 'offer-invalid' }
  if (!args.active) return { path: 'refuse', reason: 'listing-not-active' }
  return { path: 'spendOffer', offerOutpoint: args.offerOutpoint }
}
