import { describe, expect, it } from 'vitest'
import { buildBsv21BurnLockingScript } from './bsv21Inscribe'

const TOKEN_ID = `${'ab'.repeat(32)}_0`

describe('buildBsv21BurnLockingScript', () => {
  it('builds the canonical application/bsv-20 burn inscription', () => {
    const built = buildBsv21BurnLockingScript({
      address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      tokenId: TOKEN_ID,
      amt: '0042',
    })
    expect(built.json).toEqual({
      p: 'bsv-20',
      op: 'burn',
      id: TOKEN_ID,
      amt: '42',
    })
    expect(built.lockingScript.startsWith('0063036f7264')).toBe(true)
    expect(built.lockingScript.endsWith('88ac')).toBe(true)
  })

  it('refuses zero and malformed amounts', () => {
    expect(() =>
      buildBsv21BurnLockingScript({
        address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        tokenId: TOKEN_ID,
        amt: '0',
      }),
    ).toThrow(/positive/)
  })
})
