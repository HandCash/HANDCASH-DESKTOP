import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => {
  const active = {
    identityKey: 'id-1',
    rootKeyHex: 'aa'.repeat(32),
    handle: 'alice',
    chain: 'main' as const,
    accountIndex: 0,
    masterRootKeyHex: 'aa'.repeat(32),
    mnemonic: null,
    monitor: { stopTasks: vi.fn() },
    wallet: {},
  }
  return {
    active,
    getActiveWallet: vi.fn(() => active),
    clearActiveWallet: vi.fn(),
    bootWallet: vi.fn(async () => undefined),
  }
})

const echo = vi.hoisted(() => ({
  order: [] as string[],
  echoAllDerivedOutputs: vi.fn(async () => {
    echo.order.push('echo')
    return 0
  }),
  recoverEchoedChange: vi.fn(async () => ({})),
}))
vi.mock('./reimportDerivedChange', () => ({
  echoAllDerivedOutputs: echo.echoAllDerivedOutputs,
  recoverEchoedChange: echo.recoverEchoedChange,
}))

vi.mock('./session', () => ({
  getActiveWallet: session.getActiveWallet,
  clearActiveWallet: session.clearActiveWallet,
  bootWallet: session.bootWallet,
}))
vi.mock('./walletCoordinator', () => ({
  runHistoryReplica: <T>(fn: () => Promise<T>) => fn(),
}))
vi.mock('./historyBackupPrefs', () => ({
  getHistoryBackupPrefs: () => ({ url: 'https://history.test/' }),
  historyBackupObjectUrl: () => 'https://history.test/id-1.brc39',
  noteSpendableHighWater: vi.fn(),
  setHistoryBackupPrefs: vi.fn(),
  setSpendableHighWaterFromPush: vi.fn(),
}))
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./vault', () => ({ revealRootKeyHex: vi.fn() }))
vi.mock('./cloudBackupHealth', () => ({ refreshCloudBackupHealth: vi.fn() }))
vi.mock('./brc39LocalArchive', () => ({
  archiveBrc39Locally: vi.fn(),
  listLocalBrc39Archive: vi.fn(() => []),
  readLocalBrc39Archive: vi.fn(),
}))
vi.mock('./historyCryptoSecret', () => ({ historyCryptoSecret: vi.fn() }))
vi.mock('./brc39Encrypt', () => ({ encryptBrc39Document: vi.fn() }))
vi.mock('@bsv/wallet-toolbox-client', () => ({
  exportBRC38Json: vi.fn(),
  importBRC39: vi.fn(),
}))

import { replaceLocalHistoryFromCloud } from './historyBackup'

describe('replaceLocalHistoryFromCloud stage reporting', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', {
      deleteDatabase: () => {
        const req: { onsuccess?: () => void } = {}
        queueMicrotask(() => req.onsuccess?.())
        return req
      },
    })
  })

  it('reports wipe → reboot → download in domain order before the fetch is attempted', async () => {
    const stages: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        stages.push('fetch')
        return new Response(null, { status: 503 })
      })
    )

    await expect(
      replaceLocalHistoryFromCloud(null, { onStage: (s) => stages.push(s) })
    ).rejects.toThrow()

    expect(stages).toEqual(['wipe', 'reboot', 'download', 'fetch'])
    expect(session.clearActiveWallet).toHaveBeenCalledTimes(1)
    expect(session.bootWallet).toHaveBeenCalledTimes(1)
    expect(stages.indexOf('wipe')).toBeLessThan(stages.indexOf('reboot'))
  })

  it('echoes derivations before the wipe and replaces only this subwallet', async () => {
    const deleted: string[] = []
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        deleted.push(name)
        echo.order.push('wipe')
        const req: { onsuccess?: () => void } = {}
        queueMicrotask(() => req.onsuccess?.())
        return req
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    echo.order.length = 0
    session.bootWallet.mockClear()
    Object.assign(session.active, { accountIndex: 2, rootKeyHex: 'bb'.repeat(32) })
    try {
      await expect(replaceLocalHistoryFromCloud(null)).rejects.toThrow()
    } finally {
      Object.assign(session.active, { accountIndex: 0, rootKeyHex: 'aa'.repeat(32) })
    }

    expect(echo.order).toEqual(['echo', 'wipe'])
    expect(deleted).toEqual(['handcash-brc100-main-alice-a2'])
    expect(session.bootWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        rootKeyHex: 'bb'.repeat(32),
        accountIndex: 2,
        masterRootKeyHex: 'aa'.repeat(32),
      }),
    )
  })

  it('is silent when no progress sink is given', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    await expect(replaceLocalHistoryFromCloud(null)).rejects.toThrow()
  })
})
