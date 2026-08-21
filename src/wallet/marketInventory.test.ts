import { describe, expect, it } from 'vitest'
import { rememberProvenVerdict } from './provenCache'
import { addMarketOriginVerdicts } from './marketInventory'

describe('market inventory authenticity projection', () => {
  it('exposes only the durable BRC-150 verdict as originVerified', () => {
    const proven = `${'a'.repeat(64)}.0`
    const unproven = `${'b'.repeat(64)}.1`
    rememberProvenVerdict(proven, 'brc150')
    rememberProvenVerdict(unproven, 'unproven')

    expect(
      addMarketOriginVerdicts({
        outputs: [{ outpoint: proven }, { outpoint: unproven }, { outpoint: 'bad' }],
      }),
    ).toMatchObject({
      outputs: [
        { authenticity: 'brc150', originVerified: true },
        { authenticity: 'unproven', originVerified: false },
        { authenticity: 'unproven', originVerified: false },
      ],
    })
  })

  it('names the origin the wallet proved, not the one metadata claims', () => {
    const tip = `${'c'.repeat(64)}.0`
    const origin = `${'d'.repeat(64)}_7`
    rememberProvenVerdict(tip, { tier: 'brc150', origin, verifiedAt: Date.now() })

    const projected = addMarketOriginVerdicts({
      outputs: [
        {
          outpoint: tip,
          customInstructions: JSON.stringify({ origin: `${'e'.repeat(64)}_1` }),
        },
      ],
    }) as { outputs: { provenOrigin?: string | null }[] }
    expect(projected.outputs[0].provenOrigin).toBe(origin)
  })

  it('offers no origin for a tip the wallet has not proven', () => {
    const projected = addMarketOriginVerdicts({
      outputs: [{ outpoint: `${'f'.repeat(64)}.3` }],
    }) as { outputs: { provenOrigin?: string | null; originVerified?: boolean }[] }
    expect(projected.outputs[0]).toMatchObject({
      originVerified: false,
      provenOrigin: null,
    })
  })
})
