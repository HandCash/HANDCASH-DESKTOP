import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerSnapshot } from './peerSnapshot'
import {
  peerSpenderOf,
  refreshPeerDeviceSpends,
  resetPeerDeviceSpendsForTests,
} from './peerDeviceSpends'
import { coinCleared, noteCoinsCleared, resetSpendCertaintyForTests } from './spendCertainty'

const T = (c: string) => c.repeat(64)
const op = (c: string, vout = 0) => `${T(c)}.${vout}`

const durable = new Map<string, string>()
const hidden: string[] = []
let meta: { exists: boolean; exportedAt: number | null } | null = null
let lastUploadedAt: number | null = null
let snapshot: PeerSnapshot | Error = { storageIdentityKey: 'other', txs: [] }
let spendableHere: string[] = []
let knownHere = new Set<string>()
const fetchBytes = vi.fn(async () => ({ bytes: new Uint8Array([1]), exportedAt: meta?.exportedAt ?? null }))

vi.mock('./accountLocalKeys', () => ({ accountLocalKey: (k: string) => `acct:${k}` }))
vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => durable.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    durable.set(k, v)
    return true
  },
}))
vi.mock('./historyBackupPrefs', () => ({
  resolveHistoryBackupBaseUrl: () => 'https://backup.example',
  getHistoryBackupPrefs: () => ({ lastUploadedAt }),
}))
vi.mock('./historyBackup', () => ({
  fetchRemoteBrc39Meta: async () => meta,
  fetchRemoteBrc39Bytes: () => fetchBytes(),
}))
vi.mock('./historyCryptoSecret', () => ({ historyCryptoSecret: () => 'secret' }))
vi.mock('./brc39Encrypt', () => ({
  readBrc39Snapshot: async () => {
    if (snapshot instanceof Error) throw snapshot
    return snapshot
  },
}))
vi.mock('./staleOutputRelease', () => ({
  hideSpentOutpoints: async (outpoints: string[], spender: string) => {
    hidden.push(`${outpoints.join(',')} by ${spender.slice(0, 4)}`)
    return outpoints.length
  },
}))
vi.mock('./session', () => ({ bumpBalanceAfterHeal: () => undefined }))
vi.mock('./pinnedWallet', () => ({
  pinnedActiveWallet: () => ({
    rootKeyHex: '11'.repeat(32),
    wallet: {
      storage: {
        runAsStorageProvider: async (fn: (sp: unknown) => unknown) =>
          fn({
            makeAvailable: async () => ({ storageIdentityKey: 'local' }),
            findOutputs: async ({ paged }: { paged: { offset: number } }) =>
              paged.offset > 0
                ? []
                : spendableHere.map((o) => {
                    const [txid, vout] = o.split('.')
                    return { txid, vout: Number(vout) }
                  }),
            findTransactions: async ({ partial }: { partial: { txid: string } }) =>
              knownHere.has(partial.txid) ? [{ txid: partial.txid }] : [],
          }),
      },
    },
  }),
}))

describe('refreshPeerDeviceSpends', () => {
  beforeEach(() => {
    durable.clear()
    hidden.length = 0
    fetchBytes.mockClear()
    meta = { exists: true, exportedAt: 1_000 }
    lastUploadedAt = null
    snapshot = { storageIdentityKey: 'other', txs: [] }
    spendableHere = []
    knownHere = new Set()
    resetPeerDeviceSpendsForTests()
    resetSpendCertaintyForTests()
  })

  it('ignores the upload this install wrote', async () => {
    lastUploadedAt = 1_000
    await expect(refreshPeerDeviceSpends({ force: true })).resolves.toEqual({ kind: 'own' })
    expect(fetchBytes).not.toHaveBeenCalled()
  })

  it('hides coins another install spent and remembers the spender', async () => {
    spendableHere = [op('a'), op('b'), op('c')]
    knownHere = new Set([T('2')])
    noteCoinsCleared([op('a')])
    snapshot = {
      storageIdentityKey: 'other',
      txs: [
        { txid: T('1'), status: 'unproven', inputs: [op('a'), op('z')] },
        { txid: T('2'), status: 'completed', inputs: [op('b')] },
        { txid: T('3'), status: 'failed', inputs: [] },
      ],
    }
    await expect(refreshPeerDeviceSpends({ force: true })).resolves.toEqual({
      kind: 'read',
      spent: 1,
      withdrawn: 0,
    })
    expect(hidden).toEqual([`${op('a')} by 1111`])
    expect(peerSpenderOf(op('a').toUpperCase())).toBe(T('1'))
    expect(peerSpenderOf(op('b'))).toBeNull()
    expect(coinCleared(op('a'))).toBe(false)

    resetPeerDeviceSpendsForTests()
    expect(peerSpenderOf(op('a'))).toBe(T('1'))
    await expect(refreshPeerDeviceSpends({ force: true })).resolves.toEqual({ kind: 'seen' })
    expect(fetchBytes).toHaveBeenCalledOnce()
  })

  it('treats a snapshot from this storage as its own', async () => {
    spendableHere = [op('a')]
    snapshot = {
      storageIdentityKey: 'local',
      txs: [{ txid: T('1'), status: 'unproven', inputs: [op('a')] }],
    }
    await expect(refreshPeerDeviceSpends({ force: true })).resolves.toEqual({ kind: 'own' })
    expect(hidden).toEqual([])
    expect(peerSpenderOf(op('a'))).toBeNull()
  })

  it('withdraws a spend the other install later failed', async () => {
    spendableHere = [op('a')]
    snapshot = {
      storageIdentityKey: 'other',
      txs: [{ txid: T('1'), status: 'unproven', inputs: [op('a')] }],
    }
    await refreshPeerDeviceSpends({ force: true })
    expect(peerSpenderOf(op('a'))).toBe(T('1'))

    meta = { exists: true, exportedAt: 2_000 }
    spendableHere = []
    snapshot = { storageIdentityKey: 'other', txs: [{ txid: T('1'), status: 'failed', inputs: [] }] }
    await expect(refreshPeerDeviceSpends({ force: true })).resolves.toEqual({
      kind: 'read',
      spent: 0,
      withdrawn: 1,
    })
    expect(peerSpenderOf(op('a'))).toBeNull()
  })

  it('asks at most once per window on the signing path', async () => {
    meta = { exists: false, exportedAt: null }
    await expect(refreshPeerDeviceSpends()).resolves.toEqual({ kind: 'absent' })
    await expect(refreshPeerDeviceSpends()).resolves.toEqual({ kind: 'throttled' })
  })

  it('backs off a snapshot it could not read', async () => {
    snapshot = new Error('BRC-39 authentication failed')
    const first = await refreshPeerDeviceSpends({ force: true })
    expect(first.kind).toBe('failed')
    await expect(refreshPeerDeviceSpends({ force: true })).resolves.toEqual({ kind: 'seen' })
    expect(fetchBytes).toHaveBeenCalledOnce()
  })
})
