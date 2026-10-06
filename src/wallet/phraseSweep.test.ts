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

describe('phraseSweep refusedOverFunding', () => {
  const tip = `${'a'.repeat(64)}.1`
  const refusal = (reason: string, dead: string[] = []) => Object.assign(new Error(reason), { code: 'INPUTS_UNVERIFIED', reason, dead })

  it('blames the wallet’s fee coin only when the bundle’s own tips are not the dead inputs', async () => {
    const { refusedOverFunding } = await import('./phraseSweep')
    expect(refusedOverFunding(refusal('still-dead'), [{ outpoint: tip }])).toBe(true)
    expect(refusedOverFunding(refusal('input-spent', [`${'b'.repeat(64)}.0`]), [{ outpoint: tip }])).toBe(true)
    expect(refusedOverFunding(refusal('input-spent', [`${'A'.repeat(64)}_1`]), [{ outpoint: tip }])).toBe(false)
    expect(refusedOverFunding(refusal('input-spent'), [{ outpoint: tip }])).toBe(false)
    expect(refusedOverFunding(new Error('Insufficient funds'), [{ outpoint: tip }])).toBe(false)
  })
})
