/**
 * Item art decoded from bytes alone: no storage, no DOM, so it runs in the
 * compute worker as well as on the main thread.
 */
import { Beef } from '@bsv/sdk'
import type { ItemArt, ItemArtRequest } from '../ports/computePort'
import { base64ToBytes } from './base64Binary'
import { imageMimeFor } from './inscriptionImage'
import { parseOrdEnvelope } from './ordinalOwnership'

/**
 * One item may not own the store. Studio items cap at 100 KB; this leaves room
 * for a hand-built inscription without letting a 2 MB ordinal in.
 */
export const MAX_ITEM_ART_BYTES = 256 * 1024

export function originArtKey(origin: string): string {
  return origin.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

export function splitArtOrigin(origin: string): { txid: string; vout: number } | null {
  const m = /^([0-9a-f]{64})_(\d+)$/.exec(originArtKey(origin))
  if (!m) return null
  return { txid: m[1]!, vout: Number(m[2]) }
}

export function scriptHexFromBeef(beef: Beef, txid: string, vout: number): string | undefined {
  const tx = beef.findTxid(txid)?.tx ?? beef.findAtomicTransaction(txid)
  return tx?.outputs?.[vout]?.lockingScript?.toHex()
}

/** The picture an ord envelope carries, or null for text, oversize or no envelope. */
export function artFromScript(scriptHex: string | undefined): ItemArt | null {
  const env = parseOrdEnvelope(scriptHex)
  if (!env?.body.length || env.body.length > MAX_ITEM_ART_BYTES) return null
  const mime = imageMimeFor(env.contentType, env.body)?.split(';')[0]!.trim()
  if (!mime) return null
  return { mime, body: env.body }
}

/**
 * Art from a peer's BRC-150 remittance. The BEEF spans tip→origin, so decoding
 * it hashes every transaction in the lineage: the costly part of painting a
 * received item, and why it runs off the main thread.
 */
export function decodeItemArtFromProvenance(request: ItemArtRequest): ItemArt | null {
  const parts = splitArtOrigin(request.origin)
  if (!parts) return null
  try {
    const beef = Beef.fromBinary(Array.from(base64ToBytes(request.beefB64)))
    return artFromScript(scriptHexFromBeef(beef, parts.txid, parts.vout))
  } catch {
    return null
  }
}
