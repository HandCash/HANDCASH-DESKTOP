import { getWalletRuntime } from '../walletRuntime'
import { appendAppLog } from '../appLog'
import type { Chain } from '../vault'
import {
  migrateChosenPhraseItems,
  peekPhraseItemMigrateCursor,
  type SingleItemMigrate,
} from '../phraseSweep'
import { gorillaBase, type FetchLike } from './discovery'
import { fetchHandCashUtxoSet, readUnspentOutpoints, verifyUtxoSet } from './handcashUtxoSet'
import type { AddressHoldings } from './holdings'
import { keyDeriverFor } from './importSource'
import { importItemFacts, withImportItemArt, type ImportItem, type ImportItemGroup } from './importItem'
import {
  countImportItems,
  decidedImportOutpoints,
  forgetImportItemStore,
  groupImportOutpoints,
  listedImportOutpoints,
  markImportOutpointsGone,
  pruneImportItems,
  readImportGroups,
  readImportItemPage,
  readImportListMeta,
  readStoredImportItems,
  replaceAddressItems,
  saveImportItems,
  writeImportListMeta,
  type StoredImportItem,
} from './itemStore'
import { loadImportedSources, updateImportedSource, type ImportedSource } from './store'

export type { ImportItem, ImportItemGroup } from './importItem'

/**
 * The 1-sat items a saved source holds, for browsing and moving by choice.
 *
 * The list is saved on this device (`itemStore.ts`) as it is found and read
 * back a page at a time, so closing the browser or the app keeps it and the
 * next run asks the index only about outputs it has never checked. It holds
 * an item for as long as the source does. Moving an item re-decides it from
 * its source transaction — the list is the index's view, never proof.
 */

const ADDRESS_PAGE = 100
const ADDRESS_MAX_PAGES = 50
const ADDRESS_CONCURRENCY = 4

type AddressItems = { items: ImportItem[]; complete: boolean }

/** What one sync step changed in the saved list. */
export type ImportItemChange = { added: number; gone: string[] }

export type ImportItemSync = { complete: boolean; total: number }

export type ImportItemPage = { items: ImportItem[]; last: number | null; more: boolean; total: number }

/** A shelf of the saved list: who issued its items, how many, and its face pile. */
export type ImportItemShelf = ImportItemGroup & { count: number; faces: ImportItem[] }

