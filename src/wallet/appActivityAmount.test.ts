import { describe, expect, it } from 'vitest'
import { extractInternalizedSats } from './appActivity'

describe('internalized activity amount', () => {
  it('uses the validated wallet result when remittance args omit satoshis', () => {
    expect(
      extractInternalizedSats(
        { accepted: true, satoshis: 980 },
        {
          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: 'prefix',
                derivationSuffix: 'suffix',
              },
            },
          ],
        },
      ),
    ).toBe(980)
  })

  it('falls back to explicit request output values', () => {
    expect(
      extractInternalizedSats(
        { accepted: true },
        { outputs: [{ outputIndex: 0, satoshis: 500 }] },
      ),
    ).toBe(500)
  })
})
