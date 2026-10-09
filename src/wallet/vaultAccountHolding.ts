/**
 * Holding vault accounts across devices: check, claim, take, release.
 *
 * The model is in `accountHolding.ts`. Every operation here runs on unlock,
 * on a switch, on a five-minute watch of the active account, or on an explicit
 * user action. None runs on the spend path; the spend guard asks
 * {@link activeAccountSpendRefusal}, which reads local storage only.
 */
import {
  UNKNOWN_ELSEWHERE,
  decideHoldingStep,
  holdingFromRecord,
  type AccountHolding,
  type AccountKeys,
  type HolderCondition,
  type HolderRead,
  type HolderState,
  type HolderWrite,
} from './accountHolding'
import { appendAppLog } from './appLog'
import {
  ACCOUNT_HELD_ELSEWHERE,
  createVaultAccount,
  ensureVaultAccounts,
  holdingOf,
  identityKeyForAccount,
  isHeldHere,
  nextAccountIndex,
  readVaultAccounts,
  resolveActiveRootKeyHex,
  rootKeyHexForAccount,
  setAccountHolding,
  setActiveVaultAccountIndex,
  writeVaultAccounts,
  type VaultAccount,
  type VaultAccountStore,
} from './vaultAccounts'
import type { AccountProbe } from './vaultAccountDiscovery'
import { vaultIdentityKey, type VaultMaster } from './vaultMaster'
import { runtimeIsCurrent, type WalletRuntime } from './walletRuntime'

export type HolderIo = {
  deviceId: () => string
  read: (account: AccountKeys) => Promise<HolderRead>
  write: (
    account: AccountKeys,
    fields: { deviceId: string; state: HolderState; seq: number },
    condition: HolderCondition,
  ) => Promise<HolderWrite>
}

async function defaultIo(): Promise<HolderIo> {
  const [{ readHolderRecord, writeHolderRecord }, { getOrCreateDeviceId }] = await Promise.all([
    import('./accountHolderRecord'),
    import('./deviceWallets'),
  ])
  return { deviceId: getOrCreateDeviceId, read: readHolderRecord, write: writeHolderRecord }
}

async function defaultProbe(): Promise<AccountProbe> {
  return (await import('./vaultAccountDiscovery')).probeAccountUse
}

function keysFor(master: VaultMaster, index: number): AccountKeys {
  return {
    identityKey: identityKeyForAccount(master, index),
    rootKeyHex: rootKeyHexForAccount(master, index),
  }
}

function list(indices: number[]): string {
  return indices.length ? indices.map((n) => `a${n}`).join(',') : 'none'
}

/** Writes before giving up when other installs keep winning the record. */
const MAX_CONFLICTS = 3

type AccountOutcome =
  | { kind: 'settled'; holding: AccountHolding }
  | { kind: 'incomplete'; reason: string }

async function reconcileAccount(args: {
  master: VaultMaster
  index: number
  io: HolderIo
  deviceId: string
}): Promise<AccountOutcome> {
  const { master, index, io, deviceId } = args
  const masterIdentityKey = vaultIdentityKey(master)
  const keys = keysFor(master, index)
  for (let attempt = 0; attempt <= MAX_CONFLICTS; attempt++) {
    const store = readVaultAccounts(masterIdentityKey)
    const account = store.accounts.find((a) => a.index === index)
    if (!account) return { kind: 'incomplete', reason: 'account no longer listed' }
    const local = holdingOf(account)
    const read = await io.read(keys)
    const step = decideHoldingStep({ local, read, deviceId, takeover: store.takeover === true })
    if (step.kind === 'keep') {
      return read.kind === 'unreachable' || read.kind === 'unsupported'
        ? { kind: 'incomplete', reason: read.kind === 'unreachable' ? read.reason : 'unsupported' }
        : { kind: 'settled', holding: local }
    }
    if (step.kind === 'adopt') {
      setAccountHolding(masterIdentityKey, index, step.holding)
      return { kind: 'settled', holding: step.holding }
    }
    const written = await io.write(keys, { deviceId, state: 'held', seq: step.seq }, step.condition)
    if (written.kind === 'written') {
      const holding: AccountHolding = { kind: 'here', seq: step.seq }
      setAccountHolding(masterIdentityKey, index, holding)
      return { kind: 'settled', holding }
    }
    if (written.kind !== 'conflict') {
      return {
        kind: 'incomplete',
        reason: written.kind === 'unreachable' ? written.reason : 'unsupported',
      }
    }
  }
  return { kind: 'incomplete', reason: 'holder record kept changing' }
}

