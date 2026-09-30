/**
 * Evidence sweep of the managed-change pool for coins a confirmed foreign tx
 * already spent.
 *
 * A sign that picks one such coin pays a probe, a retire and a second sign
 * before the app hears back. When one turns up the pool usually holds more, and
 * finding them three per payment turned every background bounce into a resign.
 * This pass asks once, off the spend path, and hides only on the same evidence
 * the per-sign probe uses: a named, confirmed spender that is not us. A timeout,
 * rate limit, 404 or unconfirmed spender never writes a coin off.
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
import {
  getWalletRuntime,
  runtimeIsCurrent,
  type WalletRuntime,
} from './walletRuntime'
import {
  outpointRecentlyCleared,
  probeOutpointSpend,
} from './createActionInputFate'
import { outpointFromOutput } from './txOutpoints'

const SWEEP_COOLDOWN_MS = 10 * 60_000
/** Let the payment that found the dead coin reply before probing. */
const START_DELAY_MS = 1_500
const MAX_PROBES = 300
/** WhatsOnChain's keyless limit is ~3 req/s; leave room for a live sign. */
const PROBE_CONCURRENCY = 2
const ENUM_PAGE = 500
const ENUM_MAX_PAGES = 20
const SPEND_POLL_MS = 500
const SPEND_WAIT_MAX_MS = 60_000
/** Unlock settles (history restore, first ingest) before old hides are replayed. */
const RECOVERY_DELAY_MS = 45_000
const RECOVERY_MAX_SPENDERS = 200
const TXID_RE = /^[0-9a-f]{64}$/

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

let lastSweepAt = 0
let flight: Promise<DeadCoinSweepResult> | null = null
const pendingSpenders = new Set<string>()
let adoptFlight: Promise<void> | null = null
const recoveredRuntimes = new Set<string>()

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function resetDeadCoinSweepForTests(): void {
  lastSweepAt = 0
  flight = null
  pendingSpenders.clear()
  adoptFlight = null
  recoveredRuntimes.clear()
}

/**
 * Coins were just hidden as spent by `spenders`: adopt those spenders, and
 * start one background pool sweep unless one ran recently or is running.
 */
export function scheduleDeadCoinSweep(chain: Chain, spenders: Iterable<string> = []): void {
  const runtime = getWalletRuntime()
  if (!runtime || runtime.instance.chain !== chain) return
  adoptSpendersLater(runtime, spenders)
  if (flight || Date.now() - lastSweepAt < SWEEP_COOLDOWN_MS) return
  lastSweepAt = Date.now()
  flight = (async () => {
    await delay(START_DELAY_MS)
    return sweepDeadCoins(runtime)
  })()
    .catch((err): DeadCoinSweepResult => {
      console.warn('[dead-coins] sweep failed', err)
      return { ran: false, reason: 'error' }
    })
    .finally(() => {
      flight = null
    })
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
 * Once per unlocked account: replay the named spenders of coins hidden before
 * spenders were adopted, so change stranded by those hides comes back.
 */
export function scheduleSpenderRecovery(runtime: WalletRuntime): void {
  if (recoveredRuntimes.has(runtime.runtimeId)) return
  recoveredRuntimes.add(runtime.runtimeId)
  void (async () => {
    await delay(RECOVERY_DELAY_MS)
    const { isRecomposeInFlight } = await import('./recompose')
    while (isRecomposeInFlight()) {
      if (!runtimeIsCurrent(runtime)) return
      await delay(SPEND_POLL_MS * 4)
    }
    if (!runtimeIsCurrent(runtime)) return
    const { listUtxoLocks } = await import('./utxoLockManager')
    const spenders = new Set<string>()
    for (const rec of listUtxoLocks().reverse()) {
      if (!rec.diagnostic?.startsWith('spent-by:')) continue
      const id = String(rec.spentBy ?? '').toLowerCase()
      if (TXID_RE.test(id)) spenders.add(id)
      if (spenders.size >= RECOVERY_MAX_SPENDERS) break
    }
    if (spenders.size === 0) return
    console.info(`[dead-coins] replaying ${spenders.size} named spender(s) of hidden coins`)
    adoptSpendersLater(runtime, spenders)
  })().catch((err) => {
    console.warn('[dead-coins] spender recovery failed', err)
  })
}

export async function sweepDeadCoins(runtime: WalletRuntime): Promise<DeadCoinSweepResult> {
  if (!runtimeIsCurrent(runtime)) return { ran: false, reason: 'locked' }
  const { bumpBalanceAfterHeal } = await import('./session')
  const active = runtime.instance
  const chain = active.chain
  const stillCurrent = () => runtimeIsCurrent(runtime)
  const started = Date.now()

  const outpoints = await probeableChange(active)
  if (!outpoints) return { ran: false, reason: 'noStorage' }

  const spentBy = new Map<string, string[]>()
  let unknown = 0
  let next = 0
  const worker = async () => {
    for (;;) {
      if (!stillCurrent()) return
      if (!(await waitForSpendRegion())) return
      const index = next++
      if (index >= outpoints.length) return
      const outpoint = outpoints[index]!
      const probe = await probeOutpointSpend(outpoint, '', chain)
      if (probe.kind === 'confirmedSpender') {
        const list = spentBy.get(probe.spender) ?? []
        list.push(outpoint)
        spentBy.set(probe.spender, list)
      } else if (probe.kind === 'unknown') {
        unknown += 1
      }
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker))
  if (!stillCurrent()) return { ran: false, reason: 'accountChanged' }

  let hidden = 0
  if (spentBy.size > 0) {
    if (!(await waitForSpendRegion())) return { ran: false, reason: 'spendBusy' }
    if (!stillCurrent()) return { ran: false, reason: 'accountChanged' }
    const { hideSpentOutpoints } = await import('./staleOutputRelease')
    for (const [spender, list] of spentBy) {
      hidden += await hideSpentOutpoints(list, spender, active)
    }
    bumpBalanceAfterHeal()
    adoptSpendersLater(runtime, spentBy.keys())
  }

  console.info(
    `[dead-coins] sweep checked=${outpoints.length} hidden=${hidden} unknown=${unknown} done ${
      Date.now() - started
    }ms`,
  )
  return { ran: true, checked: outpoints.length, hidden, unknown }
}
