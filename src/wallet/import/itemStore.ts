import { compareImportGroups, importItemGroup, type ImportItem, type ImportItemGroup } from './importItem'

/**
 * Saved sources' item lists, on disk, one row per item.
 *
 * A HandCash export can hold thousands of items and checking them against the
 * 1Sat index takes minutes, so the list is written batch by batch as it is
 * found and read back a page at a time. It lives as long as the item does:
 * a row leaves when the source no longer holds the output, when it is moved,
 * or when the saved source is removed. Display only — a move re-decides the
 * item from its source transaction.
 *
 * `gone` remembers outputs already checked and found spent (or moved), so a
 * later run asks the index only about outputs it has never seen. `groups`
 * names the shelves items sit on (`importItemGroup`); a shelf with no items
 * left is dropped when read.
 */

const DB_NAME = 'handcash.import-items'
const DB_VERSION = 2
const ITEMS = 'items'
const GONE = 'gone'
const META = 'meta'
const GROUPS = 'groups'
const READ_CHUNK = 400
/** Items read per shelf to find its face pile. */
const FACE_SCAN = 24
export const IMPORT_GROUP_FACES = 4

/** An item as saved; the thumbnail URL is derived on read. */
export type StoredImportItem = Omit<ImportItem, 'imageUrl'>

type ItemRow = StoredImportItem & { sourceId: string; seq: number; search: string; group: string }
type GoneRow = { sourceId: string; outpoint: string }
type GroupRow = ImportItemGroup & { sourceId: string }

/** A shelf with how many items it holds and up to four image items for its face pile. */
export type StoredImportGroup = ImportItemGroup & { count: number; faces: StoredImportItem[] }

export type ImportListMeta = {
  sourceId: string
  /** The scan this list was last checked against. */
  scanAt: number
  /** Every output of that scan was checked. */
  complete: boolean
  /** Addresses listed in full from the 1Sat index for that scan. */
  pagedAddresses: string[]
  nextSeq: number
}

/** `last` is the list position read up to — pass it as `after` for the next page. */
export type ImportItemPage = { items: StoredImportItem[]; last: number | null; more: boolean }

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This device has no IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (db.objectStoreNames.contains(ITEMS)) db.deleteObjectStore(ITEMS)
      if (db.objectStoreNames.contains(META)) db.deleteObjectStore(META)
      const items = db.createObjectStore(ITEMS, { keyPath: ['sourceId', 'outpoint'] })
      items.createIndex('order', ['sourceId', 'seq'])
      items.createIndex('address', ['sourceId', 'address'])
      items.createIndex('group', ['sourceId', 'group', 'seq'])
      db.createObjectStore(META, { keyPath: 'sourceId' })
      if (!db.objectStoreNames.contains(GONE)) db.createObjectStore(GONE, { keyPath: ['sourceId', 'outpoint'] })
      if (!db.objectStoreNames.contains(GROUPS)) db.createObjectStore(GROUPS, { keyPath: ['sourceId', 'key'] })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('Could not open the saved item list'))
  })
  opening.catch(() => {
    opening = null
  })
  return opening
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Saved item list request failed'))
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Saved item list write failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Saved item list write aborted'))
  })
}

/** Every `[sourceId, *]` key of a store keyed `[sourceId, outpoint]`. */
function sourceRange(sourceId: string): IDBKeyRange {
  return IDBKeyRange.bound([sourceId], [sourceId, []])
}

function orderRange(sourceId: string, after: number | null): IDBKeyRange {
  return IDBKeyRange.bound([sourceId, after ?? -Infinity], [sourceId, Infinity], after != null, false)
}

function groupRange(sourceId: string, group: string, after: number | null = null): IDBKeyRange {
  return IDBKeyRange.bound([sourceId, group, after ?? -Infinity], [sourceId, group, Infinity], after != null, false)
}

