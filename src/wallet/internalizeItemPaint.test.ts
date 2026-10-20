import { describe, expect, it } from 'vitest'
import {
  Beef,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { getProvenVerdict, isItemProven, resetProvenCacheForTests } from './provenCache'
import { paintAfterCreateActionIssuance, parseInternalizedItemTips } from './internalizeItemPaint'
import { p2pkhScriptHex } from './ordinalOwnership'
import { clearAppActivity, listRecentActivity } from './appActivity'

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

describe('paintAfterCreateActionIssuance', () => {
  it('keeps each issued output paired with its own collectable name', () => {
    clearAppActivity()
    const address = PrivateKey.fromRandom().toAddress()
    const hex = p2pkhScriptHex(address)

    expect(
      paintAfterCreateActionIssuance(
        { address, chain: 'main' } as never,
        'https://mint.example',
        {
          labels: ['1sat', 'handcash-mint-studio', 'item'],
          outputs: [
            {
              satoshis: 1,
              basket: '1sat',
              lockingScript: hex,
              tags: ['name:Reference Robot'],
            },
            {
              satoshis: 1,
              basket: '1sat',
              lockingScript: hex,
              tags: ['name:Reference Token Icon'],
            },
          ],
        },
        { txid: TXID },
      ),
    ).toBe(2)

    expect(
      listRecentActivity()
        .filter((entry) => entry.txid === TXID)
        .map((entry) => entry.item?.name)
        .sort(),
    ).toEqual(['Reference Robot', 'Reference Token Icon'])
    clearAppActivity()
  })

  it('proves a self-mint from the package it just signed — no indexer walk', () => {
    clearAppActivity()
    resetProvenCacheForTests()
    const key = PrivateKey.fromRandom()
    const address = key.toAddress()
    const p2pkh = p2pkhScriptHex(address)

    const funding = new Transaction()
    funding.addOutput({ satoshis: 10_000, lockingScript: LockingScript.fromHex(p2pkh) })
    const mint = new Transaction()
    mint.addInput({
      sourceTransaction: funding,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    mint.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(ORD_ENVELOPE + p2pkh),
    })
    mint.addOutput({ satoshis: 9_000, lockingScript: LockingScript.fromHex(p2pkh) })
    const beef = new Beef()
    const fundingEntry = beef.mergeRawTx(funding.toBinary())
    fundingEntry.bumpIndex = beef.mergeBump(
      new MerklePath(900_000, [
        [
          { offset: 0, hash: funding.id('hex'), txid: true },
          { offset: 1, duplicate: true },
        ],
      ]),
    )
    beef.mergeRawTx(mint.toBinary())
    const txid = mint.id('hex')

    const painted = paintAfterCreateActionIssuance(
      { address, chain: 'main' } as never,
      'https://mint.example',
      {
        labels: ['1sat', 'handcash-mint-studio', 'item'],
        outputs: [
          { satoshis: 1, basket: '1sat', lockingScript: ORD_ENVELOPE + p2pkh, tags: ['name:Fox'] },
          { satoshis: 9_000, lockingScript: p2pkh },
        ],
      },
      { txid, tx: beef.toBinaryAtomic(txid) },
    )

    expect(painted).toBe(1)
    expect(isItemProven(`${txid}.0`)).toBe(true)
    expect(getProvenVerdict(`${txid}.0`)).toMatchObject({
      tier: 'brc150',
      origin: `${txid}_0`,
      path: [`${txid}_0`],
    })
    clearAppActivity()
    resetProvenCacheForTests()
  })
})

const ORD_ENVELOPE = '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'
