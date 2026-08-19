import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import type { ActivityEntry } from '../wallet/appActivity'
import type { FungibleToken } from '../wallet/fungibles'
import {
  activityForFungible,
  fungibleDetailsMachine,
} from './fungibleDetailsMachine'

const token: FungibleToken = {
  tokenId: `${'a'.repeat(64)}_0`,
  tokenIds: [`${'a'.repeat(64)}_0`, `${'b'.repeat(64)}_1`],
  sym: 'TEST',
  amt: '1250',
  dec: 2,
  utxoCount: 2,
  outpoint: `${'c'.repeat(64)}_0`,
  spendKind: 'plain',
}

function activity(id: string, tokenId?: string): ActivityEntry {
  return {
    id,
    origin: 'wallet',
    kind: 'earned',
    sats: 1,
    at: 1,
    method: 'receive-token',
    ...(tokenId
      ? {
          item: {
            name: 'TEST',
            origin: tokenId,
            tokenId,
            amt: '100',
            dec: 2,
          },
        }
      : {}),
  }
}

describe('fungibleDetailsMachine', () => {
  it('projects loading, unavailable, and recovered token states', () => {
    const actor = createActor(fungibleDetailsMachine, {
      input: { token: null, activity: [] },
    }).start()

    expect(actor.getSnapshot().value).toBe('loading')
    actor.send({ type: 'LOAD', token: null, activity: [] })
    expect(actor.getSnapshot().value).toBe('unavailable')
    actor.send({ type: 'LOAD', token, activity: [] })
    expect(actor.getSnapshot().value).toBe('ready')
    expect(actor.getSnapshot().context.token?.sym).toBe('TEST')
  })

  it('paints a cached token without a loading frame', () => {
    const actor = createActor(fungibleDetailsMachine, {
      input: { token, activity: [] },
    }).start()

    expect(actor.getSnapshot().value).toBe('ready')
  })

  it('scopes activity to every grouped deploy id', () => {
    const entries = [
      activity('representative', token.tokenId.toUpperCase()),
      activity('grouped', token.tokenIds![1]),
      activity('other', `${'d'.repeat(64)}_0`),
      activity('bsv'),
    ]

    expect(activityForFungible(token, entries).map((entry) => entry.id)).toEqual([
      'representative',
      'grouped',
    ])
  })

  it('keeps synchronized activity token-scoped', () => {
    const actor = createActor(fungibleDetailsMachine, {
      input: { token, activity: [] },
    }).start()
    actor.send({ type: 'LOAD', token, activity: [] })
    actor.send({
      type: 'ACTIVITY_SYNCED',
      activity: [
        activity('token', token.tokenId),
        activity('other', `${'e'.repeat(64)}_0`),
      ],
    })

    expect(actor.getSnapshot().context.activity.map((entry) => entry.id)).toEqual([
      'token',
    ])
  })
})