function toStored(row: ItemRow): StoredImportItem {
  return {
    outpoint: row.outpoint,
    address: row.address,
    origin: row.origin,
    media: row.media,
    name: row.name,
    mimeType: row.mimeType,
    app: row.app ?? null,
    collectionId: row.collectionId ?? null,
    signer: row.signer ?? null,
  }
}

function toGroup(row: GroupRow): ImportItemGroup {
  return {
    key: row.key,
    kind: row.kind,
    label: row.label,
    app: row.app,
    signer: row.signer,
    collectionId: row.collectionId,
  }
}

function emptyMeta(sourceId: string): ImportListMeta {
  return { sourceId, scanAt: 0, complete: false, pagedAddresses: [], nextSeq: 0 }
}

export async function readImportListMeta(sourceId: string): Promise<ImportListMeta> {
  const db = await open()
  const row = await request(db.transaction(META).objectStore(META).get(sourceId))
  return (row as ImportListMeta | undefined) ?? emptyMeta(sourceId)
}

export async function writeImportListMeta(
  sourceId: string,
  patch: Partial<Omit<ImportListMeta, 'sourceId' | 'nextSeq'>>,
): Promise<void> {
  const db = await open()
  const tx = db.transaction(META, 'readwrite')
  const store = tx.objectStore(META)
  const prior = ((await request(store.get(sourceId))) as ImportListMeta | undefined) ?? emptyMeta(sourceId)
  store.put({ ...prior, ...patch, sourceId })
  await finished(tx)
}

/**
 * Save newly found items after the ones already listed. Items already saved
 * keep their place; items already moved or found spent stay out. Returns the
 * items that were added.
 */
export async function saveImportItems(
  sourceId: string,
  items: readonly StoredImportItem[],
): Promise<StoredImportItem[]> {
  if (items.length === 0) return []
  const db = await open()
  const tx = db.transaction([ITEMS, GONE, META, GROUPS], 'readwrite')
  const itemStore = tx.objectStore(ITEMS)
  const goneStore = tx.objectStore(GONE)
  const metaStore = tx.objectStore(META)
  const groupStore = tx.objectStore(GROUPS)
  const unique = [...new Map(items.map((item) => [item.outpoint, item])).values()]
  const shelves = new Map(unique.map((item) => {
    const group = importItemGroup(item)
    return [group.key, group] as const
  }))
  const [meta, decided, shelved] = await Promise.all([
    request(metaStore.get(sourceId)) as Promise<ImportListMeta | undefined>,
    Promise.all(
      unique.map((item) =>
        Promise.all([
          request(itemStore.getKey([sourceId, item.outpoint])),
          request(goneStore.getKey([sourceId, item.outpoint])),
        ]).then(([held, gone]) => held !== undefined || gone !== undefined),
      ),
    ),
    Promise.all([...shelves.keys()].map((key) => request(groupStore.getKey([sourceId, key])))),
  ])
  const prior = meta ?? emptyMeta(sourceId)
  const added: StoredImportItem[] = []
  let seq = prior.nextSeq
  const used = new Set<string>()
  for (const [i, item] of unique.entries()) {
    if (decided[i]) continue
    const stored = toStored(item as ItemRow)
    const group = importItemGroup(stored).key
    const row: ItemRow = {
      ...stored,
      sourceId,
      seq: seq++,
      search: [stored.name, stored.app].filter(Boolean).join(' ').toLowerCase(),
      group,
    }
    itemStore.put(row)
    used.add(group)
    added.push(stored)
  }
  for (const [i, key] of [...shelves.keys()].entries()) {
    if (shelved[i] === undefined && used.has(key)) groupStore.put({ ...shelves.get(key)!, sourceId } satisfies GroupRow)
  }
  if (seq !== prior.nextSeq) metaStore.put({ ...prior, nextSeq: seq })
  await finished(tx)
  return added
}

