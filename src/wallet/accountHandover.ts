/**
 * Handing over (draft BRC-249): an install that finds an account it held now
 * held elsewhere sends what it recorded since its last upload to the new
 * holder, and never uploads or broadcasts for the account again.
 *
 * Displaced side, per account:
 * 1. Stop the account's warm monitor, so nothing here broadcasts for it.
 * 2. Export the BRC-38 delta of `(lastUploadedAt, displacedAt]`, leaving out
 *    transactions that never reached the network (`exportBrc38DeltaJson`).
 * 3. Void those transactions locally (status `failed`, proof request
 *    `invalid`) and drop their miner retries: they are never broadcast.
 *    First tombstone the BRC-29 notices they owe in the notice journal and
 *    push it: its `owed` entry carries the BEEF, and a holder that delivered
 *    it would let the payee broadcast what this install voided.
 * 4. Seal the delta to the account itself (BRC-78) and post it in parts to
 *    box `account-holding`. A pending entry survives until every part is sent.
 *
 * Holder side: {@link receiveHandovers} collects the parts from the box,
 * merges a complete document (newer rows win; nothing is replaced) and
 * acknowledges the parts only after the merge succeeded.
 */
import type { StorageProvider } from '@bsv/wallet-toolbox-client'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor } from './accountLocalKeys'
import { HOLDING_BOX } from './accountRelease'
import { appendAppLog } from './appLog'
import { UNBROADCAST_STATUSES, exportBrc38DeltaJson } from './brc38StreamExport'
import { durableGetItem, durableSetItem } from './durableStorage'
import type { ListedMessage } from './messageTransport'
import { identityKeyForAccount, rootKeyHexForAccount, toolboxDatabaseName } from './vaultAccounts'
import { vaultIdentityKey, type VaultMaster } from './vaultMaster'

const PENDING_KEY = storageRegistry.accountHandoverPending.key
/** Plaintext per part; sealed and base64'd it stays under the box body cap. */
export const HANDOVER_PART_CHARS = 150_000
/** A handover larger than this stays on this install (retained, never truncated). */
export const HANDOVER_MAX_PARTS = 40
/** Incomplete parts older than this are dropped from the box. */
const PART_MAX_AGE_MS = 7 * 24 * 60 * 60_000

export type HandoverPart = {
  v: 1
  type: 'handover'
  identityKey: string
  deviceId: string
  handoverId: string
  part: number
  parts: number
  data: string
}

type PendingHandover = {
  masterIdentityKey: string
  index: number
  identityKey: string
  /** When the account was found held elsewhere: the end of the handover window. */
  until: number
}

/** Where a displaced account's state lives and how to post for it. */
export type HandoverIo = {
  deviceId: () => string
  account: (master: VaultMaster, index: number) => { chain: 'main' | 'test'; handle: string } | null
  withStorage: <T>(
    args: { chain: 'main' | 'test'; rootKeyHex: string; databaseName: string },
    fn: (storage: StorageProvider) => Promise<T>,
  ) => Promise<T>
  send: (rootKeyHex: string, body: string) => Promise<void>
  dropMinerRetry: (txid: string, owner: { identityKey: string; accountIndex: number; chain: 'main' | 'test' }) => void
  stopMonitor: (identityKey: string) => void
  /**
   * Tombstone the notices these never-broadcast transactions owe and push the
   * notice journal, so the holder never hands their BEEF to a payee. Throws
   * when the journal cannot be pushed.
   */
  settleVoidedNotices: (args: {
    rootKeyHex: string
    owner: { identityKey: string; accountIndex: number; chain: 'main' | 'test' }
    txids: string[]
  }) => Promise<number>
}

function readPending(): PendingHandover[] {
  try {
    const parsed = JSON.parse(durableGetItem(PENDING_KEY) || '[]') as unknown
    return Array.isArray(parsed) ? (parsed as PendingHandover[]) : []
  } catch {
    return []
  }
}

function writePending(rows: PendingHandover[]): void {
  durableSetItem(PENDING_KEY, JSON.stringify(rows))
}

function lastUploadedAt(owner: { identityKey: string; accountIndex: number; chain: 'main' | 'test' }): number {
  try {
    const raw = durableGetItem(accountLocalKeyFor(storageRegistry.historyBackup.key, owner))
    const at = raw ? (JSON.parse(raw) as { lastUploadedAt?: unknown }).lastUploadedAt : null
    return typeof at === 'number' && at > 0 ? at : 0
  } catch {
    return 0
  }
}

