/**
 * Notice journal — the BRC-29 notices this account owes, off the device within
 * seconds of signing.
 *
 * The payment output's notice (`paymentNotice.ts`) is the record of truth, but
 * it leaves the device only with the next BRC-39 push, which waits out the
 * Argon2 cost after every send. A device lost in that window took the only
 * copy of the derivation the payee needs. This journal closes the window:
 *
 * - An `owed` entry is written when the payment is sealed, before it
 *   propagates, carrying what a notice needs — payee, derivation, amount, and
 *   the Atomic BEEF when it is small, so a recovering device can hand the
 *   payee a transaction that never reached a miner.
 * - A `done` entry is written when the notice is delivered or the payment is
 *   void — including a payment a displaced install voids at handover, which
 *   must never reach the payee. It is a tombstone: the `owed` body it answers is dropped, so the
 *   journal holds only what is still owed and a stale replica cannot revive a
 *   delivered notice.
 * - Replicas merge by set union (`journalReplica.ts`), sealed beside the
 *   BRC-39 object as `notices.journal`.
 *
 * Recovery (`reopenOwedBrc29Notices`) queues every owed entry; the flush
 * checks the wallet's records and the tombstones first, so a notice already
 * delivered — here or by another device — is dropped unsent.
 */
import { Hash, Utils } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor, type BoundAccountKeyScope } from './accountLocalKeys'
import { base64ToBytes, bytesToBase64 } from './base64Binary'
import { durableGetItem, durableSetItem } from './durableStorage'
import { journalReplica, type JournalAccount, type JournalSyncResult } from './journalReplica'
import type { ActiveWallet } from './session'

export type NoticeJournalEntry =
  | {
      k: 'owed'
      op: string
      sats: number
      payee: string
      prefix: string
      suffix: string
      chat?: true
      /** Base64 Atomic BEEF of the payment, when under `BEEF_MAX_CHARS`. */
      beef?: string
    }
  | { k: 'done'; op: string }

export type OwedJournalNotice = {
  txid: string
  vout: number
  satoshis: number
  payee: string
  derivationPrefix: string
  derivationSuffix: string
  chatRef: boolean
}

/** A larger BEEF is left out; the payee can still fetch a propagated payment. */
const BEEF_MAX_CHARS = 64 * 1024
const KEY_BASE = storageRegistry.noticeJournal.key
const OP_RE = /^([0-9a-f]{64})\.(\d+)$/
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/

type JournalState = {
  entries: Map<string, NoticeJournalEntry>
  done: Set<string>
  root: string | null
}

const states = new Map<string, JournalState>()

const outpoint = (txid: string, vout: number): string | null => {
  const op = `${txid.trim().toLowerCase()}.${Math.trunc(vout)}`
  return OP_RE.test(op) && vout >= 0 ? op : null
}

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null

/** Canonical form: fixed key order, so equal entries hash equal on every device. */
export function cleanNoticeEntry(raw: unknown): NoticeJournalEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const op = typeof e.op === 'string' ? e.op.trim().toLowerCase() : ''
  if (!OP_RE.test(op)) return null
  if (e.k === 'done') return { k: 'done', op }
  if (e.k !== 'owed') return null
  const sats = Math.trunc(Number(e.sats))
  const payee = typeof e.payee === 'string' ? e.payee.trim().toLowerCase() : ''
  const prefix = text(e.prefix, 256)
  const suffix = text(e.suffix, 256)
  if (!Number.isFinite(sats) || sats <= 0 || !PUBKEY_RE.test(payee) || !prefix || !suffix) return null
  const beef = text(e.beef, BEEF_MAX_CHARS)
  return {
    k: 'owed',
    op,
    sats,
    payee,
    prefix,
    suffix,
    ...(e.chat === true ? { chat: true as const } : {}),
    ...(beef ? { beef } : {}),
  }
}

const entryId = (entry: NoticeJournalEntry): string =>
  Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(entry), 'utf8')))

function keyFor(owner: BoundAccountKeyScope): string {
  return accountLocalKeyFor(KEY_BASE, owner)
}

/** Admit one entry; false when it adds nothing. A `done` drops the `owed` body it answers. */
function admit(state: JournalState, entry: NoticeJournalEntry): boolean {
  if (state.done.has(entry.op)) return false
  const id = entryId(entry)
  if (state.entries.has(id)) return false
  if (entry.k === 'done') {
    for (const [held, prior] of state.entries) {
      if (prior.op === entry.op) state.entries.delete(held)
    }
    state.done.add(entry.op)
  }
  state.entries.set(id, entry)
  state.root = null
  return true
}

function load(owner: BoundAccountKeyScope): JournalState {
  const key = keyFor(owner)
  const held = states.get(key)
  if (held) return held
  const state: JournalState = { entries: new Map(), done: new Set(), root: null }
  try {
    const raw = durableGetItem(key)
    const file = raw ? (JSON.parse(raw) as { e?: unknown }) : null
    for (const rawEntry of Array.isArray(file?.e) ? file.e : []) {
      const entry = cleanNoticeEntry(rawEntry)
      if (entry) admit(state, entry)
    }
  } catch {
    // An unreadable file is reported by the next write failing to grow it.
  }
  states.set(key, state)
  return state
}

