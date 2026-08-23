import { describe, expect, it } from 'vitest'
import { parseInternalizedItemTips } from './internalizeItemPaint'

const TXID = 'a'.repeat(64)
const ADDR = '1HandCashTestAddress'

describe('parseInternalizedItemTips', () => {
  it('reads basket insertion outputs from internalize args', () => {
    const tips = parseInternalizedItemTips(
      { address: ADDR, chain: 'main' } as never,
      {
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: '1sat',
              tags: ['ordinal', `origin:${TXID}_0`, 'name:Lab Item'],
              customInstructions: JSON.stringify({
                origin: `${TXID}_0`,
                name: 'Lab Item',
                app: 'app-lab',
              }),
            },
          },
        ],
      },
      { txid: TXID },
    )
    expect(tips).toHaveLength(1)
    expect(tips[0]?.outpoint).toBe(`${TXID}.0`)
    expect(tips[0]?.name).toBe('Lab Item')
    expect(tips[0]?.app).toBe('app-lab')
  })
})
