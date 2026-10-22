import { describe, expect, it } from 'vitest'
import { SpendLedger, UNCLAIMED_SPEND_TTL_MS, spendRequestKey, type BridgeReply } from './spendLedger.js'

const PAID: BridgeReply = { status: 200, body: '{"txid":"aa"}' }
const key = spendRequestKey('shop.example', '/createAction', '{"outputs":[1]}')

describe('spend ledger', () => {
  it('joins a retry of a timed-out spend to the run still in the wallet', async () => {
    const ledger = new SpendLedger()
    expect(ledger.begin(key, 1).kind).toBe('dispatch')
    ledger.orphan(1)

    const retry = ledger.begin(key, 2)
    expect(retry.kind).toBe('join')
    ledger.settle(1, PAID)
    expect(retry.kind === 'join' && (await retry.reply)).toEqual(PAID)

    expect(ledger.begin(key, 3).kind).toBe('dispatch')
  })

  it('answers a retry after the timed-out spend landed with that payment, once', () => {
    const ledger = new SpendLedger()
    ledger.begin(key, 1)
    ledger.orphan(1)
    ledger.settle(1, PAID)

    expect(ledger.begin(key, 2)).toEqual({ kind: 'replay', reply: PAID })
    expect(ledger.begin(key, 3).kind).toBe('dispatch')
  })

  it('lets a deliberate repeat pay again once the first caller got its answer', () => {
    const ledger = new SpendLedger()
    ledger.begin(key, 1)
    ledger.settle(1, PAID)
    ledger.done(1)
    expect(ledger.begin(key, 2).kind).toBe('dispatch')
  })

  it('joins a duplicate sent while the first is still running', async () => {
    const ledger = new SpendLedger()
    ledger.begin(key, 1)
    const dup = ledger.begin(key, 2)
    ledger.settle(1, PAID)
    ledger.done(1)
    expect(dup.kind === 'join' && (await dup.reply)).toEqual(PAID)
  })

  it('keeps different requests apart', () => {
    const ledger = new SpendLedger()
    ledger.begin(key, 1)
    expect(ledger.begin(spendRequestKey('other.example', '/createAction', '{"outputs":[1]}'), 2).kind).toBe('dispatch')
    expect(ledger.begin(spendRequestKey('shop.example', '/createAction', '{"outputs":[2]}'), 3).kind).toBe('dispatch')
  })

  it('tells every retry the outcome is unknown when the wallet stopped mid-spend', async () => {
    const ledger = new SpendLedger()
    const unknown: BridgeReply = { status: 503, body: '{"code":"WALLET_BRIDGE_PENDING"}' }
    ledger.begin(key, 1)
    const waiting = ledger.begin(key, 2)
    ledger.loseAll(unknown)
    expect(waiting.kind === 'join' && (await waiting.reply)).toEqual(unknown)
    expect(ledger.begin(key, 3)).toEqual({ kind: 'replay', reply: unknown })
    expect(ledger.begin(key, 4)).toEqual({ kind: 'replay', reply: unknown })
  })

  it('forgets an unclaimed run after its time', () => {
    let now = 0
    const ledger = new SpendLedger(() => now)
    ledger.begin(key, 1)
    ledger.orphan(1)
    ledger.settle(1, PAID)
    now = UNCLAIMED_SPEND_TTL_MS + 1
    expect(ledger.begin(key, 2).kind).toBe('dispatch')
  })
})
