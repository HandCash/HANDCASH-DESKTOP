import { Beef, type ChainTracker } from '@bsv/sdk'
import { storageRegistry } from '../../storage/registry'
import { durableGetItem, durableSetItem } from '../durableStorage'
import {
  retainedCarriesSigma,
  retainedIssuerMetadata,
  retainedScriptIs,
  retainedSignedBy,
} from '../issuerAttribution'
import type { ActiveWallet } from '../session'
import { retainedTokenGenesis, retainTokenGenesis } from './genesisStore'
import { TOKEN_LINEAGE_MAX_BYTES } from './inboundLineage'
import {
  collectBsv21TokenAncestryTxids,
  decodeTokenOutput,
  fillTokenParentBodies,
  prove,
} from './prove176'
import { normalizeTokenId } from './types'

/**
 * BRC-176 lineage for P2P BSV-21: the token twin of BRC-150 remittance.
 *
 * Every token output names its deploy, but only a walk proves it descends from
 * it. The sender ships the walk's transaction bodies beside the Atomic BEEF, so
 * the payee proves offline. The payee keeps the deploy (the only output that
 * carries the issuer's Sigma) and records which held tips reach it. Issuer
 * attestation needs both: a tip that merely names a token id is never attested.
 */

const VERDICT_KEY = storageRegistry.tokenLineage.key
const MAX_VERDICTS = 2048
const HEAL_RETRY_MS = 10 * 60_000

const OUTPOINT_RE = /^[0-9a-f]{64}_\d+$/

function underscore(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

function asBeef(source: Beef | number[] | Uint8Array): Beef | null {
  if (source instanceof Beef) return source
  try {
    return Beef.fromBinary(Array.from(source))
  } catch {
    return null
  }
}

/**
 * Token-parent bodies from `subjectTxid` back to its deploy, minus the subject
 * itself (that rides as Atomic BEEF). The deploy keeps its merkle proof so the
 * payee can judge its height. Null when the source cannot prove the subject's
 * outputs or the lineage is over budget.
 */
export function tokenLineageFromBeef(
  source: Beef | number[] | Uint8Array,
  subjectTxid: string,
  rawTokenId: string,
): number[] | null {
  const beef = asBeef(source)
  const tokenId = normalizeTokenId(rawTokenId)
  const subject = subjectTxid.trim().toLowerCase()
  const tx = beef?.findTxid(subject)?.tx
  if (!beef || !tokenId || !tx) return null
  const tips = tx.outputs
    .map((out, vout) => ({ vout, decoded: decodeTokenOutput(out.lockingScript) }))
    .filter(({ decoded }) => decoded?.role === 'value' && decoded.tokenId === tokenId)
    .map(({ vout }) => `${subject}_${vout}`)
  if (tips.length === 0) return null
  let ancestry: string[]
  try {
    ancestry = collectBsv21TokenAncestryTxids({ outpoints: tips, tokenId, beef })
  } catch {
    return null
  }
  const deployTxid = tokenId.split('_')[0]!
  const lineage = new Beef()
  for (const txid of ancestry) {
    if (txid === subject) continue
    const entry = beef.findTxid(txid)
    if (!entry?.tx) return null
    const bump =
      txid === deployTxid && entry.bumpIndex !== undefined ? beef.bumps[entry.bumpIndex] : undefined
    lineage.mergeRawTx(entry.tx.toBinary(), bump ? lineage.mergeBump(bump) : undefined)
  }
  if (lineage.txs.length === 0) return null
  const bytes = lineage.toBinary()
  if (bytes.length > TOKEN_LINEAGE_MAX_BYTES) {
    console.warn(
      `[bsv21] lineage for ${subject.slice(0, 12)} omitted — ${bytes.length} bytes over budget`,
    )
    return null
  }
  return bytes
}

/** The payee's proof package: its Atomic BEEF with the sender's lineage folded in. */
export function withTokenLineage(beef: Beef, lineage: number[] | null | undefined): Beef {
  if (!lineage?.length) return beef
  try {
    const work = beef.clone()
    work.atomicTxid = undefined
    work.mergeBeef(lineage)
    return work
  } catch {
    return beef
  }
}

let verdicts: Map<string, string> | null = null

function loadVerdicts(): Map<string, string> {
  if (verdicts) return verdicts
  verdicts = new Map()
  try {
    const raw = durableGetItem(VERDICT_KEY)
    const rows = raw ? (JSON.parse(raw) as unknown) : null
    if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
      for (const [tip, deploy] of Object.entries(rows as Record<string, unknown>)) {
        if (OUTPOINT_RE.test(tip) && typeof deploy === 'string' && OUTPOINT_RE.test(deploy)) {
          verdicts.set(tip, deploy)
        }
      }
    }
  } catch {
    verdicts.clear()
  }
  return verdicts
}

