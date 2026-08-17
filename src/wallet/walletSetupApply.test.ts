import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

describe('ensureHandCashServiceDefaults', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('applies HandCash history without trustholders when setup was never chosen', async () => {
    const { ensureHandCashServiceDefaults } = await import('./walletSetupApply')
    const { getWalletConfigPrefs } = await import('./walletConfig')
    const { getHistoryBackupPrefs } = await import('./historyBackupPrefs')

    ensureHandCashServiceDefaults()

    const cfg = getWalletConfigPrefs()
    expect(cfg.mode).toBe('history')
    expect(cfg.historyBaseUrl).toMatch(/brc-cloud|handcash/i)
    expect(cfg.backupServiceUrls).toEqual([])
    expect(getHistoryBackupPrefs().baseUrl).toBe(cfg.historyBaseUrl.replace(/\/+$/, ''))
  })

  it('does not override an explicit no-backup choice', async () => {
    const { applyWalletSetupSelection, ensureHandCashServiceDefaults } =
      await import('./walletSetupApply')
    applyWalletSetupSelection('none', '')
    ensureHandCashServiceDefaults()
    const { getWalletConfigPrefs } = await import('./walletConfig')
    const { getHistoryBackupPrefs } = await import('./historyBackupPrefs')
    expect(getWalletConfigPrefs().mode).toBe('none')
    expect(getHistoryBackupPrefs().baseUrl).toBe('')
  })

  it('does not fill suggested history when setup is none', async () => {
    const { applyWalletSetupSelection } = await import('./walletSetupApply')
    applyWalletSetupSelection('none', '')
    const { ensureSuggestedHistoryBackupUrl, getHistoryBackupPrefs } =
      await import('./historyBackupPrefs')
    expect(ensureSuggestedHistoryBackupUrl().baseUrl).toBe('')
    expect(getHistoryBackupPrefs().baseUrl).toBe('')
  })

  it('fills a blank history URL for recommended mode', async () => {
    const { applyWalletSetupSelection, ensureHandCashServiceDefaults, handCashHistoryUrl } =
      await import('./walletSetupApply')
    applyWalletSetupSelection('recommended', handCashHistoryUrl())
    const { getWalletConfigPrefs } = await import('./walletConfig')
    expect(getWalletConfigPrefs().mode).toBe('history')
    expect(getWalletConfigPrefs().backupServiceUrls).toEqual([])
    const { setHistoryBackupPrefs, getHistoryBackupPrefs } = await import(
      './historyBackupPrefs'
    )
    setHistoryBackupPrefs({ baseUrl: '' })
    ensureHandCashServiceDefaults()
    expect(getHistoryBackupPrefs().baseUrl).toBe(handCashHistoryUrl())
  })

  it('lists no trustholder providers while the feature is off', async () => {
    const { listTrustholderProviders, depositShareToTrustholder } =
      await import('./trustholderBackup')
    expect(listTrustholderProviders()).toEqual([])
    await expect(
      depositShareToTrustholder({
        operator: 'handcash',
        password: 'x',
        email: 'a@b.c',
        onOtpNeeded: async () => '000000',
      }),
    ).rejects.toThrow(/not available/i)
  })
})
