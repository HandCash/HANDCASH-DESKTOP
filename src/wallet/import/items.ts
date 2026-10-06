import { getWalletRuntime } from '../walletRuntime'
import { appendAppLog } from '../appLog'
import type { Chain } from '../vault'
import {
  migrateOnePhraseItem,
  peekPhraseItemMigrateCursor,
  type SingleItemMigrate,
} from '../phraseSweep'
import { gorillaBase, type FetchLike } from './discovery'
import { fetchHandCashUtxoSet, readUnspentOutpoints, verifyUtxoSet } from './handcashUtxoSet'
import { keyDeriverFor } from './importSource'
import { importItemFacts, withImportItemArt, type ImportItem } from './importItem'
import { loadImportedSources, updateImportedSource, type ImportedSource } from './store'

export type { ImportItem } from './importItem'

/**
 * The 1-sat items a saved source holds, for browsing and moving one at a time.
 *
 * The list lives for the session only, keyed by the scan it came from: a few
 * thousand rows do not belong in sealed prefs, and the next scan replaces it.
 * Moving an item re-decides it from its source transaction — the list is the
 * index's view, never proof.
 */
const remembered = new Map<string, { scanAt: number; items: ImportItem[]; complete: boolean }>()

const ADDRESS_PAGE = 100
const ADDRESS_MAX_PAGES = 50
const ADDRESS_CONCURRENCY = 4

export type ImportItemList = { items: ImportItem[]; complete: boolean }

export function rememberImportItems(
  sourceId: string,
  scanAt: number,
  list: ImportItemList,
): void {
  remembered.set(sourceId, { scanAt, items: list.items, complete: list.complete })
}

export function forgetImportItems(sourceId: string): void {
  remembered.delete(sourceId)
}

/** Every item of the last scan; reuses the scan's list while it is current. */
export async function listImportItems(args: {
  sourceId: string
  fetchImpl?: FetchLike
}): Promise<ImportItemList> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')
  const scan = source.scan
  if (!scan) throw new Error('Scan this wallet first')
  const startedAt = Date.now()

  const kept = remembered.get(source.id)
  const base: ImportItemList =
    kept && kept.scanAt === scan.at
      ? { items: kept.items, complete: kept.complete }
      : scan.via === 'handcash-utxo-set'
        ? await utxoSetItems(source, active.chain, args.fetchImpl)
        : { items: [], complete: true }

  const listed = new Map<string, number>()
  for (const item of base.items) listed.set(item.address, (listed.get(item.address) ?? 0) + 1)
  const unlisted = scan.holdings.filter(
    (h) => !h.uncompressed && h.itemCount > (listed.get(h.address) ?? 0),
  )
  const seen = new Set(base.items.map((i) => i.outpoint))
  const items = base.items.slice()
  let complete = base.complete
  for (let i = 0; i < unlisted.length; i += ADDRESS_CONCURRENCY) {
    const pages = await Promise.all(
      unlisted
        .slice(i, i + ADDRESS_CONCURRENCY)
        .map((h) => addressItems(h.address, active.chain, args.fetchImpl ?? fetch)),
    )
    for (const page of pages) {
      complete &&= page.complete
      for (const item of page.items) {
        if (seen.has(item.outpoint)) continue
        seen.add(item.outpoint)
        items.push(item)
      }
    }
  }
  const list = { items: items.map((item) => withImportItemArt(item, active.chain)), complete }
  rememberImportItems(source.id, scan.at, list)
  appendAppLog(
    'info',
    `[import] items listed ${items.length} reused=${kept?.scanAt === scan.at} addresses=${unlisted.length} complete=${complete} done ${Date.now() - startedAt}ms`,
  )
  return list
}

