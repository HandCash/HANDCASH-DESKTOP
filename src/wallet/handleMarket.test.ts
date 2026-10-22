import { describe, expect, it, vi } from 'vitest'
import { HandleIssueError, issueHandleCertificate, listHandleIssueGrants, type HandleIssueRequest } from './handleIssuance'
import {
  HANDLE_MARKET_ENABLED,
  HandleMarketError,
  HandleMarketServerError,
  buyHandle,
  resumeHandlePurchases,
  walletHandleMarketDeps,
  type HandleMarketDeps,
  type HandleMarketOrder,
  type HandlePurchase,
} from './handleMarket'

const KEY = '02' + 'a'.repeat(64)
const OTHER = '03' + 'b'.repeat(64)
const ORIGIN = 'handcash.io'
/** The test market's own price list; Desktop never holds one. */
const TEST_PRICES = { 3: 3000, 4: 2000, base: 1000 }
const txidFor = (n: number) => n.toString(16).padStart(64, '0')

function memoryStore() {
  let purchases: HandlePurchase[] = []
  return {
    load: () => purchases.map((p) => ({ ...p })),
    save: (p: HandlePurchase) => {
      purchases = [...purchases.filter((x) => x.orderId !== p.orderId), { ...p }]
    },
    remove: (id: string) => {
      purchases = purchases.filter((x) => x.orderId !== id)
    },
  }
}

function fakeMarket(overrides: Partial<HandleMarketDeps> = {}) {
  let orders = 0
  let tickets = 0
  const order = (handle: string, identityKey: string): HandleMarketOrder => ({
    id: `order-${++orders}`,
    handle,
    identityKey,
    priceSats: handle.length === 3 ? TEST_PRICES[3] : handle.length === 4 ? TEST_PRICES[4] : TEST_PRICES.base,
    payTo: `1PayTo${orders}`,
    state: 'quoted',
    expiresAt: Date.now() + 900_000,
  })
  const deps: HandleMarketDeps = {
    enabled: true,
    sleep: vi.fn(async () => {}),
    activeIdentityKey: () => KEY,
    holderOf: vi.fn(async () => null),
    quote: vi.fn(async (scope) => order(scope.handle, scope.identityKey)),
    confirm: vi.fn(async () => 'allow' as const),
    pay: vi.fn(async () => ({ txid: txidFor(1) })),
    fulfil: vi.fn(async (p: HandlePurchase) => ({
      order: { ...order(p.handle, p.identityKey), id: p.orderId, state: 'paid' as const },
      claimTicket: `ticket${++tickets}.sig`,
    })),
    issue: vi.fn(async (_origin: string, req: HandleIssueRequest) => ({
      handle: req.handle,
      domain: 'handcash.test',
      display: `@${req.handle}@handcash.test`,
      identityKey: req.identityKey,
      certificate: {} as never,
    })),
    store: memoryStore(),
    ...overrides,
  }
  return deps
}

async function refusal(p: Promise<unknown>): Promise<HandleMarketError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(HandleMarketError)
  return err as HandleMarketError
}

