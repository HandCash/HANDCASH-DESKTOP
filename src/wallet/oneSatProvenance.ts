/**
 * BRC-150 provenance remittance for basket `1sat` (+ recursive inscription tips).
 *
 * Oversized remittance edge case: never truncate path/beef — omit provenance
 * and leave identity unproven.
 *
 * Sends embed remittance for the *spent* tip (new outpoint unknown
 * pre-broadcast). Receivers MUST use `verifyProvenanceForHeldTip`, which accepts
 * either a direct tip match or a parent remittance when the held tip spends it.
 *
 * Senders SHOULD reuse or extend a prior verified remittance (prepend the new
 * tip + merge its tx into the BEEF) instead of re-walking lineage every hop.
 */
import { Beef, type Transaction } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { hasOrdEnvelope } from './ordinalOwnership'
import { getProvenVerdict } from './provenCache'

/** Soft cap on `beefB64` characters (~300KB binary). Over → omit, don’t truncate. */
export const REMITTANCE_MAX_BEEF_B64_CHARS = 400_000

export type ProvenanceVerifyResult = {
  proven: boolean
  reason: string | null
}

export type ProvenanceV2 = {
  v: 2
  origin: string
  tip: string
  path: string[]
  beefB64: string
  contentType?: string
}

export type ProvenanceRemittance = ProvenanceV2

/**
 * Satoshis locked by `tx.inputs[vin]`, read from its source output in `beef`
 * (or a `sourceTransaction` already linked on the input).
 */
export function inputSatoshisFromBeef(
  beef: Beef,
  tx: Transaction,
  vin: number,
): number | null {
  const input = tx.inputs[vin]
  if (!input) return null
  const vout = input.sourceOutputIndex
  if (!Number.isSafeInteger(vout) || vout < 0) return null
  const linked = input.sourceTransaction?.outputs[vout]?.satoshis
  if (typeof linked === 'number' && linked >= 0) return linked
  const sourceTxid = String(input.sourceTXID ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sourceTxid)) return null
  const out = beef.findTxid(sourceTxid)?.tx?.outputs[vout]
  if (!out || typeof out.satoshis !== 'number' || out.satoshis < 0) return null
  return out.satoshis
}

/**
 * 1Sat / ordinal FIFO: which vin’s single satoshi lands on `vout`.
 *
 * `sum(input sats before vin) === sum(output sats before vout)`, and that input
 * is 1 sat. Missing preceding input sources → null (fail closed).
 */
export function findOrdinalParentVin(
  beef: Beef,
  tx: Transaction,
  vout: number,
): number | null {
  const out = tx.outputs[vout]
  if (!out || out.satoshis !== 1) return null
  let precedingOut = 0
  for (let j = 0; j < vout; j++) {
    const s = tx.outputs[j]?.satoshis
    if (typeof s !== 'number' || s < 0) return null
    precedingOut += s
  }
  let precedingIn = 0
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const inSats = inputSatoshisFromBeef(beef, tx, vin)
    if (inSats == null) return null
    if (inSats === 1 && precedingIn === precedingOut) return vin
    precedingIn += inSats
  }
  return null
}

/** True when vin’s 1-sat is the FIFO sat that `vout` receives. */
export function ordinalVinMapsToVout(
  beef: Beef,
  tx: Transaction,
  vin: number,
  vout: number,
): boolean {
  return findOrdinalParentVin(beef, tx, vout) === vin
}

function vinSpendingParent(
  tx: Transaction,
  parentTxid: string,
  parentVout: number,
): number {
  const id = parentTxid.toLowerCase()
  return tx.inputs.findIndex(
    (input) =>
      String(input.sourceTXID).toLowerCase() === id &&
      input.sourceOutputIndex === parentVout,
  )
}

