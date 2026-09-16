import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import {
  paintAfterCreateActionBsv21Mint,
  paintAfterCreateActionIssuance,
  paintAfterInternalizeBsv21,
  parseInternalizedItemTips,
} from './internalizeItemPaint'
import {
  clearFungiblesCache,
  encodeBsv21Binary,
  getCachedFungibles,
} from './token'
import { p2pkhScriptHex } from './ordinalOwnership'

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

describe('paintAfterCreateActionIssuance', () => {
  it('paints a 162 mint in basket 1sat onto Tokens, not Collect', () => {
    clearFungiblesCache()
    const address = PrivateKey.fromRandom().toAddress()
    const hex = encodeBsv21Binary({
      amount: 11111111111n,
      payload: {},
      rest: p2pkhScriptHex(address),
    }).toHex()
    const painted = paintAfterCreateActionIssuance(
      { address, chain: 'main' } as never,
      'https://mint.example',
      {
        labels: ['1sat', 'handcash-mint-studio', 'item'],
        outputs: [
          {
            satoshis: 1,
            basket: '1sat',
            lockingScript: hex,
          },
        ],
      },
      { txid: TXID },
    )
    expect(painted).toBe(1)
    expect(getCachedFungibles()).toMatchObject([
      {
        tokenId: `${TXID}_0`,
        amt: '11111111111',
        outpoint: `${TXID}.0`,
      },
    ])
    expect(getCachedFungibles()[0]?.sym).not.toBe('Collectable')
    // A binary tip must paint as sendable BSV-21, never "Legacy — burn only".
    expect(getCachedFungibles()[0]?.binarySupply).toBe('locked')
    clearFungiblesCache()
  })
})

describe('paintAfterCreateActionBsv21Mint', () => {
  it('paints JSON deploy+mint from local scripts without waiting on listOutputs', () => {
    clearFungiblesCache()
    const address = PrivateKey.fromRandom().toAddress()
    const rest = p2pkhScriptHex(address)
    const payload = {
      p: 'bsv-20',
      op: 'deploy+mint',
      sym: 'LAB',
      amt: '5000',
      dec: '0',
    }
    const mime = 'application/bsv-20'
    const mimeHex = Array.from(new TextEncoder().encode(mime))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const bodyHex = Array.from(new TextEncoder().encode(JSON.stringify(payload)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const mimeLen = (mimeHex.length / 2).toString(16).padStart(2, '0')
    const bodyLen = bodyHex.length / 2
    const bodyPush =
      bodyLen < 76
        ? bodyLen.toString(16).padStart(2, '0') + bodyHex
        : '4c' + bodyLen.toString(16).padStart(2, '0') + bodyHex
    const hex =
      '0063036f726451' + mimeLen + mimeHex + '00' + bodyPush + '68' + rest

    const painted = paintAfterCreateActionBsv21Mint(
      { address, chain: 'main' } as never,
      'https://mint.example',
      {
        outputs: [
          {
            satoshis: 1,
            basket: 'bsv21',
            lockingScript: hex,
            tags: ['bsv21', 'op:deploy+mint', 'sym:LAB', 'amt:5000'],
            customInstructions: JSON.stringify(payload),
          },
        ],
      },
      { txid: TXID },
    )

    expect(painted).toBe(1)
    expect(getCachedFungibles()).toMatchObject([
      {
        tokenId: `${TXID}_0`,
        amt: '5000',
        sym: 'LAB',
        outpoint: `${TXID}.0`,
      },
    ])
    clearFungiblesCache()
  })
})