describe('handles market purchase', () => {
  it('is off in the shipped wallet, and an off market asks nothing and pays nothing', async () => {
    expect(HANDLE_MARKET_ENABLED).toBe(false)
    expect(walletHandleMarketDeps(() => KEY).enabled).toBe(false)
    const deps = fakeMarket({ enabled: false })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps))).code).toBe('HANDLE_MARKET_OFF')
    expect(deps.holderOf).not.toHaveBeenCalled()
    expect(deps.quote).not.toHaveBeenCalled()
    expect(deps.pay).not.toHaveBeenCalled()
    expect(await resumeHandlePurchases(ORIGIN, deps)).toEqual([])
  })

  it('pays the quoted price for each length: three, four, then five or more', async () => {
    const deps = fakeMarket()
    for (const [handle, sats] of [['abc', 3000], ['abcd', 2000], ['abcde', 1000], ['abcdefghij', 1000]] as const) {
      const result = await buyHandle(ORIGIN, { handle, identityKey: KEY }, deps)
      expect(result.priceSats).toBe(sats)
      expect(deps.pay).toHaveBeenLastCalledWith(expect.objectContaining({ satoshis: sats }))
      expect(deps.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ handle, priceSats: sats }))
    }
  })

  it('checks, shows the price, pays, then issues with the ticket, and keeps nothing once issued', async () => {
    const deps = fakeMarket()
    const calls: string[] = []
    for (const name of ['holderOf', 'quote', 'confirm', 'pay', 'fulfil', 'issue'] as const) {
      const fn = deps[name] as (...args: never[]) => unknown
      ;(deps as Record<string, unknown>)[name] = vi.fn((...args: never[]) => {
        calls.push(name)
        return fn(...args)
      })
    }
    const result = await buyHandle(ORIGIN, { handle: '$Alice', identityKey: KEY.toUpperCase() }, deps)
    expect(calls).toEqual(['holderOf', 'quote', 'confirm', 'pay', 'fulfil', 'issue'])
    expect(deps.pay).toHaveBeenCalledWith({ to: '1PayTo1', satoshis: 1000, description: expect.stringContaining('@alice@') })
    expect(deps.issue).toHaveBeenCalledWith(ORIGIN, { handle: 'alice', identityKey: KEY, claimTicket: 'ticket1.sig' })
    expect(result).toMatchObject({ handle: 'alice', identityKey: KEY, txid: txidFor(1), issued: { handle: 'alice' } })
    expect(deps.store.load()).toEqual([])
  })

  it('refuses a handle shorter than three characters before quoting or paying', async () => {
    const deps = fakeMarket()
    for (const handle of ['ab', 'a']) {
      expect((await refusal(buyHandle(ORIGIN, { handle, identityKey: KEY }, deps))).code).toBe('HANDLE_MARKET_TOO_SHORT')
    }
    expect((await refusal(buyHandle(ORIGIN, { handle: 'no spaces', identityKey: KEY }, deps))).code).toBe('HANDLE_MARKET_INVALID')
    expect(deps.quote).not.toHaveBeenCalled()
    expect(deps.pay).not.toHaveBeenCalled()
  })

  it('refuses a taken handle, one this key holds, and one the market reports taken or reserved, without paying', async () => {
    const taken = fakeMarket({ holderOf: vi.fn(async () => OTHER) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'taken', identityKey: KEY }, taken))).code).toBe('HANDLE_MARKET_TAKEN')
    expect(taken.quote).not.toHaveBeenCalled()

    const held = fakeMarket({ holderOf: vi.fn(async () => KEY) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'mine', identityKey: KEY }, held))).code).toBe('HANDLE_MARKET_HELD')

    for (const code of ['handle-taken', 'handle-reserved']) {
      const raced = fakeMarket({ quote: vi.fn(async () => { throw new HandleMarketServerError(code, 409) }) })
      expect((await refusal(buyHandle(ORIGIN, { handle: 'raced', identityKey: KEY }, raced))).code).toBe('HANDLE_MARKET_TAKEN')
      expect(raced.pay).not.toHaveBeenCalled()
    }
    const short = fakeMarket({ quote: vi.fn(async () => { throw new HandleMarketServerError('handle-too-short', 400) }) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, short))).code).toBe('HANDLE_MARKET_TOO_SHORT')
    const unpriced = fakeMarket({ quote: vi.fn(async () => { throw new HandleMarketServerError('market-unpriced', 503) }) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, unpriced))).code).toBe('HANDLE_MARKET_UNPRICED')
    const off = fakeMarket({ quote: vi.fn(async () => { throw new HandleMarketServerError('handle-market-off', 404) }) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, off))).code).toBe('HANDLE_MARKET_OFF')
  })

  it('refuses a key the wallet is not signing with, before and after the price prompt', async () => {
    const deps = fakeMarket({ activeIdentityKey: () => OTHER })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps))).code).toBe('HANDLE_MARKET_WRONG_KEY')
    expect(deps.quote).not.toHaveBeenCalled()

    let active = KEY
    const switched = fakeMarket({
      activeIdentityKey: () => active,
      confirm: vi.fn(async () => {
        active = OTHER
        return 'allow' as const
      }),
    })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, switched))).code).toBe('HANDLE_MARKET_WRONG_KEY')
    expect(switched.pay).not.toHaveBeenCalled()
  })

  it('pays nothing when the price is refused or the quote does not match the request', async () => {
    const refused = fakeMarket({ confirm: vi.fn(async () => 'deny' as const) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, refused))).code).toBe('HANDLE_MARKET_REFUSED')
    expect(refused.pay).not.toHaveBeenCalled()

    for (const bad of [{ handle: 'other' }, { identityKey: OTHER }, { priceSats: 0 }, { priceSats: 1.5 }, { payTo: '' }]) {
      const deps = fakeMarket()
      const quote = deps.quote
      deps.quote = vi.fn(async (scope) => ({ ...(await quote(scope)), ...bad }))
      expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps))).code).toBe('HANDLE_MARKET_UNAVAILABLE')
      expect(deps.confirm).not.toHaveBeenCalled()
      expect(deps.pay).not.toHaveBeenCalled()
    }
  })

  it('a failed payment issues nothing and leaves nothing to resume', async () => {
    const deps = fakeMarket({ pay: vi.fn(async () => { throw new Error('Insufficient funds') }) })
    const err = await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps))
    expect(err.code).toBe('HANDLE_MARKET_PAYMENT_FAILED')
    expect(err.message).toContain('Insufficient funds')
    expect(err.purchase).toBeUndefined()
    expect(deps.fulfil).not.toHaveBeenCalled()
    expect(deps.issue).not.toHaveBeenCalled()
    expect(deps.store.load()).toEqual([])
  })

  it('an issuance that fails on its ticket asks for a fresh ticket and pays once', async () => {
    const deps = fakeMarket()
    const issue = deps.issue
    deps.issue = vi
      .fn()
      .mockRejectedValueOnce(new HandleIssueError('HANDLE_ISSUE_TICKET_REJECTED', 'expired', 'ticket-expired'))
      .mockRejectedValueOnce(new HandleIssueError('HANDLE_ISSUE_FAILED', 'reply lost'))
      .mockImplementation(issue)
    const result = await buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps)
    expect(result.issued?.handle).toBe('abc')
    expect(deps.pay).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.issue).mock.calls.map((c) => c[1].claimTicket)).toEqual(['ticket1.sig', 'ticket2.sig', 'ticket3.sig'])
    expect(deps.store.load()).toEqual([])
  })

  it('a lost reply after the handle was bound ends as issued, without paying or claiming again', async () => {
    const deps = fakeMarket()
    deps.issue = vi.fn().mockRejectedValueOnce(new HandleIssueError('HANDLE_ISSUE_FAILED', 'reply lost'))
    const fulfil = deps.fulfil
    deps.fulfil = vi
      .fn()
      .mockImplementationOnce(fulfil)
      .mockImplementation(async (p: HandlePurchase) => ({ order: { ...(await fulfil(p)).order, state: 'issued' } }))
    const result = await buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps)
    expect(result.issued).toBeNull()
    expect(deps.issue).toHaveBeenCalledTimes(1)
    expect(deps.pay).toHaveBeenCalledTimes(1)
    expect(deps.store.load()).toEqual([])
  })

  it('a handle taken after payment becomes a refund the market owes, kept for the user to see', async () => {
    const deps = fakeMarket()
    deps.issue = vi.fn(async () => {
      throw new HandleIssueError('HANDLE_ISSUE_TAKEN', 'taken', 'handle-taken')
    })
    const fulfil = deps.fulfil
    deps.fulfil = vi
      .fn()
      .mockImplementationOnce(fulfil)
      .mockImplementation(async (p: HandlePurchase) => ({
        order: { ...(await fulfil(p)).order, state: 'refund-owed', refundReason: 'handle-taken' },
      }))
    const err = await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps))
    expect(err.code).toBe('HANDLE_MARKET_REFUND_OWED')
    expect(err.purchase).toMatchObject({ state: 'refund-owed', refundReason: 'handle-taken', txid: txidFor(1) })
    expect(deps.store.load()).toEqual([expect.objectContaining({ state: 'refund-owed' })])
    expect(await resumeHandlePurchases(ORIGIN, deps)).toEqual([])
  })

  it('when issuance keeps failing the paid purchase is kept, and resuming finishes it without paying again', async () => {
    const deps = fakeMarket()
    const issue = deps.issue
    deps.issue = vi.fn(async () => {
      throw new HandleIssueError('HANDLE_ISSUE_FAILED', 'HandCash is down')
    })
    const err = await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps))
    expect(err.code).toBe('HANDLE_MARKET_ISSUE_PENDING')
    expect(err.purchase).toMatchObject({ state: 'paid', txid: txidFor(1) })
    expect(deps.issue).toHaveBeenCalledTimes(4)
    expect(deps.sleep).toHaveBeenCalledTimes(3)

    deps.issue = vi.fn(issue)
    const [outcome] = await resumeHandlePurchases(ORIGIN, deps)
    expect(outcome).toMatchObject({ ok: true, result: { handle: 'abc', txid: txidFor(1) } })
    expect(deps.pay).toHaveBeenCalledTimes(1)
    expect(deps.store.load()).toEqual([])
  })

  it('buying a handle already paid for finishes that purchase instead of paying twice', async () => {
    const deps = fakeMarket({ fulfil: vi.fn(async () => { throw new TypeError('Failed to fetch') }) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps))).code).toBe('HANDLE_MARKET_ISSUE_PENDING')
    const healthy = fakeMarket({ store: deps.store, pay: deps.pay })
    const result = await buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, healthy)
    expect(result.orderId).toBe('order-1')
    expect(deps.pay).toHaveBeenCalledTimes(1)
    expect(healthy.quote).not.toHaveBeenCalled()
  })

  it('stops asking at a final refusal or an issuance only the user can fix, and keeps the purchase', async () => {
    const refused = fakeMarket({ fulfil: vi.fn(async () => { throw new HandleMarketServerError('payment-not-to-order', 400) }) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, refused))).code).toBe('HANDLE_MARKET_ISSUE_PENDING')
    expect(refused.fulfil).toHaveBeenCalledTimes(1)
    expect(refused.store.load()).toEqual([expect.objectContaining({ state: 'paid' })])

    const locked = fakeMarket({ issue: vi.fn(async () => { throw new HandleIssueError('HANDLE_ISSUE_WRONG_KEY', 'locked') }) })
    expect((await refusal(buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, locked))).code).toBe('HANDLE_MARKET_ISSUE_PENDING')
    expect(locked.issue).toHaveBeenCalledTimes(1)
  })

  it('waits out a payment the market has not seen yet', async () => {
    const deps = fakeMarket()
    const fulfil = deps.fulfil
    deps.fulfil = vi
      .fn()
      .mockRejectedValueOnce(new HandleMarketServerError('payment-not-found', 409))
      .mockImplementation(fulfil)
    expect((await buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps)).issued?.handle).toBe('abc')
    expect(deps.sleep).toHaveBeenCalledTimes(1)
  })

  it('resumes only purchases of the account signing now', async () => {
    const deps = fakeMarket({ activeIdentityKey: () => OTHER })
    deps.store.save({ orderId: 'order-9', handle: 'abc', identityKey: KEY, priceSats: 1, payTo: '1X', state: 'paid', txid: txidFor(9) })
    expect(await resumeHandlePurchases(ORIGIN, deps)).toEqual([])
    expect(deps.fulfil).not.toHaveBeenCalled()
  })

  it('issues through the issueHandle grant, approved by the price prompt and used once', async () => {
    const claimed: HandleIssueRequest[] = []
    const deps = fakeMarket({
      issue: (origin, request) =>
        issueHandleCertificate(origin, request, {
          now: Date.now,
          activeIdentityKey: () => KEY,
          approve: async (_o, scope) => (scope.handle === request.handle ? 'allow' : 'deny'),
          prepare: async () => async (req) => {
            claimed.push(req)
            return { handle: req.handle, domain: 'handcash.test', display: '', identityKey: req.identityKey, certificate: {} as never }
          },
        }),
    })
    await buyHandle(ORIGIN, { handle: 'abc', identityKey: KEY }, deps)
    expect(claimed).toEqual([{ handle: 'abc', identityKey: KEY, claimTicket: 'ticket1.sig' }])
    expect(listHandleIssueGrants()).toEqual([])
  })
})