export type HoldingCheck = {
  /** Accounts this install held before the check and no longer does. */
  displaced: number[]
  /** Accounts it holds now and did not before. */
  gained: number[]
  /** A host could not answer for some account; its holding is unchanged. */
  incomplete: boolean
}

/**
 * Reconcile every listed account (or `indices`) with its holder record and
 * publish the ones this install holds but never announced.
 */
export async function checkVaultAccountHoldings(
  master: VaultMaster,
  opts: { indices?: number[]; io?: HolderIo } = {},
): Promise<HoldingCheck> {
  const started = Date.now()
  const io = opts.io ?? (await defaultIo())
  const deviceId = io.deviceId()
  const masterIdentityKey = vaultIdentityKey(master)
  const before = ensureVaultAccounts(master)
  const wasHere = new Set(before.accounts.filter(isHeldHere).map((a) => a.index))
  const indices = opts.indices ?? before.accounts.map((a) => a.index)
  const outcomes = await Promise.all(
    indices.map((index) => reconcileAccount({ master, index, io, deviceId })),
  )
  const incomplete = outcomes.some((o) => o.kind === 'incomplete')
  const after = readVaultAccounts(masterIdentityKey)
  const isHere = new Set(after.accounts.filter(isHeldHere).map((a) => a.index))
  const displaced = indices.filter((n) => wasHere.has(n) && !isHere.has(n))
  const gained = indices.filter((n) => !wasHere.has(n) && isHere.has(n))
  if (after.takeover && after.discovered && !incomplete && !opts.indices) {
    after.takeover = false
    writeVaultAccounts(after)
  }
  const ms = Date.now() - started
  if (displaced.length || gained.length || incomplete || ms > 250) {
    const reasons = outcomes.flatMap((o, i) => (o.kind === 'incomplete' ? [`a${indices[i]} ${o.reason}`] : []))
    appendAppLog(
      displaced.length || incomplete ? 'warn' : 'info',
      `[account-holding] check done ${ms}ms: here ${list([...isHere])} · displaced ${list(displaced)} · gained ${list(gained)}` +
        (reasons.length ? ` · unchecked ${reasons.join('; ')}` : ''),
    )
  }
  return { displaced, gained, incomplete }
}

export class AccountAllocationError extends Error {}

/**
 * Allocate the next account under the vault and hold it here.
 *
 * The index is reserved with a create-only holder record, so two devices that
 * allocate at once never end up on one key. Indices taken by another install
 * (a record, or a history backup or mail from an install that predates
 * records) are listed as held elsewhere and skipped.
 */
