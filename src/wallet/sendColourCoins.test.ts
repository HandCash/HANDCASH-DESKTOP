import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'

const TOKEN = `${'ab'.repeat(32)}_0`
const ADDR = PrivateKey.fromRandom().toAddress()

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    identityKey: '03' + 'aa'.repeat(32),
    address: ADDR,
    wallet: {
      listOutputs: async () => ({ outputs: [] }),
    },
  }),
}))

describe('sendColourCoins remittance-only refuse', () => {
  it('refuses to spend a remittance-only 1-sat as a 162 token', async () => {
    const { sendColourCoins } = await import('./sendColourCoins')
    await expect(
      sendColourCoins({
        origin: TOKEN,
        amount: 60,
        toAddress: ADDR,
        tips: [
          {
            outpoint: `${'cd'.repeat(32)}_1`,
            origin: TOKEN,
            satoshis: 1,
            amt: 60,
            proven: true,
            lockingScript: `76a914${'11'.repeat(20)}88ac`,
            customInstructions: JSON.stringify({
              p: 'bsv-20',
              op: 'transfer',
              id: TOKEN,
              amt: '60',
            }),
          },
        ],
      }),
    ).rejects.toThrow(/Need 60|only 0/)
  })
})
