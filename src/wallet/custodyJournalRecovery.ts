/**
 * Recovery: re-internalize every journaled output the chain says is unspent
 * and the toolbox has no row for.
 *
 * Only absent rows are candidates. A row the toolbox holds but marks
 * unspendable may belong to a signed tx not yet broadcast; reviving it would
 * double-spend, so those stay with the lifecycle-aware heals
 * (`staleOutputRelease`, spend certainty).
 */
import { pinAccountKeyScope, type BoundAccountKeyScope } from './accountLocalKeys'
import { getBeefForTxidCached } from './beefCache'
import {
  appendCustody,
  custodyOutpoint,
  custodyRecipeFor,
  unspentCustodyOutputs,
  type CustodyEntry,
  type SpendRecipe,
} from './custodyJournal'
import { forgetDerivedChange, listDerivedChangeEcho } from './derivedChangeEcho'
import { withVisibleOnChainBeef } from './legacyBeef'
import { withRestoredInternalizeStatus } from './peerIngestHelpers'
import type { ActiveWallet } from './session'
import { creditUtxo, releaseConsumedUtxo } from './utxoLockManager'
import { getWalletRuntime } from './walletRuntime'

/** Largest absent outputs probed per pass; the rest wait for the next one. */
const RECOVERY_PROBE_MAX = 400
const PAGE = 500
const MAX_PAGES = 200
/** An unanswered probe waits this long before the outpoint is asked again. */
const UNKNOWN_BACKOFF_MS = 10 * 60_000

const unknownUntil = new Map<string, number>()

export type CustodyRecoveryResult = {
  checked: number
  live: number
  liveSats: number
  imported: number
  failed: number
  spent: number
  unknown: number
}

function isCurrentWallet(active: ActiveWallet): boolean {
  return getWalletRuntime()?.instance === active
}

/**
 * Fold the legacy change echo into the journal. The echo resolves against the
 * bound account, so only the current wallet may seed.
 */
export function seedCustodyFromEcho(active: ActiveWallet, owner: BoundAccountKeyScope): number {
  if (!isCurrentWallet(active)) return 0
  const entries: CustodyEntry[] = listDerivedChangeEcho().map((echo) => ({
    k: 'out',
    op: `${echo.txid}.${echo.vout}`,
    sats: echo.satoshis,
    r: {
      p: 'wallet payment',
      prefix: echo.derivationPrefix,
      suffix: echo.derivationSuffix,
      ...(echo.senderIdentityKey ? { sender: echo.senderIdentityKey } : {}),
    },
  }))
  return entries.length ? appendCustody(owner, entries).added : 0
}

/** Every outpoint the toolbox holds a row for, spendable or not. */
async function heldOutpoints(active: ActiveWallet): Promise<Set<string> | null> {
  const storage = active.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  const held = new Set<string>()
  try {
    await storage.runAsStorageProvider(async (sp) => {
      const provider = sp as { findOutputs?: (args: unknown) => Promise<unknown> }
      if (typeof provider.findOutputs !== 'function') return
      for (const spendable of [true, false]) {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const batch = await provider.findOutputs({
            partial: { spendable },
            noScript: true,
            paged: { limit: PAGE, offset: page * PAGE },
          })
          const rows = Array.isArray(batch) ? (batch as Array<{ txid?: string; vout?: number }>) : []
          for (const row of rows) {
            const txid = String(row.txid ?? '').toLowerCase()
            if (/^[0-9a-f]{64}$/.test(txid) && Number.isInteger(row.vout)) held.add(`${txid}.${row.vout}`)
          }
          if (rows.length < PAGE) break
        }
      }
    })
  } catch (err) {
    console.warn('[custody-journal] output read failed', err)
    return null
  }
  return held
}

function outputSpec(vout: number, r: SpendRecipe, self: string) {
  if (r.p === 'wallet payment') {
    return {
      outputIndex: vout,
      protocol: 'wallet payment' as const,
      paymentRemittance: {
        derivationPrefix: r.prefix,
        derivationSuffix: r.suffix,
        senderIdentityKey: r.sender || self,
      },
    }
  }
  return {
    outputIndex: vout,
    protocol: 'basket insertion' as const,
    insertionRemittance: {
      basket: r.basket,
      ...(r.ci ? { customInstructions: r.ci } : {}),
      ...(r.tags?.length ? { tags: r.tags } : {}),
    },
  }
}

/** Re-internalize journaled outputs of one transaction. */
export async function reimportCustodyOutputs(
  active: ActiveWallet,
  txid: string,
  outs: Array<{ vout: number; sats: number; r: SpendRecipe }>,
): Promise<{ imported: number; failed: number }> {
  if (outs.length === 0) return { imported: 0, failed: 0 }
  let atomic: number[]
  try {
    const beef = await getBeefForTxidCached(active, txid, { allowUnprovenRawTx: true, needProof: true })
    atomic = Array.from(beef.toBinaryAtomic(txid))
  } catch (err) {
    console.warn(`[custody-journal] no BEEF for ${txid.slice(0, 12)}…`, err)
    return { imported: 0, failed: outs.length }
  }
  if (atomic.length === 0) return { imported: 0, failed: outs.length }
  try {
    await withRestoredInternalizeStatus(txid, () =>
      withVisibleOnChainBeef(() =>
        active.wallet.internalizeAction({
          tx: atomic,
          description: 'Recover from custody journal',
          labels: ['handcash-custody-recover'],
          outputs: outs.map((o) => outputSpec(o.vout, o.r, active.identityKey)),
          seekPermission: false,
        }),
      ),
    )
  } catch (err) {
    console.warn(`[custody-journal] internalize ${txid.slice(0, 12)}… failed`, err)
    return { imported: 0, failed: outs.length }
  }
  for (const o of outs) {
    if (o.r.p !== 'wallet payment') continue
    const outpoint = `${txid}.${o.vout}`
    releaseConsumedUtxo(outpoint, 'reimport:custody-journal')
    creditUtxo(outpoint, { satoshis: o.sats })
  }
  return { imported: outs.length, failed: 0 }
}