export async function claimVaultAccount(args: {
  master: VaultMaster
  name?: string
  io?: HolderIo
  probe?: AccountProbe
}): Promise<VaultAccountStore> {
  const started = Date.now()
  const { master } = args
  const io = args.io ?? (await defaultIo())
  const probe = args.probe ?? (await defaultProbe())
  const deviceId = io.deviceId()
  const masterIdentityKey = vaultIdentityKey(master)
  let index = nextAccountIndex(ensureVaultAccounts(master))
  const skipped: number[] = []
  const nameFor = (n: number) => args.name?.trim() || `Wallet ${n}`
  const listElsewhere = (n: number, holding: AccountHolding) => {
    if (readVaultAccounts(masterIdentityKey).accounts.some((a) => a.index === n)) return
    createVaultAccount({ master, name: `Wallet ${n}`, index: n, holding })
    skipped.push(n)
  }
  const done = (store: VaultAccountStore, how: string) => {
    const ms = Date.now() - started
    if (ms > 250 || skipped.length) {
      appendAppLog('info', `[account-holding] claim a${index} ${how} done ${ms}ms (skipped ${list(skipped)})`)
    }
    return store
  }
  for (let conflicts = 0; conflicts <= MAX_CONFLICTS; ) {
    const keys = keysFor(master, index)
    const read = await io.read(keys)
    if (read.kind === 'record') {
      listElsewhere(index, holdingFromRecord(read.record, deviceId))
      index += 1
      continue
    }
    if (read.kind === 'unreachable') {
      throw new AccountAllocationError(
        'HandCash could not reach your backup host to reserve a new wallet. Check the connection and try again.',
      )
    }
    if (read.kind === 'unsupported') {
      const store = readVaultAccounts(masterIdentityKey)
      if (store.accounts.some((a) => !isHeldHere(a))) {
        throw new AccountAllocationError(
          'Another device holds wallets in this vault, and your backup host cannot record which device holds a new one.',
        )
      }
      return done(createVaultAccount({ master, name: nameFor(index), index }), 'local')
    }
    const use = await probe({ index, ...keys })
    if (use === 'used') {
      listElsewhere(index, UNKNOWN_ELSEWHERE)
      index += 1
      continue
    }
    if (use === 'unknown') {
      throw new AccountAllocationError(
        'HandCash could not check whether the next wallet is already in use. Check the connection and try again.',
      )
    }
    const written = await io.write(keys, { deviceId, state: 'held', seq: 1 }, { create: true })
    if (written.kind === 'written') {
      return done(
        createVaultAccount({ master, name: nameFor(index), index, holding: { kind: 'here', seq: 1 } }),
        'reserved',
      )
    }
    if (written.kind === 'conflict') {
      conflicts += 1
      continue
    }
    throw new AccountAllocationError(
      written.kind === 'unreachable'
        ? 'HandCash could not reach your backup host to reserve a new wallet. Check the connection and try again.'
        : 'Your backup host cannot record which device holds a new wallet.',
    )
  }
  throw new AccountAllocationError('Another device kept reserving the same wallet. Try again.')
}

export type TakeResult =
  | { kind: 'taken' }
  /** Another install holds it (`deviceId` null: nobody ever announced it). */
  | { kind: 'held-elsewhere'; deviceId: string | null }
  | { kind: 'unavailable'; reason: string }

/**
 * Hold account `index` here. A released account moves at once; one another
 * install still holds moves only with `force`, the user's word that the other
 * device is gone or will stop.
 */
export async function takeVaultAccount(args: {
  master: VaultMaster
  index: number
  force: boolean
  io?: HolderIo
}): Promise<TakeResult> {
  const { master, index, force } = args
  const io = args.io ?? (await defaultIo())
  const deviceId = io.deviceId()
  const masterIdentityKey = vaultIdentityKey(master)
  const keys = keysFor(master, index)
  for (let attempt = 0; attempt <= MAX_CONFLICTS; attempt++) {
    const read = await io.read(keys)
    if (read.kind === 'unreachable') return { kind: 'unavailable', reason: read.reason }
    if (read.kind === 'unsupported') {
      return { kind: 'unavailable', reason: 'your backup host cannot record which device holds a wallet' }
    }
    let seq = 1
    let condition: HolderCondition = { create: true }
    if (read.kind === 'record') {
      const { record } = read
      if (record.state === 'held' && record.deviceId === deviceId) {
        setAccountHolding(masterIdentityKey, index, { kind: 'here', seq: record.seq })
        return { kind: 'taken' }
      }
      if (record.state === 'held' && !force) return { kind: 'held-elsewhere', deviceId: record.deviceId }
      seq = record.seq + 1
      condition = { create: false, etag: read.etag }
    } else if (!force) {
      return { kind: 'held-elsewhere', deviceId: null }
    }
    const written = await io.write(keys, { deviceId, state: 'held', seq }, condition)
    if (written.kind === 'written') {
      setAccountHolding(masterIdentityKey, index, { kind: 'here', seq })
      appendAppLog('info', `[account-holding] took a${index} seq=${seq}${force ? ' (forced)' : ''}`)
      return { kind: 'taken' }
    }
    if (written.kind === 'unreachable') return { kind: 'unavailable', reason: written.reason }
    if (written.kind === 'unsupported') {
      return { kind: 'unavailable', reason: 'your backup host cannot record which device holds a wallet' }
    }
  }
  return { kind: 'unavailable', reason: 'the holder record kept changing' }
}

/**
 * Announce that account `index` is free for another install, then stop
 * holding it. The caller has already flushed the account's history; a
 * release that cannot be announced is refused.
 */
