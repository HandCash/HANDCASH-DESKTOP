/**
 * BRC-38 export that never holds the wallet in memory.
 *
 * The toolbox's `exportBRC38Json` reads every table into arrays, widens each
 * binary field to a `number[]` (eight bytes per byte), copies every row into
 * its portable form, then canonicalizes the whole tree. On a wallet with a few
 * thousand inscriptions that peak passed the Android WebView heap and killed
 * the renderer inside the export, every attempt, so history never uploaded.
 *
 * This walks the large tables with the IndexedDB cursor (`filter*`), turns
 * each row into its canonical JSON at once and keeps only that string. Past
 * the document budget it keeps measuring but stops keeping, so a refusal names
 * the real size and the table that owns it instead of costing the renderer.
 *
 * The output is byte-identical to the toolbox's (same field rules, key order
 * and row order); the encrypt worker still runs the full `parseBRC38Json`
 * validation before sealing.
 */
import { Utils } from '@bsv/sdk'
import { exportBRC38Json, type StorageProvider } from '@handcash/wallet-engine'
import { appendAppLog } from './appLog'
import { noteBackupOversize } from './backupWatchdog'
import { HISTORY_DOCUMENT_BUDGET_BYTES, HistoryDocumentTooLargeError } from './historyDocumentBudget'

const BRC38_TITLE = 'User Wallet Data Format'

const BINARY_FIELDS: Record<string, readonly string[]> = {
  commission: ['lockingScript'],
  output: ['lockingScript'],
  provenTx: ['merklePath', 'rawTx'],
  provenTxReq: ['rawTx', 'inputBEEF'],
  transaction: ['inputBEEF', 'rawTx'],
}

const JSON_FIELDS: Record<string, readonly string[]> = {
  provenTxReq: ['history', 'notify'],
  syncState: ['syncMap', 'errorLocal', 'errorOther'],
}

type Row = Record<string, unknown>
type SortKey = readonly (number | string)[]

/** The cursor surface of `StorageIdb`; remote providers have none. */
type CursorStorage = StorageProvider & {
  filterTransactions(args: { partial: Row }, filtered: (row: Row) => void): Promise<void>
  filterProvenTxReqs(args: { partial: Row }, filtered: (row: Row) => void, userId?: number): Promise<void>
  filterOutputs(args: { partial: Row }, filtered: (row: Row) => void): Promise<void>
  /** On `StorageIdb`, absent from the toolbox's published typings. */
  validateEntity(row: Row): Row
}

function hasCursorSurface(storage: StorageProvider): storage is CursorStorage {
  const s = storage as unknown as Partial<CursorStorage>
  return (
    typeof s.filterTransactions === 'function' &&
    typeof s.filterProvenTxReqs === 'function' &&
    typeof s.filterOutputs === 'function' &&
    typeof s.validateEntity === 'function'
  )
}

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) throw new Error('Cannot canonicalize null or undefined')
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Row
    return `{${Object.keys(obj)
      .sort(compareCodepoints)
      .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
      .join(',')}}`
  }
  throw new Error(`Unsupported JSON value type: ${typeof value}`)
}

/** Same message as the toolbox validator, so the null-note repair still recognises it. */
function rejectNulls(value: unknown, path: string): void {
  if (value === null) throw new Error(`BRC-38 ${path} must omit null values`)
  if (Array.isArray(value)) value.forEach((child, i) => rejectNulls(child, `${path}[${i}]`))
  else if (typeof value === 'object' && value !== undefined) {
    for (const [key, child] of Object.entries(value as Row)) rejectNulls(child, `${path}.${key}`)
  }
}

function toBase64(value: unknown): string {
  if (value instanceof Uint8Array) return Utils.toBase64(Array.from(value))
  return Utils.toBase64(value as number[])
}

function portableRow(kind: string, row: Row): Row {
  const out: Row = {}
  const binary = BINARY_FIELDS[kind] ?? []
  const json = JSON_FIELDS[kind] ?? []
  for (const [key, value] of Object.entries(row)) {
    if (value == null || key === 'logger') continue
    if (binary.includes(key)) out[key] = toBase64(value)
    else if (json.includes(key)) out[key] = typeof value === 'string' ? JSON.parse(value) : value
    else if (value instanceof Date) out[key] = value.toISOString()
    else out[key] = value
  }
  return out
}

