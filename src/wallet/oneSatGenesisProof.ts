/**
 * One-time BRC-150 lineage proof for a tip that arrived without one.
 *
 * An ordinal imported from an indexer carries no remittance, and the BEEF the
 * wallet holds for its tip stops at that transaction — so `rebuildProvenanceV2FromBeef`
 * has nothing older to walk and every imported item stays `unproven` forever.
 * Because hardened induction refuses to adopt an unproven tip, such an item can
 * also never climb to BRC-156: it sends over soft-latch, and the recipient
 * inherits the same unproven claim.
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
import { deriveOneSatPathFromBeef, verifyProvenanceV2 } from './oneSatProvenance'
import { hasOrdEnvelope } from './ordinalOwnership'

/** Hops walked before we give up. Deep enough for a decade of transfers. */
export const MAX_GENESIS_HOPS = 64
/**
 * Parent candidates examined per hop.
 *
 * A transfer spends the ordinal plus a little funding, so the sat is found in
 * the first inputs. The cap stops a transaction with hundreds of inputs from
 * turning one hop into a fetch storm.
 */
const MAX_PARENT_CANDIDATES = 8

export type GenesisProof = {
  /** Underscore form, proven by verified BEEF rather than claimed. */
  origin: string
  /** Tip → origin, every step spending the one before it. */
  path: string[]
  hops: number
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
}): Promise<GenesisProof | null> {
  const tip = toPoint(args.tipOutpoint)
  if (!POINT.test(tip)) return null
  const maxHops = args.maxHops ?? MAX_GENESIS_HOPS

  const merged = new Beef()
  const fetched = new Set<string>()

  const hydrate = async (txid: string): Promise<void> => {
    if (fetched.has(txid)) return
    fetched.add(txid)
    merged.mergeBeef((await args.getBeef(txid)).toBinary())
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
    const match = POINT.exec(point)
    if (!match) return null
    try {
      await hydrate(match[1]!)
    } catch {
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

    let parent: string | null = null
    for (const input of here.tx.inputs.slice(0, MAX_PARENT_CANDIDATES)) {
      const parentTxid = String(input.sourceTXID ?? '').toLowerCase()
      const parentVout = input.sourceOutputIndex
      if (!/^[0-9a-f]{64}$/.test(parentTxid) || !Number.isSafeInteger(parentVout)) continue
      try {
        await hydrate(parentTxid)
      } catch {
        continue
      }
      const candidate = `${parentTxid}_${parentVout}`
      if (outputAt(candidate)?.output?.satoshis === 1) {
        parent = candidate
        break
      }
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
  const result = verifyProvenanceV2(
    { v: 2, origin, tip, path, beefB64: bytesToBase64(merged.toBinary()) },
    tip,
    { enforceBudget: false },
  )
  if (!result.proven) {
    console.warn('[brc-150] assembled lineage failed verification', tip, result.reason)
    return null
  }
  return { origin, path, hops }
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