function groupByTxid(outpoints: Array<{ op: string; sats: number; r: SpendRecipe }>) {
  const groups = new Map<string, Array<{ vout: number; sats: number; r: SpendRecipe }>>()
  for (const { op, sats, r } of outpoints) {
    const [txid, vout] = op.split('.')
    const list = groups.get(txid) ?? []
    list.push({ vout: Number(vout), sats, r })
    groups.set(txid, list)
  }
  return groups
}

/**
 * Re-internalize specific outpoints the caller already proved unspent and
 * absent. Fails closed (skipped) for any outpoint the journal has no recipe for.
 */
export async function reimportJournaledOutpoints(
  active: ActiveWallet,
  outpoints: string[],
): Promise<{ imported: number; skipped: number; failed: number }> {
  const owner = pinAccountKeyScope(active)
  if (!owner || !isCurrentWallet(active)) return { imported: 0, skipped: outpoints.length, failed: 0 }
  seedCustodyFromEcho(active, owner)
  const held = await heldOutpoints(active)
  if (!held || !isCurrentWallet(active)) return { imported: 0, skipped: outpoints.length, failed: 0 }
  const known: Array<{ op: string; sats: number; r: SpendRecipe }> = []
  let skipped = 0
  const seen = new Set<string>()
  for (const raw of outpoints) {
    const op = custodyOutpoint(raw) ?? raw
    if (seen.has(op) || held.has(op)) continue
    seen.add(op)
    const recipe = custodyRecipeFor(owner, op)
    if (recipe) known.push({ op, ...recipe })
    else skipped += 1
  }
  if (skipped > 0) {
    console.warn(`[custody-journal] ${skipped} outpoint(s) live on chain with no recipe — cannot re-import`)
  }
  let imported = 0
  let failed = 0
  for (const [txid, outs] of groupByTxid(known)) {
    if (!isCurrentWallet(active)) {
      skipped += outs.length
      continue
    }
    const part = await reimportCustodyOutputs(active, txid, outs)
    imported += part.imported
    failed += part.failed
  }
  return { imported, skipped, failed }
}

/**
 * One recovery pass: seed from the echo, probe the largest absent outputs,
 * journal chain-proven spends, re-internalize the live ones.
 */
export async function recoverFromCustodyJournal(
  active: ActiveWallet | null = getWalletRuntime()?.instance ?? null,
): Promise<CustodyRecoveryResult> {
  const result: CustodyRecoveryResult = {
    checked: 0,
    live: 0,
    liveSats: 0,
    imported: 0,
    failed: 0,
    spent: 0,
    unknown: 0,
  }
  const owner = pinAccountKeyScope(active)
  if (!active || !owner || !isCurrentWallet(active)) return result
  const t0 = Date.now()
  seedCustodyFromEcho(active, owner)
  const held = await heldOutpoints(active)
  if (!held || !isCurrentWallet(active)) return result
  const now = Date.now()
  const absent = unspentCustodyOutputs(owner)
    .filter((o) => !held.has(o.op) && (unknownUntil.get(o.op) ?? 0) <= now)
    .sort((a, b) => b.sats - a.sats)
    .slice(0, RECOVERY_PROBE_MAX)
  result.checked = absent.length
  if (absent.length === 0) return result

  const { probeOutpointSpends } = await import('./createActionInputFate')
  const probes = await probeOutpointSpends(
    absent.map((o) => o.op),
    '',
    active.chain,
  )
  if (!isCurrentWallet(active)) return result
  const live: typeof absent = []
  const dead: string[] = []
  for (const o of absent) {
    const probe = probes.get(o.op)
    if (probe?.kind === 'unspent') {
      unknownUntil.delete(o.op)
      live.push(o)
    } else if (probe?.kind === 'spent') {
      unknownUntil.delete(o.op)
      dead.push(o.op)
    } else {
      unknownUntil.set(o.op, now + UNKNOWN_BACKOFF_MS)
      result.unknown += 1
    }
  }
  if (dead.length > 0) {
    result.spent = appendCustody(
      owner,
      dead.map((op) => ({ k: 'spent', op })),
    ).added
    forgetDerivedChange(dead)
  }
  result.live = live.length
  result.liveSats = live.reduce((sum, o) => sum + o.sats, 0)
  for (const [txid, outs] of groupByTxid(live)) {
    if (!isCurrentWallet(active)) break
    const part = await reimportCustodyOutputs(active, txid, outs)
    result.imported += part.imported
    result.failed += part.failed
  }
  console.info(
    `[custody-journal] recovery checked=${result.checked} live=${result.live} sats=${result.liveSats} ` +
      `imported=${result.imported} failed=${result.failed} spent=${result.spent} unknown=${result.unknown} ` +
      `done ${Date.now() - t0}ms`,
  )
  return result
}

export function resetCustodyRecoveryForTests(): void {
  unknownUntil.clear()
}