/** File tips whose BRC-176 walk reached `deployOutpoint`. */
export function rememberProvenTokenTips(outpoints: readonly string[], deployOutpoint: string): void {
  const deploy = underscore(deployOutpoint)
  if (!OUTPOINT_RE.test(deploy)) return
  const rows = loadVerdicts()
  let changed = false
  for (const raw of outpoints) {
    const tip = underscore(raw)
    if (!OUTPOINT_RE.test(tip) || tip === deploy || rows.get(tip) === deploy) continue
    rows.delete(tip)
    rows.set(tip, deploy)
    changed = true
  }
  if (!changed) return
  while (rows.size > MAX_VERDICTS) rows.delete(rows.keys().next().value!)
  durableSetItem(VERDICT_KEY, JSON.stringify(Object.fromEntries(rows)))
}

/** Deploy a recorded walk bound this output to — a terminal for later walks. */
export function provenTokenDeployOf(outpoint: string): string | null {
  const tip = underscore(outpoint)
  if (!OUTPOINT_RE.test(tip)) return null
  return loadVerdicts().get(tip) ?? null
}

/**
 * Prove `outpoints` against `beef` and file the ones that reach `tokenId`'s
 * deploy. Returns the deploy outpoint when at least one did.
 */
export function recordProvenTokenTips(
  beef: Beef,
  outpoints: readonly string[],
  rawTokenId: string,
): string | null {
  const tokenId = normalizeTokenId(rawTokenId)
  if (!tokenId) return null
  const proven: string[] = []
  for (const outpoint of outpoints) {
    const result = prove(outpoint, beef, provenTokenDeployOf)
    if (result.ok && result.tokenId === tokenId) proven.push(outpoint)
  }
  if (proven.length === 0) return null
  rememberProvenTokenTips(proven, tokenId)
  return tokenId
}

/** The tip is the deploy itself, or a recorded walk reached that deploy. */
export function tokenTipBound(outpoint: string, rawTokenId: string): boolean {
  const tokenId = normalizeTokenId(rawTokenId)
  const tip = underscore(outpoint)
  if (!tokenId || !OUTPOINT_RE.test(tip)) return false
  return tip === tokenId || loadVerdicts().get(tip) === tokenId
}

/**
 * Issuer attestation for a held BSV-21 tip, the rule items follow with BRC-150:
 * the retained deploy's Sigma verifies for `issuer`, and the tip is bound to
 * that deploy — by being it (its script matches) or by a proven walk.
 */
export function tokenIssuerAttested(args: {
  outpoint: string
  tokenId: string
  issuer?: string | null
  lockingScript?: string
}): boolean {
  const tokenId = normalizeTokenId(args.tokenId)
  if (!args.issuer || !tokenId) return false
  if (underscore(args.outpoint) === tokenId) {
    // The txid fixes the retained output's script; a listed script that differs
    // is a basket row that is not this outpoint's output.
    const scriptMatches =
      args.lockingScript === undefined || retainedScriptIs(tokenId, args.lockingScript)
    return scriptMatches && retainedSignedBy(tokenId, args.issuer)
  }
  return tokenTipBound(args.outpoint, tokenId) && retainedSignedBy(tokenId, args.issuer)
}

export async function chainTrackerFor(wallet: ActiveWallet): Promise<ChainTracker | null> {
  try {
    return (await wallet.services?.getChainTracker?.()) ?? null
  } catch {
    return null
  }
}

const healTriedAt = new Map<string, number>()
const genesisFetchTriedAt = new Map<string, number>()

export type HeldTipProof =
  | { kind: 'bound'; source: 'verdict' | 'local' | 'fetched' }
  | {
      kind: 'refused'
      reason: 'bad-outpoint' | 'retry-later' | 'no-tip-body' | 'walk-failed' | 'no-genesis'
    }

type BodySource = {
  body: (txid: string) => Promise<Beef | null>
  /** Set once any body came from a provider rather than this device. */
  fetched: boolean
}

/**
 * Transaction bodies for a heal: this device first (session, retained deploys,
 * toolbox), then a provider by txid. A received token's parents live on the
 * sender's device, so a local-only walk could never bind a tip received
 * before lineage rode the envelope.
 */
async function bodySource(wallet: ActiveWallet): Promise<BodySource> {
  const { getBeefForTxidCached, getLocalTxForTxid, peekSessionBeef } = await import('../beefCache')
  const source: BodySource = {
    fetched: false,
    body: async (txid) => {
      const session = peekSessionBeef(txid)
      if (session?.findTxid(txid)?.tx) return session
      const genesis = retainedTokenGenesis(txid)
      if (genesis) return genesis
      const tx = await getLocalTxForTxid(wallet, txid).catch(() => null)
      if (tx) {
        const beef = new Beef()
        beef.mergeRawTx(tx.toBinary())
        return beef
      }
      // A body is keyed by the hash of its bytes: a provider can withhold the
      // lineage, never forge it. The walk and the deploy's Sigma still decide.
      const remote = await getBeefForTxidCached(wallet, txid, {
        needProof: false,
        allowUnprovenRawTx: true,
      }).catch(() => null)
      if (!remote?.findTxid(txid)?.tx) return null
      source.fetched = true
      return remote
    },
  }
  return source
}

