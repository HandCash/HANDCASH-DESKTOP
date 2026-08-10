/**
 * Resolve the shared media outpoint for a derivative tip (Kit Kat pattern).
 *
 * Preference for peer remittance:
 * 1. Explicit `content` already on customInstructions / tags
 * 2. BRC-160 field 3 parent on the origin envelope
 * 3. uri-list / ord:// body on the origin envelope
 */

import { parseContentReference } from './derivativeContent'
import { parseOrdEnvelope } from './ordinalOwnership'

export function resolveDerivativeContent(args: {
  /** Prior remittance / tags claim. */
  claimed?: string | null
  /** Origin locking script hex (from BEEF). */
  originScriptHex?: string | null
  /** Indexer text body when MIME is a reference type. */
  referenceBody?: string | null
  referenceMime?: string | null
}): string | null {
  const claimed = (args.claimed ?? '').trim()
  if (/^[0-9a-f]{64}_\d+$/i.test(claimed.replace(/\.(\d+)$/, '_$1'))) {
    return claimed.toLowerCase().replace(/\.(\d+)$/, '_$1')
  }

  const envelope = parseOrdEnvelope(args.originScriptHex ?? undefined)
  if (envelope?.parent) return envelope.parent

  if (envelope) {
    const fromBody = parseContentReference(envelope.body, envelope.contentType)
    if (fromBody) return fromBody
  }

  if (args.referenceBody) {
    const fromRef = parseContentReference(args.referenceBody, args.referenceMime)
    if (fromRef) return fromRef
  }

  return null
}
