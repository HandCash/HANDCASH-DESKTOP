/**
 * Evidence sweep of the managed-change pool for coins a confirmed foreign tx
 * already spent.
 *
 * A sign that picks one such coin pays a probe, a retire and a second sign
 * before the app hears back — seconds, and the difference between a 4s and a
 * 20s background payment. So the pool is swept right after unlock, before the
 * first payment, and again whenever a sign still finds a dead coin. It hides
 * only on the same evidence the per-sign probe uses: a named, confirmed
 * spender that is not us. A timeout, rate limit, unknown output or unconfirmed
 * spender never writes a coin off; those coins are asked again after a pause
 * (hc-a580a 0.1.540: 21 of 50 went unanswered one-per-request, and the next
 * six payments resigned over them).
 *
 * Hiding the coin is only half the repair. A coin still spendable here that a
 * confirmed tx spent is, in practice, an input handed back when this wallet
 * failed its own send locally while that send confirmed; the same fail hid the
 * send's change. Every named spender is therefore adopted: a local `failed`
 * row the chain shows landed is restored, and its change comes back
 * (hc-a580a 0.1.539: ~2.5M sats of phantom coins hidden, change not restored).
 */
import type { Chain } from './vault'
import type { ActiveWallet } from './session'
import type { ConfirmedSpenderAdoption } from './staleOutputRelease'
import {
  getWalletRuntime,
  runtimeIsCurrent,
  type WalletRuntime,
} from './walletRuntime'
import {
  outpointRecentlyCleared,
  probeOutpointSpends,
  SPENT_PROBE_BATCH,
} from './createActionInputFate'
import { outpointFromOutput } from './txOutpoints'
import { createDurableTtlTxidMap } from './durableTtlTxidMap'

const SWEEP_COOLDOWN_MS = 10 * 60_000
/** A sweep that left coins unanswered may run again this soon. */
const RETRY_COOLDOWN_MS = 60_000
/** Let the payment that found the dead coin reply before probing. */
const START_DELAY_MS = 1_500
/** Pauses before asking again about coins the explorer did not answer. */
const RETRY_DELAYS_MS = [5_000, 20_000] as const
/** WhatsOnChain's keyless limit is ~3 req/s; leave room for a live sign. */
const CHUNK_GAP_MS = 400
const SWEEP_PROBE_MS = 4_000
const MAX_PROBES = 300
const ENUM_PAGE = 500
const ENUM_MAX_PAGES = 20
const SPEND_POLL_MS = 500
const SPEND_WAIT_MAX_MS = 60_000
/** Unlock settles (history restore, first ingest) before the first sweep. */
const UNLOCK_SWEEP_DELAY_MS = 8_000
const RECOVERY_MAX_SPENDERS = 200
const TXID_RE = /^[0-9a-f]{64}$/

/** Restored, live or missing: the answer does not change for the same txid. */
const settledSpenders = createDurableTtlTxidMap({
  key: 'handcash.deadCoins.settledSpenders.v1',
  max: 1_000,
  ttlMs: 30 * 24 * 60 * 60_000,
})
/** `notOnChain` includes "no provider answered", so it is asked again a day later. */
const notOnChainSpenders = createDurableTtlTxidMap({
  key: 'handcash.deadCoins.notOnChainSpenders.v1',
  max: 1_000,
  ttlMs: 24 * 60 * 60_000,
})

export type DeadCoinSweepResult =
  | { ran: true; checked: number; hidden: number; unknown: number }
  | {
      ran: false
      reason: 'locked' | 'noStorage' | 'accountChanged' | 'spendBusy' | 'error'
    }

type OutputRow = {
  txid?: unknown
  vout?: unknown
  outputIndex?: unknown
  satoshis?: unknown
  change?: unknown
  basket?: unknown
  transactionId?: unknown
}

type TxRow = { transactionId?: unknown }

let nextSweepAt = 0
let flight: Promise<DeadCoinSweepResult> | null = null
const pendingSpenders = new Set<string>()
let adoptFlight: Promise<void> | null = null
const unlockedRuntimes = new Set<string>()

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function resetDeadCoinSweepForTests(): void {
  nextSweepAt = 0
  flight = null
  pendingSpenders.clear()
  adoptFlight = null
  unlockedRuntimes.clear()
  settledSpenders.reset()
  notOnChainSpenders.reset()
}

function spenderSettled(txid: string): boolean {
  return settledSpenders.has(txid) || notOnChainSpenders.has(txid)
}

function recordAdoption(txid: string, outcome: ConfirmedSpenderAdoption): void {
  try {
    if (outcome === 'notOnChain') notOnChainSpenders.remember(txid)
    else if (outcome !== 'unreadable') settledSpenders.remember(txid)
  } catch {
    // Unrecorded spenders are asked again next unlock; nothing is lost.
  }
}

/**
 * Coins were just hidden as spent by `spenders`: adopt those spenders, and
 * start one background pool sweep unless one ran recently or is running.
 */
