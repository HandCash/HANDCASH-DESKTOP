import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindAccountLocalKeyScope, peekAccountLocalKeyScope } from './accountLocalKeys'

const state = vi.hoisted(() => ({
  active: { identityKey: 'account-a', accountIndex: 1, chain: 'main' as const, rootKeyHex: 'test-key' },
  store: new Map<string, string>(),
}))
vi.mock('./session', () => ({ getActiveWallet: () => state.active }))
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => state.store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => { state.store.set(key, value); return true },
}))
vi.mock('./identityRequestAuth', () => ({ signedIdentityFetch: vi.fn() }))
vi.mock('./historyBackupPrefs', () => ({
  getHistoryBackupPrefs: () => ({ baseUrl: 'https://backup.example' }),
  resolveHistoryBackupBaseUrl: () => 'https://backup.example',
}))
import { signedIdentityFetch } from './identityRequestAuth'
import { downloadAndMergeActivityBackup, uploadActivityBackup } from './deviceSync'
import { exportAllActivity, rebindAppActivityForAccount, upsertAppActivity } from './appActivity'

function select(identityKey: string, accountIndex: number) {
  state.active = { ...state.active, identityKey, accountIndex }
  bindAccountLocalKeyScope(state.active)
  rebindAppActivityForAccount()
}

afterEach(() => { vi.restoreAllMocks(); state.store.clear() })

describe('Activity backup account ownership', () => {
  it('uploads the captured account even if the lazy Activity import resumes after a switch', async () => {
    select('account-a', 1)
    upsertAppActivity({ origin: 'handcash', kind: 'earned', method: 'receive', sats: 1, txid: 'aa'.repeat(32) })
    vi.mocked(signedIdentityFetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    const pending = uploadActivityBackup()
    select('account-b', 2)
    upsertAppActivity({ origin: 'handcash', kind: 'earned', method: 'receive', sats: 2, txid: 'bb'.repeat(32) })
    await pending
    const [, , url, request] = vi.mocked(signedIdentityFetch).mock.calls.at(-1)!
    expect(url).toContain('/account-a/activity.json')
    const body = JSON.parse(String(request?.body))
    expect(body.identityKey).toBe('account-a')
    expect(body.entries.map((row: { txid: string }) => row.txid)).toEqual(['aa'.repeat(32)])
  })

  it('merges a late response only into its captured account after A → B → A → B', async () => {
    select('account-a', 1)
    const ownerA = peekAccountLocalKeyScope() as Parameters<typeof exportAllActivity>[0]
    let finish!: (response: Response) => void
    vi.mocked(signedIdentityFetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = downloadAndMergeActivityBackup()
    select('account-b', 2)
    upsertAppActivity({ origin: 'handcash', kind: 'earned', method: 'receive', sats: 2, txid: 'bb'.repeat(32) })
    const beforeB = exportAllActivity()
    select('account-a', 1)
    select('account-b', 2)
    finish(new Response(JSON.stringify({
      identityKey: 'account-a',
      entries: [{ id: 'a-row', origin: 'handcash', kind: 'earned', method: 'receive', sats: 1, at: 1, txid: 'aa'.repeat(32) }],
    }), { status: 200 }))
    expect(await pending).toBe(1)
    expect(exportAllActivity()).toEqual(beforeB)
    expect(exportAllActivity(ownerA).map(row => row.id)).toEqual(['a-row'])
    select('account-a', 1)
    expect(exportAllActivity().map(row => row.id)).toEqual(['a-row'])
  })
})