export async function releaseVaultAccount(args: {
  master: VaultMaster
  index: number
  io?: HolderIo
}): Promise<void> {
  const { master, index } = args
  const io = args.io ?? (await defaultIo())
  const deviceId = io.deviceId()
  const masterIdentityKey = vaultIdentityKey(master)
  const keys = keysFor(master, index)
  for (let attempt = 0; attempt <= MAX_CONFLICTS; attempt++) {
    const account = readVaultAccounts(masterIdentityKey).accounts.find((a) => a.index === index)
    if (!account || !isHeldHere(account)) throw new Error(ACCOUNT_HELD_ELSEWHERE)
    const local = holdingOf(account)
    const read = await io.read(keys)
    if (read.kind === 'unreachable' || read.kind === 'unsupported') {
      throw new Error(
        'HandCash could not tell your backup host this wallet is moving, so it stays on this device.',
      )
    }
    let seq = local.seq + 1
    let condition: HolderCondition = { create: true }
    if (read.kind === 'record') {
      const { record } = read
      if (record.seq >= local.seq && !(record.state === 'held' && record.deviceId === deviceId)) {
        setAccountHolding(masterIdentityKey, index, holdingFromRecord(record, deviceId))
        throw new Error(ACCOUNT_HELD_ELSEWHERE)
      }
      seq = Math.max(record.seq, local.seq) + 1
      condition = { create: false, etag: read.etag }
    }
    const written = await io.write(keys, { deviceId, state: 'released', seq }, condition)
    if (written.kind === 'written') {
      setAccountHolding(masterIdentityKey, index, { kind: 'elsewhere', seq, deviceId: null })
      appendAppLog('info', `[account-holding] released a${index} seq=${seq}`)
      return
    }
    if (written.kind !== 'conflict') {
      throw new Error(
        'HandCash could not tell your backup host this wallet is moving, so it stays on this device.',
      )
    }
  }
  throw new Error('Another device kept changing this wallet’s holder. Try again.')
}

/** A restore that replaces the vault's previous install: claim every account it finds. */
export function markVaultTakeover(master: VaultMaster): void {
  const store = ensureVaultAccounts(master)
  store.takeover = true
  for (const account of store.accounts) {
    const holding = holdingOf(account)
    if (holding.kind !== 'here') account.holding = { kind: 'here', seq: holding.seq }
  }
  writeVaultAccounts(store)
}

/**
 * A restore that keeps the other device: hold nothing that already exists,
 * and reserve a new account for this install. Discovery must finish first,
 * because the new index has to sit above every used one.
 */
export async function prepareAddedDevice(args: {
  master: VaultMaster
  io?: HolderIo
  probe?: AccountProbe
}): Promise<VaultAccount> {
  const started = Date.now()
  const { master } = args
  const io = args.io ?? (await defaultIo())
  const probe = args.probe ?? (await defaultProbe())
  const store = ensureVaultAccounts(master)
  store.takeover = false
  // Accounts this install once announced keep their claim; the check below settles them.
  for (const account of store.accounts) {
    const holding = holdingOf(account)
    if (holding.kind === 'here' && holding.seq === 0) account.holding = UNKNOWN_ELSEWHERE
  }
  writeVaultAccounts(store)
  const { discoverVaultAccounts } = await import('./vaultAccountDiscovery')
  const discovery = await discoverVaultAccounts({ master, probe })
  if (discovery.kind === 'interrupted') {
    throw new AccountAllocationError(
      'HandCash could not check which wallets this vault already uses. Check the connection and try again.',
    )
  }
  await checkVaultAccountHoldings(master, { io })
  const masterIdentityKey = vaultIdentityKey(master)
  let held = readVaultAccounts(masterIdentityKey).accounts.find(isHeldHere)
  if (!held) {
    const claimed = await claimVaultAccount({ master, io, probe })
    held = claimed.accounts.filter(isHeldHere).at(-1)
  }
  if (!held) throw new AccountAllocationError('The new wallet for this device was not saved.')
  setActiveVaultAccountIndex(masterIdentityKey, held.index)
  appendAppLog('info', `[account-holding] added device holds a${held.index} done ${Date.now() - started}ms`)
  return held
}

/** The account to boot: the active held one, else a new one reserved for this install. */
export async function resolveBootAccount(master: VaultMaster): Promise<{
  rootKeyHex: string
  accountIndex: number
}> {
  const resolved = resolveActiveRootKeyHex(master)
  if (resolved) return resolved
  const store = await claimVaultAccount({ master })
  const held = store.accounts.filter(isHeldHere).at(-1)
  if (!held) throw new AccountAllocationError('The new wallet for this device was not saved.')
  setActiveVaultAccountIndex(store.masterIdentityKey, held.index)
  return { rootKeyHex: rootKeyHexForAccount(master, held.index), accountIndex: held.index }
}

