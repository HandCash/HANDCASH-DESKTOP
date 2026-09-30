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

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function resetDeadCoinSweepForTests(): void {
  lastSweepAt = 0
  flight = null
}

/** Start one background sweep unless one ran recently or is still running. */
export function scheduleDeadCoinSweep(chain: Chain): void {
  const runtime = getWalletRuntime()
  if (!runtime || runtime.instance.chain !== chain) return
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
  }

  console.info(
    `[dead-coins] sweep checked=${outpoints.length} hidden=${hidden} unknown=${unknown} done ${
      Date.now() - started
    }ms`,
  )
  return { ran: true, checked: outpoints.length, hidden, unknown }
}
