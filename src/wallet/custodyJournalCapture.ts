/**
 * Write every output the toolbox learns into the custody journal.
 *
 * The one place all outputs pass through — own sends, BRC-100 apps, receipts —
 * is the wallet's own `createAction` / `signAction` / `internalizeAction`.
 * Wrapping those once at build time journals each transaction's recipes
 * before the call returns, so a locally signed send is journaled before
 * `signedSendLifecycle` propagates it (write-ahead). `journalAllToolboxOutputs`
 * is the sweep that catches anything a crash cut short.
 */
import { Beef, type WalletInterface } from '@bsv/sdk'
import type { BoundAccountKeyScope } from './accountLocalKeys'
import { appendCustody, type CustodyEntry, type SpendRecipe } from './custodyJournal'
import {
  buildInternalizeCustomInstructions,
  INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX,
} from './oneSatProvenance'
import { withStorageLockLabel } from './storageLockTrace'
import { extractTxid } from './txExplorer'

type ToolboxRow = {
  outputId?: number
  transactionId?: number
  basketId?: number
  txid?: string
  vout?: number
  satoshis?: number
  derivationPrefix?: string | null
  derivationSuffix?: string | null
  senderIdentityKey?: string | null
  customInstructions?: string | null
}

type Provider = {
  findOutputs?: (args: unknown) => Promise<unknown>
  findTransactions?: (args: unknown) => Promise<unknown>
  findOutputBaskets?: (args: unknown) => Promise<unknown>
  findOutputTags?: (args: unknown) => Promise<unknown>
  findOutputTagMaps?: (args: unknown) => Promise<unknown>
}

type StorageHost = {
  storage?: { runAsStorageProvider?: <T>(fn: (sp: unknown) => Promise<T>) => Promise<T> }
}

const PAGE = 500
const MAX_PAGES = 200

function rowsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

/**
 * `tx`: keyed reads for one transaction's outputs, baskets and tags. It runs
 * inside every createAction while the storage lock is held, and a wallet with
 * thousands of items has thousands of `origin:` tags — reading the tag tables
 * whole made each capture a multi-second hold. `all`: the sweep reads every
 * row anyway, so one pass over each table is cheaper.
 */
type LabelScope = 'tx' | 'all'

async function basketNames(sp: Provider, rows: ToolboxRow[], scope: LabelScope) {
  const baskets = new Map<number, string>()
  const ids = [...new Set(rows.map((r) => r.basketId).filter((id): id is number => typeof id === 'number'))]
  const found =
    scope === 'all'
      ? rowsOf(await sp.findOutputBaskets?.({ partial: {} }))
      : (await Promise.all(ids.map(async (basketId) => rowsOf(await sp.findOutputBaskets?.({ partial: { basketId } }))))).flat()
  for (const b of found) {
    if (b.isDeleted !== true && typeof b.basketId === 'number' && typeof b.name === 'string') {
      baskets.set(b.basketId, b.name)
    }
  }
  return baskets
}

async function labelsFor(sp: Provider, rows: ToolboxRow[], outputIds: Set<number>, scope: LabelScope) {
  const baskets = await basketNames(sp, rows, scope)
  const tags = new Map<number, string[]>()
  if (outputIds.size === 0 || !sp.findOutputTagMaps || !sp.findOutputTags) return { baskets, tags }
  const maps =
    scope === 'tx'
      ? (
          await Promise.all(
            [...outputIds].map(async (outputId) => rowsOf(await sp.findOutputTagMaps!({ partial: { outputId } }))),
          )
        ).flat()
      : rowsOf(await sp.findOutputTagMaps({ partial: {} }))
  const tagIds = [...new Set(maps.map((m) => Number(m.outputTagId)).filter(Number.isFinite))]
  const tagRows =
    scope === 'tx'
      ? (
          await Promise.all(
            tagIds.map(async (outputTagId) => rowsOf(await sp.findOutputTags!({ partial: { outputTagId } }))),
          )
        ).flat()
      : rowsOf(await sp.findOutputTags({ partial: {} }))
  const names = new Map<number, string>()
  for (const t of tagRows) {
    if (t.isDeleted !== true && typeof t.outputTagId === 'number' && typeof t.tag === 'string') {
      names.set(t.outputTagId, t.tag)
    }
  }
  for (const m of maps) {
    const outputId = Number(m.outputId)
    const tag = names.get(Number(m.outputTagId))
    if (m.isDeleted === true || !tag || !outputIds.has(outputId)) continue
    tags.set(outputId, [...(tags.get(outputId) ?? []), tag])
  }
  return { baskets, tags }
}