type ActiveAccount = { identityKey: string; accountIndex: number; vaultMaster: VaultMaster }

const masterIdentityKeys = new WeakMap<VaultMaster, string>()

function masterIdentityKeyOf(master: VaultMaster): string {
  let id = masterIdentityKeys.get(master)
  if (!id) {
    id = vaultIdentityKey(master)
    masterIdentityKeys.set(master, id)
  }
  return id
}

let releasingIdentityKey: string | null = null

/** Why the active account may not spend on this install, or null. Local storage only. */
export function activeAccountSpendRefusal(active: ActiveAccount | null): string | null {
  if (!active?.vaultMaster) return null
  if (releasingIdentityKey === active.identityKey) return 'This wallet is moving to another device.'
  const account = readVaultAccounts(masterIdentityKeyOf(active.vaultMaster)).accounts.find(
    (a) => a.index === active.accountIndex,
  )
  return account && !isHeldHere(account) ? ACCOUNT_HELD_ELSEWHERE : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Everything another install restores an account from, pushed now. */
async function flushAccountHistory(runtime: WalletRuntime): Promise<void> {
  const { sessionBackupCredential } = await import('./sessionBackupAuth')
  const password = sessionBackupCredential()
  if (password === null) {
    throw new Error('Unlock again before moving this wallet; its history has to be backed up first.')
  }
  const { uploadBrc39Backup } = await import('./historyBackup')
  await uploadBrc39Backup(password, { passwordAlreadyVerified: true })
  if (!runtimeIsCurrent(runtime)) throw new Error('The wallet changed while moving')
  const { syncCustodyJournal } = await import('./custodyJournalBackup')
  const journal = await syncCustodyJournal(runtime.instance, 'release')
  if (journal.kind === 'failed') throw new Error(`Custody journal backup failed: ${journal.reason}`)
  const { uploadActivityBackup, uploadFriendsBackup } = await import('./deviceSync')
  for (const [what, push] of [['friends', uploadFriendsBackup], ['activity', uploadActivityBackup]] as const) {
    await push().catch((error: unknown) =>
      appendAppLog('warn', `[account-holding] ${what} backup before release failed: ${messageOf(error)}`),
    )
  }
}

/**
 * Hand the active account to another install: refuse spends, flush its
 * history, announce the release. The caller switches to another account.
 */
export async function releaseActiveVaultAccount(runtime: WalletRuntime): Promise<void> {
  const active = runtime.instance
  const started = Date.now()
  releasingIdentityKey = active.identityKey
  try {
    const { waitForForegroundSpendIdle } = await import('./walletCoordinator')
    await waitForForegroundSpendIdle()
    await flushAccountHistory(runtime)
    await releaseVaultAccount({ master: active.vaultMaster, index: active.accountIndex })
    // A receive ingested during the flush must reach the backup before another install opens it.
    const { isHistoryBackupDirty } = await import('./deviceSync')
    if (isHistoryBackupDirty()) {
      await flushAccountHistory(runtime).catch((error: unknown) =>
        appendAppLog('warn', `[account-holding] history push after release failed: ${messageOf(error)}`),
      )
    }
    appendAppLog('info', `[account-holding] release a${active.accountIndex} done ${Date.now() - started}ms`)
  } finally {
    releasingIdentityKey = null
  }
}

/** How often the active account's holder record is re-read while unlocked. */
export const HOLDING_WATCH_MS = 5 * 60_000

let watchTimer: ReturnType<typeof setInterval> | null = null

/** Notice a takeover by another install within minutes, without touching the spend path. */
export function watchActiveAccountHolding(master: VaultMaster, activeIndex: () => number | null): void {
  stopHoldingWatch()
  watchTimer = setInterval(() => {
    const index = activeIndex()
    if (index == null) return
    void checkVaultAccountHoldings(master, { indices: [index] }).catch((error: unknown) =>
      appendAppLog('warn', `[account-holding] watch failed: ${messageOf(error)}`),
    )
  }, HOLDING_WATCH_MS)
}

export function stopHoldingWatch(): void {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
}