function requireInt(value: unknown, path: string): number {
  if (!Number.isInteger(value)) throw new Error(`BRC-38 ${path} must be an integer`)
  return value as number
}

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    const order = typeof x === 'number' ? x - (y as number) : (x as string).localeCompare(y as string)
    if (order !== 0) return order
  }
  return 0
}

type Table = {
  name: string
  kind: string
  key: (row: Row) => SortKey
  strip?: string
  rows: { key: SortKey; json: string }[]
  count: number
  chars: number
}

const TABLES: readonly Omit<Table, 'rows' | 'count' | 'chars'>[] = [
  { name: 'provenTxs', kind: 'provenTx', key: (r) => [requireInt(r.provenTxId, 'provenTxId')] },
  { name: 'provenTxReqs', kind: 'provenTxReq', key: (r) => [requireInt(r.provenTxReqId, 'provenTxReqId')] },
  { name: 'outputBaskets', kind: 'outputBasket', key: (r) => [requireInt(r.basketId, 'basketId')] },
  { name: 'transactions', kind: 'transaction', key: (r) => [requireInt(r.transactionId, 'transactionId')] },
  { name: 'commissions', kind: 'commission', key: (r) => [requireInt(r.commissionId, 'commissionId')] },
  { name: 'outputs', kind: 'output', key: (r) => [requireInt(r.outputId, 'outputId')] },
  { name: 'outputTags', kind: 'outputTag', key: (r) => [requireInt(r.outputTagId, 'outputTagId')] },
  {
    name: 'outputTagMaps',
    kind: 'outputTagMap',
    key: (r) => [requireInt(r.outputId, 'outputId'), requireInt(r.outputTagId, 'outputTagId')],
  },
  { name: 'txLabels', kind: 'txLabel', key: (r) => [requireInt(r.txLabelId, 'txLabelId')] },
  {
    name: 'txLabelMaps',
    kind: 'txLabelMap',
    key: (r) => [requireInt(r.transactionId, 'transactionId'), requireInt(r.txLabelId, 'txLabelId')],
  },
  { name: 'certificates', kind: 'certificate', key: (r) => [requireInt(r.certificateId, 'certificateId')], strip: 'fields' },
  {
    name: 'certificateFields',
    kind: 'certificateField',
    key: (r) => {
      if (typeof r.fieldName !== 'string') throw new Error('BRC-38 fieldName must be a string')
      return [requireInt(r.certificateId, 'certificateId'), r.fieldName]
    },
  },
  { name: 'syncStates', kind: 'syncState', key: (r) => [requireInt(r.syncStateId, 'syncStateId')] },
]

function mib(chars: number): string {
  return `${(chars / (1024 * 1024)).toFixed(1)}MB`
}

class DocumentSink {
  readonly tables = new Map<string, Table>()
  total = 0
  over = false

  constructor(readonly budget: number) {
    for (const t of TABLES) this.tables.set(t.name, { ...t, rows: [], count: 0, chars: 0 })
  }

  add(name: string, row: Row): void {
    const table = this.tables.get(name)!
    const portable = portableRow(table.kind, row)
    if (table.strip) delete portable[table.strip]
    rejectNulls(portable, `document.tables.${name}[${table.count}]`)
    const key = table.key(portable)
    const json = canonical(portable)
    table.count++
    table.chars += json.length
    this.total += json.length
    if (this.over) return
    if (this.total > this.budget) {
      this.over = true
      for (const t of this.tables.values()) t.rows = []
      return
    }
    table.rows.push({ key, json })
  }

  breakdown(): string {
    return [...this.tables.values()]
      .filter((t) => t.chars > 0)
      .sort((a, b) => b.chars - a.chars)
      .map((t) => `${t.name} ${mib(t.chars)} (${t.count})`)
      .join(', ')
  }

  tablesJson(): string {
    const names = [...this.tables.keys()].sort(compareCodepoints)
    return `{${names
      .map((name) => {
        const rows = this.tables.get(name)!.rows
        rows.sort((a, b) => compareKeys(a.key, b.key))
        return `${JSON.stringify(name)}:[${rows.map((r) => r.json).join(',')}]`
      })
      .join(',')}}`
  }
}

