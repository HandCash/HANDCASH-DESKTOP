/**
 * Custody journal — how to spend every output this wallet ever controlled.
 *
 * A coin on chain is only ours while we still know how to unlock it. For
 * managed change and BRC-29 receipts that knowledge is a random derivation
 * prefix/suffix the seed cannot regenerate; for basket outputs it is the
 * basket and its custom instructions. All of it lived in toolbox IndexedDB,
 * which a wipe, a restore from an older BRC-39 snapshot, or a lost device
 * replaces wholesale. Every heal before this one patched a single path into
 * that hole.
 *
 * The journal closes it at the root:
 * - Each entry is exactly an `internalizeAction` output spec (BRC-100
 *   `wallet payment` or `basket insertion`), so recovery is "re-internalize
 *   what the chain says is still unspent" — no protocol of our own.
 * - Entries are immutable and content-addressed (sha256 of their canonical
 *   JSON). Nothing is edited or evicted; a spend is one more entry, written
 *   only on chain evidence. Two copies merge by set union, so no replica can
 *   ever be "thinner" than another and no merge can lose a recipe.
 * - The root (sha256 over sorted entry ids) names the whole set: equal roots
 *   are equal journals.
 *
 * Capture lives in `custodyJournalCapture.ts` (write-ahead of propagation),
 * off-device replication in `custodyJournalBackup.ts`, recovery in
 * `custodyJournalRecovery.ts`.
 */
import { Hash, Utils } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor, type BoundAccountKeyScope } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'

export type SpendRecipe =
  /** BRC-29 derivation; `sender` omitted means this wallet's own identity. */
  | { p: 'wallet payment'; prefix: string; suffix: string; sender?: string }
  | { p: 'basket insertion'; basket: string; ci?: string; tags?: string[] }

export type CustodyEntry =
  | { k: 'out'; op: string; sats: number; r: SpendRecipe }
  /** The chain showed this outpoint spent. Never written from local state. */
  | { k: 'spent'; op: string }
  /**
   * The user relinquished a basket output. Retires only a basket recipe; a
   * wallet-payment recipe is money and always recovers.
   */
  | { k: 'released'; op: string }

type JournalFile = { v: 1; e: CustodyEntry[] }

type JournalState = {
  entries: CustodyEntry[]
  ids: Set<string>
  /** Latest recipe per outpoint; a wallet-payment recipe outranks a basket one. */
  recipes: Map<string, { sats: number; r: SpendRecipe }>
  spent: Set<string>
  released: Set<string>
  root: string | null
}

const KEY_BASE = storageRegistry.custodyJournal.key
const states = new Map<string, JournalState>()

const OUTPOINT_RE = /^([0-9a-f]{64})[._](\d+)$/

/** `txid.vout`, lowercase; null for anything else. */
export function custodyOutpoint(raw: string): string | null {
  const m = OUTPOINT_RE.exec(raw.trim().toLowerCase())
  return m ? `${m[1]}.${Number(m[2])}` : null
}

function cleanRecipe(raw: unknown, self?: string): SpendRecipe | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.p === 'wallet payment') {
    const prefix = typeof r.prefix === 'string' ? r.prefix.trim() : ''
    const suffix = typeof r.suffix === 'string' ? r.suffix.trim() : ''
    if (!prefix || !suffix) return null
    const sender = typeof r.sender === 'string' ? r.sender.trim().toLowerCase() : ''
    return {
      p: 'wallet payment',
      prefix,
      suffix,
      ...(sender && sender !== self?.toLowerCase() ? { sender } : {}),
    }
  }
  if (r.p === 'basket insertion') {
    const basket = typeof r.basket === 'string' ? r.basket.trim() : ''
    if (!basket || basket === 'default') return null
    // `internalizeAction` refuses longer; such a recipe could never replay.
    const ci = typeof r.ci === 'string' && r.ci && r.ci.length <= 1000 ? r.ci : undefined
    const tags = Array.isArray(r.tags)
      ? [...new Set(r.tags.filter((t): t is string => typeof t === 'string' && t.length > 0))].sort()
      : []
    return {
      p: 'basket insertion',
      basket,
      ...(ci ? { ci } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    }
  }
  return null
}

/** Canonical form: fixed key order, so equal entries hash equal on every device. */
export function cleanCustodyEntry(raw: unknown, self?: string): CustodyEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const op = typeof e.op === 'string' ? custodyOutpoint(e.op) : null
  if (!op) return null
  if (e.k === 'spent') return { k: 'spent', op }
  if (e.k === 'released') return { k: 'released', op }
  if (e.k !== 'out') return null
  const sats = Math.trunc(Number(e.sats))
  if (!Number.isFinite(sats) || sats < 0) return null
  const r = cleanRecipe(e.r, self)
  return r ? { k: 'out', op, sats, r } : null
}

export function custodyEntryId(entry: CustodyEntry): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(entry), 'utf8')))
}