export function scheduleDeadCoinSweep(chain: Chain, spenders: Iterable<string> = []): void {
  const runtime = getWalletRuntime()
  if (!runtime || runtime.instance.chain !== chain) return
  adoptSpendersLater(runtime, spenders)
  startSweep(runtime, { force: false })
}

function startSweep(
  runtime: WalletRuntime,
  opts: { force: boolean },
): Promise<DeadCoinSweepResult> | null {
  if (flight) return flight
  if (!opts.force && Date.now() < nextSweepAt) return null
  nextSweepAt = Date.now() + SWEEP_COOLDOWN_MS
  flight = (async () => {
    await delay(START_DELAY_MS)
    return sweepDeadCoins(runtime)
  })()
    .then((result) => {
      if (result.ran && result.unknown > 0) nextSweepAt = Date.now() + RETRY_COOLDOWN_MS
      return result
    })
    .catch((err): DeadCoinSweepResult => {
      console.warn('[dead-coins] sweep failed', err)
      return { ran: false, reason: 'error' }
    })
    .finally(() => {
      flight = null
    })
  return flight
}

/**
 * Spendable managed change whose funding tx may be mined. Change of a live
 * local tx cannot have a confirmed spender, so it is never asked about.
 */
async function probeableChange(active: ActiveWallet): Promise<string[] | null> {
  const storage = active.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  const { LIVE_LOCAL_TX_STATUSES } = await import('./localTxClosure')
  return storage.runAsStorageProvider(async (activeSp) => {
    const sp = activeSp as {
      findOutputs?: (args: unknown) => Promise<OutputRow[] | undefined>
      findTransactions?: (args: unknown) => Promise<TxRow[] | undefined>
    }
    if (typeof sp.findOutputs !== 'function' || typeof sp.findTransactions !== 'function') {
      return null
    }
    const unsettled = new Set<number>()
    for (let page = 0; page < ENUM_MAX_PAGES; page += 1) {
      const batch =
        (await sp.findTransactions({
          partial: {},
          status: [...LIVE_LOCAL_TX_STATUSES],
          noRawTx: true,
          paged: { limit: ENUM_PAGE, offset: page * ENUM_PAGE },
        })) ?? []
      for (const row of batch) {
        const id = Number(row.transactionId)
        if (Number.isFinite(id) && id > 0) unsettled.add(id)
      }
      if (batch.length < ENUM_PAGE) break
    }

    const outpoints: string[] = []
    for (let page = 0; page < ENUM_MAX_PAGES && outpoints.length < MAX_PROBES; page += 1) {
      const batch =
        (await sp.findOutputs({
          partial: { spendable: true, change: true },
          paged: { limit: ENUM_PAGE, offset: page * ENUM_PAGE },
        })) ?? []
      for (const row of batch) {
        if (row.change !== true) continue
        const basket = String(row.basket ?? '').toLowerCase()
        if (basket === '1sat' || basket === 'bsv21') continue
        if (Math.floor(Number(row.satoshis) || 0) <= 1) continue
        if (unsettled.has(Number(row.transactionId))) continue
        const outpoint = outpointFromOutput(row)
        if (!outpoint || outpointRecentlyCleared(outpoint)) continue
        outpoints.push(outpoint)
        if (outpoints.length >= MAX_PROBES) break
      }
      if (batch.length < ENUM_PAGE) break
    }
    return outpoints
  })
}

async function waitForSpendRegion(): Promise<boolean> {
  const { shouldYieldChainIngestToSpend } = await import('./walletCoordinator')
  const deadline = Date.now() + SPEND_WAIT_MAX_MS
  while (shouldYieldChainIngestToSpend()) {
    if (Date.now() > deadline) return false
    await delay(SPEND_POLL_MS)
  }
  return true
}

/** Queue confirmed spenders for adoption off the reply path. */
export function adoptSpendersLater(runtime: WalletRuntime, spenders: Iterable<string>): void {
  for (const raw of spenders) {
    const id = raw.trim().toLowerCase()
    if (TXID_RE.test(id)) pendingSpenders.add(id)
  }
  if (adoptFlight || pendingSpenders.size === 0) return
  adoptFlight = (async () => {
    await delay(START_DELAY_MS)
    await drainSpenders(runtime)
  })()
    .catch((err) => {
      console.warn('[dead-coins] spender adoption failed', err)
    })
    .finally(() => {
      adoptFlight = null
      if (pendingSpenders.size > 0 && runtimeIsCurrent(runtime)) {
        adoptSpendersLater(runtime, [])
      }
    })
}

async function drainSpenders(runtime: WalletRuntime): Promise<void> {
  const { adoptConfirmedSpender } = await import('./staleOutputRelease')
  const tally: Record<string, number> = {}
  while (pendingSpenders.size > 0) {
    if (!runtimeIsCurrent(runtime)) {
      pendingSpenders.clear()
      return
    }
    if (!(await waitForSpendRegion())) continue
    const [txid] = pendingSpenders
    pendingSpenders.delete(txid!)
    const outcome = await adoptConfirmedSpender(txid!)
    recordAdoption(txid!, outcome)
    tally[outcome] = (tally[outcome] ?? 0) + 1
    if (outcome === 'restored') {
      console.info(
        `[dead-coins] restored spender ${txid!.slice(0, 12)} — on chain but failed locally; its change is spendable again`,
      )
    }
  }
  console.info(
    `[dead-coins] spenders ${Object.entries(tally)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')}`,
  )
  if ((tally.restored ?? 0) > 0) {
    const { bumpBalanceAfterHeal } = await import('./session')
    bumpBalanceAfterHeal()
  }
}

