import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

import {
  colourSettleActivityToken,
  internalizePeerColourSettle,
} from './ingestColourSettle'
import {
  clearAppActivity,
  isTokenActivity,
  listRecentActivity,
  noteInboundReceiveComplete,
} from './appActivity'

const ORIGIN =
  '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'
const TXID =
  '2a562450e7b7009e01f6924376f4081ccf43a46487a1fd06a3a975935c7dda19'

describe('internalizePeerColourSettle', () => {
  it('refuses an invalid colour origin before touching the wallet', async () => {
    expect(
      await internalizePeerColourSettle({
        txid: TXID,
        token: {
          kind: '1sat-ft',
          origin: 'not-an-origin',
          amount: '69',
          sym: 'KING',
        },
      }),
    ).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'invalid-colour-origin',
    })
  })

  it('refuses an invalid txid before touching the wallet', async () => {
    expect(
      await internalizePeerColourSettle({
        txid: 'nope',
        token: {
          kind: '1sat-ft',
          origin: ORIGIN,
          amount: '69',
          sym: 'KING',
        },
      }),
    ).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'invalid-txid',
    })
  })
})

describe('colour-settle activity paint', () => {
  beforeEach(() => {
    store.clear()
    clearAppActivity()
  })

  it('paints an inbound token receive as receive-token, not receive-collectable', () => {
    const token = colourSettleActivityToken(
      {
        kind: '1sat-ft',
        origin: ORIGIN,
        amount: '69',
        sym: 'KING',
      },
      ORIGIN,
      '69',
    )
    expect(token).toEqual({
      tokenId: ORIGIN,
      amount: '69',
      sym: 'KING',
      dec: 0,
    })
    expect(token.tokenId).toBe(ORIGIN)
    expect(token.tokenId).not.toBe(`${TXID}_0`)

    noteInboundReceiveComplete({
      txid: TXID,
      item: true,
      itemName: token.sym,
      itemOrigin: ORIGIN,
      outpoint: `${TXID}.0`,
      token,
    })

    const rows = listRecentActivity(10).filter((e) => e.txid === TXID)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.method).toBe('receive-token')
    expect(row.method).not.toBe('receive-collectable')
    expect(row.note).toBe('Received 69 KING')
    expect(isTokenActivity(row)).toBe(true)
    expect(row.item).toMatchObject({
      name: 'KING',
      origin: ORIGIN,
      tokenId: ORIGIN,
      amt: '69',
      dec: 0,
      outpoint: `${TXID}.0`,
    })
  })
})
