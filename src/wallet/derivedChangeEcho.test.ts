import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./session', () => ({
  getActiveWallet: () => null,
}))

describe('derivedChangeEcho', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('round-trips remittance keyed by either outpoint form', async () => {
    const { rememberDerivedChange, derivedChangeEchoFor, derivedChangeEchoLockKeys } =
      await import('./derivedChangeEcho')
    const txid = 'aa'.repeat(32)
    rememberDerivedChange([
      {
        txid,
        vout: 4,
        satoshis: 575_245,
        derivationPrefix: 'pre==',
        derivationSuffix: 'suf==',
      },
    ])
    expect(derivedChangeEchoFor(`${txid}.4`)?.derivationPrefix).toBe('pre==')
    expect(derivedChangeEchoFor(`${txid}_4`)?.satoshis).toBe(575_245)
    expect(derivedChangeEchoLockKeys().has(`${txid}_4`)).toBe(true)
  })

  it('refuses a row with no derivation', async () => {
    const { derivedChangeEchoFromRow } = await import('./derivedChangeEcho')
    expect(
      derivedChangeEchoFromRow({
        txid: 'bb'.repeat(32),
        vout: 0,
        satoshis: 100,
      }),
    ).toBeNull()
  })
})