/** Merge source txs for vin `0..upToVin` into `beef` when present on `from`. */
export function mergePrecedingInputSources(
  beef: Beef,
  tx: Transaction,
  upToVin: number,
  from?: Beef,
): void {
  for (let i = 0; i <= upToVin; i++) {
    const input = tx.inputs[i]
    const linked = input?.sourceTransaction
    if (linked) {
      beef.mergeRawTx(linked.toBinary())
      continue
    }
    const sourceTxid = String(input?.sourceTXID ?? '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(sourceTxid)) continue
    const src = from?.findTxid(sourceTxid)?.tx ?? beef.findTxid(sourceTxid)?.tx
    if (src) beef.mergeRawTx(src.toBinary())
  }
}

/**
 * Recover the actual one-sat spend path already present in a BEEF.
 *
 * This is the deliberately O(N) BRC-150 path derivation on the sender; receivers
 * then verify the explicit path. Returning `[tip, origin]` for a deep transfer is
 * not a shortcut — it is an invalid proof because the tip transaction does not
 * directly spend genesis.
 */
export function deriveOneSatPathFromBeef(
  beef: Beef,
  tipOutpoint: string,
  originOutpoint: string,
): string[] | null {
  const tip = toUnderscore(tipOutpoint).toLowerCase()
  const origin = toUnderscore(originOutpoint).toLowerCase()
  const pointRe = /^([0-9a-f]{64})_(\d+)$/
  if (!pointRe.test(tip) || !pointRe.test(origin)) return null
  if (tip === origin) return [tip]

  const memo = new Map<string, string[] | null>()
  const visiting = new Set<string>()

  const walk = (point: string): string[] | null => {
    if (point === origin) return [origin]
    if (memo.has(point)) return memo.get(point) ?? null
    if (visiting.has(point)) return null
    visiting.add(point)

    const match = pointRe.exec(point)
    if (!match) return null
    const tx = beef.findTxid(match[1]!)?.tx
    if (!tx) return null
    if (tx.inputs.length > 0) {
      mergePrecedingInputSources(beef, tx, tx.inputs.length - 1)
    }

    const vout = Number(match[2])
    const ordinalVin = findOrdinalParentVin(beef, tx, vout)
    if (ordinalVin == null) {
      visiting.delete(point)
      memo.set(point, null)
      return null
    }
    const input = tx.inputs[ordinalVin]!
    const parentTxid = String(input.sourceTXID).toLowerCase()
    const parentVout = input.sourceOutputIndex
    if (/^[0-9a-f]{64}$/.test(parentTxid) && Number.isSafeInteger(parentVout)) {
      const parent = `${parentTxid}_${parentVout}`
      const suffix = walk(parent)
      if (suffix) {
        const result = [point, ...suffix]
        memo.set(point, result)
        visiting.delete(point)
        return result
      }
    }

    visiting.delete(point)
    memo.set(point, null)
    return null
  }

  return walk(tip)
}

/**
 * Rebuild a legacy BRC-150 path without trusting an indexer identity.
 *
 * The parent of each hop is the unique FIFO 1-sat input that lands on that
 * vout. Missing preceding input sources fail closed rather than guessing.
 */
export function rebuildProvenanceV2FromBeef(
  beef: Beef,
  tipOutpoint: string,
): ProvenanceV2 | null {
  const tip = toUnderscore(tipOutpoint).toLowerCase()
  const pointRe = /^([0-9a-f]{64})_(\d+)$/
  if (!pointRe.test(tip)) return null

  type Candidate = { origin: string; path: string[] }
  const memo = new Map<string, Candidate | null>()
  const visiting = new Set<string>()

  const walk = (point: string): Candidate | null => {
    if (memo.has(point)) return memo.get(point) ?? null
    if (visiting.has(point)) return null
    visiting.add(point)

    const match = pointRe.exec(point)
    const tx = match ? beef.findTxid(match[1]!)?.tx : undefined
    const output = tx?.outputs[Number(match?.[2])]
    if (!tx || !output || output.satoshis !== 1) {
      visiting.delete(point)
      memo.set(point, null)
      return null
    }
    if (tx.inputs.length > 0) {
      mergePrecedingInputSources(beef, tx, tx.inputs.length - 1)
    }

    const parents: Candidate[] = []
    const ordinalVin = findOrdinalParentVin(beef, tx, Number(match![2]))
    if (ordinalVin != null) {
      const input = tx.inputs[ordinalVin]!
      const parentTxid = String(input.sourceTXID).toLowerCase()
      const parentVout = input.sourceOutputIndex
      const parentOutput = beef.findTxid(parentTxid)?.tx?.outputs[parentVout]
      if (parentOutput?.satoshis === 1) {
        const candidate = walk(`${parentTxid}_${parentVout}`)
        if (candidate) parents.push(candidate)
      }
    }

    const origins = new Set(parents.map((candidate) => candidate.origin))
    let result: Candidate | null = null
    if (origins.size === 1) {
      const longest = parents
        .slice()
        .sort((a, b) => b.path.length - a.path.length)[0]!
      result = { origin: longest.origin, path: [point, ...longest.path] }
    } else if (origins.size === 0 && hasOrdEnvelope(output.lockingScript?.toHex())) {
      result = { origin: point, path: [point] }
    }

    visiting.delete(point)
    memo.set(point, result)
    return result
  }

  const candidate = walk(tip)
  if (!candidate) return null
  const tipTxid = tip.slice(0, 64)
  let binary: number[]
  try {
    // Full BEEF: AtomicBEEF drops mined path parents and preceding input sources.
    binary = typeof beef.toBinary === 'function' ? beef.toBinary() : beef.toBinaryAtomic(tipTxid)
  } catch {
    return null
  }
  const provenance: ProvenanceV2 = {
    v: 2,
    origin: candidate.origin,
    tip,
    path: candidate.path,
    beefB64: bytesToBase64(binary),
  }
  return verifyProvenanceV2(provenance, tip).proven ? provenance : null
}

function toUnderscore(outpoint: string): string {
  const n = outpoint.trim()
  if (n.includes('_')) return n
  return n.replace(/\.(\d+)$/, '_$1')
}

function toDot(outpoint: string): string {
  const n = outpoint.trim()
  if (n.includes('.')) return n
  return n.replace(/_(\d+)$/, '.$1')
}

function bytesToBase64(bytes: number[] | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!)
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Isolated size gate — truncate is forbidden. */
export function provenanceFitsBudget(p: ProvenanceV2): boolean {
  return typeof p.beefB64 === 'string' && p.beefB64.length <= REMITTANCE_MAX_BEEF_B64_CHARS
}

function pathTxid(outpoint: string): string {
  return toUnderscore(outpoint).slice(0, 64).toLowerCase()
}

/**
 * Path transactions present in `beef` as txid-only (no raw body).
 *
 * BRC-150 / BRC-96 allow these when the receiver can supply the body by other
 * means — which is how a lean remittance ships a Pixel Foxes tip without the
 * megabyte mint transaction.
 */
export function missingPathTxBodies(beef: Beef, path: string[]): string[] {
  const missing: string[] = []
  for (const point of path) {
    const txid = pathTxid(point)
    if (!/^[0-9a-f]{64}$/.test(txid)) continue
    const entry = beef.findTxid(txid)
    if (!entry?.tx) missing.push(txid)
  }
  return missing
}

/**
 * Shrink a tip→origin BEEF so it fits the remittance wire budget.
 *
 * Batch-mint origins (Pixel Foxes) are megabytes because one transaction carries
 * hundreds of sibling inscriptions. BRC-150 allows txid-only entries when the
 * receiver can supply those transactions by other means ([BRC-96](transactions)).
 * We drop raw bodies of fat path transactions — origin first — while keeping
 * their merkle bumps and the tip's raw bytes. The receiver hydrates missing
 * bodies once; a whole collection shares one origin fetch.
 *
 * Returns null only when even a tip-only package cannot fit (pathological tip).
 */
export function fitRemittanceBeef(
  beef: Beef,
  path: string[],
  maxBytes: number = REMITTANCE_MAX_BEEF_BYTES,
): { beef: Beef; binary: number[]; stripped: string[] } | null {
  const lean = beef.clone()
  // Remittance is a full BEEF package. A prior AtomicBEEF subject is the spent
  // tip, not the tip we are about to prove — leaving it set makes structural
  // validation fail the moment we merge the next hop.
  lean.atomicTxid = undefined
  const stripped: string[] = []
  const tipTxid = pathTxid(path[0] ?? '')
  const originTxid = pathTxid(path[path.length - 1] ?? '')
  const pathTxids = [
    ...new Set(
      path.map(pathTxid).filter((txid) => /^[0-9a-f]{64}$/.test(txid)),
    ),
  ]

  const measure = (): number[] =>
    typeof lean.toBinary === 'function' ? lean.toBinary() : []

  let binary = measure()
  if (binary.length <= maxBytes) {
    return { beef: lean, binary, stripped }
  }

  const strip = (txid: string): boolean => {
    if (!txid || txid === tipTxid) return false
    const entry = lean.findTxid(txid)
    if (!entry || entry.isTxidOnly || !entry.tx) return false
    lean.makeTxidOnly(txid)
    stripped.push(txid)
    return true
  }

  // Origin first — almost always the batch mint.
  if (originTxid && originTxid !== tipTxid && strip(originTxid)) {
    binary = measure()
    if (binary.length <= maxBytes) return { beef: lean, binary, stripped }
  }

  // Then other non-tip path txs, largest first (rare; deep hops with fat parents).
  const candidates = pathTxids
    .filter((txid) => txid !== tipTxid && txid !== originTxid)
    .map((txid) => ({
      txid,
      len: lean.findTxid(txid)?.rawTx?.length ?? 0,
    }))
    .filter((c) => c.len > 0)
    .sort((a, b) => b.len - a.len)

  for (const c of candidates) {
    if (!strip(c.txid)) continue
    binary = measure()
    if (binary.length <= maxBytes) return { beef: lean, binary, stripped }
  }

  binary = measure()
  return binary.length <= maxBytes ? { beef: lean, binary, stripped } : null
}

/**
 * Fetch raw bodies for any path transactions that arrived as txid-only.
 *
 * One Pixel Foxes origin fetch is reused by every tip in the collection via
 * {@link getBeefForTxidCached}. Failures leave the beef unchanged so verify
 * fails closed.
 */
export async function hydrateMissingPathTxs(
  beef: Beef,
  path: string[],
  getBeef: (txid: string) => Promise<Beef>,
): Promise<{ beef: Beef; fetched: string[] }> {
  const missing = missingPathTxBodies(beef, path)
  if (missing.length === 0) return { beef, fetched: [] }
  const merged = beef.clone()
  const fetched: string[] = []
  await Promise.all(
    missing.map(async (txid) => {
      try {
        const piece = await getBeef(txid)
        if (!piece.findTxid(txid)?.tx) return
        merged.mergeBeef(piece.toBinary())
        fetched.push(txid)
      } catch {
        // Verify will fail closed on the still-missing body.
      }
    }),
  )
  return { beef: merged, fetched }
}

/**
 * Path bodies a verifier would have to fetch for itself, without fetching any.
 *
 * Lets a caller price the choice between publishing a proof as it stands and
 * completing it first, which costs a round trip per missing body. Null means the
 * proof could not be read at all, so no claim is made about what it needs.
 */
export function provenanceMissingPathBodies(provenance: unknown): string[] | null {
  const parsed = parseProvenanceV2(provenance)
  if (!parsed) return null
  try {
    const beef = Beef.fromBinary(Array.from(base64ToBytes(parsed.beefB64)))
    const path = parsed.path.map((point) => toUnderscore(point).toLowerCase())
    return missingPathTxBodies(beef, path)
  } catch {
    return null
  }
}

/**
 * Re-encode a proof so it stands on its own, for a verifier that cannot fetch.
 *
 * A peer remittance may ship path transactions as txid-only because the
 * receiver hydrates them ({@link fitRemittanceBeef}). A publish target such as
 * the tm_1sat_market overlay has nobody to ask: it runs
 * `Beef.verifyValid(false)` and refuses txid-only entries outright, so a
 * slimmed proof that verifies here is rejected there.
 *
 * Hydrates every txid-only path body and returns the complete package, or null
 * when a body cannot be recovered. The caller enforces its own size budget with
 * the digest that verifier actually compares — omitting is allowed, truncating
 * is not.
 */
export async function completeProvenanceForPublish(args: {
  provenance: ProvenanceV2
  getBeef: (txid: string) => Promise<Beef>
}): Promise<ProvenanceV2 | null> {
  const provenance = parseProvenanceV2(args.provenance)
  if (!provenance) return null
  try {
    const path = provenance.path.map((point) => toUnderscore(point).toLowerCase())
    const source = Beef.fromBinary(Array.from(base64ToBytes(provenance.beefB64)))
    const { beef } = await hydrateMissingPathTxs(source, path, args.getBeef)
    if (missingPathTxBodies(beef, path).length > 0) {
      console.warn('[brc-150] cannot publish provenance — path body unavailable')
      return null
    }
    // The overlay rejects a prior AtomicBEEF subject along with txid-only
    // entries; a publish package is a plain BEEF over the whole lineage.
    const complete = beef.clone()
    complete.atomicTxid = undefined
    if (!complete.verifyValid(false).valid) {
      console.warn('[brc-150] cannot publish provenance — package does not self-verify')
      return null
    }
    return {
      ...provenance,
      path,
      beefB64: bytesToBase64(complete.toBinary()),
    }
  } catch (err) {
    console.warn('[brc-150] cannot publish provenance', err)
    return null
  }
}

/**
 * Encode a verified lineage as remittance bytes, slimming when the full BEEF
 * exceeds the wire budget. Returns null when even the slim form cannot travel.
 */
export function encodeRemittanceBeef(
  beef: Beef,
  path: string[],
): { beefB64: string; stripped: string[] } | null {
  const fitted = fitRemittanceBeef(beef, path)
  if (!fitted) return null
  return {
    beefB64: bytesToBase64(fitted.binary),
    stripped: fitted.stripped,
  }
}

/**
 * Session cache of tip-named remittances built by extending a parent proof
 * after item settle (or imported). Avoids re-hydrate on the next send.
 */
const remittanceByTip = new Map<string, ProvenanceV2>()

export function rememberProvenanceRemittance(p: ProvenanceV2): void {
  const tip = toUnderscore(p.tip).toLowerCase()
  remittanceByTip.set(tip, {
    ...p,
    tip,
    origin: toUnderscore(p.origin).toLowerCase(),
    path: p.path.map((x) => toUnderscore(x).toLowerCase()),
  })
}

export function getRememberedProvenanceRemittance(
  tipOutpoint: string,
): ProvenanceV2 | null {
  return remittanceByTip.get(toUnderscore(tipOutpoint).toLowerCase()) ?? null
}

/** Test / logout helper. */
export function clearRememberedProvenanceRemittances(): void {
  remittanceByTip.clear()
}

/** Largest assembled lineage that still fits a remittance, in bytes. */
export const REMITTANCE_MAX_BEEF_BYTES = Math.floor(
  (REMITTANCE_MAX_BEEF_B64_CHARS * 3) / 4,
)

/**
 * File a lineage a walk just proved as remittance for its tip.
 *
 * Walking is the expensive way to learn an item's ancestry; being told is the
 * cheap way. A wallet that proves a lineage and then throws it away sends the
 * item with no remittance, and the receiver pays for the same walk again —
 * which is how a self-send of an already-proven item takes a minute to verify.
 * Keeping it makes the next send O(1) to build and O(1) for the receiver to
 * check, and later hops extend this rather than starting over.
 *
 * Returns whether it was kept. A lineage too large to travel is declined rather
 * than stored, since it could never be attached to a send.
 */
export function rememberProvenLineage(args: {
  tipOutpoint: string
  origin: string
  path: string[]
  beef: number[]
}): boolean {
  if (args.beef.length === 0) return false
  try {
    const path = args.path.map((x) => toUnderscore(x).toLowerCase())
    const tip = toUnderscore(args.tipOutpoint).toLowerCase()
    const origin = toUnderscore(args.origin).toLowerCase()
    let beefB64: string
    if (args.beef.length <= REMITTANCE_MAX_BEEF_BYTES) {
      beefB64 = bytesToBase64(args.beef)
    } else {
      // Batch-mint origins blow the wire budget as raw bytes. Slim to txid-only
      // origin (and any other fat path txs) so the next send still has something
      // to attach — the receiver hydrates the shared mint once.
      const encoded = encodeRemittanceBeef(Beef.fromBinary(args.beef), path)
      if (!encoded) return false
      beefB64 = encoded.beefB64
      if (encoded.stripped.length > 0) {
        console.info(
          `[brc-150] remittance slimmed for ${tip} — stripped ${encoded.stripped.length} fat path tx(s)`,
        )
      }
    }
    const remittance: ProvenanceV2 = {
      v: 2,
      origin,
      tip,
      path,
      beefB64,
    }
    if (!provenanceFitsBudget(remittance)) return false
    rememberProvenanceRemittance(remittance)
    return true
  } catch (err) {
    // The verdict is pinned either way; reuse is an optimisation, not a proof.
    console.warn('[brc-150] could not keep proven lineage for send', err)
    return false
  }
}

/**
 * Prepend `heldOutpoint` onto a prior tip→origin remittance and merge the held
 * tip transaction into the BEEF. O(1) package growth vs O(hops) lineage walk.
 *
 * Prior must already verify for `prior.tip`. Held tip must spend that tip as a
 * 1-sat input. Returns null when the inductive step cannot be proven or the
 * extended package exceeds the remittance budget even after slimming.
 *
 * Lean priors (txid-only origin) hydrate via `getBeef` before the check — the
 * shared mint is almost always already in the BEEF cache after a prior walk.
 */
export async function extendProvenanceV2(args: {
  prior: unknown
  heldOutpoint: string
  /** BEEF or raw tx bytes that include the held tip transaction. */
  tipBeef: number[] | Beef
  getBeef?: (txid: string) => Promise<Beef>
}): Promise<ProvenanceV2 | null> {
  const prior = parseProvenanceV2(args.prior)
  if (!prior) return null
  const held = toUnderscore(args.heldOutpoint).toLowerCase()
  const priorTip = toUnderscore(prior.tip).toLowerCase()
  const origin = toUnderscore(prior.origin).toLowerCase()

  if (priorTip === held) {
    if (args.getBeef) {
      const ok = await verifyProvenanceV2Async(prior, held, {
        enforceBudget: true,
        getBeef: args.getBeef,
      })
      return ok.proven ? prior : null
    }
    const direct = verifyProvenanceV2(prior, held, { enforceBudget: true })
    return direct.proven ? prior : null
  }

  let priorBeef: Beef
  try {
    priorBeef = Beef.fromBinary(base64ToBytes(prior.beefB64))
  } catch {
    return null
  }
  if (args.getBeef && missingPathTxBodies(priorBeef, prior.path).length > 0) {
    const hydrated = await hydrateMissingPathTxs(
      priorBeef,
      prior.path,
      args.getBeef,
    )
    priorBeef = hydrated.beef
  }
  const priorOk = verifyLineageInBeef({
    beef: priorBeef,
    origin: prior.origin,
    tip: prior.tip,
    path: prior.path,
    heldOutpoint: priorTip,
  })
  if (!priorOk.proven) return null

  const heldMatch = /^([0-9a-f]{64})_(\d+)$/.exec(held)
  const parentMatch = /^([0-9a-f]{64})_(\d+)$/.exec(priorTip)
  if (!heldMatch || !parentMatch) return null
  const heldTxid = heldMatch[1]!
  const heldVout = Number(heldMatch[2])
  const parentTxid = parentMatch[1]!
  const parentVout = Number(parentMatch[2])

  try {
    const tipBeef =
      args.tipBeef instanceof Beef
        ? args.tipBeef
        : Beef.fromBinary(args.tipBeef)
    const heldTx = tipBeef.findTxid(heldTxid)?.tx
    if (!heldTx) return null
    const out = heldTx.outputs[heldVout]
    if (!out || out.satoshis !== 1) return null
    const vin = vinSpendingParent(heldTx, parentTxid, parentVout)
    if (vin < 0) return null

    priorBeef.mergeRawTx(heldTx.toBinary())
    mergePrecedingInputSources(priorBeef, heldTx, vin, tipBeef)
    if (!ordinalVinMapsToVout(priorBeef, heldTx, vin, heldVout)) return null
    // The prior package may have arrived as AtomicBEEF of the spent tip. Once
    // we merge the new tip that subject is wrong — clear it before verifying.
    priorBeef.atomicTxid = undefined

    const path = [
      held,
      ...prior.path.map((x) => toUnderscore(x).toLowerCase()),
    ]
    // Drop accidental duplicate if prior.path already started with held.
    if (path.length >= 2 && path[1] === held) path.splice(1, 1)

    const check = verifyLineageInBeef({
      beef: priorBeef,
      origin,
      tip: held,
      path,
      heldOutpoint: held,
    })
    if (!check.proven) return null

    const encoded = encodeRemittanceBeef(priorBeef, path)
    if (!encoded) return null

    const provenance: ProvenanceV2 = {
      v: 2,
      origin,
      tip: held,
      path,
      beefB64: encoded.beefB64,
      ...(prior.contentType ? { contentType: prior.contentType } : {}),
    }
    if (!provenanceFitsBudget(provenance)) return null
    return provenance
  } catch {
    return null
  }
}

export function parseProvenanceV2(raw: unknown): ProvenanceV2 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 2) return null
  if (typeof o.origin !== 'string' || typeof o.tip !== 'string') return null
  if (typeof o.beefB64 !== 'string' || !o.beefB64) return null
  if (!Array.isArray(o.path) || o.path.length < 1) return null
  if (!o.path.every((x) => typeof x === 'string')) return null
  return {
    v: 2,
    origin: toUnderscore(o.origin),
    tip: toUnderscore(o.tip),
    path: (o.path as string[]).map(toUnderscore),
    beefB64: o.beefB64,
    contentType: typeof o.contentType === 'string' ? o.contentType : undefined,
  }
}