async function defaultIo(): Promise<HandoverIo> {
  const [{ getOrCreateDeviceId }, { getWalletRuntime }, { SetupClient }, transport, outbox, pool] = await Promise.all([
    import('./deviceWallets'),
    import('./walletRuntime'),
    import('@bsv/wallet-toolbox-client'),
    import('./messageTransport'),
    import('./pendingMinerOutbox'),
    import('./walletPool'),
  ])
  return {
    deviceId: getOrCreateDeviceId,
    account: (master) => {
      const active = getWalletRuntime()?.instance
      if (!active || vaultIdentityKey(active.vaultMaster) !== vaultIdentityKey(master)) return null
      return { chain: active.chain, handle: active.handle }
    },
    withStorage: async (args, fn) => {
      const storage = await SetupClient.createStorageIdb(args)
      try {
        return await fn(storage)
      } finally {
        await storage.destroy()
      }
    },
    send: (rootKeyHex, body) => transport.sendToOwnBox(rootKeyHex, HOLDING_BOX, transport.sealToSelf(rootKeyHex, body)),
    dropMinerRetry: (txid, owner) => outbox.removePendingMinerSubmit(txid, owner),
    stopMonitor: pool.dropWarmAccount,
    settleVoidedNotices: async ({ rootKeyHex, owner, txids }) => {
      const journal = await import('./noticeJournal')
      const settled = journal.voidJournalNotices(owner, txids)
      if (settled === 0) return 0
      const synced = await journal.syncNoticeJournalFor({ rootKeyHex, owner }, 'handover')
      if (synced.kind === 'failed') throw new Error(`notice journal not pushed: ${synced.reason}`)
      return settled
    },
  }
}

/** Record the handovers `indices` owe, then try to send every pending one for this vault. */
export async function handOverAccounts(master: VaultMaster, indices: number[], io?: HandoverIo): Promise<void> {
  const resolved = io ?? (await defaultIo())
  const masterIdentityKey = vaultIdentityKey(master)
  const pending = readPending()
  const until = Date.now()
  for (const index of indices) {
    const identityKey = identityKeyForAccount(master, index)
    resolved.stopMonitor(identityKey)
    if (pending.some((p) => p.identityKey === identityKey)) continue
    pending.push({ masterIdentityKey, index, identityKey, until })
  }
  writePending(pending)
  await flushPendingHandovers(master, resolved)
}