/** Union `incoming` into the journal; already-known and answered entries are no-ops. */
export function appendNoticeEntries(
  owner: BoundAccountKeyScope,
  incoming: readonly unknown[],
): { added: number; ok: boolean } {
  const state = load(owner)
  let added = 0
  for (const raw of incoming) {
    const entry = cleanNoticeEntry(raw)
    if (entry && admit(state, entry)) added += 1
  }
  if (added === 0) return { added, ok: true }
  const ok = durableSetItem(keyFor(owner), JSON.stringify({ v: 1, e: [...state.entries.values()] }))
  if (!ok) {
    console.error(`[notice-journal] write refused — ${added} entr${added === 1 ? 'y' : 'ies'} held in memory only`)
  }
  replica.scheduleFor(owner)
  return { added, ok }
}

export function noticeJournalEntries(owner: BoundAccountKeyScope): readonly NoticeJournalEntry[] {
  return [...load(owner).entries.values()]
}

/** sha256 over the sorted entry ids; equal roots are equal journals. */
export function noticeJournalRoot(owner: BoundAccountKeyScope): string {
  const state = load(owner)
  if (state.root) return state.root
  const ids = [...state.entries.keys()].sort().join('')
  state.root = Utils.toHex(Hash.sha256(Utils.toArray(ids, 'utf8')))
  return state.root
}

/** Record a notice owed for a sealed payment, before it propagates. */
export function journalOwedNotice(
  owner: BoundAccountKeyScope,
  notice: {
    txid: string
    vout: number
    satoshis: number
    payee: string
    derivationPrefix: string
    derivationSuffix: string
    chatRef?: boolean
    atomicBeef?: number[]
  },
): boolean {
  const op = outpoint(notice.txid, notice.vout)
  if (!op) return false
  const beef = notice.atomicBeef?.length ? bytesToBase64(notice.atomicBeef) : undefined
  return (
    appendNoticeEntries(owner, [
      {
        k: 'owed',
        op,
        sats: notice.satoshis,
        payee: notice.payee,
        prefix: notice.derivationPrefix,
        suffix: notice.derivationSuffix,
        ...(notice.chatRef ? { chat: true } : {}),
        ...(beef && beef.length <= BEEF_MAX_CHARS ? { beef } : {}),
      },
    ]).added > 0
  )
}

/** Nothing more is owed for `txid:vout`: delivered, or the payment is void. */
export function journalNoticeDone(owner: BoundAccountKeyScope, txid: string, vout: number): void {
  const op = outpoint(txid, vout)
  if (op) appendNoticeEntries(owner, [{ k: 'done', op }])
}

/**
 * Nothing is owed for any notice of these transactions: they are void (a
 * displaced install never broadcasts them). Returns how many journaled notices
 * these transactions have, settled now or before — what the replica must carry.
 */
export function voidJournalNotices(owner: BoundAccountKeyScope, txids: readonly string[]): number {
  const ids = new Set(txids.map((t) => t.trim().toLowerCase()))
  const mine = [...load(owner).entries.values()].filter((entry) => ids.has(entry.op.split('.')[0]!))
  const owed = mine.filter((entry) => entry.k === 'owed').map((entry) => entry.op)
  if (owed.length > 0) appendNoticeEntries(owner, owed.map((op) => ({ k: 'done', op })))
  return new Set(mine.map((entry) => entry.op)).size
}

/** True once any replica recorded `txid:vout` as delivered or void. */
export function noticeJournalSettled(owner: BoundAccountKeyScope, txid: string, vout: number): boolean {
  const op = outpoint(txid, vout)
  return op != null && load(owner).done.has(op)
}

export function owedJournalNotices(owner: BoundAccountKeyScope): OwedJournalNotice[] {
  const owed: OwedJournalNotice[] = []
  for (const entry of load(owner).entries.values()) {
    if (entry.k !== 'owed') continue
    const [, txid, vout] = OP_RE.exec(entry.op)!
    owed.push({
      txid: txid!,
      vout: Number(vout),
      satoshis: entry.sats,
      payee: entry.payee,
      derivationPrefix: entry.prefix,
      derivationSuffix: entry.suffix,
      chatRef: entry.chat === true,
    })
  }
  return owed
}

/** The Atomic BEEF journaled with an owed notice for `txid`, if any. */
export function noticeJournalBeef(owner: BoundAccountKeyScope, txid: string): number[] | null {
  const id = txid.trim().toLowerCase()
  for (const entry of load(owner).entries.values()) {
    if (entry.k === 'owed' && entry.beef && entry.op.startsWith(`${id}.`)) {
      return Array.from(base64ToBytes(entry.beef))
    }
  }
  return null
}

const replica = journalReplica({
  object: 'notices.journal',
  info: 'handcash notice journal v1',
  tag: 'notice-journal',
  debounceMs: 2_000,
  root: noticeJournalRoot,
  entries: noticeJournalEntries,
  append: appendNoticeEntries,
})

/** Pull, union, and push when the two sets differ. */
export function syncNoticeJournal(active: ActiveWallet, reason: string): Promise<JournalSyncResult> {
  return replica.sync(active, reason)
}

/** Sync an account this install does not have open (a displaced install's handover). */
export function syncNoticeJournalFor(account: JournalAccount, reason: string): Promise<JournalSyncResult> {
  return replica.syncAccount(account, reason)
}

export function resetNoticeJournalForTests(): void {
  replica.reset()
  states.clear()
}
