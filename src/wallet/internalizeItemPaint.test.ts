import { describe, expect, it } from 'vitest'
import {
  paintAfterInternalizeBsv21,
  parseInternalizedItemTips,
} from './internalizeItemPaint'
import {
  clearFungiblesCache,
  getCachedFungibles,
} from './fungibles'

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

  it('paints an internalized BSV-21 output immediately with its icon', () => {
    clearFungiblesCache()
    const tokenId = `${'b'.repeat(64)}_0`
    const icon = `${'c'.repeat(64)}_1`
    const painted = paintAfterInternalizeBsv21(
      { address: ADDR, chain: 'main' } as never,
      {
        outputs: [
          {
            outputIndex: 2,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: 'bsv21',
              tags: ['bsv21', `bsv21:${tokenId}`, 'amt:25', 'sym:tst', `icon:${icon}`],
              customInstructions: JSON.stringify({
                p: 'bsv-20',
                op: 'transfer',
                id: tokenId,
                amt: '25',
                sym: 'TST',
                icon,
                dec: 2,
              }),
            },
          },
        ],
      },
      { txid: TXID },
    )

    expect(painted).toBe(1)
    expect(getCachedFungibles()).toMatchObject([
      {
        tokenId,
        amt: '25',
        sym: 'TST',
        icon,
        outpoint: `${TXID}.2`,
      },
    ])
    clearFungiblesCache()
  })
})