/**
 * Structural + BEEF validity check. Tip must match the held outpoint (dot or underscore).
 *
 * `enforceBudget` is about what may travel in a remittance, not about what is
 * true: a locally assembled lineage is verified from the same transactions
 * whether or not it would fit in an output's customInstructions, and an
 * inscription large enough to blow the cap must still be provable to its owner.
 *
 * Sync entry point — lean remittances with txid-only path txs fail here until
 * {@link verifyProvenanceV2Async} (or {@link verifyProvenanceForHeldTip})
 * hydrates them.
 */
export function verifyProvenanceV2(
  provenance: unknown,
  heldOutpoint: string,
  opts?: { enforceBudget?: boolean },
): ProvenanceVerifyResult {
  const p = parseProvenanceV2(provenance)
  if (!p) return { proven: false, reason: 'missing or non-v2 provenance' }
  if (opts?.enforceBudget !== false && !provenanceFitsBudget(p)) {
    return { proven: false, reason: 'remittance over size budget' }
  }
  const shape = checkLineageShape(p, heldOutpoint)
  if (shape) return shape

  let beef: Beef
  try {
    beef = Beef.fromBinary(base64ToBytes(p.beefB64))
  } catch (err) {
    return {
      proven: false,
      reason: err instanceof Error ? err.message : 'beef parse failed',
    }
  }
  const missing = missingPathTxBodies(beef, p.path)
  if (missing.length > 0) {
    return {
      proven: false,
      reason: `path transaction missing: ${missing[0]}`,
    }
  }
  return verifyLineageInBeef({
    beef,
    origin: p.origin,
    tip: p.tip,
    path: p.path,
    heldOutpoint,
  })
}