/**
 * Custom instructions a recipe can replay. `internalizeAction` refuses more
 * than 1000 characters, so BRC-150 provenance (rebuilt from chain on demand)
 * is dropped and item display text trimmed the way receive already does.
 */
export function replayableCustomInstructions(raw: string): string {
  if (raw.length <= INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX) return raw
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    body = { ...(parsed as Record<string, unknown>) }
  } catch {
    return ''
  }
  delete body.provenance
  const lean = JSON.stringify(body)
  if (lean.length <= INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX) return lean
  if (typeof body.origin !== 'string') return ''
  const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : undefined)
  return buildInternalizeCustomInstructions({
    origin: body.origin,
    name: text('name') ?? '',
    app: text('app'),
    collectionId: text('collectionId'),
    content: text('content'),
  })
}

/** The recipe a toolbox row carries, or null for outputs that are not ours. */
export function recipeFromRow(
  row: ToolboxRow,
  basket: string | undefined,
  tags: string[] | undefined,
): SpendRecipe | null {
  const prefix = String(row.derivationPrefix ?? '').trim()
  const suffix = String(row.derivationSuffix ?? '').trim()
  const inDefault = !basket || basket === 'default'
  // A wallet payment always lands in `default`: never recover a basket output
  // (an item tip) as spendable change.
  if (prefix && suffix && inDefault) {
    const sender = String(row.senderIdentityKey ?? '').trim()
    return { p: 'wallet payment', prefix, suffix, ...(sender ? { sender } : {}) }
  }
  if (inDefault) return null
  const ci = replayableCustomInstructions(String(row.customInstructions ?? ''))
  return {
    p: 'basket insertion',
    basket,
    ...(ci ? { ci } : {}),
    ...(tags?.length ? { tags } : {}),
  }
}

async function entriesFromRows(
  sp: Provider,
  rows: ToolboxRow[],
  txidOf: (row: ToolboxRow) => string | undefined,
  scope: LabelScope,
): Promise<CustodyEntry[]> {
  const ids = new Set(rows.map((r) => Number(r.outputId)).filter(Number.isFinite))
  const { baskets, tags } = await labelsFor(sp, rows, ids, scope)
  const entries: CustodyEntry[] = []
  for (const row of rows) {
    const txid = txidOf(row)
    const vout = Number(row.vout)
    if (!txid || !/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) continue
    const r = recipeFromRow(
      row,
      row.basketId != null ? baskets.get(row.basketId) : undefined,
      tags.get(Number(row.outputId)),
    )
    if (r) entries.push({ k: 'out', op: `${txid}.${vout}`, sats: Math.trunc(Number(row.satoshis) || 0), r })
  }
  return entries
}

async function withProvider<T>(
  wallet: StorageHost,
  label: string,
  fn: (sp: Provider) => Promise<T>,
): Promise<T | null> {
  const run = wallet.storage?.runAsStorageProvider
  if (typeof run !== 'function') return null
  return withStorageLockLabel(label, () =>
    run.call<unknown, [(sp: unknown) => Promise<T>], Promise<T>>(wallet.storage, async (sp) =>
      fn(sp as Provider),
    ),
  )
}

/** Journal the recipes of one transaction's outputs. */
export async function journalToolboxTx(
  wallet: StorageHost,
  owner: BoundAccountKeyScope,
  rawTxid: string,
): Promise<number> {
  const txid = rawTxid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return 0
  const startedAt = Date.now()
  const entries = await withProvider(wallet, 'custodyJournal(tx)', async (sp) => {
    if (!sp.findOutputs || !sp.findTransactions) return []
    const tx = rowsOf(
      await sp.findTransactions({ partial: { txid }, noRawTx: true, paged: { limit: 1, offset: 0 } }),
    )[0]
    const transactionId = Number(tx?.transactionId)
    if (!Number.isFinite(transactionId)) return []
    const rows = rowsOf(
      await sp.findOutputs({ partial: { transactionId }, noScript: true, paged: { limit: PAGE, offset: 0 } }),
    ) as ToolboxRow[]
    return entriesFromRows(sp, rows, () => txid, 'tx')
  })
  const ms = Date.now() - startedAt
  if (ms > 250) {
    console.info(`[custody-journal] tx ${txid.slice(0, 12)} outputs=${entries?.length ?? 0} done ${ms}ms`)
  }
  return entries?.length ? appendCustody(owner, entries).added : 0
}