/** Send every handover this vault still owes. Safe to call on any tick. */
export async function flushPendingHandovers(master: VaultMaster, io?: HandoverIo): Promise<void> {
  const masterIdentityKey = vaultIdentityKey(master)
  const owed = readPending().filter((p) => p.masterIdentityKey === masterIdentityKey)
  if (!owed.length) return
  const resolved = io ?? (await defaultIo())
  for (const entry of owed) {
    const done = await handOver(master, entry, resolved).catch((error: unknown) => {
      appendAppLog(
        'warn',
        `[account-holding] handover a${entry.index} deferred: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    })
    if (done) writePending(readPending().filter((p) => p.identityKey !== entry.identityKey))
  }
}

async function handOver(master: VaultMaster, entry: PendingHandover, io: HandoverIo): Promise<boolean> {
  const started = Date.now()
  const where = io.account(master, entry.index)
  if (!where) throw new Error('vault is not open')
  const rootKeyHex = rootKeyHexForAccount(master, entry.index)
  const owner = { identityKey: entry.identityKey, accountIndex: entry.index, chain: where.chain }
  const databaseName = toolboxDatabaseName({ chain: where.chain, handle: where.handle, accountIndex: entry.index })
  // Uploads stop once the account is taken, so this is still the upload before the take.
  const since = lastUploadedAt(owner)
  const storageArgs = { chain: where.chain, rootKeyHex, databaseName }
  // Before voiding: once voided they are no longer listed, so a retry could not settle them.
  const unbroadcast = await io.withStorage(storageArgs, (storage) => listUnbroadcast(storage, entry.identityKey))
  const settled = await io.settleVoidedNotices({ rootKeyHex, owner, txids: unbroadcast })
  if (settled > 0) appendAppLog('info', `[account-holding] handover a${entry.index}: ${settled} notice(s) of voided payments settled`)
  const { delta, voided } = await io.withStorage(storageArgs, async (storage) => {
    const delta = await exportBrc38DeltaJson(storage, entry.identityKey, { since, until: entry.until })
    return { delta, voided: await voidUnbroadcast(storage, entry.identityKey) }
  })
  for (const txid of voided) io.dropMinerRetry(txid, owner)
  if (!delta) {
    appendAppLog('info', `[account-holding] handover a${entry.index}: nothing since last upload · voided ${voided.length}`)
    return true
  }
  const parts = Math.ceil(delta.json.length / HANDOVER_PART_CHARS)
  if (parts > HANDOVER_MAX_PARTS) {
    appendAppLog(
      'error',
      `[account-holding] handover a${entry.index} kept here: ${delta.json.length} chars is over ${HANDOVER_MAX_PARTS} parts`,
    )
    return true
  }
  const handoverId = `${entry.identityKey.slice(0, 16)}-${entry.until}`
  const deviceId = io.deviceId()
  for (let part = 0; part < parts; part++) {
    const body: HandoverPart = {
      v: 1,
      type: 'handover',
      identityKey: entry.identityKey,
      deviceId,
      handoverId,
      part,
      parts,
      data: delta.json.slice(part * HANDOVER_PART_CHARS, (part + 1) * HANDOVER_PART_CHARS),
    }
    await io.send(rootKeyHex, JSON.stringify(body))
  }
  appendAppLog(
    'info',
    `[account-holding] handover a${entry.index} done ${Date.now() - started}ms: ${delta.transactions} tx · ${delta.outputs} outputs · ${parts} part(s) · voided ${voided.length}`,
  )
  return true
}

/** Txids of every transaction this install never broadcast for the account. */
async function listUnbroadcast(storage: StorageProvider, identityKey: string): Promise<string[]> {
  const user = await storage.findUserByIdentityKey(identityKey)
  if (!user) return []
  const txids: string[] = []
  for (const status of UNBROADCAST_STATUSES) {
    const rows = await storage.findTransactions({
      partial: { userId: user.userId, status: status as never },
      noRawTx: true,
    })
    for (const tx of rows) if (tx.txid) txids.push(tx.txid)
  }
  return txids
}

/** Fail every transaction this install never broadcast for the account. Returns their txids. */
async function voidUnbroadcast(storage: StorageProvider, identityKey: string): Promise<string[]> {
  const user = await storage.findUserByIdentityKey(identityKey)
  if (!user) return []
  const voided: string[] = []
  for (const status of UNBROADCAST_STATUSES) {
    const rows = await storage.findTransactions({
      partial: { userId: user.userId, status: status as never },
      noRawTx: true,
    })
    for (const tx of rows) {
      await storage.updateTransactionStatus('failed', tx.transactionId)
      if (!tx.txid) continue
      voided.push(tx.txid)
      for (const req of await storage.findProvenTxReqs({ partial: { txid: tx.txid } })) {
        await storage.updateProvenTxReq(req.provenTxReqId, { status: 'invalid' })
      }
    }
  }
  return voided
}

export function parseHandoverPart(plaintext: string, identityKey: string): HandoverPart | null {
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return null
  }
  const p = raw as Partial<HandoverPart> | null
  if (!p || p.v !== 1 || p.type !== 'handover') return null
  if (p.identityKey !== identityKey.trim().toLowerCase()) return null
  if (typeof p.deviceId !== 'string' || typeof p.handoverId !== 'string' || typeof p.data !== 'string') return null
  if (!Number.isSafeInteger(p.parts) || (p.parts as number) < 1 || (p.parts as number) > HANDOVER_MAX_PARTS) return null
  if (!Number.isSafeInteger(p.part) || (p.part as number) < 0 || (p.part as number) >= (p.parts as number)) return null
  return p as HandoverPart
}

export type HandoverInbox = {
  /** Open a sealed body; null when it is not sealed by the account. */
  open: (body: string) => string | null
  /** Null while the account is not open here: complete handovers wait in the box. */
  merge: ((json: string) => Promise<void>) | null
  acknowledge: (messageIds: string[]) => Promise<void>
}

/**
 * Merge every complete handover among `messages` (the account's
 * `account-holding` box). Returns the ids of messages that were handover parts,
 * consumed or not, so the caller does not read them as release messages.
 */
export async function receiveHandovers(args: {
  identityKey: string
  deviceId: string
  messages: ListedMessage[]
  inbox: HandoverInbox
  now?: number
}): Promise<Set<string>> {
  const { identityKey, deviceId, messages, inbox } = args
  const now = args.now ?? Date.now()
  const seen = new Set<string>()
  const groups = new Map<string, { parts: Map<number, string>; total: number; ids: string[]; newest: number }>()
  const stale: string[] = []
  for (const m of messages) {
    const plaintext = inbox.open(m.body)
    if (plaintext == null) continue
    const part = parseHandoverPart(plaintext, identityKey)
    if (!part) continue
    seen.add(m.messageId)
    if (part.deviceId === deviceId) continue
    const group = groups.get(part.handoverId) ?? {
      parts: new Map<number, string>(),
      total: part.parts,
      ids: [] as string[],
      newest: 0,
    }
    group.parts.set(part.part, part.data)
    group.ids.push(m.messageId)
    group.newest = Math.max(group.newest, Number(m.createdAt) || 0)
    groups.set(part.handoverId, group)
  }
  for (const [handoverId, group] of groups) {
    if (group.parts.size < group.total) {
      if (group.newest && now - group.newest > PART_MAX_AGE_MS) stale.push(...group.ids)
      continue
    }
    if (!inbox.merge) continue
    const json = Array.from({ length: group.total }, (_, i) => group.parts.get(i) ?? '').join('')
    const started = Date.now()
    try {
      await inbox.merge(json)
      await inbox.acknowledge(group.ids)
      appendAppLog('info', `[account-holding] handover ${handoverId} merged done ${Date.now() - started}ms (${group.total} part(s))`)
    } catch (error) {
      appendAppLog(
        'warn',
        `[account-holding] handover ${handoverId} merge failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (stale.length) await inbox.acknowledge(stale)
  return seen
}