/**
 * Like {@link verifyProvenanceV2}, but hydrates txid-only path bodies first.
 *
 * This is how a lean Pixel Foxes remittance verifies in O(1) package work plus
 * one shared origin fetch — not an O(hops) rediscovery walk.
 */
export async function verifyProvenanceV2Async(
  provenance: unknown,
  heldOutpoint: string,
  opts?: {
    enforceBudget?: boolean
    getBeef?: (txid: string) => Promise<Beef>
  },
): Promise<ProvenanceVerifyResult> {
  const p = parseProvenanceV2(provenance)
  if (!p) return { proven: false, reason: 'missing or non-v2 provenance' }
  if (opts?.enforceBudget !== false && !provenanceFitsBudget(p)) {
    return { proven: false, reason: 'remittance over size budget' }
  }
  const shape = checkLineageShape(p, heldOutpoint)
  if (shape) return shape

  let beef: Beef
  try {
    beef = Beef.fromBinary(base64ToBytes(p.beefB64))
  } catch (err) {
    return {
      proven: false,
      reason: err instanceof Error ? err.message : 'beef parse failed',
    }
  }
  if (opts?.getBeef) {
    const hydrated = await hydrateMissingPathTxs(beef, p.path, opts.getBeef)
    beef = hydrated.beef
    if (hydrated.fetched.length > 0) {
      console.info(
        `[brc-150] hydrated ${hydrated.fetched.length} lean path tx(s) for verify`,
      )
    }
  }
  return verifyLineageInBeef({
    beef,
    origin: p.origin,
    tip: p.tip,
    path: p.path,
    heldOutpoint,
  })
}

