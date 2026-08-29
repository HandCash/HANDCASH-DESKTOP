import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { aggregateFungibles } from './bsv21'
import { encodeBsv21Binary, tokenIdToWire } from './bsv21Binary'
import { decodeListedBsv21Tip } from './colourListing'
import { buildOnesatFtTransferLockingScript } from './onesatFtInscribe'
import { buildBsv21ValueLock } from './bsv21Send'
import { listFungibleTips } from './fungibles'

const ADDR = PrivateKey.fromRandom().toAddress()
const TOKEN_A = `${'ab'.repeat(32)}_0`
const TOKEN_B = `${'cd'.repeat(32)}_0`

describe('bsv21 listing aggregation', () => {
  it('aggregates Σ amt by deploy outpoint and ignores 1sat-ft leftovers', () => {
    const payee = buildBsv21ValueLock({
      tokenId: TOKEN_A,
      amount: 60n,
      address: ADDR,
    })
    const change = buildBsv21ValueLock({
      tokenId: TOKEN_A,
      amount: 40n,
      address: ADDR,
    })
    const other = buildBsv21ValueLock({
      tokenId: TOKEN_B,
      amount: 7n,
      address: ADDR,
    })
    const leftover = buildOnesatFtTransferLockingScript({
      address: ADDR,
      amt: 68862,
    }).lockingScript

    const a = decodeListedBsv21Tip({
      outpoint: `${'11'.repeat(32)}.0`,
      satoshis: 1,
      lockingScript: payee,
      tags: ['bsv21', `bsv21:${TOKEN_A}`, 'amt:60', 'sym:gold'],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: TOKEN_A,
        amt: '60',
        sym: 'GOLD',
        dec: '2',
      }),
    })
    const b = decodeListedBsv21Tip({
      outpoint: `${'22'.repeat(32)}.1`,
      satoshis: 1,
      lockingScript: change,
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: TOKEN_A,
        amt: '40',
      }),
    })
    const c = decodeListedBsv21Tip({
      outpoint: `${'33'.repeat(32)}.0`,
      satoshis: 1,
      lockingScript: other,
    })
    const leftoverRow = decodeListedBsv21Tip({
      outpoint: `${'44'.repeat(32)}.1`,
      satoshis: 1,
      lockingScript: leftover,
      tags: ['1sat-ft'],
      customInstructions: JSON.stringify({
        p: '1sat-ft',
        origin: TOKEN_A,
        amt: '68862',
        sym: 'KING',
      }),
    })

    expect(leftoverRow).toBeNull()
    expect(a?.tokenId).toBe(TOKEN_A)
    expect(a?.amt).toBe('60')
    expect(a?.dec).toBe(2)
    expect(a?.sym).toBe('GOLD')
    expect(b?.tokenId).toBe(TOKEN_A)
    expect(c?.tokenId).toBe(TOKEN_B)

    const cards = aggregateFungibles([a!, b!, c!])
    expect(cards).toHaveLength(2)
    const gold = cards.find((t) => t.tokenId === TOKEN_A)
    const otherCard = cards.find((t) => t.tokenId === TOKEN_B)
    expect(gold?.amt).toBe('100')
    expect(gold?.utxoCount).toBe(2)
    expect(gold?.tokenId).toBe(TOKEN_A)
    expect(gold?.dec).toBe(2)
    expect(otherCard?.amt).toBe('7')
    expect(otherCard?.tokenId).toBe(TOKEN_B)
  })

  it('uses the deploy outpoint as the card id when the script is a deploy', () => {
    const deployOut = `${'ee'.repeat(32)}_0`
    const script = encodeBsv21Binary({
      amount: 1000n,
      payload: { sym: 'GOLD', dec: 0 },
      rest: `76a914${'11'.repeat(20)}88ac`,
    }).toHex()
    const tip = decodeListedBsv21Tip({
      outpoint: deployOut.replace('_', '.'),
      satoshis: 1,
      lockingScript: script,
    })
    expect(tip?.tokenId).toBe(deployOut)
    expect(tip?.amt).toBe('1000')
    expect(tip?.op).toBe('deploy+mint')
    expect(aggregateFungibles([tip!])[0]?.tokenId).toBe(deployOut)
  })
})