async function timed<T>(sink: DocumentSink, name: string, work: () => Promise<T>): Promise<T> {
  const at = Date.now()
  const result = await work()
  const ms = Date.now() - at
  if (ms > 250) {
    const t = sink.tables.get(name)
    appendAppLog('info', `[cloud-backup] export ${name} done ${ms}ms rows=${t?.count ?? 0} chars=${t?.chars ?? 0}`)
  }
  return result
}

/**
 * A throw inside a cursor callback aborts the IndexedDB transaction, and the
 * abort then rejects a promise nobody awaits. Hold the first error and raise
 * it once the cursor has closed.
 */
async function scan(walk: (each: (fn: () => void) => void) => Promise<void>): Promise<void> {
  let failure: unknown = null
  await walk((fn) => {
    if (failure != null) return
    try {
      fn()
    } catch (err) {
      failure = err
    }
  })
  if (failure != null) throw failure
}

/** A locking script kept in the raw transaction, which `findOutputs` fills in. */
function needsScriptFill(o: Row): boolean {
  const length = o.scriptLength as number | undefined
  if (!length || !o.scriptOffset || !o.txid) return false
  return (o.lockingScript as { length?: number } | undefined)?.length !== length
}

/**
 * Canonical BRC-38 JSON for `identityKey`, or `HistoryDocumentTooLargeError`
 * (with the backup held off) once it passes `budget` characters.
 */
export async function exportBrc38JsonStreaming(
  storage: StorageProvider,
  identityKey: string,
  budget = HISTORY_DOCUMENT_BUDGET_BYTES,
): Promise<string> {
  if (!hasCursorSurface(storage)) return exportBRC38Json(storage, identityKey)

  const sourceStorage = await storage.makeAvailable()
  const user = await storage.findUserByIdentityKey(identityKey)
  if (!user) throw new Error(`No wallet user for ${identityKey}`)
  const userId = user.userId
  const sink = new DocumentSink(budget)
  const validate = (row: Row): Row => storage.validateEntity(row)

  const transactionIds = new Set<number>()
  const txids = new Set<string>()
  const provenTxIds = new Set<number>()
  await timed(sink, 'transactions', () =>
    scan((each) =>
      storage.filterTransactions({ partial: { userId } }, (raw) =>
        each(() => {
          const tx = validate(raw)
          transactionIds.add(tx.transactionId as number)
          if (typeof tx.txid === 'string') txids.add(tx.txid)
          if (tx.provenTxId != null) provenTxIds.add(tx.provenTxId as number)
          sink.add('transactions', tx)
        }),
      ),
    ),
  )

  await timed(sink, 'provenTxReqs', () =>
    scan((each) =>
      storage.filterProvenTxReqs(
        { partial: {} },
        (raw) =>
          each(() => {
            const req = validate(raw)
            if (typeof req.txid !== 'string' || !txids.has(req.txid)) return
            if (req.provenTxId != null) provenTxIds.add(req.provenTxId as number)
            sink.add('provenTxReqs', req)
          }),
        userId,
      ),
    ),
  )

  await timed(sink, 'provenTxs', async () => {
    for (const provenTxId of [...provenTxIds].sort((a, b) => a - b)) {
      const found = await storage.findProvenTxs({ partial: { provenTxId } })
      if (found.length > 1) throw new Error(`BRC-38 duplicate provenTxs.provenTxId: ${provenTxId}`)
      if (found[0]) sink.add('provenTxs', found[0] as unknown as Row)
    }
  })

  for (const basket of await storage.findOutputBaskets({ partial: { userId } })) {
    sink.add('outputBaskets', basket as unknown as Row)
  }
  for (const commission of await storage.findCommissions({ partial: { userId } })) {
    sink.add('commissions', commission as unknown as Row)
  }

  const outputIds = new Set<number>()
  const scriptFills: number[] = []
  await timed(sink, 'outputs', async () => {
    await scan((each) =>
      storage.filterOutputs({ partial: { userId } }, (raw) =>
        each(() => {
          const output = validate(raw)
          outputIds.add(output.outputId as number)
          if (needsScriptFill(output)) scriptFills.push(output.outputId as number)
          else sink.add('outputs', output)
        }),
      ),
    )
    for (const outputId of scriptFills) {
      const [output] = await storage.findOutputs({ partial: { outputId } })
      if (output) sink.add('outputs', output as unknown as Row)
    }
  })

  for (const tag of await storage.findOutputTags({ partial: { userId } })) {
    sink.add('outputTags', tag as unknown as Row)
  }
  for (const map of await storage.getOutputTagMapsForUser({ userId })) {
    if (outputIds.has(map.outputId)) sink.add('outputTagMaps', map as unknown as Row)
  }
  for (const label of await storage.findTxLabels({ partial: { userId } })) {
    sink.add('txLabels', label as unknown as Row)
  }
  for (const map of await storage.getTxLabelMapsForUser({ userId })) {
    if (transactionIds.has(map.transactionId)) sink.add('txLabelMaps', map as unknown as Row)
  }
  for (const certificate of await storage.findCertificates({ partial: { userId } })) {
    sink.add('certificates', certificate as unknown as Row)
  }
  for (const field of await storage.findCertificateFields({ partial: { userId } })) {
    sink.add('certificateFields', field as unknown as Row)
  }
  for (const syncState of await storage.findSyncStates({ partial: { userId } })) {
    sink.add('syncStates', syncState as unknown as Row)
  }

  if (sink.over) {
    appendAppLog(
      'error',
      `[cloud-backup] refusing BRC-38 export at ${mib(sink.total)} — over the ${mib(budget)} budget — ${sink.breakdown()}`,
    )
    noteBackupOversize(sink.total)
    throw new HistoryDocumentTooLargeError(sink.total)
  }

  return assembleDocument(sink, sourceStorage, user)
}

