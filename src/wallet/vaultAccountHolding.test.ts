import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

import {
  parseHolderRecord,
  signHolderRecord,
  type AccountKeys,
  type HolderRead,
  type HolderRecord,
  type HolderWrite,
} from './accountHolding'
import type { AccountProbe } from './vaultAccountDiscovery'
import {
  activeAccountSpendRefusal,
  checkVaultAccountHoldings,
  claimVaultAccount,
  markVaultTakeover,
  prepareAddedDevice,
  releaseVaultAccount,
  takeVaultAccount,
  type HolderIo,
} from './vaultAccountHolding'
import {
  ACCOUNT_HELD_ELSEWHERE,
  createVaultAccount,
  identityKeyForAccount,
  initCreatedVaultAccounts,
  readVaultAccounts,
  resolveActiveRootKeyHex,
  setActiveVaultAccountIndex,
  writeVaultAccounts,
} from './vaultAccounts'
import { brc157VaultMaster } from './vaultMaster'

const MASTER = brc157VaultMaster(Array(32).fill(0x7f))
const MASTER_IK = identityKeyForAccount(MASTER, 0)

/** One backup host: holder records by identity key, ETags, create-only and If-Match like BRC-CLOUD. */
function host() {
  const records = new Map<string, { body: string; etag: string }>()
  let n = 0
  const reachable = { up: true }
  const writes: Array<{ identityKey: string; record: HolderRecord }> = []
  const io = (deviceId: string): HolderIo => ({
    deviceId: () => deviceId,
    read: async ({ identityKey }: AccountKeys): Promise<HolderRead> => {
      if (!reachable.up) return { kind: 'unreachable', reason: 'offline' }
      const row = records.get(identityKey)
      if (!row) return { kind: 'absent' }
      const record = parseHolderRecord(JSON.parse(row.body), identityKey)
      return record ? { kind: 'record', record, etag: row.etag } : { kind: 'unreachable', reason: 'bad' }
    },
    write: async (account, fields, condition): Promise<HolderWrite> => {
      if (!reachable.up) return { kind: 'unreachable', reason: 'offline' }
      const row = records.get(account.identityKey)
      if (condition.create && row) return { kind: 'conflict' }
      if (!condition.create && condition.etag && condition.etag !== row?.etag) return { kind: 'conflict' }
      const record = signHolderRecord(account.rootKeyHex, fields)
      records.set(account.identityKey, { body: JSON.stringify(record), etag: `"${++n}"` })
      writes.push({ identityKey: account.identityKey, record })
      return { kind: 'written', record }
    },
  })
  const holderOf = (index: number) => {
    const row = records.get(identityKeyForAccount(MASTER, index))
    return row ? (JSON.parse(row.body) as HolderRecord) : null
  }
  return { io, holderOf, reachable, writes }
}

/** Separate local storage per install; `on(device)` makes it the current one. */
const devices = new Map<string, Map<string, string>>()
function on(device: string) {
  if (!devices.has(device)) devices.set(device, new Map())
  const mem = devices.get(device)!
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v)
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
  })
}

const holdings = () =>
  Object.fromEntries(readVaultAccounts(MASTER_IK).accounts.map((a) => [a.index, a.holding?.kind ?? 'here']))

/** Discovery and allocation probes see what the host holds (records are use). */
function probeOf(h: ReturnType<typeof host>, extraUsed: number[] = []): AccountProbe {
  return async ({ index }) => (h.holderOf(index) || extraUsed.includes(index) ? 'used' : 'unused')
}

beforeEach(() => {
  devices.clear()
  on('A')
})