function keyFor(owner: BoundAccountKeyScope): string {
  return accountLocalKeyFor(KEY_BASE, owner)
}

function admit(state: JournalState, entry: CustodyEntry, id: string): void {
  state.entries.push(entry)
  state.ids.add(id)
  state.root = null
  if (entry.k === 'spent') {
    state.spent.add(entry.op)
    return
  }
  if (entry.k === 'released') {
    state.released.add(entry.op)
    return
  }
  const prior = state.recipes.get(entry.op)
  if (prior?.r.p === 'wallet payment' && entry.r.p !== 'wallet payment') return
  state.recipes.set(entry.op, { sats: entry.sats, r: entry.r })
}

function load(owner: BoundAccountKeyScope): JournalState {
  const key = keyFor(owner)
  const held = states.get(key)
  if (held) return held
  const state: JournalState = {
    entries: [],
    ids: new Set(),
    recipes: new Map(),
    spent: new Set(),
    released: new Set(),
    root: null,
  }
  try {
    const raw = durableGetItem(key)
    const file = raw ? (JSON.parse(raw) as Partial<JournalFile>) : null
    for (const rawEntry of Array.isArray(file?.e) ? file.e : []) {
      const entry = cleanCustodyEntry(rawEntry, owner.identityKey)
      if (!entry) continue
      const id = custodyEntryId(entry)
      if (!state.ids.has(id)) admit(state, entry, id)
    }
  } catch {
    // An unreadable file is reported by the next write failing to grow it.
  }
  states.set(key, state)
  return state
}

export type CustodyAppend = { added: number; ok: boolean }

/**
 * Append entries; already-known ones are no-ops. `ok` is false when the store
 * refused the write — the entries stay in memory and ride the next append.
 */
export function appendCustody(
  owner: BoundAccountKeyScope,
  entries: readonly unknown[],
): CustodyAppend {
  const state = load(owner)
  let added = 0
  for (const raw of entries) {
    const entry = cleanCustodyEntry(raw, owner.identityKey)
    if (!entry) continue
    const id = custodyEntryId(entry)
    if (state.ids.has(id)) continue
    admit(state, entry, id)
    added += 1
  }
  if (added === 0) return { added, ok: true }
  const file: JournalFile = { v: 1, e: state.entries }
  const ok = durableSetItem(keyFor(owner), JSON.stringify(file))
  if (!ok) {
    console.error(
      `[custody-journal] write refused — ${added} recipe(s) held in memory only (${state.entries.length} total)`,
    )
  }
  for (const listener of listeners) listener(owner)
  return { added, ok }
}

export function custodyEntries(owner: BoundAccountKeyScope): readonly CustodyEntry[] {
  return load(owner).entries
}

export function custodyRecipeFor(
  owner: BoundAccountKeyScope,
  outpoint: string,
): { sats: number; r: SpendRecipe } | null {
  const op = custodyOutpoint(outpoint)
  return op ? (load(owner).recipes.get(op) ?? null) : null
}

function isLive(state: JournalState, op: string, r: SpendRecipe): boolean {
  if (state.spent.has(op)) return false
  return !(r.p === 'basket insertion' && state.released.has(op))
}

/** Outpoints with a recipe, no on-chain spend recorded, and not relinquished. */
export function unspentCustodyOutputs(
  owner: BoundAccountKeyScope,
): Array<{ op: string; sats: number; r: SpendRecipe }> {
  const state = load(owner)
  const out: Array<{ op: string; sats: number; r: SpendRecipe }> = []
  for (const [op, recipe] of state.recipes) {
    if (isLive(state, op, recipe.r)) out.push({ op, ...recipe })
  }
  return out
}

/** sha256 over the sorted entry ids; equal roots are equal journals. */
export function custodyJournalRoot(owner: BoundAccountKeyScope): string {
  const state = load(owner)
  if (state.root) return state.root
  const ids = [...state.ids].sort().join('')
  state.root = Utils.toHex(Hash.sha256(Utils.toArray(ids, 'utf8')))
  return state.root
}

export function custodyJournalSummary(owner: BoundAccountKeyScope): {
  entries: number
  recipes: number
  spent: number
  unspentSats: number
  root: string
} {
  const state = load(owner)
  let unspentSats = 0
  for (const [op, recipe] of state.recipes) {
    if (isLive(state, op, recipe.r)) unspentSats += recipe.sats
  }
  return {
    entries: state.entries.length,
    recipes: state.recipes.size,
    spent: state.spent.size,
    unspentSats,
    root: custodyJournalRoot(owner),
  }
}

type Listener = (owner: BoundAccountKeyScope) => void
const listeners = new Set<Listener>()

/** Called after every append that grew the journal. */
export function onCustodyJournalGrew(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Drop parsed state; the durable file is the source of truth. */
export function forgetCustodyJournalCache(): void {
  states.clear()
}
