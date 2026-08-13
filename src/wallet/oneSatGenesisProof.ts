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
  verifyLineageInBeef,
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
   * The whole assembled lineage, serialized — but **empty unless the walk was
   * asked for it** via `includeBeef` or `maxBeefBytes`.
   *
   * A sender needs this to put a complete BRC-150 remittance on the wire.
   * A background verify does not: it pins the verdict and throws the lineage
   * away, and serializing megabytes for that blocks the thread for seconds.
   */
  beef: number[]
}

/**
 * Why a walk ended, so the caller can tell "the network was down" from "this is
 * not a provable ordinal lineage".
 *
 * Collapsing both into `null` is what left items spinning with no explanation:
 * a transient indexer outage looked identical to a genuinely invalid item, so
 * neither could be reported to the user or scheduled correctly.
 */
export type GenesisWalkOutcome =
  | { kind: 'proven'; proof: GenesisProof }
  /** Yielded to something the user is waiting on. Costs one retry, nothing else. */
  | { kind: 'aborted'; hops: number }
  /** A hop could not be fetched. Retryable — the lineage may still be fine. */
  | { kind: 'unavailable'; reason: string; hops: number }
  /** Assembled BEEF exceeded the caller's wire budget. */
  | { kind: 'overBudget'; bytes: number; hops: number }
  /** Conclusive: the chain data says this is not a provable 1-sat lineage. */
  | { kind: 'invalid'; reason: string; hops: number }

/** One-line explanation for logs and the details panel. */
export function describeGenesisWalk(outcome: GenesisWalkOutcome): string {
  switch (outcome.kind) {
    case 'proven':
      return `proven back to ${outcome.proof.origin} in ${outcome.proof.hops} hop(s)`
    case 'aborted':
      return `abandoned after ${outcome.hops} hop(s) — the wallet needed the network`
    case 'unavailable':
      return `could not read hop ${outcome.hops} — ${outcome.reason}`
    case 'overBudget':
      return `lineage is ${outcome.bytes} bytes, over the wire budget`
    case 'invalid':
      return `not a provable lineage at hop ${outcome.hops} — ${outcome.reason}`
  }
}

const POINT = /^([0-9a-f]{64})_(\d+)$/

function toPoint(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.slice(0, 140)
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
  shouldStop?: () => boolean
  maxBeefBytes?: number
  includeBeef?: boolean
}): Promise<GenesisProof | null> {
  const outcome = await walkGenesisLineage(args)
  return outcome.kind === 'proven' ? outcome.proof : null
}

