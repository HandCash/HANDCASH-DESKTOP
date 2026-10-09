import type { ActiveWallet } from '../session'
import { getWalletRuntime } from '../walletRuntime'
import { appendAppLog } from '../appLog'
import { beginWalletJob, type WalletJobHandle } from '../walletJobs'
import { IMPORT_CHUNK } from '../../machines/importQueueMachine'
import { MAX_ITEMS_PER_MIGRATE_TX } from '../itemMigrateBundle'
import {
  clearPhraseItemMigrateCursor,
  peekPhraseItemMigrateCursor,
  refreshAfterPhraseItemMigrate,
  scanAddressAny,
  sweepPhraseFunding,
  type PhraseFundingSource,
  type PhraseCandidate,
} from '../phraseSweep'
import {
  addHeld,
  totalHoldings,
  type AddressHoldings,
  type HeldTally,
  type HoldingsTotals,
} from './holdings'
import { keyDeriverFor } from './importSource'
import { listedImportOutpoints } from './itemStore'
import { clearImportItems, importItems, syncImportItems } from './items'
import { sweepTokensFromAddress } from './tokenSweep'
import { loadImportedSources, updateImportedSource, type ImportedSource, type SweepSummary } from './store'

/**
 * Explicit, compatible-only sweep of a saved source.
 *
 * Never automatic: it runs from the user's confirm on a preview. Cash, 1-sat
 * collectables and valid BSV-21 tokens move into this wallet; everything else
 * stays at the source and is reported with its reason. Each asset class uses
 * the path this wallet already trusts for it — legacy cash sweep, the item
 * migrate (BRC-150 remittance, bundled across addresses from the saved list),
 * and the token sweep.
 * The whole sweep is one wallet job: one Activity row with a bar, and its item
 * rows fold into one record.
 */

/** Tips per item transaction; matches the preview's fee estimate. */
export const IMPORT_ITEMS_PER_TX = MAX_ITEMS_PER_MIGRATE_TX
/** Address reads in flight while the cash step lists coins. */
const CASH_SCAN_CONCURRENCY = 4

export type SweepPlan = {
  cash: AddressHoldings[]
  items: AddressHoldings[]
  tokens: AddressHoldings[]
  totals: HoldingsTotals
}

/** What an explicit sweep would move, from the last scan. Pure. */
export function planSweep(source: Pick<ImportedSource, 'scan'>): SweepPlan {
  const holdings = (source.scan?.holdings ?? []).filter((h) => !h.uncompressed)
  return {
    cash: holdings.filter((h) => h.cashCount > 0),
    items: holdings.filter((h) => h.itemCount > 0),
    tokens: holdings.filter((h) => h.tokens.some((t) => t.standard === 'bsv21' && t.id)),
    totals: totalHoldings(source.scan?.holdings ?? []),
  }
}

export type SweepProgress = {
  phase: 'cash' | 'items' | 'tokens' | 'refresh'
  message: string
  /** Items moved so far, counted as each transaction broadcasts. */
  done: number
  /** Items listed for this sweep; null outside the item step or before the list is read. */
  total: number | null
  /**
   * The chunk in flight when the sweep spans more than one: 11 items of
   * 2,630 do not move a bar, 11 of a 100-item batch do.
   */
  batch: { done: number; total: number } | null
}

export async function sweepImportedSource(args: {
  sourceId: string
  onProgress?: (progress: SweepProgress) => void
  shouldStop?: () => boolean
}): Promise<SweepSummary> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')
  if (!source.scan) throw new Error('Scan this wallet before sweeping it')

  const startedAt = Date.now()
  const plan = planSweep(source)
  const job = beginWalletJob({ kind: 'wallet-sweep', identityKey: active.identityKey, startedAt })
  try {
    const { summary, paused } = await runSweep(args, source, plan, active, job)
    if (paused) job.stop(paused)
    else job.finish(`${summary.items.toLocaleString()} collectable(s) moved`)
    appendAppLog(
      'info',
      `[import] sweep done ${Date.now() - startedAt}ms kind=${source.kind} cash=${summary.cashSats}sats items=${summary.items}` +
        ` tokens=${summary.tokens.length} failed=${summary.failed}${paused ? ' paused' : ''}`,
    )
    return summary
  } catch (err) {
    job.fail(err instanceof Error ? err.message : String(err))
    throw err
  }
}