/** The scan's own path, items only: HandCash's set, then the 1Sat index by outpoint. */
async function utxoSetItems(
  source: ImportedSource,
  chain: Chain,
  fetchImpl?: FetchLike,
): Promise<ImportItemList> {
  const deriver = keyDeriverFor(source.secret)
  const set = await fetchHandCashUtxoSet({ deriver, ...(fetchImpl ? { fetchImpl } : {}) })
  if (set.kind === 'refused') return { items: [], complete: true }
  const verified = await verifyUtxoSet(deriver, set.utxos)
  return itemsFromOutpoints(
    verified.itemOutpoints,
    await readUnspentOutpoints({
      chain,
      outpoints: [...verified.itemOutpoints.values()].flat(),
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  )
}

export function itemsFromOutpoints(
  byAddress: ReadonlyMap<string, readonly string[]>,
  read: Pick<Awaited<ReturnType<typeof readUnspentOutpoints>>, 'unspent' | 'facts' | 'failed' | 'stopped'>,
): ImportItemList {
  const items: ImportItem[] = []
  for (const [address, outpoints] of byAddress) {
    for (const outpoint of outpoints) {
      if (!read.unspent.has(outpoint)) continue
      const facts = read.facts.get(outpoint) ?? { origin: null, media: null, name: null, mimeType: null }
      items.push({ outpoint, address, ...facts, imageUrl: null })
    }
  }
  return { items, complete: read.failed === 0 && !read.stopped }
}

/** One address's 1-sat outputs from the 1Sat index, every page. */
async function addressItems(
  address: string,
  chain: Chain,
  fetchImpl: FetchLike,
): Promise<ImportItemList> {
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

export type ImportItemRefusal = 'gone' | 'ownKey' | 'pausedBatch'

export type ImportItemResult =
  | SingleItemMigrate
  | { kind: 'refused'; reason: ImportItemRefusal; message: string }

const REFUSAL_MESSAGES: Record<ImportItemRefusal, string> = {
  gone: 'This item’s address is not in the last scan. Rescan, then try again.',
  ownKey: 'That address is this wallet’s own key — use Refresh instead.',
  pausedBatch:
    'A paused sweep is moving items from this address. Finish or forget it before moving items one at a time.',
}

/**
 * Move one item into this wallet. Explicit and single: it runs from the user's
 * choice of this item, on the same item-migrate path the sweep uses.
 */
export async function importOneItem(args: {
  sourceId: string
  item: ImportItem
}): Promise<ImportItemResult> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')
  const refuse = (reason: ImportItemRefusal): ImportItemResult => {
    appendAppLog('warn', `[import] item refused reason=${reason} outpoint=${args.item.outpoint}`)
    return { kind: 'refused', reason, message: REFUSAL_MESSAGES[reason] }
  }

  const holding = source.scan?.holdings.find(
    (h) => h.address === args.item.address && !h.uncompressed,
  )
  if (!source.scan || !holding) return refuse('gone')
  const key = keyDeriverFor(source.secret).privateKeyAt(holding.path)
  const identityKey = key.toPublicKey().toString()
  if (identityKey.toLowerCase() === active.identityKey.toLowerCase()) return refuse('ownKey')
  if (peekPhraseItemMigrateCursor()?.sourceAddress === holding.address) return refuse('pausedBatch')

  const result = await migrateOnePhraseItem({
    candidate: {
      scheme: 'import',
      label: holding.label,
      path: holding.path,
      rootKeyHex: key.toHex(),
      identityKey,
      address: holding.address,
    },
    outpoint: args.item.outpoint,
    ...(args.item.origin ? { origin: args.item.origin } : {}),
    ...(args.item.name ? { name: args.item.name } : {}),
  })

  if (result.kind === 'moved' || result.kind === 'skipped') {
    const kept = remembered.get(source.id)
    if (kept) kept.items = kept.items.filter((i) => i.outpoint !== args.item.outpoint)
  }
  if (result.kind === 'moved') {
    const scan = source.scan
    await updateImportedSource(source.id, {
      scan: {
        ...scan,
        holdings: scan.holdings.map((h) =>
          h.address === holding.address ? { ...h, itemCount: Math.max(0, h.itemCount - 1) } : h,
        ),
      },
    })
  }
  return result
}