/** Cheap ordering checks that need no BEEF, shared by both entry points. */
function checkLineageShape(
  p: { origin: string; tip: string; path: string[] },
  heldOutpoint: string,
): ProvenanceVerifyResult | null {
  if (p.path[0] !== p.tip) return { proven: false, reason: 'path[0] !== tip' }
  if (p.path[p.path.length - 1] !== p.origin) {
    return { proven: false, reason: 'path does not end at origin' }
  }
  const held = toUnderscore(heldOutpoint)
  if (p.tip !== held) {
    return { proven: false, reason: 'tip does not match held outpoint' }
  }
  return null
}

/**
 * {@link verifyProvenanceV2} against a BEEF that is already parsed.
 *
 * A locally assembled lineage is verified from the same transactions whether or
 * not it ever reaches the wire, and re-encoding one only to decode and re-parse
 * it costs seconds of blocked main thread on a phone — a Pixel Foxes origin is
 * a single transaction carrying hundreds of inscriptions. Callers that hold the
 * `Beef` should verify it here; {@link verifyProvenanceV2} remains the entry
 * point for remittance that genuinely arrived as bytes.
 */
export function verifyLineageInBeef(args: {
  beef: Beef
  origin: string
  tip: string
  path: string[]
  heldOutpoint: string
}): ProvenanceVerifyResult {
  const p = {
    origin: toUnderscore(args.origin),
    tip: toUnderscore(args.tip),
    path: args.path.map(toUnderscore),
  }
  const shape = checkLineageShape(p, args.heldOutpoint)
  if (shape) return shape

  try {
    const beef = args.beef
    // A txid-only entry is only legal when the receiver independently trusts
    // that transaction. This verifier has no such trust input, so every path
    // transaction must be present and structurally proven by the BEEF.
    const { valid } = beef.verifyValid(false)
    if (!valid) return { proven: false, reason: 'beef structurally invalid' }

    const tipTxid = p.tip.slice(0, 64).toLowerCase()
    if (beef.atomicTxid && beef.atomicTxid.toLowerCase() !== tipTxid) {
      return { proven: false, reason: 'AtomicBEEF subject is not the tip transaction' }
    }
    if (beef.atomicTxid && !beef.isAtomic(tipTxid)) {
      return { proven: false, reason: 'AtomicBEEF dependency graph is invalid' }
    }

    const parsedPath: Array<{ normalized: string; txid: string; vout: number }> = []
    for (const outpoint of p.path) {
      const normalized = toUnderscore(outpoint).toLowerCase()
      const match = /^([0-9a-f]{64})_(\d+)$/.exec(normalized)
      if (!match) return { proven: false, reason: `invalid path outpoint: ${outpoint}` }
      const vout = Number(match[2])
      if (!Number.isSafeInteger(vout)) {
        return { proven: false, reason: `invalid path output index: ${outpoint}` }
      }
      parsedPath.push({ normalized, txid: match[1]!, vout })
    }

    for (const point of parsedPath) {
      const tx = beef.findTxid(point.txid)?.tx
      if (!tx) return { proven: false, reason: `path transaction missing: ${point.txid}` }
      const output = tx.outputs[point.vout]
      if (!output) {
        return { proven: false, reason: `path output missing: ${point.normalized}` }
      }
      if (output.satoshis !== 1) {
        return { proven: false, reason: `path output is not one satoshi: ${point.normalized}` }
      }
    }

    // `path` is ordered tip → origin. Spend + FIFO sat assignment: the parent
    // 1-sat must be the input whose sats land on the child vout.
    for (let i = 0; i + 1 < parsedPath.length; i++) {
      const child = parsedPath[i]!
      const parent = parsedPath[i + 1]!
      if (child.txid === parent.txid) continue
      const childTx = beef.findTxid(child.txid)?.tx
      if (!childTx) {
        return {
          proven: false,
          reason: `path transaction missing: ${child.txid}`,
        }
      }
      const vin = vinSpendingParent(childTx, parent.txid, parent.vout)
      if (vin < 0) {
        return {
          proven: false,
          reason: `${child.normalized} does not spend parent ${parent.normalized}`,
        }
      }
      if (!ordinalVinMapsToVout(beef, childTx, vin, child.vout)) {
        return {
          proven: false,
          reason: `${child.normalized} does not receive the ordinal sat from ${parent.normalized}`,
        }
      }
    }

    const origin = parsedPath[parsedPath.length - 1]!
    const originTx = beef.findTxid(origin.txid)?.tx
    const originScript = originTx?.outputs[origin.vout]?.lockingScript?.toHex()
    if (!hasOrdEnvelope(originScript)) {
      return { proven: false, reason: 'origin output has no valid ord envelope' }
    }
  } catch (err) {
    return {
      proven: false,
      reason: err instanceof Error ? err.message : 'beef parse failed',
    }
  }
  return { proven: true, reason: null }
}