/** Journal every output row the toolbox holds, spendable or not. */
export async function journalAllToolboxOutputs(
  wallet: StorageHost,
  owner: BoundAccountKeyScope,
): Promise<{ added: number; rows: number }> {
  const startedAt = Date.now()
  const result = await withProvider(wallet, 'custodyJournal(sweep)', async (sp) => {
    if (!sp.findOutputs) return { entries: [] as CustodyEntry[], rows: 0 }
    const rows: ToolboxRow[] = []
    for (const spendable of [true, false]) {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const batch = rowsOf(
          await sp.findOutputs({
            partial: { spendable },
            noScript: true,
            paged: { limit: PAGE, offset: page * PAGE },
          }),
        ) as ToolboxRow[]
        rows.push(...batch)
        if (batch.length < PAGE) break
      }
    }
    const txids = new Map<number, string>()
    const missing = [...new Set(rows.filter((r) => !r.txid).map((r) => Number(r.transactionId)))]
    for (const transactionId of missing.filter(Number.isFinite)) {
      const tx = rowsOf(
        await sp.findTransactions?.({ partial: { transactionId }, noRawTx: true, paged: { limit: 1, offset: 0 } }),
      )[0]
      if (typeof tx?.txid === 'string') txids.set(transactionId, tx.txid.toLowerCase())
    }
    const entries = await entriesFromRows(
      sp,
      rows,
      (row) => row.txid?.toLowerCase() ?? txids.get(Number(row.transactionId)),
      'all',
    )
    return { entries, rows: rows.length }
  })
  if (!result) return { added: 0, rows: 0 }
  const added = appendCustody(owner, result.entries).added
  const ms = Date.now() - startedAt
  if (added > 0 || ms > 250) {
    console.info(
      `[custody-journal] captured ${added} new recipe(s) from ${result.rows} output row(s) done ${ms}ms`,
    )
  }
  return { added, rows: result.rows }
}

function atomicSubject(tx: unknown): string | null {
  try {
    const bytes = Array.isArray(tx) ? (tx as number[]) : tx instanceof Uint8Array ? Array.from(tx) : null
    return bytes ? (Beef.fromBinary(bytes).atomicTxid ?? null) : null
  } catch {
    return null
  }
}

const INSTALLED = new WeakSet<object>()

/**
 * Journal each action's outputs before the call returns. A capture failure is
 * logged, never thrown: the toolbox already committed the action, and the
 * sweep picks the recipes up from its rows.
 */
export function installCustodyJournal(
  wallet: WalletInterface & StorageHost,
  owner: BoundAccountKeyScope,
): void {
  if (INSTALLED.has(wallet)) return
  INSTALLED.add(wallet)
  const capture = async (txid: string | null | undefined, step: string) => {
    if (!txid) return
    try {
      await journalToolboxTx(wallet, owner, txid)
    } catch (err) {
      console.error(`[custody-journal] write-ahead failed after ${step} ${txid.slice(0, 12)}`, err)
    }
  }
  const create = wallet.createAction.bind(wallet)
  wallet.createAction = async (args, originator) => {
    const result = await create(args, originator)
    await capture(extractTxid(result), 'createAction')
    return result
  }
  const sign = wallet.signAction.bind(wallet)
  wallet.signAction = async (args, originator) => {
    const result = await sign(args, originator)
    await capture(extractTxid(result), 'signAction')
    return result
  }
  const internalize = wallet.internalizeAction.bind(wallet)
  wallet.internalizeAction = async (args, originator) => {
    const result = await internalize(args, originator)
    await capture(atomicSubject(args.tx), 'internalizeAction')
    return result
  }
  const relinquish = wallet.relinquishOutput.bind(wallet)
  wallet.relinquishOutput = async (args, originator) => {
    const result = await relinquish(args, originator)
    if (result?.relinquished && typeof args.output === 'string') {
      appendCustody(owner, [{ k: 'released', op: args.output }])
    }
    return result
  }
}