/**
 * Keep the deploy of a token this wallet holds. A mint lives in toolbox
 * storage, but the session cache forgets it and the durable BEEF cache keeps
 * only recent sends — so without this a self-minted token loses its attestation
 * once its mint ages out, while items re-read their origin on every list.
 */
async function retainHeldTokenGenesis(
  wallet: ActiveWallet,
  tokenId: string,
  source: BodySource,
): Promise<boolean> {
  const deployTxid = tokenId.split('_')[0]!
  if (retainedTokenGenesis(deployTxid)) return true
  const { getLocalBeefForTxid, peekSessionBeef } = await import('../beefCache')
  const session = peekSessionBeef(deployTxid)
  let held = session?.findTxid(deployTxid)?.tx
    ? session
    : await getLocalBeefForTxid(wallet, deployTxid).catch(() => null)
  if (!held?.findTxid(deployTxid)?.tx) {
    const now = Date.now()
    if (now - (genesisFetchTriedAt.get(deployTxid) ?? 0) < HEAL_RETRY_MS) return false
    genesisFetchTriedAt.set(deployTxid, now)
    held = await source.body(deployTxid)
  }
  if (!held?.findTxid(deployTxid)?.tx) return false
  return retainTokenGenesis(held, deployTxid, await chainTrackerFor(wallet))
}

/**
 * Bind a held tip to its deploy and keep that deploy — for tips filed before
 * lineage was recorded. This device's bytes first, then bodies by txid; the
 * BRC-176 walk decides, never an indexer's ownership answer.
 */
export async function proveHeldTokenTip(
  wallet: ActiveWallet,
  outpoint: string,
  rawTokenId: string,
): Promise<HeldTipProof> {
  const tokenId = normalizeTokenId(rawTokenId)
  const tip = underscore(outpoint)
  if (!tokenId || !OUTPOINT_RE.test(tip)) return { kind: 'refused', reason: 'bad-outpoint' }
  const source = await bodySource(wallet)
  const walked = tokenTipBound(tip, tokenId) ? 'verdict' : await walkHeldTip(wallet, tip, tokenId, source)
  if (walked !== 'verdict' && walked !== 'walked') return { kind: 'refused', reason: walked }
  if (!(await retainHeldTokenGenesis(wallet, tokenId, source)))
    return { kind: 'refused', reason: 'no-genesis' }
  return {
    kind: 'bound',
    source: source.fetched ? 'fetched' : walked === 'verdict' ? 'verdict' : 'local',
  }
}

async function walkHeldTip(
  wallet: ActiveWallet,
  tip: string,
  tokenId: string,
  source: BodySource,
): Promise<'walked' | 'retry-later' | 'no-tip-body' | 'walk-failed'> {
  const now = Date.now()
  if (now - (healTriedAt.get(tip) ?? 0) < HEAL_RETRY_MS) return 'retry-later'
  healTriedAt.set(tip, now)
  const tipTxid = tip.split('_')[0]!
  const start = await source.body(tipTxid)
  if (!start) return 'no-tip-body'
  const filled = await fillTokenParentBodies(start, source.body, [tipTxid], provenTokenDeployOf)
  const deploy = recordProvenTokenTips(filled, [tip], tokenId)
  if (!deploy) return 'walk-failed'
  await retainTokenGenesis(filled, deploy.split('_')[0]!, await chainTrackerFor(wallet))
  return 'walked'
}

export type TokenAttestationGap =
  | 'attested'
  /** The deploy is not retained, so its Sigma cannot be read yet. */
  | 'no-genesis'
  /** The deploy is retained and names no issuer: an unsigned mint. */
  | 'unsigned-mint'
  /** No held tip has a walk that reached the deploy. */
  | 'unbound'
  /**
   * The deploy carries neither issuer tape nor Sigma; only this wallet's
   * remittance names an issuer. A mint from before Sigma-signed issuance.
   */
  | 'remittance-only'
  /** The deploy names an issuer (tape or Sigma) that its Sigma does not verify for. */
  | 'unsigned'

/** Which attestation step a held token still lacks. */
export function tokenAttestationGap(token: {
  tokenId: string
  issuer?: string | null
  tipOutpoints: readonly string[]
}): TokenAttestationGap {
  const tokenId = normalizeTokenId(token.tokenId)
  if (!tokenId) return 'no-genesis'
  const deploy = retainedIssuerMetadata(tokenId)
  if (!deploy) return 'no-genesis'
  const issuer = deploy.issuer ?? token.issuer
  if (!issuer) return 'unsigned-mint'
  if (!token.tipOutpoints.some((tip) => tokenTipBound(tip, tokenId))) return 'unbound'
  if (retainedSignedBy(tokenId, issuer)) return 'attested'
  return deploy.issuer || retainedCarriesSigma(tokenId) ? 'unsigned' : 'remittance-only'
}

export function resetTokenLineageForTests(): void {
  verdicts = null
  healTriedAt.clear()
  genesisFetchTriedAt.clear()
}