/**
 * Verify BRC-150 remittance for the tip the wallet actually holds.
 *
 * Remittance embeds proof of the *spent* tip. When `provenance.tip` is that
 * parent and `heldOutpoint` spends it (1 sat), the held tip inherits the proof
 * — no O(N) lineage walk. Falls back to strict tip match otherwise.
 */
export async function verifyProvenanceForHeldTip(args: {
  provenance: unknown
  heldOutpoint: string
  getBeef?: (txid: string) => Promise<Beef>
}): Promise<
  ProvenanceVerifyResult & { origin?: string; path?: string[] }
> {
  const p = parseProvenanceV2(args.provenance)
  if (!p) {
    return { proven: false, reason: 'missing provenance' }
  }

  // Parsed once and reused. This runs on every incoming tip, and re-decoding a
  // remittance BEEF per check used to cost four full parses of the same bytes.
  let beef: Beef
  try {
    beef = Beef.fromBinary(base64ToBytes(p.beefB64))
  } catch (err) {
    return {
      proven: false,
      reason: err instanceof Error ? err.message : 'beef parse failed',
    }
  }
  // Lean remittances ship the tip + path with the fat origin as txid-only.
  // Hydrate before any structural check so Pixel Foxes verify in one shared
  // origin fetch instead of a rediscovery walk.
  if (args.getBeef && missingPathTxBodies(beef, p.path).length > 0) {
    const hydrated = await hydrateMissingPathTxs(beef, p.path, args.getBeef)
    beef = hydrated.beef
    if (hydrated.fetched.length > 0) {
      console.info(
        `[brc-150] hydrated ${hydrated.fetched.length} lean path tx(s) for held tip`,
      )
    }
  }
  const lineage = { beef, origin: p.origin, tip: p.tip, path: p.path }

  const held = toUnderscore(args.heldOutpoint)
  const direct = verifyLineageInBeef({ ...lineage, heldOutpoint: held })
  if (direct.proven) return { ...direct, origin: p.origin, path: p.path }
  if (p.tip === held) return direct

  const parentOk = verifyLineageInBeef({
    ...lineage,
    heldOutpoint: toDot(p.tip),
  })
  if (!parentOk.proven) {
    return {
      proven: false,
      reason: parentOk.reason ?? 'parent remittance invalid',
    }
  }

  const heldMatch = /^([0-9a-f]{64})_(\d+)$/i.exec(held)
  const parentMatch = /^([0-9a-f]{64})_(\d+)$/i.exec(p.tip)
  if (!heldMatch || !parentMatch) {
    return { proven: false, reason: 'invalid held or remittance tip outpoint' }
  }
  const heldTxid = heldMatch[1]!.toLowerCase()
  const heldVout = Number(heldMatch[2])
  const parentTxid = parentMatch[1]!.toLowerCase()
  const parentVout = Number(parentMatch[2])

  let heldTx = beef.findTxid(heldTxid)?.tx ?? null
  if (!heldTx && args.getBeef) {
    try {
      heldTx = (await args.getBeef(heldTxid)).findTxid(heldTxid)?.tx ?? null
    } catch {
      heldTx = null
    }
  }
  if (!heldTx) {
    return {
      proven: false,
      reason: 'held tip transaction missing for parent remittance check',
    }
  }
  const out = heldTx.outputs[heldVout]
  if (!out || out.satoshis !== 1) {
    return { proven: false, reason: 'held tip is not a 1-sat output' }
  }
  const vin = vinSpendingParent(heldTx, parentTxid, parentVout)
  if (vin < 0) {
    return {
      proven: false,
      reason: 'held tip does not spend remittance tip (parent)',
    }
  }
  // Verification is finished, so the remittance BEEF can be extended in place
  // for sat mapping rather than parsed a second time.
  let mapBeef = beef
  try {
    mapBeef.mergeRawTx(heldTx.toBinary())
  } catch {
    mapBeef = new Beef()
    mapBeef.mergeRawTx(heldTx.toBinary())
  }
  if (!ordinalVinMapsToVout(mapBeef, heldTx, vin, heldVout) && args.getBeef) {
    for (let i = 0; i < vin; i++) {
      const srcTxid = String(heldTx.inputs[i]?.sourceTXID ?? '').toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(srcTxid)) continue
      try {
        mapBeef.mergeBeef((await args.getBeef(srcTxid)).toBinary())
      } catch {
        /* mapping may still fail closed */
      }
    }
    mergePrecedingInputSources(mapBeef, heldTx, vin)
  }
  if (!ordinalVinMapsToVout(mapBeef, heldTx, vin, heldVout)) {
    return {
      proven: false,
      reason: 'held tip does not receive the ordinal sat from remittance tip',
    }
  }
  // The held tip inherits the parent's proof, so it also inherits its path with
  // one hop prepended. Handing that back lets the caller record how this tip was
  // proven, not merely that it was — the difference between a later send passing
  // the proof on and making the next holder rediscover it.
  return { proven: true, reason: null, origin: p.origin, path: [held, ...p.path] }
}

