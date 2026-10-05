import { P2PKH, PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))

import { chooseTokenTip } from './tokenSweep'
import { ordEnvelopeHex } from '../ordScriptPush'

const key = PrivateKey.fromRandom()
const lock = new P2PKH().lock(key.toPublicKey().toAddress()).toHex()
const TXID = 'ab'.repeat(32)
const ID = `${'cd'.repeat(32)}_0`

function tokenScript(json: Record<string, string>, layout: 'p2pkh-first' | 'envelope-first' = 'p2pkh-first') {
  const envelope = ordEnvelopeHex('application/bsv-20', new TextEncoder().encode(JSON.stringify(json)))
  return layout === 'p2pkh-first' ? lock + envelope : envelope + lock
}

const indexed = (patch: Partial<Parameters<typeof chooseTokenTip>[0]['indexed']> = {}) => ({
  txid: TXID,
  vout: 1,
  satoshis: 1,
  amt: '500',
  status: 1,
  listing: false,
  spend: '',
  ...patch,
})

describe('chooseTokenTip', () => {
  const transfer = { p: 'bsv-20', op: 'transfer', id: ID, amt: '500' }

  it.each(['p2pkh-first', 'envelope-first'] as const)('moves a valid tip (%s)', (layout) => {
    expect(
      chooseTokenTip({
        indexed: indexed(),
        tokenId: ID,
        lockingScriptHex: tokenScript(transfer, layout),
        satoshis: 1,
        spendLockHex: lock,
      }),
    ).toEqual({ kind: 'move', tip: { outpoint: `${TXID}.1`, txid: TXID, vout: 1, amt: 500n } })
  })

  it('holds what the indexer has not validated — one bad input burns the transfer', () => {
    const base = { tokenId: ID, lockingScriptHex: tokenScript(transfer), satoshis: 1, spendLockHex: lock }
    expect(chooseTokenTip({ ...base, indexed: indexed({ status: 0 }) })).toEqual({ kind: 'hold', reason: 'tokenPending' })
    expect(chooseTokenTip({ ...base, indexed: indexed({ status: -1 }) })).toEqual({ kind: 'hold', reason: 'tokenInvalid' })
    expect(chooseTokenTip({ ...base, indexed: indexed({ listing: true }) })).toEqual({ kind: 'hold', reason: 'listed' })
  })

  it('holds a tip whose script disagrees with the indexer', () => {
    const base = { indexed: indexed(), tokenId: ID, satoshis: 1, spendLockHex: lock }
    expect(chooseTokenTip({ ...base, lockingScriptHex: tokenScript({ ...transfer, amt: '501' }) }).kind).toBe('hold')
    expect(chooseTokenTip({ ...base, lockingScriptHex: tokenScript({ ...transfer, id: `${'ef'.repeat(32)}_0` }) }).kind).toBe('hold')
    expect(chooseTokenTip({ ...base, lockingScriptHex: null })).toEqual({ kind: 'hold', reason: 'tokenUnreadable' })
    expect(chooseTokenTip({ ...base, satoshis: 2, lockingScriptHex: tokenScript(transfer) }).kind).toBe('hold')
  })

  it('holds a tip locked to another key or cosigned', () => {
    const other = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex()
    const base = { indexed: indexed(), tokenId: ID, satoshis: 1 }
    expect(chooseTokenTip({ ...base, lockingScriptHex: tokenScript(transfer), spendLockHex: other })).toEqual({
      kind: 'hold',
      reason: 'foreign',
    })
    const envelope = ordEnvelopeHex('application/bsv-20', new TextEncoder().encode(JSON.stringify(transfer)))
    const cosigned = `${envelope}76a914${'11'.repeat(20)}88ad21${'02' + '22'.repeat(32)}ac`
    expect(chooseTokenTip({ ...base, lockingScriptHex: cosigned, spendLockHex: lock })).toEqual({
      kind: 'hold',
      reason: 'cosigned',
    })
  })

  it('accepts a deploy+mint output as its own id', () => {
    const selfId = `${TXID}_1`
    expect(
      chooseTokenTip({
        indexed: indexed(),
        tokenId: selfId,
        lockingScriptHex: tokenScript({ p: 'bsv-20', op: 'deploy+mint', amt: '500', sym: 'X' }),
        satoshis: 1,
        spendLockHex: lock,
      }).kind,
    ).toBe('move')
  })
})