/** Outputs checked and found spent, or moved: they leave the list and stay out. */
export async function markImportOutpointsGone(sourceId: string, outpoints: readonly string[]): Promise<void> {
  if (outpoints.length === 0) return
  const db = await open()
  const tx = db.transaction([ITEMS, GONE], 'readwrite')
  const itemStore = tx.objectStore(ITEMS)
  const goneStore = tx.objectStore(GONE)
  for (const outpoint of outpoints) {
    itemStore.delete([sourceId, outpoint])
    goneStore.put({ sourceId, outpoint } satisfies GoneRow)
  }
  await finished(tx)
}

/**
 * One page in list order, after `after` (the previous page's `last`), from
 * the whole list or one shelf (`group`). A query matches the start of the
 * outpoint or anywhere in the name or app.
 */
export async function readImportItemPage(
  sourceId: string,
  opts: { after: number | null; limit: number; query?: string; group?: string },
): Promise<ImportItemPage> {
  const db = await open()
  const query = opts.query?.trim().toLowerCase() ?? ''
  const items: StoredImportItem[] = []
  let after = opts.after
  for (;;) {
    const want = query ? READ_CHUNK : opts.limit - items.length
    const store = db.transaction(ITEMS).objectStore(ITEMS)
    const rows = (await request(
      opts.group != null
        ? store.index('group').getAll(groupRange(sourceId, opts.group, after), want)
        : store.index('order').getAll(orderRange(sourceId, after), want),
    )) as ItemRow[]
    for (const row of rows) {
      after = row.seq
      if (query && !row.search.includes(query) && !row.outpoint.startsWith(query)) continue
      items.push(toStored(row))
      if (items.length === opts.limit) return { items, last: row.seq, more: true }
    }
    if (rows.length < want) return { items, last: after, more: false }
  }
}

/**
 * Every shelf that still holds items, in shelf order, with its count and
 * face pile. Shelves left empty are dropped.
 */
export async function readImportGroups(sourceId: string): Promise<StoredImportGroup[]> {
  const db = await open()
  const groupRows = (await request(
    db.transaction(GROUPS).objectStore(GROUPS).getAll(sourceRange(sourceId)),
  )) as GroupRow[]
  const tx = db.transaction(ITEMS)
  const index = tx.objectStore(ITEMS).index('group')
  const read = await Promise.all(
    groupRows.map(async (row) => {
      const range = groupRange(sourceId, row.key)
      const [count, sample] = await Promise.all([
        request(index.count(range)),
        request(index.getAll(range, FACE_SCAN)) as Promise<ItemRow[]>,
      ])
      const faces = sample
        .filter((item) => item.mimeType?.toLowerCase().startsWith('image/'))
        .slice(0, IMPORT_GROUP_FACES)
        .map(toStored)
      return { ...toGroup(row), count, faces }
    }),
  )
  const empty = read.filter((group) => group.count === 0)
  if (empty.length > 0) {
    const drop = db.transaction(GROUPS, 'readwrite')
    for (const group of empty) drop.objectStore(GROUPS).delete([sourceId, group.key])
    await finished(drop)
  }
  return read.filter((group) => group.count > 0).sort(compareImportGroups)
}

/** Every outpoint on one shelf, in list order. */
export async function groupImportOutpoints(sourceId: string, group: string): Promise<string[]> {
  const db = await open()
  const keys = await request(
    db.transaction(ITEMS).objectStore(ITEMS).index('group').getAllKeys(groupRange(sourceId, group)),
  )
  return keys.map((key) => (key as [string, string])[1])
}

export async function readStoredImportItem(sourceId: string, outpoint: string): Promise<StoredImportItem | null> {
  const db = await open()
  const row = (await request(db.transaction(ITEMS).objectStore(ITEMS).get([sourceId, outpoint]))) as ItemRow | undefined
  return row ? toStored(row) : null
}

export async function countImportItems(sourceId: string): Promise<number> {
  const db = await open()
  return request(db.transaction(ITEMS).objectStore(ITEMS).count(sourceRange(sourceId)))
}

