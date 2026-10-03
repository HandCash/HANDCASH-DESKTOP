/**
 * Holdings reconcile: every disagreement between what the wallet lists and
 * what the chain says, kept durably until one chain answer settles it.
 *
 * The token and item lists are projections of the wallet's own outputs. A
 * projection alone can lose an asset silently — a basket row retired by a
 * failed spend, a restore from an older backup — and it can paint an output
 * the chain already spent. Neither is allowed to pass unseen:
 *
 * - `left-basket`: an output this wallet listed is no longer listed. Proven
 *   spent closes it. Proven unspent restores the row (or re-claims the output
 *   from its transaction) and the entry stays until a read lists it again.
 * - `off-chain-index`: the basket lists an item the address scan does not.
 *   Proven spent retires the row. Proven unspent closes it — the index lags.
 *
 * Each outpoint is asked about once per backoff step, never per read, and
 * nothing is dropped on an unknown answer. "Spent" counts only when the named
 * spender's body consumes the outpoint — an index is a finder, not a judge.
 * A row a local transaction still reserves is never restored or re-claimed.
 * Mutations run only while every wallet region is idle.
 */
import { Transaction } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { accountLocalKey } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { isItemAbandoned, isItemSent, markItemsConsumed } from './sentItemGuard'
import { isUtxoBlockedFromRestore, sealedSpenderOf } from './utxoLockManager'
import type { OutpointSpendProbe } from './createActionInputFate'
import type { Chain } from './vault'

export type HoldingsAsset = 'token' | 'item'
export type HoldingsGap = 'left-basket' | 'off-chain-index'

export type HoldingsEntry = {
  /** Dotted, lower-case. */
  outpoint: string
  asset: HoldingsAsset
  gap: HoldingsGap
  label?: string
  since: number
  checks: number
  nextAt: number
}

export type ReconcileFate =
  | {
      kind: 'close'
      reason: 'sent-here' | 'abandoned' | 'spent' | 'chain-agrees'
      spender?: string
    }
  | { kind: 'restore' }
  | { kind: 'retire'; spender: string }
  | { kind: 'recheck'; reason: 'chain-unknown' | 'reserved' | 'spender-unproven' }

export function chooseReconcileFate(args: {
  gap: HoldingsGap
  sentHere: boolean
  abandoned: boolean
  reserved: boolean
  probe: OutpointSpendProbe
  /** The spender's body consumes this outpoint. Only read for a spent probe. */
  spenderProven: boolean
}): ReconcileFate {
  if (args.sentHere) return { kind: 'close', reason: 'sent-here' }
  if (args.abandoned) return { kind: 'close', reason: 'abandoned' }
  const { probe } = args
  if (probe.kind === 'spent' && !args.spenderProven) {
    return { kind: 'recheck', reason: 'spender-unproven' }
  }
  if (args.gap === 'left-basket') {
    if (probe.kind === 'spent') return { kind: 'close', reason: 'spent', spender: probe.spender }
    if (probe.kind === 'unknown') return { kind: 'recheck', reason: 'chain-unknown' }
    return args.reserved ? { kind: 'recheck', reason: 'reserved' } : { kind: 'restore' }
  }
  if (probe.kind === 'spent') return { kind: 'retire', spender: probe.spender }
  if (probe.kind === 'unknown') return { kind: 'recheck', reason: 'chain-unknown' }
  return { kind: 'close', reason: 'chain-agrees' }
}

/** A send that is still signing marks its inputs within this window. */
export const RECONCILE_SETTLE_MS = 2 * 60_000
/** Delay before each further check, by checks already made. */
export const RECONCILE_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const
/** An index that agrees is not asked again about the same row for this long. */
export const CHAIN_AGREES_QUIET_MS = 24 * 60 * 60_000
const CHECK_BATCH = 50
const BUSY_RETRY_MS = 30_000

export function nextCheckAt(checks: number, now: number): number {
  const step = RECONCILE_BACKOFF_MS[Math.min(checks, RECONCILE_BACKOFF_MS.length - 1)]!
  return now + step
}

