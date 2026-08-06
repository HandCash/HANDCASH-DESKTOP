import { describe, expect, it } from 'vitest'
import {
  liveOneSatKeys,
  outpointKey,
  partitionByLiveUtxos,
} from './collectableOwnership'

const TX = 'a'.repeat(64)
const TX2 = 'b'.repeat(64)

describe('collectableOwnership', () => {
  it('normalizes underscore outpoints to dotted keys', () => {
    expect(outpointKey(`${TX}_0`)).toBe(`${TX}.0`)
    expect(outpointKey(`${TX}.0`)).toBe(`${TX}.0`)
  })

  it('keeps only 1-sat outpoints from an address scan', () => {
    const keys = liveOneSatKeys([
      { outpoint: `${TX}.0`, satoshis: 1 },
      { outpoint: `${TX}.1`, satoshis: 2 },
      { outpoint: `${TX2}.0`, satoshis: 5000 },
      { outpoint: `${TX2}_1`, satoshis: 1 },
    ])
    expect([...keys].sort()).toEqual([`${TX}.0`, `${TX2}.1`].sort())
  })

  it('drops basket tips the address no longer holds', () => {
    const live = liveOneSatKeys([{ outpoint: `${TX}.0`, satoshis: 1 }])
    const { owned, spentOrMissing } = partitionByLiveUtxos(
      [
        { outpoint: `${TX}.0`, satoshis: 1 },
        { outpoint: `${TX2}.0`, satoshis: 1 },
      ],
      live,
    )
    expect(owned.map((o) => o.outpoint)).toEqual([`${TX}.0`])
    expect(spentOrMissing.map((o) => o.outpoint)).toEqual([`${TX2}.0`])
  })

  it('treats underscore basket rows as matching dotted live keys', () => {
    const live = liveOneSatKeys([{ outpoint: `${TX}.0`, satoshis: 1 }])
    const { owned, spentOrMissing } = partitionByLiveUtxos(
      [{ outpoint: `${TX}_0`, satoshis: 1 }],
      live,
    )
    expect(owned).toHaveLength(1)
    expect(spentOrMissing).toHaveLength(0)
  })
})