function assembleDocument(sink: DocumentSink, sourceStorage: unknown, user: unknown): string {
  const source = portableRow('settings', sourceStorage as Row)
  const owner = portableRow('user', user as Row)
  rejectNulls(source, 'document.sourceStorage')
  rejectNulls(owner, 'document.user')
  const top: Record<string, string> = {
    brc: '38',
    exportedAt: JSON.stringify(new Date().toISOString()),
    formatVersion: '1',
    sourceStorage: canonical(source),
    tables: sink.tablesJson(),
    title: JSON.stringify(BRC38_TITLE),
    user: canonical(owner),
  }
  return `{${Object.keys(top)
    .sort(compareCodepoints)
    .map((key) => `${JSON.stringify(key)}:${top[key]}`)
    .join(',')}}`
}

/**
 * Transactions an install signed (or built) but never handed to the network.
 * Once another install holds the account they are void (draft BRC-249,
 * "Handing over"): never broadcast, never handed over.
 */
export const UNBROADCAST_STATUSES: ReadonlySet<string> = new Set(['unsigned', 'nosend', 'nonfinal', 'unprocessed'])

function updatedMs(row: Row): number {
  const at = row.updated_at
  if (at instanceof Date) return at.getTime()
  if (typeof at === 'string' || typeof at === 'number') return new Date(at).getTime()
  return 0
}

export type Brc38Delta = {
  json: string
  transactions: number
  outputs: number
}

/**
 * Canonical BRC-38 JSON of what changed in `(since, until]`: the transactions
 * and outputs updated in that window, plus every row they reference so the
 * document validates on its own. Transactions that never reached the network
 * are left out, with the outputs they created and the spends they recorded.
 * Null when nothing changed.
 *
 * `until` bounds the window at the moment the account was found held
 * elsewhere, so rows this install touches afterwards (voiding its unsent
 * transactions frees their inputs) never overwrite the new holder's.
 */