/** Outpoints already decided for this source — listed, spent or moved. */
export async function decidedImportOutpoints(sourceId: string): Promise<Set<string>> {
  const db = await open()
  const tx = db.transaction([ITEMS, GONE])
  const [items, gone] = await Promise.all([
    request(tx.objectStore(ITEMS).getAllKeys(sourceRange(sourceId))),
    request(tx.objectStore(GONE).getAllKeys(sourceRange(sourceId))),
  ])
  const out = new Set<string>()
  for (const key of [...items, ...gone]) out.add((key as [string, string])[1])
  return out
}

/** Outpoints currently listed for this source. */
export async function listedImportOutpoints(sourceId: string): Promise<Set<string>> {
  const db = await open()
  const keys = await request(db.transaction(ITEMS).objectStore(ITEMS).getAllKeys(sourceRange(sourceId)))
  return new Set(keys.map((key) => (key as [string, string])[1]))
}

/**
 * Drop what the source no longer holds: listed items that are neither in
 * `live` nor at an address listed in full (`keepAddresses`), and spent marks
 * for outputs the source stopped naming. Returns the items that left.
 */
export async function pruneImportItems(
  sourceId: string,
  live: ReadonlySet<string>,
  keepAddresses: ReadonlySet<string>,
): Promise<string[]> {
  const db = await open()
  const removed: string[] = []
  let after: number | null = null
  for (;;) {
    const index = db.transaction(ITEMS).objectStore(ITEMS).index('order')
    const rows = (await request(index.getAll(orderRange(sourceId, after), READ_CHUNK))) as ItemRow[]
    const drop = rows.filter((row) => !live.has(row.outpoint) && !keepAddresses.has(row.address))
    if (drop.length > 0) {
      const tx = db.transaction(ITEMS, 'readwrite')
      for (const row of drop) tx.objectStore(ITEMS).delete([sourceId, row.outpoint])
      await finished(tx)
      removed.push(...drop.map((row) => row.outpoint))
    }
    if (rows.length < READ_CHUNK) break
    after = rows[rows.length - 1]!.seq
  }
  const goneKeys = await request(db.transaction(GONE).objectStore(GONE).getAllKeys(sourceRange(sourceId)))
  const stale = goneKeys.filter((key) => !live.has((key as [string, string])[1]))
  if (stale.length > 0) {
    const tx = db.transaction(GONE, 'readwrite')
    for (const key of stale) tx.objectStore(GONE).delete(key)
    await finished(tx)
  }
  return removed
}

/**
 * An address listed in full: its items become exactly `items`. Returns the
 * previously listed items that are no longer there, and the ones added.
 */
export async function replaceAddressItems(
  sourceId: string,
  address: string,
  items: readonly StoredImportItem[],
): Promise<{ removed: string[]; added: StoredImportItem[] }> {
  const db = await open()
  const index = db.transaction(ITEMS).objectStore(ITEMS).index('address')
  const held = (await request(index.getAllKeys(IDBKeyRange.only([sourceId, address])))) as Array<[string, string]>
  const keep = new Set(items.map((i) => i.outpoint))
  const removed = held.map((key) => key[1]).filter((outpoint) => !keep.has(outpoint))
  if (removed.length > 0) {
    const tx = db.transaction(ITEMS, 'readwrite')
    for (const outpoint of removed) tx.objectStore(ITEMS).delete([sourceId, outpoint])
    await finished(tx)
  }
  return { removed, added: await saveImportItems(sourceId, items) }
}

/** The saved source is gone, or swept: forget its list. */
export async function forgetImportItemStore(sourceId: string): Promise<void> {
  const db = await open()
  const tx = db.transaction([ITEMS, GONE, META, GROUPS], 'readwrite')
  tx.objectStore(ITEMS).delete(sourceRange(sourceId))
  tx.objectStore(GONE).delete(sourceRange(sourceId))
  tx.objectStore(META).delete(sourceId)
  tx.objectStore(GROUPS).delete(sourceRange(sourceId))
  await finished(tx)
}

/** @internal */
export async function __resetImportItemStoreForTests(): Promise<void> {
  const db = await opening?.catch(() => null)
  db?.close()
  opening = null
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}
