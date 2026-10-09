import { beforeEach, describe, expect, it, vi } from 'vitest'

const signals = vi.hoisted(() => ({
  backupUrl: 'https://backup.example/v1/wallets/k/wallet.brc39' as string | null,
  head: 'absent' as 'absent' | 'present' | 'refused' | 'unavailable',
  mail: false as boolean | null,
}))

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./historyBackupPrefs', () => ({
  historyBackupObjectUrl: () => {
    if (!signals.backupUrl) throw new Error('Set a backup URL first')
    return signals.backupUrl
  },
}))
vi.mock('./historyRemoteProbe', () => ({
  probeRemoteBrc39: async () => ({ kind: signals.head }),
}))
vi.mock('./messageTransport', () => ({
  messageboxHasMail: async () => signals.mail,
}))

import {
  discoverVaultAccounts,
  probeAccountUse,
  type AccountProbe,
  type AccountUse,
} from './vaultAccountDiscovery'
import {
  createVaultAccount,
  identityKeyForAccount,
  readVaultAccounts,
  subscribeVaultAccounts,
} from './vaultAccounts'
import { brc157VaultMaster, brc42VaultMaster, type VaultMaster } from './vaultMaster'

const MASTER = brc42VaultMaster('1ad0895dd317163f0e83499c30bc593dbcc54cad96a5f57b065ce9f700513250')
const MASTER_IK = identityKeyForAccount(MASTER, 0)
const mem = new Map<string, string>()

beforeEach(() => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v)
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
  })
})

/** A remote that knows the accounts at `used`, keyed by identity key as a real host is. */
function remote(used: number[], unknownAt?: number, master: VaultMaster = MASTER) {
  const byKey = new Map(used.map((n) => [identityKeyForAccount(master, n), n]))
  const probed: number[] = []
  const probe: AccountProbe = async ({ index, identityKey, rootKeyHex }) => {
    probed.push(index)
    expect(identityKeyForAccount(master, index)).toBe(identityKey)
    expect(rootKeyHex).toMatch(/^[0-9a-f]{64}$/)
    if (index === unknownAt) return 'unknown'
    return (byKey.has(identityKey) ? 'used' : 'unused') satisfies AccountUse
  }
  return { probe, probed }
}

const indices = () => readVaultAccounts(MASTER_IK).accounts.map((a) => a.index)

describe('discoverVaultAccounts (BRC-208 recovery from the vault root alone)', () => {
  it('restores every account a fresh device does not list, unused ones in between included', async () => {
    const { probe, probed } = remote([1, 2, 5])
    const result = await discoverVaultAccounts({ master: MASTER, probe })
    expect(result).toEqual({ kind: 'complete', found: [1, 2, 3, 4, 5] })
    expect(indices()).toEqual([0, 1, 2, 3, 4, 5])
    expect(probed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const store = readVaultAccounts(MASTER_IK)
    expect(store.discovered).toBe(true)
    expect(store.accounts[5]).toEqual({ index: 5, name: 'Wallet 5', identityKey: identityKeyForAccount(MASTER, 5) })
  })

  it('stops after five unused indices in a row', async () => {
    const { probe } = remote([7])
    const result = await discoverVaultAccounts({ master: MASTER, probe })
    expect(result).toEqual({ kind: 'complete', found: [] })
    expect(indices()).toEqual([0])
  })

  it('runs once per device, and the next account created takes the next index', async () => {
    const first = remote([1])
    await discoverVaultAccounts({ master: MASTER, probe: first.probe })
    const second = remote([1, 2])
    const again = await discoverVaultAccounts({ master: MASTER, probe: second.probe })
    expect(again).toEqual({ kind: 'skipped' })
    expect(second.probed).toEqual([])
    createVaultAccount({ master: MASTER, name: 'Shop' })
    expect(indices()).toEqual([0, 1, 2])
  })

  it('keeps what it found and retries next unlock when a host cannot answer', async () => {
    const down = remote([1, 2], 3)
    const result = await discoverVaultAccounts({ master: MASTER, probe: down.probe })
    expect(result).toEqual({ kind: 'interrupted', found: [1, 2], atIndex: 3 })
    expect(readVaultAccounts(MASTER_IK).discovered).toBeUndefined()

    const up = remote([1, 2, 4])
    const retry = await discoverVaultAccounts({ master: MASTER, probe: up.probe })
    expect(up.probed[0]).toBe(3)
    expect(retry).toEqual({ kind: 'complete', found: [3, 4] })
    expect(indices()).toEqual([0, 1, 2, 3, 4])
  })

  it('does not duplicate an account the user created while probes were out', async () => {
    const { probe: base } = remote([1, 2])
    const probe: AccountProbe = async (account) => {
      if (account.index === 2) {
        createVaultAccount({ master: MASTER, name: 'Mine' })
      }
      return base(account)
    }
    await discoverVaultAccounts({ master: MASTER, probe })
    const store = readVaultAccounts(MASTER_IK)
    expect(store.accounts.map((a) => [a.index, a.name])).toEqual([
      [0, 'Primary'],
      [1, 'Mine'],
      [2, 'Wallet 2'],
    ])
  })

  it('walks BRC-157 profiles the same way', async () => {
    const profiles = brc157VaultMaster(Array(32).fill(0x7f))
    const { probe } = remote([1, 3], undefined, profiles)
    const result = await discoverVaultAccounts({ master: profiles, probe })
    expect(result).toEqual({ kind: 'complete', found: [1, 2, 3] })
    const store = readVaultAccounts(identityKeyForAccount(profiles, 0))
    expect(store.accounts.map((a) => a.identityKey)).toEqual(
      [0, 1, 2, 3].map((n) => identityKeyForAccount(profiles, n)),
    )
  })

  it('tells the account menu when the list changes, and only then', async () => {
    const heard = vi.fn()
    const off = subscribeVaultAccounts(heard)
    const { probe } = remote([1])
    await discoverVaultAccounts({ master: MASTER, probe })
    const calls = heard.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    readVaultAccounts(MASTER_IK)
    await discoverVaultAccounts({ master: MASTER, probe })
    expect(heard.mock.calls.length).toBe(calls)
    off()
  })
})

describe('probeAccountUse', () => {
  const account = { index: 1, identityKey: identityKeyForAccount(MASTER, 1), rootKeyHex: MASTER.keyHex }
  const cases: Array<[string, typeof signals, AccountUse]> = [
    ['a history backup', { backupUrl: 'u', head: 'present', mail: null }, 'used'],
    ['mail waiting', { backupUrl: 'u', head: 'absent', mail: true }, 'used'],
    ['neither', { backupUrl: 'u', head: 'absent', mail: false }, 'unused'],
    ['no backup host configured and no mail', { backupUrl: null, head: 'absent', mail: false }, 'unused'],
    ['an unreachable backup host', { backupUrl: 'u', head: 'unavailable', mail: false }, 'unknown'],
    ['an unreachable messagebox', { backupUrl: 'u', head: 'absent', mail: null }, 'unknown'],
  ]
  it.each(cases)('%s', async (_name, given, expected) => {
    Object.assign(signals, given)
    expect(await probeAccountUse(account)).toBe(expected)
  })
})
