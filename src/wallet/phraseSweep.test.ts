import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./durableStorage', () => {
  const store = new Map<string, string>()
  return {
    durableGetItem: (key: string) => store.get(key) ?? null,
    durableSetItem: (key: string, value: string) => {
      store.set(key, value)
      return true
    },
  }
})

describe('phraseSweep validatePhraseInput', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('accepts 12-word BIP39 and rejects junk', async () => {
    const { validatePhraseInput } = await import('./phraseSweep')
    expect(validatePhraseInput('not a phrase')).toMatch(/12- or 24/)
    expect(
      validatePhraseInput(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    ).toBeNull()
    expect(validatePhraseInput('abandon '.repeat(11).trim())).toMatch(/12- or 24|valid/i)
  })
})