/**
 * Once per unlocked account: sweep the pool before the first payment can pick
 * a dead coin, then replay the named spenders of coins hidden earlier so
 * change stranded by those hides comes back. Spenders already settled on a
 * previous launch are not asked again.
 */
export function scheduleUnlockDeadCoinPass(runtime: WalletRuntime): void {
  if (unlockedRuntimes.has(runtime.runtimeId)) return
  unlockedRuntimes.add(runtime.runtimeId)
  void (async () => {
    await delay(UNLOCK_SWEEP_DELAY_MS)
    const { isRecomposeInFlight } = await import('./recompose')
    while (isRecomposeInFlight()) {
      if (!runtimeIsCurrent(runtime)) return
      await delay(SPEND_POLL_MS * 4)
    }
    if (!runtimeIsCurrent(runtime)) return
    await startSweep(runtime, { force: true })
    if (!runtimeIsCurrent(runtime)) return

    const { listUtxoLocks } = await import('./utxoLockManager')
    const spenders = new Set<string>()
    for (const rec of listUtxoLocks().reverse()) {
      if (!rec.diagnostic?.startsWith('spent-by:')) continue
      const id = String(rec.spentBy ?? '').toLowerCase()
      if (!TXID_RE.test(id) || spenderSettled(id)) continue
      spenders.add(id)
      if (spenders.size >= RECOVERY_MAX_SPENDERS) break
    }
    if (spenders.size === 0) return
    console.info(`[dead-coins] replaying ${spenders.size} named spender(s) of hidden coins`)
    adoptSpendersLater(runtime, spenders)
  })().catch((err) => {
    console.warn('[dead-coins] unlock pass failed', err)
  })
}

async function hideBySpender(
  runtime: WalletRuntime,
  spentBy: Map<string, string[]>,
): Promise<number> {
  if (spentBy.size === 0) return 0
  const { hideSpentOutpoints } = await import('./staleOutputRelease')
  const { bumpBalanceAfterHeal } = await import('./session')
  let hidden = 0
  for (const [spender, list] of spentBy) {
    hidden += await hideSpentOutpoints(list, spender, runtime.instance)
  }
  bumpBalanceAfterHeal()
  adoptSpendersLater(runtime, spentBy.keys())
  return hidden
}

export async function sweepDeadCoins(runtime: WalletRuntime): Promise<DeadCoinSweepResult> {
  if (!runtimeIsCurrent(runtime)) return { ran: false, reason: 'locked' }
  const chain = runtime.instance.chain
  const started = Date.now()

  const outpoints = await probeableChange(runtime.instance)
  if (!outpoints) return { ran: false, reason: 'noStorage' }

  let pending = outpoints
  let hidden = 0
  for (let pass = 0; pending.length > 0 && pass <= RETRY_DELAYS_MS.length; pass += 1) {
    if (pass > 0) await delay(RETRY_DELAYS_MS[pass - 1]!)
    const spentBy = new Map<string, string[]>()
    const unanswered: string[] = []
    for (let i = 0; i < pending.length; i += SPENT_PROBE_BATCH) {
      if (i > 0) await delay(CHUNK_GAP_MS)
      if (!(await waitForSpendRegion())) return { ran: false, reason: 'spendBusy' }
      if (!runtimeIsCurrent(runtime)) return { ran: false, reason: 'accountChanged' }
      const chunk = pending.slice(i, i + SPENT_PROBE_BATCH)
      const probes = await probeOutpointSpends(chunk, '', chain, SWEEP_PROBE_MS)
      for (const outpoint of chunk) {
        const probe = probes.get(outpoint)
        if (probe?.kind === 'confirmedSpender') {
          const list = spentBy.get(probe.spender) ?? []
          list.push(outpoint)
          spentBy.set(probe.spender, list)
        } else if (probe?.kind !== 'noConfirmedSpender') {
          unanswered.push(outpoint)
        }
      }
    }
    if (spentBy.size > 0) {
      if (!(await waitForSpendRegion())) return { ran: false, reason: 'spendBusy' }
      if (!runtimeIsCurrent(runtime)) return { ran: false, reason: 'accountChanged' }
      hidden += await hideBySpender(runtime, spentBy)
    }
    pending = unanswered
  }

  console.info(
    `[dead-coins] sweep checked=${outpoints.length} hidden=${hidden} unknown=${pending.length} done ${
      Date.now() - started
    }ms`,
  )
  return { ran: true, checked: outpoints.length, hidden, unknown: pending.length }
}