/** {@link proveGenesisLineage}, but says why it stopped. */
export async function walkGenesisLineage(args: {
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
   * lineage only to omit it for being over the wire budget. Implies
   * {@link includeBeef}, since the final size can only be known by serializing.
   */
  maxBeefBytes?: number
  /**
   * Serialize the assembled lineage into {@link GenesisProof.beef}. Only a
   * sender needs it; leaving it off keeps a background verify from spending
   * seconds of blocked main thread on bytes nobody reads.
   */
  includeBeef?: boolean
}): Promise<GenesisWalkOutcome> {
  const tip = toPoint(args.tipOutpoint)
  if (!POINT.test(tip)) {
    return { kind: 'invalid', reason: 'tip is not an outpoint', hops: 0 }
  }
  const maxHops = args.maxHops ?? MAX_GENESIS_HOPS
  const maxBeefBytes = args.maxBeefBytes
  const needBeefBytes = args.includeBeef === true || maxBeefBytes != null

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
    if (args.shouldStop?.()) return { kind: 'aborted', hops }
    // Let the UI paint between hops — phone main thread otherwise freezes for
    // the whole walk (tens of seconds on deep Pixel Foxes lineages).
    if (hops > 0) await new Promise<void>((r) => setTimeout(r, 0))
    const match = POINT.exec(point)
    if (!match) {
      return { kind: 'invalid', reason: 'parent is not an outpoint', hops }
    }
    try {
      await hydrate(match[1]!)
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === 'genesis-lineage-over-budget'
      ) {
        return { kind: 'overBudget', bytes: fetchedBytes, hops }
      }
      return { kind: 'unavailable', reason: errText(err), hops }
    }

    const here = outputAt(point)
    // Hydration succeeded but the transaction or output is missing from what the
    // provider returned — a data gap, not a verdict about the item.
    if (!here?.output) {
      return {
        kind: 'unavailable',
        reason: 'provider returned no such output',
        hops,
      }
    }
    // A lineage that runs through anything but a single satoshi is not an
    // ordinal lineage; stop rather than invent one.
    if (here.output.satoshis !== 1) {
      return {
        kind: 'invalid',
        reason: `ancestor holds ${here.output.satoshis} sats, not 1`,
        hops,
      }
    }
    if (hasOrdEnvelope(here.output.lockingScript?.toHex())) {
      origin = point
      break
    }
    if (hops === maxHops) {
      return {
        kind: 'invalid',
        reason: `no inscription within ${maxHops} hops`,
        hops,
      }
    }

    const vout = Number(match[2])
    let parent: string | null = null
    for (let vin = 0; vin < Math.min(here.tx.inputs.length, MAX_PARENT_CANDIDATES); vin++) {
      const srcTxid = String(here.tx.inputs[vin]?.sourceTXID ?? '').toLowerCase()
      const srcVout = here.tx.inputs[vin]?.sourceOutputIndex
      if (!/^[0-9a-f]{64}$/.test(srcTxid) || !Number.isSafeInteger(srcVout)) {
        return { kind: 'invalid', reason: 'ancestor input is malformed', hops }
      }
      try {
        await hydrate(srcTxid)
      } catch (err) {
        if (
          err instanceof Error &&
          err.message === 'genesis-lineage-over-budget'
        ) {
          return { kind: 'overBudget', bytes: fetchedBytes, hops }
        }
        return { kind: 'unavailable', reason: errText(err), hops }
      }
      const ordinalVin = findOrdinalParentVin(merged, here.tx, vout)
      if (ordinalVin == null) continue
      const input = here.tx.inputs[ordinalVin]!
      const parentTxid = String(input.sourceTXID ?? '').toLowerCase()
      const parentVout = input.sourceOutputIndex
      if (
        !/^[0-9a-f]{64}$/.test(parentTxid) ||
        !Number.isSafeInteger(parentVout)
      ) {
        return { kind: 'invalid', reason: 'parent input is malformed', hops }
      }
      parent = `${parentTxid}_${parentVout}`
      break
    }
    if (!parent) {
      return {
        kind: 'invalid',
        reason: 'could not map the satoshi to a parent input',
        hops,
      }
    }
    point = parent
  }

  if (!origin) {
    return {
      kind: 'invalid',
      reason: 'walk ended without an inscription',
      hops,
    }
  }

  // Everything below is uninterrupted CPU on the shared thread, and it is the
  // most expensive stretch of the walk — an origin that mints hundreds of
  // inscriptions in one transaction takes tens of seconds. Give the UI a frame
  // and one last chance to claim the thread before committing to it.
  if (args.shouldStop?.()) return { kind: 'aborted', hops }
  await new Promise<void>((r) => setTimeout(r, 0))

  // Re-derive the path from the hydrated BEEF and verify it with the shared
  // verifier, so the proof never rests on the order this walk happened to take.
  const path = deriveOneSatPathFromBeef(merged, tip, origin)
  if (!path || path[0] !== tip || path[path.length - 1] !== origin) {
    return {
      kind: 'invalid',
      reason: 're-derived path does not run tip to origin',
      hops,
    }
  }
  // Verified in memory. Serializing to the wire format only to decode and
  // re-parse it is pure waste, and on a phone it is most of the freeze.
  const result = verifyLineageInBeef({
    beef: merged,
    origin,
    tip,
    path,
    heldOutpoint: tip,
  })
  if (!result.proven) {
    return {
      kind: 'invalid',
      reason: result.reason || 'assembled lineage failed verification',
      hops,
    }
  }

  // Only a sender putting the lineage on the wire needs the bytes. A background
  // verify pins a verdict and throws the BEEF away, so it must not pay to
  // serialize megabytes it will never read.
  //
  // Serialized whole rather than atomically: AtomicBEEF keeps only the subject
  // and its recursive dependencies, and a mined tip carrying its own merkle
  // proof depends on nothing — which strips the very ancestry being proven and
  // is why the older rebuild could never prove a confirmed item.
  const beef = needBeefBytes ? merged.toBinary() : []
  if (maxBeefBytes != null && beef.length > maxBeefBytes) {
    return { kind: 'overBudget', bytes: beef.length, hops }
  }
  return { kind: 'proven', proof: { origin, path, hops, beef } }
}
