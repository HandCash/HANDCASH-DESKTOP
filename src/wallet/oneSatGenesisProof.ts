/**
 * One-time BRC-150 lineage proof for a tip that arrived without one.
 *
 * An ordinal imported from an indexer carries no remittance, and the BEEF the
 * wallet holds for its tip stops at that transaction — so `rebuildProvenanceV2FromBeef`
 * has nothing older to walk and every imported item stays `unproven` forever.
 * Such an item then sends without a BRC-150 proof, and the recipient inherits the
 * same unproven claim.
 *
 * This breaks that loop by hydrating the ancestry itself — one transaction per
 * hop, each with its own merkle proof — and then handing the assembled BEEF to
 * the existing verifier. Parents are read out of the transactions (`sourceTXID`),
 * never from an indexer, so a lying indexer can only make the walk fail, never
 * make it pass.
 *
 * The result is worth its cost exactly once: the verdict is pinned, the assembled
 * BEEF is thrown away (it runs to hundreds of kilobytes — see
 * `INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX`), and the next send can go hardened.
 */
import { Beef } from '@bsv/sdk'
import {
  deriveOneSatPathFromBeef,
  findOrdinalParentVin,
  verifyProvenanceV2,
} from './oneSatProvenance'
import { hasOrdEnvelope } from './ordinalOwnership'

/** Hops walked before we give up. Deep enough for a decade of transfers. */
export const MAX_GENESIS_HOPS = 64
/**
 * Input sources hydrated per hop while resolving FIFO mapping.
 *
 * A transfer spends the ordinal plus a little funding, so the sat is usually
 * in the first inputs. Hydration is in vin order and stops once mapping is
 * known (canonical i0→o0 fetches only the parent). The cap stops a transaction
 * with hundreds of inputs from turning one hop into a fetch storm.
 */
const MAX_PARENT_CANDIDATES = 8

export type GenesisProof = {
  /** Underscore form, proven by verified BEEF rather than claimed. */
  origin: string
  /** Tip → origin, every step spending the one before it. */
  path: string[]
  hops: number
  /**
   * The whole assembled lineage, serialized. A sender needs this to put a
   * complete BRC-150 remittance on the wire; discard it once the verdict is
   * pinned, because it runs to hundreds of kilobytes.
   */
  beef: number[]
}

const POINT = /^([0-9a-f]{64})_(\d+)$/