/**
 * Authenticity verify for collectables — BRC-150 v2 only.
 */
export function verifyProvenance(
  provenance: unknown,
  heldOutpoint: string,
): ProvenanceVerifyResult {
  if (parseProvenanceV2(provenance)) {
    return verifyProvenanceV2(provenance, heldOutpoint)
  }
  return { proven: false, reason: 'missing provenance' }
}

/**
 * Assemble the tip's ancestry when the locally held BEEF cannot reach genesis.
 *
 * Imported ordinals and confirmed tips both arrive without ancestry, and a
 * sender that gives up there hands the receiver an unprovable item — the
 * "arrived unverified with no traits" case. Imported dynamically because
 * `oneSatGenesisProof` verifies through this module.
 */
async function hydrateLineageForSend(
  wallet: ActiveWallet,
  tip: string,
  opts?: { shouldStop?: () => boolean },
): Promise<{ origin: string; path: string[]; beef: number[] } | null> {
  if (!wallet.services?.getBeefForTxid) return null
  try {
    const [{ proveGenesisLineage }, { getBeefForTxidCached }] = await Promise.all([
      import('./oneSatGenesisProof'),
      import('./beefCache'),
    ])
    // Walk the full lineage without a wire-size abort — batch-mint origins are
    // megabytes, but {@link encodeRemittanceBeef} slims them to txid-only for
    // the wire. Aborting mid-walk left Pixel Foxes sends bare forever.
    const proof = await proveGenesisLineage({
      tipOutpoint: tip,
      getBeef: (hop) => getBeefForTxidCached(wallet, hop),
      shouldStop: opts?.shouldStop,
      includeBeef: true,
    })
    if (!proof) return null
    console.info(
      `[brc-150] hydrated ${proof.hops} hop(s) of lineage for the send of ${tip}`,
    )
    return { origin: proof.origin, path: proof.path, beef: proof.beef }
  } catch (err) {
    console.warn('[brc-150] lineage hydration for send failed', tip, err)
    return null
  }
}

/**
 * The tip→origin path a previous walk in this wallet proved for `tip`.
 *
 * A verdict outlives the session that earned it, so this is the record that a
 * restart would otherwise lose along with the in-memory remittance. Only a
 * lineage walk writes it, and only for the origin it actually reached, so a
 * mismatched origin means the record is about a different claim — ignore it.
 */
function knownProvenPath(tip: string, origin: string): string[] | null {
  const verdict = getProvenVerdict(toDot(tip))
  if (!verdict || verdict.tier !== 'brc150') return null
  const path = verdict.path?.map((point) => toUnderscore(point).toLowerCase())
  if (!path || path.length === 0) return null
  if (path[0] !== tip.toLowerCase()) return null
  if (path[path.length - 1] !== origin.toLowerCase()) return null
  return path
}

/**
 * Build v2 remittance for a known tip outpoint (usually the UTXO being spent).
 * Returns null when beef unavailable or cannot fit even as a lean package.
 *
 * Preference order (cheapest first):
 * 1. Session-remembered tip-named remittance
 * 2. Reuse prior remittance when it already names this tip
 * 3. Extend prior parent remittance (prepend tip + merge tip tx) — O(1) growth
 * 4. Replay a path this wallet already proved, over a warmed BEEF cache
 * 5. Derive path from tip BEEF / hydrate lineage — O(hops) fallback
 *
 * Oversized batch-mint origins are slimmed to txid-only bodies (BRC-96); the
 * receiver hydrates the shared mint once instead of forcing an omit.
 */