describe('one install per account across devices', () => {
  it('announces the accounts a device holds, create-only, once', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    const first = await checkVaultAccountHoldings(MASTER, { io: h.io('A') })
    expect(first).toEqual({ displaced: [], gained: [], incomplete: false })
    expect(h.holderOf(0)).toMatchObject({ deviceId: 'A', state: 'held', seq: 1 })
    expect(readVaultAccounts(MASTER_IK).accounts[0]!.holding).toEqual({ kind: 'here', seq: 1 })
    await checkVaultAccountHoldings(MASTER, { io: h.io('A') })
    expect(h.writes).toHaveLength(1)
  })

  it('an unreachable host changes nothing and is reported', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    h.reachable.up = false
    expect(await checkVaultAccountHoldings(MASTER, { io: h.io('A') })).toEqual({
      displaced: [],
      gained: [],
      incomplete: true,
    })
    expect(holdings()).toEqual({ 0: 'here' })
  })

  it('two installs of one phrase upgrading: the second to announce gives way', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    await checkVaultAccountHoldings(MASTER, { io: h.io('A') })
    on('B')
    initCreatedVaultAccounts(MASTER)
    const check = await checkVaultAccountHoldings(MASTER, { io: h.io('B') })
    expect(check.displaced).toEqual([0])
    expect(holdings()).toEqual({ 0: 'elsewhere' })
    expect(resolveActiveRootKeyHex(MASTER)).toBeNull()
    expect(h.holderOf(0)).toMatchObject({ deviceId: 'A', seq: 1 })
  })

  it('allocation reserves the index, so two devices never land on one key', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    on('B')
    initCreatedVaultAccounts(MASTER)
    // B reserves 1 while A still lists only account 0.
    const b = await claimVaultAccount({ master: MASTER, io: h.io('B'), probe: probeOf(h) })
    expect(b.accounts.map((a) => [a.index, a.holding?.kind])).toEqual([
      [0, undefined],
      [1, 'here'],
    ])
    on('A')
    const a = await claimVaultAccount({ master: MASTER, name: 'Shop', io: h.io('A'), probe: probeOf(h) })
    expect(a.accounts.map((x) => [x.index, x.name, x.holding?.kind])).toEqual([
      [0, 'Primary', undefined],
      [1, 'Wallet 1', 'elsewhere'],
      [2, 'Shop', 'here'],
    ])
    expect(h.holderOf(1)).toMatchObject({ deviceId: 'B' })
    expect(h.holderOf(2)).toMatchObject({ deviceId: 'A' })
  })

  it('allocation skips an index an older install used without a record', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    const store = await claimVaultAccount({ master: MASTER, io: h.io('A'), probe: probeOf(h, [1]) })
    expect(store.accounts.map((a) => [a.index, a.holding?.kind])).toEqual([
      [0, undefined],
      [1, 'elsewhere'],
      [2, 'here'],
    ])
  })

  it('allocation fails closed when it cannot check the host', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    h.reachable.up = false
    await expect(claimVaultAccount({ master: MASTER, io: h.io('A'), probe: probeOf(h) })).rejects.toThrow(
      /could not reach your backup host/,
    )
    const unknown: AccountProbe = async () => 'unknown'
    h.reachable.up = true
    await expect(claimVaultAccount({ master: MASTER, io: h.io('A'), probe: unknown })).rejects.toThrow(
      /could not check whether the next wallet/,
    )
    expect(readVaultAccounts(MASTER_IK).accounts).toHaveLength(1)
  })

  it('without holder records, allocation stays local only while nothing is held elsewhere', async () => {
    const io: HolderIo = {
      deviceId: () => 'A',
      read: async () => ({ kind: 'unsupported' }),
      write: async () => ({ kind: 'unsupported' }),
    }
    initCreatedVaultAccounts(MASTER)
    const store = await claimVaultAccount({ master: MASTER, io, probe: async () => 'unused' })
    expect(store.accounts.map((a) => a.index)).toEqual([0, 1])
    createVaultAccount({ master: MASTER, name: 'x', index: 2, holding: { kind: 'elsewhere', seq: 1, deviceId: 'B' } })
    await expect(claimVaultAccount({ master: MASTER, io, probe: async () => 'unused' })).rejects.toThrow(
      /Another device holds wallets/,
    )
  })

  it('moving an account: release on one device, take without confirmation on the other', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    await claimVaultAccount({ master: MASTER, io: h.io('A'), probe: probeOf(h) })
    await checkVaultAccountHoldings(MASTER, { io: h.io('A') })
    on('B')
    initCreatedVaultAccounts(MASTER)
    createVaultAccount({ master: MASTER, name: 'Wallet 1', index: 1, holding: { kind: 'elsewhere', seq: 0, deviceId: null } })

    expect(await takeVaultAccount({ master: MASTER, index: 1, force: false, io: h.io('B') })).toEqual({
      kind: 'held-elsewhere',
      deviceId: 'A',
    })

    on('A')
    await releaseVaultAccount({ master: MASTER, index: 1, io: h.io('A') })
    expect(h.holderOf(1)).toMatchObject({ deviceId: 'A', state: 'released', seq: 2 })
    expect(holdings()[1]).toBe('elsewhere')

    on('B')
    expect(await takeVaultAccount({ master: MASTER, index: 1, force: false, io: h.io('B') })).toEqual({ kind: 'taken' })
    expect(h.holderOf(1)).toMatchObject({ deviceId: 'B', state: 'held', seq: 3 })
    expect(readVaultAccounts(MASTER_IK).accounts[1]!.holding).toEqual({ kind: 'here', seq: 3 })

    on('A')
    await checkVaultAccountHoldings(MASTER, { io: h.io('A') })
    expect(readVaultAccounts(MASTER_IK).accounts[1]!.holding).toEqual({ kind: 'elsewhere', seq: 3, deviceId: 'B' })
  })

  it('taking over a held account needs force; the old holder is displaced at its next check', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    await checkVaultAccountHoldings(MASTER, { io: h.io('A') })
    on('B')
    initCreatedVaultAccounts(MASTER)
    await checkVaultAccountHoldings(MASTER, { io: h.io('B') })
    expect(await takeVaultAccount({ master: MASTER, index: 0, force: true, io: h.io('B') })).toEqual({ kind: 'taken' })
    on('A')
    const check = await checkVaultAccountHoldings(MASTER, { io: h.io('A') })
    expect(check.displaced).toEqual([0])
  })

  it('a release that cannot be announced is refused and the account stays here', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    await checkVaultAccountHoldings(MASTER, { io: h.io('A') })
    h.reachable.up = false
    await expect(releaseVaultAccount({ master: MASTER, index: 0, io: h.io('A') })).rejects.toThrow(
      /stays on this device/,
    )
    expect(holdings()).toEqual({ 0: 'here' })
  })

  it('a restore that replaces the old device claims every account; the old device gives way', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    await claimVaultAccount({ master: MASTER, io: h.io('A'), probe: probeOf(h) })
    await checkVaultAccountHoldings(MASTER, { io: h.io('A') })

    on('B')
    markVaultTakeover(MASTER)
    // Discovery lists account 1 as this install's while the takeover stands.
    writeVaultAccounts({ ...readVaultAccounts(MASTER_IK), discovered: true })
    createVaultAccount({ master: MASTER, name: 'Wallet 1', index: 1, holding: { kind: 'here', seq: 0 } })
    const claimed = await checkVaultAccountHoldings(MASTER, { io: h.io('B') })
    expect(claimed.incomplete).toBe(false)
    expect(h.holderOf(0)).toMatchObject({ deviceId: 'B', seq: 2 })
    expect(h.holderOf(1)).toMatchObject({ deviceId: 'B', seq: 2 })
    expect(readVaultAccounts(MASTER_IK).takeover).toBe(false)

    on('A')
    expect((await checkVaultAccountHoldings(MASTER, { io: h.io('A') })).displaced).toEqual([0, 1])
  })

  it('a restore that keeps the other device holds only a new account above every used one', async () => {
    const h = host()
    initCreatedVaultAccounts(MASTER)
    await claimVaultAccount({ master: MASTER, io: h.io('A'), probe: probeOf(h) })
    await checkVaultAccountHoldings(MASTER, { io: h.io('A') })

    on('B')
    const held = await prepareAddedDevice({ master: MASTER, io: h.io('B'), probe: probeOf(h) })
    expect(held.index).toBe(2)
    expect(holdings()).toEqual({ 0: 'elsewhere', 1: 'elsewhere', 2: 'here' })
    expect(readVaultAccounts(MASTER_IK).activeIndex).toBe(2)
    expect(h.holderOf(0)).toMatchObject({ deviceId: 'A' })
    expect(h.holderOf(2)).toMatchObject({ deviceId: 'B', seq: 1 })

    on('A')
    expect((await checkVaultAccountHoldings(MASTER, { io: h.io('A') })).displaced).toEqual([])
  })

  it('a restore that keeps the other device stops when discovery cannot finish', async () => {
    const h = host()
    on('B')
    await expect(
      prepareAddedDevice({ master: MASTER, io: h.io('B'), probe: async () => 'unknown' }),
    ).rejects.toThrow(/could not check which wallets/)
  })

  it('the spend guard refuses an account held elsewhere, from local storage alone', () => {
    initCreatedVaultAccounts(MASTER)
    createVaultAccount({ master: MASTER, name: 'x', index: 1, holding: { kind: 'elsewhere', seq: 1, deviceId: 'B' } })
    const active = (accountIndex: number) => ({
      identityKey: identityKeyForAccount(MASTER, accountIndex),
      accountIndex,
      vaultMaster: MASTER,
    })
    expect(activeAccountSpendRefusal(active(0))).toBeNull()
    expect(activeAccountSpendRefusal(active(1))).toBe(ACCOUNT_HELD_ELSEWHERE)
    expect(activeAccountSpendRefusal(null)).toBeNull()
    expect(() => setActiveVaultAccountIndex(MASTER_IK, 1)).toThrow(ACCOUNT_HELD_ELSEWHERE)
  })
})