async function runSweep(
  args: Parameters<typeof sweepImportedSource>[0],
  source: ImportedSource,
  plan: SweepPlan,
  active: ActiveWallet,
  job: WalletJobHandle,
): Promise<{ summary: SweepSummary; paused: string | null }> {
  const deriver = keyDeriverFor(source.secret)
  /** Known once the saved list is read; the bar runs indeterminate until then. */
  let itemTotal: number | null = null
  const report = (
    phase: SweepProgress['phase'],
    message: string,
    itemsDone = 0,
    batch: SweepProgress['batch'] = null,
  ) => {
    const total = phase === 'items' ? itemTotal : null
    args.onProgress?.({ phase, message, done: itemsDone, total, batch })
    job.progress(itemsDone, total, message)
  }
  const stop = () => args.shouldStop?.() === true
  const notes: string[] = []
  // Listed tips are counted per output by the token sweep itself.
  const { listed: _listed, ...preHeld } = plan.totals.held
  let held: HeldTally = preHeld
  let cashSats = 0
  let items = 0
  let failed = 0
  /** Why the sweep stopped short and resumes on the next one; null when it ran out of work. */
  let paused: string | null = null
  const tokens: SweepSummary['tokens'] = []

  const candidateFor = (h: AddressHoldings): PhraseCandidate | null => {
    const key = deriver.privateKeyAt(h.path)
    if (key.toPublicKey().toString().toLowerCase() === active.identityKey.toLowerCase()) {
      notes.push(`${h.label} is this wallet’s own key — use Refresh instead.`)
      return null
    }
    return {
      scheme: 'import',
      label: h.label,
      path: h.path,
      rootKeyHex: key.toHex(),
      identityKey: key.toPublicKey().toString(),
      address: h.address,
    }
  }

  // Cash first: it is what pays for item and token transactions. Every address
  // is read, then all of its coins share transactions, each signed by its own key.
  const cashFrom = plan.cash.flatMap((h) => {
    const candidate = candidateFor(h)
    return candidate ? [candidate] : []
  })
  if (cashFrom.length > 0 && !stop()) {
    const scannedAt = Date.now()
    const sources: PhraseFundingSource[] = []
    let read = 0
    let next = 0
    const reader = async () => {
      while (next < cashFrom.length && !stop()) {
        const candidate = cashFrom[next++]!
        report('cash', `Reading BSV addresses… ${read} of ${cashFrom.length}`)
        try {
          const scan = await scanAddressAny(candidate.address, active.chain)
          if (scan.utxos.length > 0) sources.push({ candidate, utxos: scan.utxos })
        } catch {
          notes.push(`${candidate.label} could not be read. Sweep again to move its BSV.`)
        }
        read += 1
      }
    }
    await Promise.all(Array.from({ length: Math.min(CASH_SCAN_CONCURRENCY, cashFrom.length) }, reader))
    appendAppLog('info', `[import] cash scan addresses=${cashFrom.length} holding=${sources.length} done ${Date.now() - scannedAt}ms`)
    if (sources.length > 0 && !stop()) {
      report('cash', `Moving BSV from ${sources.length} address(es)…`)
      const result = await sweepPhraseFunding({ sources })
      cashSats += result.fundingSatsMoved
      failed += result.failed
      notes.push(...result.errors.slice(0, 2))
    }
  }

  // Items ride the cross-address migrate Browse items uses: each carries the key
  // of the address holding it, so a HandCash export — one item per address —
  // still shares transactions — a whole chunk per transaction — instead of one
  // per address.
  if (plan.items.length > 0 && !stop()) {
    const ownedHere = new Set(plan.items.map((h) => h.address))
    const cursor = peekPhraseItemMigrateCursor()
    // An older build's paused per-address run on this source: the list below covers it.
    if (cursor && ownedHere.has(cursor.sourceAddress)) clearPhraseItemMigrateCursor()
    report('items', 'Listing collectables…')
    const listing = await syncImportItems({ sourceId: source.id, shouldStop: stop })
    if (!listing.complete && !stop()) {
      notes.push('Some addresses could not be read. Sweep again to move what they hold.')
    }
    const listed = [...(await listedImportOutpoints(source.id))]
    itemTotal = listed.length || null
    for (let i = 0; i < listed.length && !stop() && !paused; i += IMPORT_CHUNK) {
      const outpoints = listed.slice(i, i + IMPORT_CHUNK)
      const inChunk = new Set(outpoints)
      const landed = new Set<string>()
      const reportMoving = () => {
        const done = items + landed.size
        const batch = listed.length > IMPORT_CHUNK ? { done: landed.size, total: outpoints.length } : null
        const of = `${done.toLocaleString()} of ${listed.length.toLocaleString()}`
        report(
          'items',
          batch ? `Moving collectables… ${of} · batch ${batch.done} of ${batch.total}` : `Moving collectables… ${of}`,
          done,
          batch,
        )
      }
      reportMoving()
      const chunk = await importItems({
        sourceId: source.id,
        identityKey: active.identityKey,
        outpoints,
        activityGroup: job.id,
        onLanded: (moved) => {
          for (const outpoint of moved) if (inChunk.has(outpoint)) landed.add(outpoint)
          reportMoving()
        },
      })
      for (const { result } of chunk.results) {
        if (result.kind === 'moved') items += 1
        else if (result.kind === 'skipped') held = addHeld(held, 'notCollectable', 1)
        else if (result.kind === 'failed' || result.kind === 'unreadable') failed += 1
      }
      const lastError = chunk.results.find((r) => r.result.kind === 'failed')?.result
      if (lastError && 'message' in lastError) notes.push(lastError.message)
      if (chunk.stopped === 'funds') {
        paused = 'This wallet ran low on BSV for item fees. Add funds and sweep again — it resumes.'
        notes.push(paused)
      } else if (chunk.stopped === 'stale-funding') {
        paused = 'A spent fee coin is being cleared from this wallet. Sweep again in a moment — it resumes.'
        notes.push(paused)
      }
    }
    report('items', `Moved ${items.toLocaleString()} collectable(s)`, items)
  }

  for (const h of plan.tokens) {
    if (stop() || paused) break
    const candidate = candidateFor(h)
    if (!candidate) continue
    report('tokens', `Moving tokens from ${h.label}…`, items)
    const result = await sweepTokensFromAddress({
      active,
      spendKey: deriver.privateKeyAt(h.path),
      address: h.address,
      tokens: h.tokens.filter((t) => t.standard === 'bsv21' && t.id),
    })
    for (const moved of result.moved) {
      const sym = h.tokens.find((t) => t.id === moved.tokenId)?.sym ?? 'token'
      tokens.push({ tokenId: moved.tokenId, sym, amount: moved.amount })
    }
    for (const [reason, count] of Object.entries(result.held)) {
      held = addHeld(held, reason as keyof HeldTally, count ?? 0)
    }
    failed += result.failed
    notes.push(...result.errors.slice(0, 2))
    if (result.stopped === 'funds') {
      paused = 'This wallet ran low on BSV for token fees. Add funds and sweep again.'
      notes.push(paused)
    }
  }

  if (cashSats > 0 || items > 0 || tokens.length > 0) {
    report('refresh', 'Checking the chain…', items)
    await refreshAfterPhraseItemMigrate()
  }
  if (stop()) {
    paused ??= 'Paused — sweep again to continue.'
    notes.push('Paused — sweep again to continue.')
  }

  const summary: SweepSummary = {
    at: Date.now(),
    cashSats,
    items,
    tokens,
    held,
    failed,
    notes: [...new Set(notes)].slice(0, 8),
  }
  await clearImportItems(source.id)
  await updateImportedSource(source.id, { lastSweep: summary })
  return { summary, paused }
}