describe('decodeListedBsv21Tip remittance-only', () => {
  it('does not accept CI/tags id+amt without a 162 script', () => {
    const tokenId = `${'ab'.repeat(32)}_0`
    expect(
      decodeListedBsv21Tip({
        outpoint: `${'11'.repeat(32)}.0`,
        satoshis: 1,
        lockingScript: `76a914${'11'.repeat(20)}88ac`,
        tags: ['bsv21', `bsv21:${tokenId}`, 'amt:60'],
        customInstructions: JSON.stringify({
          p: 'bsv-20',
          op: 'transfer',
          id: tokenId,
          amt: '60',
        }),
      }),
    ).toBeNull()
  })
})


describe('parseListedOutput remittance-only', () => {
  it('listFungibleTips ignores remittance-only 1-sat', async () => {
    const tips = await listFungibleTips(
      {
        identityKey: '03' + 'aa'.repeat(32),
        wallet: {
          listOutputs: async () => ({
            outputs: [
              {
                outpoint: `${'cd'.repeat(32)}.1`,
                satoshis: 1,
                tags: ['bsv21', `bsv21:${TOKEN_A}`, 'amt:60'],
                customInstructions: JSON.stringify({
                  p: 'bsv-20',
                  op: 'transfer',
                  id: TOKEN_A,
                  amt: '60',
                }),
                lockingScript: `76a914${'11'.repeat(20)}88ac`,
              },
            ],
          }),
        },
      } as never,
      { tokenIds: [TOKEN_A] },
    )
    expect(tips).toEqual([])
  })
})

describe('162 payload icon and colourSupply', () => {
  const P2PKH = `76a914${'11'.repeat(20)}88ac`

  it('deploy 162 with 4-byte payload icon and no CI is live locked with icon outpoint', () => {
    const deployOut = `${'ee'.repeat(32)}_0`
    const script = encodeBsv21Binary({
      amount: 69240n,
      payload: { sym: 'GOLD', dec: 0, icon: Uint8Array.from([1, 0, 0, 0]) },
      rest: P2PKH,
    }).toHex()
    const tip = decodeListedBsv21Tip({
      outpoint: deployOut.replace('_', '.'),
      satoshis: 1,
      lockingScript: script,
    })
    expect(tip).not.toBeNull()
    expect(tip?.colourSupply).toBe('locked')
    expect(tip?.icon).toBe(`${'ee'.repeat(32)}_1`)
    expect(tip?.sym).toBe('GOLD')
    const card = aggregateFungibles([tip!])[0]
    expect(card?.colourSupply).toBe('locked')
    expect(card?.icon).toBe(`${'ee'.repeat(32)}_1`)
    expect(card?.colourMaxSupply).toBe(69240)
  })

  it('deploy 162 with 36-byte payload icon and no CI is live locked', () => {
    const deployOut = `${'ab'.repeat(32)}_0`
    const iconId = `${'ff'.repeat(32)}_3`
    const script = encodeBsv21Binary({
      amount: 100n,
      payload: { sym: 'GOLD', icon: tokenIdToWire(iconId) },
      rest: P2PKH,
    }).toHex()
    const tip = decodeListedBsv21Tip({
      outpoint: deployOut.replace('_', '.'),
      satoshis: 1,
      lockingScript: script,
    })
    expect(tip?.colourSupply).toBe('locked')
    expect(tip?.icon).toBe(iconId)
    const card = aggregateFungibles([tip!])[0]
    expect(card?.colourSupply).toBe('locked')
    expect(card?.icon).toBe(iconId)
  })
})