export async function exportBrc38DeltaJson(
  storage: StorageProvider,
  identityKey: string,
  window: { since: number; until: number },
  budget = HISTORY_DOCUMENT_BUDGET_BYTES,
): Promise<Brc38Delta | null> {
  if (!hasCursorSurface(storage)) throw new Error('Handover needs local IndexedDB storage')
  const changed = (row: Row) => {
    const at = updatedMs(row)
    return at > window.since && at <= window.until
  }

  const sourceStorage = await storage.makeAvailable()
  const user = await storage.findUserByIdentityKey(identityKey)
  if (!user) throw new Error(`No wallet user for ${identityKey}`)
  const userId = user.userId
  const sink = new DocumentSink(budget)
  const validate = (row: Row): Row => storage.validateEntity(row)

  const statusOf = new Map<number, string>()
  const changedTx = new Set<number>()
  await scan((each) =>
    storage.filterTransactions({ partial: { userId } }, (raw) =>
      each(() => {
        const tx = validate(raw)
        const id = tx.transactionId as number
        statusOf.set(id, String(tx.status ?? ''))
        if (changed(tx)) changedTx.add(id)
      }),
    ),
  )
  const isVoid = (id: unknown) => typeof id === 'number' && UNBROADCAST_STATUSES.has(statusOf.get(id) ?? '')

  const transactionIds = new Set<number>([...changedTx].filter((id) => !isVoid(id)))
  const outputIds = new Set<number>()
  const scriptFills: number[] = []
  await scan((each) =>
    storage.filterOutputs({ partial: { userId } }, (raw) =>
      each(() => {
        const output = validate(raw)
        if (!changed(output) || isVoid(output.transactionId) || isVoid(output.spentBy)) return
        outputIds.add(output.outputId as number)
        transactionIds.add(output.transactionId as number)
        if (typeof output.spentBy === 'number') transactionIds.add(output.spentBy)
        if (needsScriptFill(output)) scriptFills.push(output.outputId as number)
        else sink.add('outputs', output)
      }),
    ),
  )
  for (const outputId of scriptFills) {
    const [output] = await storage.findOutputs({ partial: { outputId } })
    if (output) sink.add('outputs', output as unknown as Row)
  }
  if (transactionIds.size === 0) return null

  const txids = new Set<string>()
  const provenTxIds = new Set<number>()
  await scan((each) =>
    storage.filterTransactions({ partial: { userId } }, (raw) =>
      each(() => {
        const tx = validate(raw)
        if (!transactionIds.has(tx.transactionId as number)) return
        if (typeof tx.txid === 'string') txids.add(tx.txid)
        if (tx.provenTxId != null) provenTxIds.add(tx.provenTxId as number)
        sink.add('transactions', tx)
      }),
    ),
  )
  await scan((each) =>
    storage.filterProvenTxReqs(
      { partial: {} },
      (raw) =>
        each(() => {
          const req = validate(raw)
          if (typeof req.txid !== 'string' || !txids.has(req.txid)) return
          if (req.provenTxId != null) provenTxIds.add(req.provenTxId as number)
          sink.add('provenTxReqs', req)
        }),
      userId,
    ),
  )
  for (const provenTxId of [...provenTxIds].sort((a, b) => a - b)) {
    const found = await storage.findProvenTxs({ partial: { provenTxId } })
    if (found[0]) sink.add('provenTxs', found[0] as unknown as Row)
  }
  for (const basket of await storage.findOutputBaskets({ partial: { userId } })) {
    sink.add('outputBaskets', basket as unknown as Row)
  }
  for (const commission of await storage.findCommissions({ partial: { userId } })) {
    if (transactionIds.has(commission.transactionId)) sink.add('commissions', commission as unknown as Row)
  }
  for (const tag of await storage.findOutputTags({ partial: { userId } })) {
    sink.add('outputTags', tag as unknown as Row)
  }
  for (const map of await storage.getOutputTagMapsForUser({ userId })) {
    if (outputIds.has(map.outputId)) sink.add('outputTagMaps', map as unknown as Row)
  }
  for (const label of await storage.findTxLabels({ partial: { userId } })) {
    sink.add('txLabels', label as unknown as Row)
  }
  for (const map of await storage.getTxLabelMapsForUser({ userId })) {
    if (transactionIds.has(map.transactionId)) sink.add('txLabelMaps', map as unknown as Row)
  }
  for (const certificate of await storage.findCertificates({ partial: { userId } })) {
    sink.add('certificates', certificate as unknown as Row)
  }
  for (const field of await storage.findCertificateFields({ partial: { userId } })) {
    sink.add('certificateFields', field as unknown as Row)
  }
  if (sink.over) throw new HistoryDocumentTooLargeError(sink.total)
  return {
    json: assembleDocument(sink, sourceStorage, user),
    transactions: sink.tables.get('transactions')!.count,
    outputs: sink.tables.get('outputs')!.count,
  }
}
