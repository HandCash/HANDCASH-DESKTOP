import { Beef, type ChainTracker } from '@bsv/sdk'
import { storageRegistry } from '../../storage/registry'
import { durableGetItem, durableSetItem } from '../durableStorage'
import { retainedScriptIs, retainedSignedBy } from '../issuerAttribution'
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
    const result = prove(outpoint, beef)
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
    return retainedScriptIs(tokenId, args.lockingScript) && retainedSignedBy(tokenId, args.issuer)
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

/**
 * Prove a held tip from this wallet's own transaction bytes, for tips filed
 * before lineage was recorded. Local storage only: no indexer decides it.
 */
export async function proveHeldTokenTipLocally(
  wallet: ActiveWallet,
  outpoint: string,
  rawTokenId: string,
): Promise<boolean> {
  const tokenId = normalizeTokenId(rawTokenId)
  const tip = underscore(outpoint)
  if (!tokenId || !OUTPOINT_RE.test(tip)) return false
  if (tokenTipBound(tip, tokenId)) return true
  const now = Date.now()
  if (now - (healTriedAt.get(tip) ?? 0) < HEAL_RETRY_MS) return false
  healTriedAt.set(tip, now)
  const { getLocalTxForTxid, peekSessionBeef } = await import('../beefCache')
  const localBody = async (txid: string): Promise<Beef | null> => {
    const session = peekSessionBeef(txid)
    if (session?.findTxid(txid)?.tx) return session
    const genesis = retainedTokenGenesis(txid)
    if (genesis) return genesis
    const tx = await getLocalTxForTxid(wallet, txid).catch(() => null)
    if (!tx) return null
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    return beef
  }
  const tipTxid = tip.split('_')[0]!
  const start = await localBody(tipTxid)
  if (!start) return false
  const filled = await fillTokenParentBodies(start, localBody, [tipTxid])
  const deploy = recordProvenTokenTips(filled, [tip], tokenId)
  if (!deploy) return false
  await retainTokenGenesis(filled, deploy.split('_')[0]!, await chainTrackerFor(wallet))
  return true
}

export function resetTokenLineageForTests(): void {
  verdicts = null
  healTriedAt.clear()
}