/** Forget a source's saved list (removed or swept). Never throws. */
export async function forgetImportItems(sourceId: string): Promise<void> {
  try {
    await forgetImportItemStore(sourceId)
  } catch (err) {
    appendAppLog('warn', `[import] saved item list not cleared: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Path → address this source's last scan derived; reused instead of re-derived. */
export function knownAddresses(source: Pick<ImportedSource, 'scan'>): Map<string, string> {
  return new Map((source.scan?.addresses ?? []).map((a) => [a.path, a.address]))
}

function storedItem(item: ImportItem | StoredImportItem): StoredImportItem {
  return {
    outpoint: item.outpoint,
    address: item.address,
    origin: item.origin,
    media: item.media,
    name: item.name,
    mimeType: item.mimeType,
    app: item.app,
    collectionId: item.collectionId,
    signer: item.signer,
  }
}

function withArt(items: readonly StoredImportItem[]): ImportItem[] {
  const chain = getWalletRuntime()?.instance?.chain ?? 'main'
  return items.map((item) => withImportItemArt({ ...item, imageUrl: null }, chain))
}

/** One page of the saved list (or one shelf of it), in the order items were found. */
export async function readImportItems(args: {
  sourceId: string
  after: number | null
  limit: number
  query?: string
  group?: string
}): Promise<ImportItemPage> {
  const [page, total] = await Promise.all([
    readImportItemPage(args.sourceId, args),
    countImportItems(args.sourceId),
  ])
  return { items: withArt(page.items), last: page.last, more: page.more, total }
}

/** The saved list's shelves, in Collect's issuer order. */
export async function readImportShelves(sourceId: string): Promise<ImportItemShelf[]> {
  const startedAt = Date.now()
  const shelves = await readImportGroups(sourceId)
  const ms = Date.now() - startedAt
  if (ms >= 250) appendAppLog('info', `[import] shelves read ${shelves.length} done ${ms}ms`)
  return shelves.map((shelf) => ({ ...shelf, faces: withArt(shelf.faces) }))
}

/** Every outpoint on one shelf, for selecting the whole shelf. */
export function importShelfOutpoints(sourceId: string, group: string): Promise<string[]> {
  return groupImportOutpoints(sourceId, group)
}

/**
 * Bring the saved list up to date with the source: drop what it no longer
 * holds, then check only outputs never checked before. Each found batch is
 * saved before `onChange` hears of it, so a stopped run keeps its progress.
 */
export async function syncImportItems(args: {
  sourceId: string
  onChange?: (change: ImportItemChange) => void
  shouldStop?: () => boolean
  fetchImpl?: FetchLike
}): Promise<ImportItemSync> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')
  const scan = source.scan
  if (!scan) throw new Error('Scan this wallet first')
  const startedAt = Date.now()
  const chain = active.chain
  const stop = () => args.shouldStop?.() === true
  const changed = (change: ImportItemChange) => {
    if (change.added > 0 || change.gone.length > 0) args.onChange?.(change)
  }

  const meta = await readImportListMeta(source.id)
  const paged = new Set(meta.scanAt === scan.at ? meta.pagedAddresses : [])
  const holdings = scan.holdings.filter((h) => !h.uncompressed)
  let complete = true
  let toPage: AddressHoldings[]

  if (scan.via === 'handcash-utxo-set') {
    const deriver = keyDeriverFor(source.secret)
    const set = await fetchHandCashUtxoSet({
      deriver,
      shouldStop: args.shouldStop,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    })
    if (set.kind === 'fetched') {
      const verified = await verifyUtxoSet(deriver, set.utxos, knownAddresses(source))
      const covered = new Set(verified.itemOutpoints.keys())
      const keep = new Set([
        ...paged,
        ...verified.readAddresses,
        ...holdings.filter((h) => h.itemCount > 0 && !covered.has(h.address)).map((h) => h.address),
      ])
      const read = await checkUtxoSetItems({
        sourceId: source.id,
        chain,
        itemOutpoints: verified.itemOutpoints,
        keepAddresses: keep,
        onChange: changed,
        shouldStop: args.shouldStop,
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      })
      complete = read.failed === 0 && !read.stopped
      const unspentAt = new Map<string, number>()
      for (const [address, outpoints] of verified.itemOutpoints) {
        unspentAt.set(address, outpoints.filter((o) => read.unspent.has(o)).length)
      }
      toPage = holdings.filter((h) =>
        paged.has(h.address)
          ? false
          : covered.has(h.address)
            ? complete && h.itemCount > (unspentAt.get(h.address) ?? 0)
            : h.itemCount > 0,
      )
    } else if (set.reason === 'unknown-keys') {
      toPage = holdings.filter((h) => h.itemCount > 0 && !paged.has(h.address))
      changed({ added: 0, gone: await pruneImportItems(source.id, new Set(), new Set([...paged, ...toPage.map((h) => h.address)])) })
    } else {
      if (set.reason !== 'stopped') {
        appendAppLog('warn', `[import] items kept as saved — HandCash set ${set.reason}: ${set.detail}`)
      }
      return { complete: false, total: await countImportItems(source.id) }
    }
  } else {
    toPage = holdings.filter((h) => h.itemCount > 0 && !paged.has(h.address))
    changed({ added: 0, gone: await pruneImportItems(source.id, new Set(), new Set([...paged, ...toPage.map((h) => h.address)])) })
  }

  for (let i = 0; i < toPage.length && !stop(); i += ADDRESS_CONCURRENCY) {
    const group = toPage.slice(i, i + ADDRESS_CONCURRENCY)
    const pages = await Promise.all(group.map((h) => addressItems(h.address, chain, args.fetchImpl ?? fetch)))
    for (const [j, page] of pages.entries()) {
      const address = group[j]!.address
      if (page.complete) {
        const { removed, added } = await replaceAddressItems(source.id, address, page.items.map(storedItem))
        paged.add(address)
        changed({ added: added.length, gone: removed })
      } else {
        complete = false
        changed({ added: (await saveImportItems(source.id, page.items.map(storedItem))).length, gone: [] })
      }
    }
  }

  const stopped = stop()
  complete &&= !stopped
  await writeImportListMeta(source.id, { scanAt: scan.at, complete, pagedAddresses: [...paged] })
  const total = await countImportItems(source.id)
  appendAppLog(
    'info',
    `[import] items synced ${total} addresses=${toPage.length} complete=${complete} stopped=${stopped} done ${Date.now() - startedAt}ms`,
  )
  return { complete, total }
}

/**
 * HandCash's one-sat outputs against the saved list: outputs it no longer
 * names leave (unless their address is listed in full), and only outputs
 * never checked go to the 1Sat index. Returns which of `itemOutpoints` are
 * listed items now.
 */
export async function checkUtxoSetItems(args: {
  sourceId: string
  chain: Chain
  itemOutpoints: ReadonlyMap<string, readonly string[]>
  keepAddresses: ReadonlySet<string>
  onChange?: (change: ImportItemChange) => void
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
  fetchImpl?: FetchLike
}): Promise<{ unspent: Set<string>; failed: number; stopped: boolean }> {
  const addressOf = new Map<string, string>()
  for (const [address, outpoints] of args.itemOutpoints) {
    for (const outpoint of outpoints) addressOf.set(outpoint, address)
  }
  const live = new Set(addressOf.keys())
  const gone = await pruneImportItems(args.sourceId, live, args.keepAddresses)
  if (gone.length > 0) args.onChange?.({ added: 0, gone })
  const decided = await decidedImportOutpoints(args.sourceId)
  const read = await readUnspentOutpoints({
    chain: args.chain,
    outpoints: [...live].filter((outpoint) => !decided.has(outpoint)),
    shouldStop: args.shouldStop,
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    onChecked: async ({ spent, found }) => {
      await markImportOutpointsGone(args.sourceId, spent)
      const added = await saveImportItems(
        args.sourceId,
        found.map(({ outpoint, facts }) => ({ outpoint, address: addressOf.get(outpoint)!, ...facts })),
      )
      if (added.length > 0) args.onChange?.({ added: added.length, gone: [] })
    },
  })
  const listed = await listedImportOutpoints(args.sourceId)
  const unspent = new Set([...live].filter((outpoint) => listed.has(outpoint)))
  return { unspent, failed: read.failed, stopped: read.stopped }
}

/** One address's 1-sat outputs from the 1Sat index, every page. */
async function addressItems(
  address: string,
  chain: Chain,
  fetchImpl: FetchLike,
): Promise<AddressItems> {
  const items: ImportItem[] = []
  for (let page = 0; page < ADDRESS_MAX_PAGES; page += 1) {
    let rows: unknown = null
    try {
      const res = await fetchImpl(
        `${gorillaBase(chain)}/api/txos/address/${encodeURIComponent(address)}/unspent?limit=${ADDRESS_PAGE}&offset=${page * ADDRESS_PAGE}`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
      )
      if (res.ok) rows = await res.json()
    } catch {
      /* an unread page leaves the list incomplete */
    }
    if (!Array.isArray(rows)) return { items, complete: false }
    for (const row of rows) {
      const { outpoint, satoshis, spend } = (row ?? {}) as {
        outpoint?: unknown
        satoshis?: unknown
        spend?: unknown
      }
      if (typeof outpoint !== 'string' || satoshis !== 1 || spend) continue
      items.push({ outpoint, address, ...importItemFacts(row, outpoint), imageUrl: null })
    }
    if (rows.length < ADDRESS_PAGE) return { items, complete: true }
  }
  return { items, complete: false }
}

export type ImportItemRefusal = 'unlisted' | 'gone' | 'ownKey' | 'pausedBatch'

export type ImportItemResult =
  | SingleItemMigrate
  | { kind: 'refused'; reason: ImportItemRefusal; message: string }

const REFUSAL_MESSAGES: Record<ImportItemRefusal, string> = {
  unlisted: 'This item is no longer in the saved list.',
  gone: 'This item’s address is not in the last scan. Rescan, then try again.',
  ownKey: 'That address is this wallet’s own key — use Refresh instead.',
  pausedBatch:
    'A paused sweep is moving items from this address. Finish or forget it before choosing items from it.',
}

export type ImportItemsResult = {
  /** Every chosen outpoint's answer, in the order given. */
  results: Array<{ outpoint: string; result: ImportItemResult }>
  /** The wallet ran out of BSV for fees; unmoved items answered `funds`. */
  stopped: 'funds' | null
}

/**
 * Move the chosen saved items into this wallet. Explicit: it runs only from
 * the user's choice. Items on one source key share transactions on the same
 * item-migrate path the sweep uses, so a selection costs a handful of
 * transactions rather than one per item. Keys run one after another; running
 * out of BSV stops the rest.
 */
export async function importItems(args: {
  sourceId: string
  outpoints: readonly string[]
}): Promise<ImportItemsResult> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')
  const startedAt = Date.now()
  const answers = new Map<string, ImportItemResult>()
  const refused = new Map<ImportItemRefusal, number>()
  const refuse = (outpoint: string, reason: ImportItemRefusal) => {
    refused.set(reason, (refused.get(reason) ?? 0) + 1)
    answers.set(outpoint, { kind: 'refused', reason, message: REFUSAL_MESSAGES[reason] })
  }

  const outpoints = [...new Set(args.outpoints)]
  const stored = await readStoredImportItems(source.id, outpoints)
  const cursorAddress = peekPhraseItemMigrateCursor()?.sourceAddress ?? null
  const deriver = keyDeriverFor(source.secret)
  const byAddress = new Map<string, { holding: AddressHoldings; items: StoredImportItem[] }>()
  for (const outpoint of outpoints) {
    const item = stored.get(outpoint)
    if (!item) {
      refuse(outpoint, 'unlisted')
      continue
    }
    const holding = source.scan?.holdings.find((h) => h.address === item.address && !h.uncompressed)
    if (!holding) {
      refuse(outpoint, 'gone')
      continue
    }
    if (holding.address === cursorAddress) {
      refuse(outpoint, 'pausedBatch')
      continue
    }
    const group = byAddress.get(holding.address)
    if (group) group.items.push(item)
    else byAddress.set(holding.address, { holding, items: [item] })
  }

  let stopped: ImportItemsResult['stopped'] = null
  let transactions = 0
  const movedPerAddress = new Map<string, number>()
  const leftList: string[] = []
  for (const { holding, items } of byAddress.values()) {
    const key = deriver.privateKeyAt(holding.path)
    const identityKey = key.toPublicKey().toString()
    if (identityKey.toLowerCase() === active.identityKey.toLowerCase()) {
      for (const item of items) refuse(item.outpoint, 'ownKey')
      continue
    }
    if (stopped) {
      for (const item of items) {
        answers.set(item.outpoint, { kind: 'funds', message: 'Not enough spendable BSV in this wallet for the item fee.' })
      }
      continue
    }
    const run = await migrateChosenPhraseItems({
      candidate: {
        scheme: 'import',
        label: holding.label,
        path: holding.path,
        rootKeyHex: key.toHex(),
        identityKey,
        address: holding.address,
      },
      items: items.map((item) => ({
        outpoint: item.outpoint,
        ...(item.origin ? { origin: item.origin } : {}),
        ...(item.name ? { name: item.name } : {}),
      })),
    })
    transactions += run.transactions
    if (run.stopped) stopped = run.stopped
    for (const item of items) {
      const result: SingleItemMigrate = run.results.get(item.outpoint) ?? {
        kind: 'failed',
        message: 'The item transaction was not accepted.',
      }
      answers.set(item.outpoint, result)
      if (result.kind === 'moved' || result.kind === 'skipped') leftList.push(item.outpoint)
      if (result.kind === 'moved') movedPerAddress.set(holding.address, (movedPerAddress.get(holding.address) ?? 0) + 1)
    }
  }

  if (leftList.length > 0) {
    await markImportOutpointsGone(source.id, leftList).catch((err: unknown) => {
      appendAppLog('warn', `[import] saved item list not updated: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  if (movedPerAddress.size > 0 && source.scan) {
    const scan = source.scan
    await updateImportedSource(source.id, {
      scan: {
        ...scan,
        holdings: scan.holdings.map((h) => {
          const moved = movedPerAddress.get(h.address)
          return moved ? { ...h, itemCount: Math.max(0, h.itemCount - moved) } : h
        }),
      },
    })
  }

  const moved = [...movedPerAddress.values()].reduce((sum, n) => sum + n, 0)
  const refusedNote = [...refused].map(([reason, n]) => ` refused.${reason}=${n}`).join('')
  appendAppLog(
    refused.size > 0 || stopped ? 'warn' : 'info',
    `[import] items done ${Date.now() - startedAt}ms chosen=${outpoints.length} moved=${moved} tx=${transactions}` +
      ` keys=${byAddress.size}${refusedNote}${stopped ? ` stopped=${stopped}` : ''}`,
  )
  return {
    results: args.outpoints.map((outpoint) => ({
      outpoint,
      result: answers.get(outpoint) ?? { kind: 'refused', reason: 'unlisted', message: REFUSAL_MESSAGES.unlisted },
    })),
    stopped,
  }
}
