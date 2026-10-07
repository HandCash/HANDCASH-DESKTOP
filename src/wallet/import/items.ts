import { getWalletRuntime } from '../walletRuntime'
import { appendAppLog } from '../appLog'
import { buildLegacyInputBeef } from '../legacyBeef'
import type { Chain } from '../vault'
import {
  migrateChosenPhraseItems,
  peekPhraseItemMigrateCursor,
  type PhraseItemStopReason,
  type SingleItemMigrate,
} from '../phraseSweep'
import { gorillaBase, type FetchLike } from './discovery'
import { fetchHandCashUtxoSet, readUnspentOnChain, readUnspentOutpoints, verifyUtxoSet } from './handcashUtxoSet'
import type { AddressHoldings } from './holdings'
import { keyDeriverFor } from './importSource'
import { importItemFacts, withImportItemArt, type ImportItem, type ImportItemGroup } from './importItem'
import {
  clearImportListing,
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

/** Forget everything saved about a removed source. Never throws. */
export async function forgetImportItems(sourceId: string): Promise<void> {
  try {
    await forgetImportItemStore(sourceId)
  } catch (err) {
    appendAppLog('warn', `[import] saved item list not cleared: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** After a sweep: re-read the list next time, keeping what is known gone. Never throws. */
export async function clearImportItems(sourceId: string): Promise<void> {
  try {
    await clearImportListing(sourceId)
  } catch (err) {
    appendAppLog('warn', `[import] saved item list not cleared: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A full on-chain recheck of the list at most this often, unless the list just grew. */
const CHAIN_CHECK_MS = 10 * 60_000

const OUTPOINT = /^([0-9a-f]{64})[_.](\d+)$/

/**
 * Listed items the chain shows spent leave the list for good. The 1Sat index
 * lags Arcade broadcasts and HandCash never learns of spends made elsewhere,
 * so an item moved or burned from this wallet would otherwise be offered again.
 */
async function dropChainSpentItems(args: {
  sourceId: string
  chain: Chain
  shouldStop?: () => boolean
  fetchImpl?: FetchLike
}): Promise<{ spent: string[]; checked: number; unknown: number; stopped: boolean }> {
  const startedAt = Date.now()
  const outputs = [...(await listedImportOutpoints(args.sourceId))].flatMap((outpoint) => {
    const m = OUTPOINT.exec(outpoint.toLowerCase())
    return m ? [{ listed: outpoint, outpoint: `${m[1]}_${m[2]}`, txid: m[1]!, vout: Number(m[2]) }] : []
  })
  if (outputs.length === 0) return { spent: [], checked: 0, unknown: 0, stopped: false }
  const read = await readUnspentOnChain({
    chain: args.chain,
    outputs,
    label: 'listed',
    ...(args.shouldStop ? { shouldStop: args.shouldStop } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  })
  const spent = read.stopped
    ? []
    : outputs.filter((o) => !read.unspent.has(o.outpoint) && !read.unknown.has(o.outpoint)).map((o) => o.listed)
  if (spent.length > 0) await markImportOutpointsGone(args.sourceId, spent)
  if (!read.stopped) await writeImportListMeta(args.sourceId, { chainCheckedAt: Date.now() })
  appendAppLog(
    spent.length > 0 ? 'warn' : 'info',
    `[import] items chain-checked ${outputs.length} spent=${spent.length} unknown=${read.unknown.size} stopped=${read.stopped} done ${Date.now() - startedAt}ms`,
  )
  return { spent, checked: outputs.length, unknown: read.unknown.size, stopped: read.stopped }
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
  let grew = false
  const changed = (change: ImportItemChange) => {
    if (change.added > 0) grew = true
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

  if (!stop() && (grew || Date.now() - (meta.chainCheckedAt ?? 0) > CHAIN_CHECK_MS)) {
    const checked = await dropChainSpentItems({
      sourceId: source.id,
      chain,
      shouldStop: args.shouldStop,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    })
    if (checked.spent.length > 0) changed({ added: 0, gone: checked.spent })
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

/**
 * Read the source transactions of items about to be imported, so the chunk
 * that moves them finds its BEEF cached. Never throws; a miss is read again
 * by the import itself.
 */
export async function prefetchImportItems(args: { sourceId: string; outpoints: readonly string[] }): Promise<void> {
  const active = getWalletRuntime()?.instance
  if (!active || args.outpoints.length === 0) return
  const startedAt = Date.now()
  try {
    const stored = await readStoredImportItems(args.sourceId, [...new Set(args.outpoints)])
    const outpoints = [...stored.keys()].map((outpoint) => outpoint.toLowerCase().replace(/_(\d+)$/, '.$1'))
    const built = await buildLegacyInputBeef(active.services, outpoints, { concurrency: 8 })
    const ms = Date.now() - startedAt
    if (ms >= 250) {
      appendAppLog('info', `[import] prefetch done ${ms}ms items=${outpoints.length} unread=${built.failures.length}`)
    }
  } catch (err) {
    appendAppLog('warn', `[import] prefetch skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
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
  /**
   * Why the rest was not tried: out of BSV for fees (unmoved items answer
   * `funds`), or the fee coin was spent elsewhere (unmoved items answer `deferred`).
   */
  stopped: PhraseItemStopReason | null
}

/** A queued chunk outlived the wallet it was queued for. */
export class ImportWalletChangedError extends Error {
  constructor() {
    super('The wallet changed, so the import stopped. Nothing moved into the other wallet.')
    this.name = 'ImportWalletChangedError'
  }
}

/**
 * Move the chosen saved items into this wallet. Explicit: it runs only from
 * the user's choice. Every chosen item rides the same item-migrate path the
 * sweep uses, signed by the key of the address holding it, so items spread
 * over many addresses — a HandCash export keeps nearly every item at its own —
 * still share transactions, 25 at a time. Running out of BSV stops the rest.
 *
 * `identityKey` pins the wallet a background queue chose: when another wallet
 * is open by the time this chunk runs, it refuses without moving anything.
 */
export async function importItems(args: {
  sourceId: string
  outpoints: readonly string[]
  identityKey?: string
  /** Wallet job id the moved items' Activity rows fold under. */
  activityGroup?: string | null
}): Promise<ImportItemsResult> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  if (args.identityKey && args.identityKey.toLowerCase() !== active.identityKey.toLowerCase()) {
    throw new ImportWalletChangedError()
  }
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
  const keyOf = new Map<string, { keyHex: string } | 'ownKey'>()
  const chosen: Array<{ item: StoredImportItem; holding: AddressHoldings; keyHex: string }> = []
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
    let key = keyOf.get(holding.address)
    if (!key) {
      const privateKey = deriver.privateKeyAt(holding.path)
      key =
        privateKey.toPublicKey().toString().toLowerCase() === active.identityKey.toLowerCase()
          ? 'ownKey'
          : { keyHex: privateKey.toHex() }
      keyOf.set(holding.address, key)
    }
    if (key === 'ownKey') {
      refuse(outpoint, 'ownKey')
      continue
    }
    chosen.push({ item, holding, keyHex: key.keyHex })
  }

  const run =
    chosen.length > 0
      ? await migrateChosenPhraseItems({
          items: chosen.map(({ item, keyHex }) => ({
            outpoint: item.outpoint,
            keyHex,
            ...(item.origin ? { origin: item.origin } : {}),
            ...(item.name ? { name: item.name } : {}),
          })),
          activityGroup: args.activityGroup ?? null,
        })
      : null
  const stopped: ImportItemsResult['stopped'] = run?.stopped ?? null
  const transactions = run?.transactions ?? 0
  const movedPerAddress = new Map<string, number>()
  const leftList: string[] = []
  for (const { item, holding } of chosen) {
    const result: SingleItemMigrate = run?.results.get(item.outpoint) ?? {
      kind: 'failed',
      message: 'The item transaction was not accepted.',
    }
    answers.set(item.outpoint, result)
    if (result.kind === 'moved' || result.kind === 'skipped') leftList.push(item.outpoint)
    if (result.kind === 'moved') movedPerAddress.set(holding.address, (movedPerAddress.get(holding.address) ?? 0) + 1)
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
      ` keys=${keyOf.size}${refusedNote}${stopped ? ` stopped=${stopped}` : ''}`,
  )
  return {
    results: args.outpoints.map((outpoint) => ({
      outpoint,
      result: answers.get(outpoint) ?? { kind: 'refused', reason: 'unlisted', message: REFUSAL_MESSAGES.unlisted },
    })),
    stopped,
  }
}
