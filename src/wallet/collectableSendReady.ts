/**
 * Whether a held collectable may be sent from this device right now.
 *
 * **Verified** (BRC-150 verdict) is enough to enable Send. The display badge
 * does not require the ~400k remittance blob to still be in localStorage —
 * that proof is omitted when over budget, and must not gray every verified
 * Pixel Fox. Send attaches stored remittance when present and does not
 * re-walk hops.
 *
 * Send stays inactive only when authenticity is still in flight, the tip is
 * unproven, or we *know* the tip tx has no merkle bump yet (unconfirmed).
 */
import { Beef, Utils } from '@bsv/sdk'
import { peekSessionBeef } from './beefCache'
import { getRememberedProvenanceRemittance } from './oneSatProvenance'
import { getProvenVerdict } from './provenCache'

export type CollectableSendReadyReason =
  | 'verifying'
  | 'unproven'
  | 'unconfirmed'

export type CollectableSendReady =
  | { ready: true }
  | { ready: false; reason: CollectableSendReadyReason }

const knownUnconfirmed = new Map<string, boolean>()

function tipTxid(outpoint: string): string | null {
  const id = outpoint
    .trim()
    .toLowerCase()
    .replace(/_(\d+)$/, '.$1')
    .split('.')[0]
  return id && /^[0-9a-f]{64}$/.test(id) ? id : null
}

function beefTipHasMerkle(beef: Beef, txid: string): boolean | null {
  const entry = beef.findTxid(txid)
  if (!entry?.tx || entry.isTxidOnly) return null
  return typeof entry.bumpIndex === 'number' && entry.bumpIndex >= 0
}

function remittanceBeef(outpoint: string): Beef | null {
  const rem = getRememberedProvenanceRemittance(outpoint)
  if (!rem?.beefB64) return null
  try {
    return Beef.fromBinary(Utils.toArray(rem.beefB64, 'base64'))
  } catch {
    return null
  }
}

/** Stored remittance BEEF for this tip — no network. */
export function storedCollectableInputBeef(outpoint: string): number[] | null {
  const beef = remittanceBeef(outpoint)
  if (!beef) return null
  try {
    return beef.toBinary()
  } catch {
    return null
  }
}

export function collectableSendReadyMessage(
  reason: CollectableSendReadyReason,
): string {
  if (reason === 'verifying') {
    return 'This collectable is still verifying authenticity.'
  }
  if (reason === 'unproven') {
    return 'Send is available after authenticity is verified.'
  }
  return 'This collectable is not confirmed on chain yet.'
}

/**
 * Known-unconfirmed only: a local tip body with no merkle bump.
 * Missing BEEF is not unconfirmed — verified inventory would all go gray.
 */
function tipKnownUnconfirmed(outpoint: string, txid: string): boolean {
  if (knownUnconfirmed.get(txid) === true) return true
  let known = false
  try {
    const fromRem = remittanceBeef(outpoint)
    const remMerkle = fromRem ? beefTipHasMerkle(fromRem, txid) : null
    if (remMerkle === false) known = true
    else if (remMerkle !== true) {
      const cached = peekSessionBeef(txid)
      if (cached && beefTipHasMerkle(cached, txid) === false) known = true
    }
  } catch {
    known = false
  }
  if (known) knownUnconfirmed.set(txid, true)
  return known
}

export function inspectCollectableSendReady(args: {
  outpoint: string
  proven: boolean
  verifying: boolean
}): CollectableSendReady {
  if (args.verifying && !args.proven) {
    return { ready: false, reason: 'verifying' }
  }
  const verdict = getProvenVerdict(args.outpoint)
  if (!args.proven && verdict?.tier !== 'brc150') {
    return { ready: false, reason: 'unproven' }
  }
  const txid = tipTxid(args.outpoint)
  if (!txid) return { ready: false, reason: 'unproven' }
  if (tipKnownUnconfirmed(args.outpoint, txid)) {
    return { ready: false, reason: 'unconfirmed' }
  }
  return { ready: true }
}

/** Test helper. */
export function resetCollectableSendReadyForTests(): void {
  knownUnconfirmed.clear()
}
