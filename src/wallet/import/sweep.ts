import { getWalletRuntime } from '../walletRuntime'
import { appendAppLog } from '../appLog'
import {
  migratePhraseItemsBatch,
  peekPhraseItemMigrateCursor,
  refreshAfterPhraseItemMigrate,
  scanAddressAny,
  sweepPhraseFunding,
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
import { sweepTokensFromAddress } from './tokenSweep'
import { loadImportedSources, updateImportedSource, type ImportedSource, type SweepSummary } from './store'

/**
 * Explicit, compatible-only sweep of a saved source.
 *
 * Never automatic: it runs from the user's confirm on a preview. Cash, 1-sat
 * collectables and valid BSV-21 tokens move into this wallet; everything else
 * stays at the source and is reported with its reason. Each asset class uses
 * the path this wallet already trusts for it — legacy cash sweep, the item
 * migrate (BRC-150 remittance, durable resume cursor), and the token sweep.
 */

/** Tips per item transaction; matches the preview's fee estimate. */
export const IMPORT_ITEMS_PER_TX = 25

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
  const deriver = keyDeriverFor(source.secret)
  const report = (phase: SweepProgress['phase'], message: string) =>
    args.onProgress?.({ phase, message })
  const stop = () => args.shouldStop?.() === true
  const notes: string[] = []
  // Listed tips are counted per output by the token sweep itself.
  const { listed: _listed, ...preHeld } = plan.totals.held
  let held: HeldTally = preHeld
  let cashSats = 0
  let items = 0
  let failed = 0
  let outOfFunds = false
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

  // Cash first: it is what pays for item and token transactions.
  for (const h of plan.cash) {
    if (stop()) break
    const candidate = candidateFor(h)
    if (!candidate) continue
    report('cash', `Moving BSV from ${h.label}…`)
    const scan = await scanAddressAny(h.address, active.chain)
    const result = await sweepPhraseFunding({ candidate, utxos: scan.utxos })
    cashSats += result.fundingSatsMoved
    failed += result.failed
    notes.push(...result.errors.slice(0, 2))
  }

  // One durable item cursor exists per wallet. Resume its source first; a
  // cursor from another source blocks items until it is finished or forgotten.
  const cursor = peekPhraseItemMigrateCursor()
  const cursorHere = cursor ? plan.items.find((h) => h.address === cursor.sourceAddress) : null
  const itemOrder = cursorHere
    ? [cursorHere, ...plan.items.filter((h) => h !== cursorHere)]
    : plan.items
  if (cursor && !cursorHere && plan.items.length > 0) {
    notes.push(
      'Another import’s collectables are paused. Finish or forget that pending import before moving these items.',
    )
  } else {
    for (const h of itemOrder) {
      if (stop() || outOfFunds) break
      const candidate = candidateFor(h)
      if (!candidate) continue
      let barren = 0
      let lastMoved = 0
      let lastFailed = 0
      for (let guard = 0; guard < 200_000 && !stop(); guard += 1) {
        const batch = await migratePhraseItemsBatch({
          candidate,
          batchSize: 50,
          itemsPerTx: IMPORT_ITEMS_PER_TX,
          ...(h.itemCountCapped ? {} : { expectedItemCount: h.itemCount }),
        })
        report('items', `Moving collectables from ${h.label}… ${(items + batch.moved).toLocaleString()} so far`)
        if (batch.done || batch.stopped === 'funds') {
          items += batch.moved
          failed += batch.failed
          held = addHeld(held, 'notCollectable', batch.skipped)
          if (batch.stopped === 'funds') {
            outOfFunds = true
            notes.push('This wallet ran low on BSV for item fees. Add funds and sweep again — it resumes.')
          }
          break
        }
        const stalled = batch.moved === lastMoved && batch.failed > lastFailed
        barren = stalled ? barren + 1 : 0
        lastMoved = batch.moved
        lastFailed = batch.failed
        if (barren >= 3) {
          items += batch.moved
          failed += batch.failed
          notes.push(batch.lastError ?? `No collectables could be moved from ${h.label}.`)
          break
        }
      }
    }
  }

  for (const h of plan.tokens) {
    if (stop() || outOfFunds) break
    const candidate = candidateFor(h)
    if (!candidate) continue
    report('tokens', `Moving tokens from ${h.label}…`)
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
      outOfFunds = true
      notes.push('This wallet ran low on BSV for token fees. Add funds and sweep again.')
    }
  }

  if (cashSats > 0 || items > 0 || tokens.length > 0) {
    report('refresh', 'Checking the chain…')
    await refreshAfterPhraseItemMigrate()
  }
  if (stop()) notes.push('Paused — sweep again to continue.')

  const summary: SweepSummary = {
    at: Date.now(),
    cashSats,
    items,
    tokens,
    held,
    failed,
    notes: [...new Set(notes)].slice(0, 8),
  }
  await updateImportedSource(source.id, { lastSweep: summary })
  appendAppLog(
    'info',
    `[import] sweep done ${Date.now() - startedAt}ms kind=${source.kind} cash=${cashSats}sats items=${items} tokens=${tokens.length} failed=${failed}`,
  )
  return summary
}
