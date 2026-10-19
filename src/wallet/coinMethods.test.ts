import { describe, expect, it } from 'vitest'
import { listAssetProfiles } from './assetProfiles'
import type { CoinWalletReport } from './coins/coinWallet'
import { coinChainOf, coinPaymentArgs, listCoinsFromReport, sendCoinsChain, sendCoinsResponseAsWithdrawLtc, sendCoinsResult, withdrawLtcAsSendCoins } from './coinMethods'
import { depositCount } from './coins/depositPhase'

describe('BRC-213 coin methods', () => {
  it('names only the chains the wallet holds, and never BSV', () => {
    expect(coinChainOf({ chain: 'ltc' })).toBe('ltc')
    expect(coinChainOf({ chain: 'bch' })).toBe('bch')
    expect(coinChainOf({ chain: 'btc' })).toBe('btc')
    expect(coinChainOf({ chain: 'doge' })).toBe('doge')
    expect(() => coinChainOf({ chain: 'bsv' })).toThrow(expect.objectContaining({ code: 'COIN_UNSUPPORTED_CHAIN' }))
    expect(() => coinChainOf({})).toThrow(expect.objectContaining({ code: 'COIN_UNSUPPORTED_CHAIN' }))
  })

  it('refuses an unknown chain before any gate, and reads the payment in the engine\'s terms', () => {
    const refused = sendCoinsChain({ chain: 'eth', address: '0x…', amount: '1' })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && JSON.parse(refused.body).code).toBe('COIN_UNSUPPORTED_CHAIN')
    expect(sendCoinsChain({ chain: 'bch' })).toEqual({ ok: true, chain: 'bch' })
    expect(coinPaymentArgs({ chain: 'bch', address: 'bitcoincash:q', amount: '546' })).toEqual({ address: 'bitcoincash:q', litoshi: '546' })
  })

  it('runs withdrawLtc as sendCoins on Litecoin and answers it in its own shape', () => {
    expect(withdrawLtcAsSendCoins({ address: 'ltc1qx', litoshi: '300000', description: 'Credits' })).toEqual({
      chain: 'ltc',
      address: 'ltc1qx',
      amount: '300000',
      description: 'Credits',
    })
    const sent = sendCoinsResponseAsWithdrawLtc({
      status: 200,
      body: JSON.stringify(sendCoinsResult('ltc', { ltcTxid: 'ab'.repeat(32), litoshi: '300000', fee: '282', status: 'queued' })),
    })
    expect(JSON.parse(sent.body)).toEqual({ ltcTxid: 'ab'.repeat(32), litoshi: '300000', fee: '282', status: 'queued' })
    const refused = sendCoinsResponseAsWithdrawLtc({
      status: 400,
      body: JSON.stringify({ status: 'error', code: 'COIN_OWN_ADDRESS', description: 'own' }),
    })
    expect(JSON.parse(refused.body).code).toBe('LTC_OWN_ADDRESS')
    const denied = { status: 403, body: JSON.stringify({ status: 'error', code: 'ACTION_DENIED' }) }
    expect(sendCoinsResponseAsWithdrawLtc(denied)).toBe(denied)
  })

  it('answers sendCoins with generic fields', () => {
    expect(sendCoinsResult('bch', { ltcTxid: 'cd'.repeat(32), litoshi: '1000', fee: '226', status: 'sent' })).toEqual({
      chain: 'bch',
      txid: 'cd'.repeat(32),
      amount: '1000',
      fee: '226',
      status: 'sent',
    })
  })

  it('lists coins in BRC-213 states: spendable once buried, confirming with its count, change once sent', () => {
    const report: CoinWalletReport = {
      address: 'ltc1qme',
      balance: { spendable: '700000', confirming: '500000' },
      coins: [
        { txid: '01'.repeat(32), vout: 0, litoshi: '500000', source: 'received', spent: false,
          phase: { kind: 'confirming', confirmations: 3, needed: 6, height: 9, checkedAt: 1 } },
        { txid: '02'.repeat(32), vout: 1, litoshi: '700000', source: 'change', spent: false, phase: { kind: 'movable' } },
      ],
      payments: [{ ltcTxid: '02'.repeat(32), address: 'ltc1qx', litoshi: '300000', fee: '282', status: 'sent', confirmed: false }],
    }
    expect(listCoinsFromReport('ltc', report, (phase) => depositCount('ltc', phase))).toEqual({
      chain: 'ltc',
      address: 'ltc1qme',
      spendable: '700000',
      confirming: '500000',
      coins: [
        { txid: '01'.repeat(32), vout: 0, amount: '500000', source: 'received', state: 'confirming', confirmations: 3, needed: 6, spent: false },
        { txid: '02'.repeat(32), vout: 1, amount: '700000', source: 'change', state: 'spendable', needed: 6, spent: false },
      ],
      payments: [{ txid: '02'.repeat(32), address: 'ltc1qx', amount: '300000', fee: '282', status: 'sent', confirmed: false }],
    })
  })
})

describe('BRC-214 asset profiles', () => {
  it('lists every profile once, coins in the payment scope and assets per action', () => {
    const { profiles } = listAssetProfiles()
    expect(profiles.map((p) => p.id)).toEqual(['bsv', 'coin:ltc', 'coin:bch', 'coin:btc', 'coin:doge', '1sat', 'p2pft', 'csft', 'csnft'])
    expect(profiles.filter((p) => p.scope === 'payment').map((p) => p.id)).toEqual(['bsv', 'coin:ltc', 'coin:bch', 'coin:btc', 'coin:doge'])
    expect(profiles.find((p) => p.id === 'coin:bch')).toMatchObject({ chain: 'bch', decimals: 8, minConfirmations: 6 })
    expect(profiles.find((p) => p.id === 'coin:btc')).toMatchObject({ chain: 'btc', decimals: 8, minConfirmations: 3 })
    expect(profiles.find((p) => p.id === 'coin:doge')).toMatchObject({ chain: 'doge', decimals: 8, minConfirmations: 20 })
  })
})