function toPoint(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

/**
 * Walk a held tip back to the inscription that created it and prove the path.
 *
 * `getBeef` must return a BEEF whose subject transaction carries a merkle proof;
 * `verifyProvenanceV2` rejects anything it cannot structurally prove, so an
 * unmined or unprovable hop fails the whole attempt rather than weakening it.
 */
export async function proveGenesisLineage(args: {
  tipOutpoint: string
  getBeef: (txid: string) => Promise<Beef>
  maxHops?: number
  /**
   * Consulted before each hop. A walk is worth abandoning the moment something
   * the user is waiting on needs the thread — merkle verification is synchronous
   * CPU, so yielding between fetches is not enough on a phone.
   */
  shouldStop?: () => boolean
  /**
   * Abort once merged BEEF inputs exceed this many bytes (upper bound via sum of
   * fetched piece lengths). Used by send remittance so we do not walk a deep
   * lineage only to omit it for being over the wire budget.
   */
  maxBeefBytes?: number
}): Promise<GenesisProof | null> {
  const tip = toPoint(args.tipOutpoint)
  if (!POINT.test(tip)) return null
  const maxHops = args.maxHops ?? MAX_GENESIS_HOPS
  const maxBeefBytes = args.maxBeefBytes

  const merged = new Beef()
  const fetched = new Set<string>()
  let fetchedBytes = 0

  const hydrate = async (txid: string): Promise<void> => {
    if (fetched.has(txid)) return
    fetched.add(txid)
    const piece = (await args.getBeef(txid)).toBinary()
    fetchedBytes += piece.length
    if (maxBeefBytes != null && fetchedBytes > maxBeefBytes) {
      throw new Error('genesis-lineage-over-budget')
    }
    merged.mergeBeef(piece)
  }

  const outputAt = (point: string) => {
    const match = POINT.exec(point)
    if (!match) return null
    const tx = merged.findTxid(match[1]!)?.tx
    return tx ? { tx, output: tx.outputs[Number(match[2])] } : null
  }

  let point = tip
  let origin: string | null = null
  let hops = 0
  for (; hops <= maxHops; hops++) {
    if (args.shouldStop?.()) return null
    // Let the UI paint between hops — phone main thread otherwise freezes for
    // the whole walk (tens of seconds on deep Pixel Foxes lineages).
    if (hops > 0) await new Promise<void>((r) => setTimeout(r, 0))
    const match = POINT.exec(point)
    if (!match) return null
    try {
      await hydrate(match[1]!)
    } catch (err) {
      if (err instanceof Error && err.message === 'genesis-lineage-over-budget') {
        console.info(
          `[brc-150] stop lineage hydrate — assembled BEEF would exceed remittance budget (${fetchedBytes} bytes, ${hops} hop(s))`,
        )
        return null
      }
      return null
    }

    const here = outputAt(point)
    // A lineage that runs through anything but a single satoshi is not an
    // ordinal lineage; stop rather than invent one.
    if (!here?.output || here.output.satoshis !== 1) return null
    if (hasOrdEnvelope(here.output.lockingScript?.toHex())) {
      origin = point
      break
    }
    if (hops === maxHops) return null

    const vout = Number(match[2])
    let parent: string | null = null
    for (let vin = 0; vin < Math.min(here.tx.inputs.length, MAX_PARENT_CANDIDATES); vin++) {
      const srcTxid = String(here.tx.inputs[vin]?.sourceTXID ?? '').toLowerCase()
      const srcVout = here.tx.inputs[vin]?.sourceOutputIndex
      if (!/^[0-9a-f]{64}$/.test(srcTxid) || !Number.isSafeInteger(srcVout)) return null
      try {
        await hydrate(srcTxid)
      } catch (err) {
        if (err instanceof Error && err.message === 'genesis-lineage-over-budget') {
          console.info(
            `[brc-150] stop lineage hydrate — assembled BEEF would exceed remittance budget (${fetchedBytes} bytes, ${hops} hop(s))`,
          )
          return null
        }
        return null
      }
      const ordinalVin = findOrdinalParentVin(merged, here.tx, vout)
      if (ordinalVin == null) continue
      const input = here.tx.inputs[ordinalVin]!
      const parentTxid = String(input.sourceTXID ?? '').toLowerCase()
      const parentVout = input.sourceOutputIndex
      if (!/^[0-9a-f]{64}$/.test(parentTxid) || !Number.isSafeInteger(parentVout)) return null
      parent = `${parentTxid}_${parentVout}`
      break
    }
    if (!parent) return null
    point = parent
  }

  if (!origin) return null

  // Re-derive the path from the hydrated BEEF and verify it with the shared
  // verifier, so the proof never rests on the order this walk happened to take.
  //
  // The BEEF is serialized whole rather than atomically: AtomicBEEF keeps only
  // the subject and its recursive dependencies, and a mined tip carrying its own
  // merkle proof depends on nothing — which strips the very ancestry being
  // proven and is why the older rebuild could never prove a confirmed item.
  const path = deriveOneSatPathFromBeef(merged, tip, origin)
  if (!path || path[0] !== tip || path[path.length - 1] !== origin) return null
  const beef = merged.toBinary()
  if (maxBeefBytes != null && beef.length > maxBeefBytes) {
    console.info(
      `[brc-150] omit assembled lineage — ${beef.length} bytes > remittance budget ${maxBeefBytes}`,
    )
    return null
  }
  const result = verifyProvenanceV2(
    { v: 2, origin, tip, path, beefB64: bytesToBase64(beef) },
    tip,
    { enforceBudget: false },
  )
  if (!result.proven) {
    console.warn('[brc-150] assembled lineage failed verification', tip, result.reason)
    return null
  }
  return { origin, path, hops, beef }
}

function bytesToBase64(bytes: number[]): string {
  let binary = ''
  // Chunked: spreading a multi-megabyte inscription into `fromCharCode` blows
  // the argument limit on exactly the items most worth proving.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.slice(i, i + 8192))
  }
  return btoa(binary)
}
