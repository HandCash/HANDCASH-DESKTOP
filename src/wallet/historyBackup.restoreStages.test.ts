import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  active: { identityKey: 'id-1', rootKeyHex: 'aa'.repeat(32), chain: 'main', handle: 'alice', accountIndex: 0, monitor: { stopTasks: vi.fn() } },
  selected: 'ledger',
  decrypt: vi.fn(async () => ({ user: { identityKey: 'id-1' }, sourceStorage: { chain: 'main' } })),
  import: vi.fn(async () => ({ inserts: 2, updates: 0, identityKey: 'id-1', mode: 'merge' })),
  destroy: vi.fn(), boot: vi.fn(), select: vi.fn(), echo: vi.fn(), recover: vi.fn(),
}))
vi.mock('./session', () => ({ getActiveWallet: () => state.active, bootWallet: state.boot }))
vi.mock('./identityRequestAuth', () => ({ signedIdentityFetch: (_root: string, _scope: string, url: string, init: RequestInit) => fetch(url, init) }))
vi.mock('./walletCoordinator', () => ({ runHistoryReplica: (fn: () => Promise<unknown>) => fn() }))
vi.mock('./vaultAccounts', () => ({ toolboxDatabaseName: () => state.selected, originalToolboxDatabaseName: () => 'ledger', selectToolboxDatabase: state.select }))
vi.mock('./reimportDerivedChange', () => ({ echoAllDerivedOutputs: state.echo, recoverEchoedChange: state.recover }))
vi.mock('./brc39Encrypt', () => ({ decryptBrc39Document: state.decrypt, encryptBrc39Document: vi.fn() }))
vi.mock('./historyCryptoSecret', () => ({ historyCryptoSecret: () => 'secret' }))
vi.mock('@bsv/wallet-toolbox-client', () => ({ importBRC38: state.import, importBRC39: vi.fn(), exportBRC38Json: vi.fn(), SetupClient: { createStorageIdb: async () => ({ destroy: state.destroy }) } }))
vi.mock('./historyBackupPrefs', () => ({ getHistoryBackupPrefs: () => ({}), historyBackupObjectUrl: () => 'https://history.test/backup', setHistoryBackupPrefs: vi.fn(), noteSpendableHighWater: vi.fn(), setSpendableHighWaterFromPush: vi.fn() }))
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./vault', () => ({ revealRootKeyHex: vi.fn() }))
vi.mock('./cloudBackupHealth', () => ({ refreshCloudBackupHealth: vi.fn() }))
vi.mock('./brc39LocalArchive', () => ({ archiveBrc39Locally: vi.fn(), listLocalBrc39Archive: vi.fn(), readLocalBrc39Archive: vi.fn() }))
import { replaceLocalHistoryFromCloud, readBoundedBackup } from './historyBackup'
describe('recovery retains the original ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.selected = 'ledger'
    state.decrypt.mockResolvedValue({ user: { identityKey: 'id-1' }, sourceStorage: { chain: 'main' } })
    state.import.mockResolvedValue({ inserts: 2, updates: 0, identityKey: 'id-1', mode: 'merge' })
    state.select.mockImplementation((_account, name) => { state.selected = name })
    state.boot.mockResolvedValue(state.active)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(100))))
    vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn(() => { throw new Error('Ledger must never be deleted') }) })
  })
  it('download failure preserves the current database and session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await expect(replaceLocalHistoryFromCloud()).rejects.toThrow('Download failed')
    expect(state.select).not.toHaveBeenCalled(); expect(state.boot).not.toHaveBeenCalled()
  })
  it('decryption failure or wrong identity never switches databases', async () => {
    state.decrypt.mockRejectedValueOnce(new Error('Authentication failed'))
    await expect(replaceLocalHistoryFromCloud()).rejects.toThrow('Authentication failed')
    state.decrypt.mockResolvedValueOnce({ user: { identityKey: 'other' }, sourceStorage: { chain: 'main' } })
    await expect(replaceLocalHistoryFromCloud()).rejects.toThrow('does not match')
    expect(state.select).not.toHaveBeenCalled()
  })
  it('an import failure closes the staging database and retains the original', async () => {
    state.import.mockRejectedValueOnce(new Error('Invalid row'))
    await expect(replaceLocalHistoryFromCloud()).rejects.toThrow('Invalid row')
    expect(state.destroy).toHaveBeenCalledOnce(); expect(state.select).not.toHaveBeenCalled()
  })
  it('switches only after successful validation and import, without deleting the original', async () => {
    const stages: string[] = []
    await expect(replaceLocalHistoryFromCloud(null, { onStage: stage => stages.push(stage) })).resolves.toMatchObject({ crypto: 'root-key', inserts: 2 })
    expect(stages).toEqual(['download', 'validate', 'merge', 'reboot'])
    expect(state.selected).toMatch(/^ledger-restore-/)
    expect(indexedDB.deleteDatabase).not.toHaveBeenCalled()
    expect(state.import.mock.invocationCallOrder[0]).toBeLessThan(state.select.mock.invocationCallOrder[0])
  })
  it('reopens the original database when replacement boot fails', async () => {
    state.boot.mockRejectedValueOnce(new Error('Boot failed'))
    await expect(replaceLocalHistoryFromCloud()).rejects.toThrow('Boot failed')
    expect(state.selected).toBe('ledger'); expect(state.boot).toHaveBeenCalledTimes(2)
  })
  it('rejects oversized downloads before allocation/import', async () => {
    await expect(readBoundedBackup(new Response(new Uint8Array(100), { headers: { 'Content-Length': String(97 * 1024 * 1024) } }))).rejects.toThrow('96 MB')
    expect(state.import).not.toHaveBeenCalled()
  })
})
