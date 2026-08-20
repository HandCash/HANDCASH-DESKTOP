import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
    return true
  },
}))

describe('ensureHandCashServiceDefaults', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('applies HandCash history when setup was never chosen', async () => {
    const { ensureHandCashServiceDefaults } = await import('./walletSetupApply')
    const { getWalletConfigPrefs } = await import('./walletConfig')
    const { getHistoryBackupPrefs } = await import('./historyBackupPrefs')

    ensureHandCashServiceDefaults()

    const cfg = getWalletConfigPrefs()
    expect(cfg.mode).toBe('history')
    expect(cfg.historyBaseUrl).toMatch(/brc-cloud|handcash/i)
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

  it('reads legacy recommended prefs as history-only and drops provider URLs', async () => {
    store.set('handcash.brc100.trustholderEnrollments.v1', '{"enrollments":[{}]}')
    store.set('handcash.brc100.trustholderSharePlan.v1', '{"shares":["secret"]}')
    store.set(
      'handcash.brc100.walletConfig.v1',
      JSON.stringify({
        mode: 'recommended',
        historyBaseUrl: '',
        backupServiceUrls: [
          'https://example.invalid/trustholders/handcash',
          'https://example.invalid/trustholders/haste',
        ],
        configuredAt: 1,
      }),
    )
    const { ensureHandCashServiceDefaults, handCashHistoryUrl } =
      await import('./walletSetupApply')
    const { getWalletConfigPrefs } = await import('./walletConfig')
    expect(getWalletConfigPrefs().mode).toBe('history')
    expect(getWalletConfigPrefs()).not.toHaveProperty('backupServiceUrls')
    expect(store.get('handcash.brc100.walletConfig.v1')).not.toContain('backupServiceUrls')
    expect(store.has('handcash.brc100.trustholderEnrollments.v1')).toBe(false)
    expect(store.has('handcash.brc100.trustholderSharePlan.v1')).toBe(false)
    const { setHistoryBackupPrefs, getHistoryBackupPrefs } = await import(
      './historyBackupPrefs'
    )
    setHistoryBackupPrefs({ baseUrl: '' })
    ensureHandCashServiceDefaults()
    expect(getHistoryBackupPrefs().baseUrl).toBe(handCashHistoryUrl())
  })
})