function key(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

function storageKey(): string | null {
  try {
    return accountLocalKey(storageRegistry.holdingsReconcile.key)
  } catch {
    return null
  }
}

type Ledger = {
  entries: Map<string, HoldingsEntry>
  /** Off-chain-index rows the chain confirmed unspent, by outpoint → quiet until. */
  quiet: Map<string, number>
}

function readLedger(): Ledger {
  const ledger: Ledger = { entries: new Map(), quiet: new Map() }
  const storeKey = storageKey()
  if (!storeKey) return ledger
  try {
    const raw = durableGetItem(storeKey)
    if (!raw) return ledger
    const parsed = JSON.parse(raw) as { entries?: unknown; quiet?: unknown }
    for (const row of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const e = row as Partial<HoldingsEntry>
      if (typeof e.outpoint !== 'string' || !/^[0-9a-f]{64}\.\d+$/.test(e.outpoint)) continue
      if (e.asset !== 'token' && e.asset !== 'item') continue
      if (e.gap !== 'left-basket' && e.gap !== 'off-chain-index') continue
      ledger.entries.set(e.outpoint, {
        outpoint: e.outpoint,
        asset: e.asset,
        gap: e.gap,
        ...(typeof e.label === 'string' ? { label: e.label } : {}),
        since: Number(e.since) || 0,
        checks: Number(e.checks) || 0,
        nextAt: Number(e.nextAt) || 0,
      })
    }
    const quiet = parsed.quiet && typeof parsed.quiet === 'object' ? parsed.quiet : {}
    const now = Date.now()
    for (const [op, until] of Object.entries(quiet as Record<string, unknown>)) {
      if (typeof until === 'number' && until > now) ledger.quiet.set(op, until)
    }
  } catch {
    /* unreadable ledger starts empty; the next read re-reports every gap */
  }
  return ledger
}

function writeLedger(ledger: Ledger): void {
  const storeKey = storageKey()
  if (!storeKey) return
  durableSetItem(
    storeKey,
    JSON.stringify({
      entries: [...ledger.entries.values()],
      quiet: Object.fromEntries(ledger.quiet),
    }),
  )
}

export function listHoldingsEntries(): HoldingsEntry[] {
  return [...readLedger().entries.values()]
}

function describe(e: Pick<HoldingsEntry, 'asset' | 'outpoint' | 'label'>): string {
  return `${e.asset} ${e.outpoint}${e.label ? ` (${e.label.slice(0, 32)})` : ''}`
}

export type HoldingsReport = {
  asset: HoldingsAsset
  /** Every outpoint this read listed. */
  listed: ReadonlySet<string>
  /** Outpoints the previous projection held that this read did not list. */
  leftBasket?: ReadonlyArray<{ outpoint: string; label?: string }>
  /**
   * The full set of listed items the address scan omits, when a scan answered.
   * Omit when there was no scan — nothing is pruned then.
   */
  offChainIndex?: ReadonlyArray<{ outpoint: string; label?: string }>
}

/**
 * File what one usable read found. Only call with a read the wallet answered
 * in full while no region was rewriting the database.
 */
export function reportHoldings(report: HoldingsReport, now = Date.now()): void {
  const ledger = readLedger()
  let changed = false
  const listed = new Set([...report.listed].map(key))
  const offIndex = report.offChainIndex
    ? new Map(report.offChainIndex.map((o) => [key(o.outpoint), o]))
    : null

  for (const entry of [...ledger.entries.values()]) {
    // Held in either basket is held: a heal that refiles an item row as a
    // token closes the item's departure.
    if (entry.gap === 'left-basket' && listed.has(entry.outpoint)) {
      ledger.entries.delete(entry.outpoint)
      changed = true
      console.info(`[holdings] ${describe(entry)} closed — held-again after ${entry.checks} check(s)`)
      continue
    }
    if (entry.asset !== report.asset) continue
    if (entry.gap === 'off-chain-index' && offIndex && !offIndex.has(entry.outpoint)) {
      ledger.entries.delete(entry.outpoint)
      changed = true
    }
  }

  for (const left of report.leftBasket ?? []) {
    const op = key(left.outpoint)
    if (!/^[0-9a-f]{64}\.\d+$/.test(op) || listed.has(op)) continue
    if (isItemSent(op) || isItemAbandoned(op)) continue
    const prior = ledger.entries.get(op)
    if (prior?.gap === 'left-basket') continue
    ledger.entries.set(op, {
      outpoint: op,
      asset: report.asset,
      gap: 'left-basket',
      ...(left.label ? { label: left.label } : {}),
      since: prior?.since ?? now,
      checks: prior?.checks ?? 0,
      nextAt: Math.max(prior?.nextAt ?? 0, now + RECONCILE_SETTLE_MS),
    })
    changed = true
    console.info(`[holdings] ${describe({ asset: report.asset, outpoint: op, label: left.label })} left-basket — checking chain`)
  }

  for (const [op, gap] of offIndex ?? []) {
    if (ledger.entries.has(op) || (ledger.quiet.get(op) ?? 0) > now) continue
    if (isItemSent(op) || isItemAbandoned(op)) continue
    ledger.entries.set(op, {
      outpoint: op,
      asset: report.asset,
      gap: 'off-chain-index',
      ...(gap.label ? { label: gap.label } : {}),
      since: now,
      checks: 0,
      nextAt: now + RECONCILE_SETTLE_MS,
    })
    changed = true
    console.info(`[holdings] ${describe({ asset: report.asset, outpoint: op, label: gap.label })} off-chain-index — checking chain`)
  }

  if (changed) writeLedger(ledger)
  if (ledger.entries.size > 0) scheduleReconcile()
}

let timer: ReturnType<typeof setTimeout> | null = null
let running: Promise<void> | null = null
let accountEpoch = 0

function scheduleReconcile(delayMs?: number): void {
  if (timer) return
  const entries = [...readLedger().entries.values()]
  if (entries.length === 0) return
  const soonest = Math.min(...entries.map((e) => e.nextAt))
  const wait = delayMs ?? Math.max(1_000, soonest - Date.now())
  timer = setTimeout(() => {
    timer = null
    void runReconcile()
  }, wait)
}

export function rebindHoldingsReconcileForAccount(): void {
  accountEpoch += 1
  if (timer) clearTimeout(timer)
  timer = null
  running = null
  // The bound account's own ledger resumes on its first read.
  queueMicrotask(() => scheduleReconcile())
}

/** True only when the spender's raw body has an input spending `outpoint`. */
async function spenderConsumes(
  spender: string,
  outpoint: string,
  chain: Chain,
): Promise<boolean> {
  const [txid, vout] = outpoint.split('.')
  try {
    const { fetchRawTxHex } = await import('./oneSatImport')
    const hex = await fetchRawTxHex(spender, chain, { pinMiss: false })
    if (!hex) return false
    const tx = Transaction.fromHex(hex)
    if (tx.id('hex') !== spender.toLowerCase()) return false
    return tx.inputs.some(
      (input) =>
        input.sourceTXID?.toLowerCase() === txid && input.sourceOutputIndex === Number(vout),
    )
  } catch {
    return false
  }
}

async function walletIdle(): Promise<boolean> {
  const { walletRegionsIdle } = await import('./walletCoordinator')
  return walletRegionsIdle()
}

export function runReconcile(): Promise<void> {
  if (running) return running
  running = reconcileDue().finally(() => {
    running = null
    scheduleReconcile()
  })
  return running
}

async function reconcileDue(): Promise<void> {
  const epoch = accountEpoch
  const { getActiveWallet } = await import('./session')
  const active = getActiveWallet()
  if (!active) return
  const now = Date.now()
  const due = [...readLedger().entries.values()]
    .filter((e) => e.nextAt <= now)
    .sort((a, b) => a.nextAt - b.nextAt)
    .slice(0, CHECK_BATCH)
  if (due.length === 0) return
  if (!(await walletIdle())) {
    scheduleReconcile(BUSY_RETRY_MS)
    return
  }
  const startedAt = Date.now()
  const { probeOutpointSpends } = await import('./createActionInputFate')
  const probes = await probeOutpointSpends(due.map((e) => e.outpoint), '', active.chain)
  if (epoch !== accountEpoch) return

  const spenderProven = new Set<string>()
  const reservedBy = new Map<string, string>()
  const { assetRowReservation } = await import('./staleOutputRelease')
  for (const entry of due) {
    const probe = probes.get(entry.outpoint)
    if (probe?.kind === 'spent') {
      if (await spenderConsumes(probe.spender, entry.outpoint, active.chain)) {
        spenderProven.add(entry.outpoint)
      }
    } else if (probe?.kind === 'unspent' && entry.gap === 'left-basket') {
      const status = await assetRowReservation(active, entry.outpoint)
      if (status) reservedBy.set(entry.outpoint, status)
    }
  }
  if (epoch !== accountEpoch) return

  const ledger = readLedger()
  const claimTxids = new Map<string, Set<string>>()
  const touched = new Set<HoldingsAsset>()
  for (const entry of due) {
    const current = ledger.entries.get(entry.outpoint)
    if (!current) continue
    const fate = chooseReconcileFate({
      gap: current.gap,
      sentHere: isItemSent(current.outpoint) || sealedSpenderOf(current.outpoint) != null,
      abandoned: isItemAbandoned(current.outpoint),
      reserved: isUtxoBlockedFromRestore(current.outpoint) || reservedBy.has(current.outpoint),
      probe: probes.get(current.outpoint) ?? { kind: 'unknown' },
      spenderProven: spenderProven.has(current.outpoint),
    })
    const checks = current.checks + 1
    switch (fate.kind) {
      case 'close':
        ledger.entries.delete(current.outpoint)
        if (fate.reason === 'chain-agrees') {
          ledger.quiet.set(current.outpoint, now + CHAIN_AGREES_QUIET_MS)
        }
        console.info(
          `[holdings] ${describe(current)} closed — ${fate.reason}${fate.spender ? ` by ${fate.spender.slice(0, 12)}` : ''}`,
        )
        break
      case 'retire': {
        if (!(await walletIdle())) {
          ledger.entries.set(current.outpoint, { ...current, nextAt: now + BUSY_RETRY_MS })
          break
        }
        markItemsConsumed([current.outpoint])
        await active.wallet
          .relinquishOutput({
            basket: current.asset === 'item' ? '1sat' : 'bsv21',
            output: current.outpoint,
          })
          .catch(() => undefined)
        ledger.entries.delete(current.outpoint)
        touched.add(current.asset)
        console.info(
          `[holdings] ${describe(current)} retired — spent on chain by ${fate.spender.slice(0, 12)}`,
        )
        break
      }
      case 'restore': {
        if (!(await walletIdle())) {
          ledger.entries.set(current.outpoint, { ...current, nextAt: now + BUSY_RETRY_MS })
          break
        }
        const { restoreUnspentAssetOutpoint } = await import('./staleOutputRelease')
        const restored = await restoreUnspentAssetOutpoint(active, current.outpoint).catch(() => false)
        // A row restored last time that still does not list has lost its
        // basket, not its spendability — only a claim files it again.
        if (!restored || current.checks > 0) {
          const txid = current.outpoint.split('.')[0]!
          const only = claimTxids.get(txid) ?? new Set<string>()
          only.add(current.outpoint)
          claimTxids.set(txid, only)
        }
        ledger.entries.set(current.outpoint, { ...current, checks, nextAt: nextCheckAt(checks, now) })
        touched.add(current.asset)
        console.info(
          `[holdings] ${describe(current)} unspent on chain — ${restored ? 'row restored' : 'row missing'}${claimTxids.get(current.outpoint.split('.')[0]!)?.has(current.outpoint) ? ', claiming from its transaction' : ''} (check ${checks})`,
        )
        break
      }
      case 'recheck':
        ledger.entries.set(current.outpoint, { ...current, checks, nextAt: nextCheckAt(checks, now) })
        console.info(
          `[holdings] ${describe(current)} kept — ${fate.reason}${reservedBy.has(current.outpoint) ? ` by a ${reservedBy.get(current.outpoint)} transaction` : ''} (check ${checks})`,
        )
        break
    }
  }
  writeLedger(ledger)

  for (const [txid, only] of claimTxids) {
    if (epoch !== accountEpoch) return
    try {
      const { recoverFromTx } = await import('./recoverFromTx')
      const outcome = await recoverFromTx(txid, { only })
      console.info(
        `[holdings] claim ${txid.slice(0, 12)} — ours=${outcome.ours} tokens=${outcome.tokens} items=${outcome.items} unrecognized=${outcome.unrecognized}`,
      )
    } catch (err) {
      console.warn(
        `[holdings] claim ${txid.slice(0, 12)} failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const ms = Date.now() - startedAt
  if (ms >= 250) console.info(`[holdings] reconcile done ${ms}ms — ${due.length} checked`)
  if (epoch !== accountEpoch) return
  if (touched.has('item')) {
    void import('./collectables').then(({ listCollectables }) => listCollectables()).catch(() => {})
  }
  if (touched.has('token')) {
    void import('./token/list').then(({ listFungibles }) => listFungibles()).catch(() => {})
  }
}

/** Test-only */
export function __resetHoldingsReconcileForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  running = null
  accountEpoch = 0
}