export async function tryBuildProvenanceV2(args: {
  tipOutpoint: string
  origin: string
  wallet: ActiveWallet
  contentType?: string
  /** Optional prior path tip→…→origin (underscore). */
  path?: string[]
  /**
   * Tip BEEF already fetched for this send. Reusing it avoids a second
   * `getBeefForTxid` round trip that otherwise dominates item-send signing.
   */
  inputBeef?: number[]
  /**
   * Remittance already on the tip (or remembered). May name this tip or its
   * parent — both are reused/extended before any lineage walk.
   */
  priorProvenance?: unknown
  /**
   * Walk tip→origin from chain when the tip BEEF has no path. Default false —
   * Pixel Fox hydrates take tens of seconds on phones. Prefer a known proven
   * path (warm cache + slim remittance) over a cold walk on the send hot path.
   */
  allowLineageHydrate?: boolean
}): Promise<ProvenanceV2 | null> {
  const tip = toUnderscore(args.tipOutpoint)
  const origin = toUnderscore(args.origin)
  const tipDot = toDot(tip)
  const [txid] = tipDot.split('.')
  if (!txid) return null
  const tipKey = tip.toLowerCase()
  const originKey = origin.toLowerCase()

  const finish = (p: ProvenanceV2 | null): ProvenanceV2 | null => {
    if (!p) return null
    if (toUnderscore(p.origin).toLowerCase() !== originKey) return null
    rememberProvenanceRemittance(p)
    return p
  }

  try {
    const { getBeefForTxidCached } = await import('./beefCache')
    const getBeef = (hop: string) => getBeefForTxidCached(args.wallet, hop)

    const remembered = getRememberedProvenanceRemittance(tipKey)
    if (remembered) {
      const ok = await verifyProvenanceV2Async(remembered, tipDot, {
        enforceBudget: true,
        getBeef,
      })
      if (ok.proven && remembered.origin === originKey) return finish(remembered)
    }

    let beef: Beef | null = null
    if (args.inputBeef?.length) {
      try {
        const fromInput = Beef.fromBinary(args.inputBeef)
        if (fromInput.findTxid(txid)?.tx) beef = fromInput
      } catch {
        // Fall through to a fresh fetch.
      }
    }
    if (!beef && args.wallet.services) {
      try {
        beef = await getBeef(txid)
      } catch {
        beef = null
      }
    }

    const prior =
      parseProvenanceV2(args.priorProvenance) ??
      remembered ??
      null
    if (prior) {
      const direct = await verifyProvenanceV2Async(prior, tipDot, {
        enforceBudget: true,
        getBeef,
      })
      if (direct.proven) return finish(prior)
      if (beef) {
        const extended = await extendProvenanceV2({
          prior,
          heldOutpoint: tip,
          tipBeef: beef,
          getBeef,
        })
        if (extended) return finish(extended)
      }
    }

    if (!beef) {
      if (!args.wallet.services) return null
      beef = await getBeef(txid)
    }
    if (!beef) return null

    // Assembled as a full (non-atomic) BEEF so ancestry survives; AtomicBEEF
    // would drop mined parents. Wire encoding may later strip fat bodies.
    let assembled = beef
    let path =
      args.path && args.path.length > 0
        ? args.path.map(toUnderscore)
        : deriveOneSatPathFromBeef(beef, tip, origin)
    if (!path || path[0] !== tip || path[path.length - 1] !== origin) {
      // A tip this wallet already proved has its path on record, and replaying a
      // known path is a warm-cache pass rather than a discovery walk. Refusing
      // it is what sent proven items out bare and made the receiver repeat the
      // walk we had already paid for.
      const known = knownProvenPath(tip, origin)
      if (!known && !args.allowLineageHydrate) {
        console.info(
          '[brc-150] omit provenance — no tip-local path (skip lineage hydrate on send)',
        )
        return null
      }
      if (known) {
        const { warmBeefCache } = await import('./beefCache')
        await warmBeefCache(
          args.wallet,
          known.map((point) => point.split('_')[0]!),
        )
        console.info(
          `[brc-150] rebuilding remittance over ${known.length - 1} proven hop(s) for ${tip}`,
        )
      }
      const hydrated = await hydrateLineageForSend(args.wallet, tip)
      if (!hydrated || hydrated.origin !== origin) {
        console.warn(
          '[brc-150] omit provenance — no complete one-sat path to origin',
        )
        return null
      }
      path = hydrated.path
      assembled = Beef.fromBinary(hydrated.beef)
    }

    const check = verifyLineageInBeef({
      beef: assembled,
      origin,
      tip,
      path,
      heldOutpoint: tipDot,
    })
    if (!check.proven) return null

    const encoded = encodeRemittanceBeef(assembled, path)
    if (!encoded) {
      console.info(
        '[brc-150] omit provenance — lineage cannot fit remittance budget even lean',
      )
      return null
    }
    if (encoded.stripped.length > 0) {
      console.info(
        `[brc-150] remittance slimmed for ${tip} — stripped ${encoded.stripped.length} fat path tx(s); receiver hydrates`,
      )
    }
    const provenance: ProvenanceV2 = {
      v: 2,
      origin,
      tip,
      path,
      beefB64: encoded.beefB64,
      ...(args.contentType ? { contentType: args.contentType } : {}),
    }
    if (!provenanceFitsBudget(provenance)) return null
    return finish(provenance)
  } catch (err) {
    console.warn('[brc-150] build provenance failed', err)
    return null
  }
}

/**
 * Remittance for a collectable send.
 *
 * Authenticity is BRC-150 v2 (full tip→origin BEEF). Shipping a structural-only
 * remittance as a "proven" flag was a fake — do not do that.
 */
export async function tryBuildProvenanceForSend(args: {
  tipOutpoint: string
  origin: string
  wallet: ActiveWallet
  contentType?: string
  path?: string[]
  inputBeef?: number[]
  priorProvenance?: unknown
}): Promise<ProvenanceRemittance | null> {
  return tryBuildProvenanceV2(args)
}

/** Merge display fields + optional provenance into customInstructions JSON. */
export function buildCollectableCustomInstructions(args: {
  origin: string
  name: string
  app?: string
  /**
   * Collection binding (BRC-99 `p 1sat collection:<id>` scope). Persisted so a
   * scoped `listOutputs` grant can match without re-hitting an indexer.
   */
  collectionId?: string
  /**
   * Shared media outpoint for derivative / reference tips (Kit Kat pattern).
   * Display claim — BRC-150 still proves tip→`origin` (the child token).
   */
  content?: string
  provenance?: ProvenanceRemittance | null
}): string {
  const body: Record<string, unknown> = {
    origin: toUnderscore(args.origin),
    name: args.name,
  }
  if (args.app) body.app = args.app
  if (args.collectionId) body.collectionId = args.collectionId
  if (args.content) {
    const content = toUnderscore(args.content)
    if (/^[0-9a-f]{64}_\d+$/i.test(content)) body.content = content
  }
  if (args.provenance) body.provenance = args.provenance
  return JSON.stringify(body)
}

/**
 * `internalizeAction` caps `customInstructions` at 1000 characters.
 *
 * The cap lives in the SDK's own validator, so it is not negotiable and it is
 * not a storage detail we can widen: an over-long value throws before anything
 * is written, and the whole transaction's outputs are lost with it. A BRC-150
 * v2 remittance is ~400k characters, so attaching one here fails 100% of the
 * time — every incoming ordinal, silently, forever.
 *
 * Dropping the BEEF costs nothing that matters. It was never received from the
 * sender; it is built locally from chain data, and `verifyItemAuthenticity`
 * rebuilds it on demand and caches the verdict. What must survive is the
 * identity the item cannot be displayed or spent without.
 */
export const INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX = 1000

export function buildInternalizeCustomInstructions(args: {
  origin: string
  name: string
  app?: string
  collectionId?: string
  content?: string
}): string {
  const full = buildCollectableCustomInstructions(args)
  if (full.length <= INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX) return full

  // Keep origin + content + collection (load-bearing for derivatives and
  // scoped grants); trim only free text.
  const origin = toUnderscore(args.origin)
  const content =
    args.content && /^[0-9a-f]{64}_\d+$/i.test(toUnderscore(args.content))
      ? toUnderscore(args.content)
      : undefined
  const collectionId = args.collectionId || undefined
  const base: Record<string, unknown> = { origin, name: '' }
  if (collectionId) base.collectionId = collectionId
  if (content) base.content = content
  const fixed = JSON.stringify(base).length
  const budget = Math.max(0, INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX - fixed - 16)
  return JSON.stringify({
    origin,
    name: args.name.slice(0, budget),
    ...(collectionId ? { collectionId } : {}),
    ...(content ? { content } : {}),
  })
}
