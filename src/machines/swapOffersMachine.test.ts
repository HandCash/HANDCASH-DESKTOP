import { describe, expect, it } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import { createChartCache } from '@aeon-ui/primitives'
import { swapOffersMachine } from './swapOffersMachine'
import type { SignedSwapOffer } from '../wallet/swap/offer'
import type { OfferBookPage } from '../wallet/swap/offerBook'

const SELF = `02${'a'.repeat(64)}`
const OTHER = `03${'b'.repeat(64)}`

const offer = (nonce: string, maker: string) =>
  ({ v: 1, maker, give: 'ltc', get: 'bsv', price: { give: '1', get: '1' }, minGet: '1000', maxGet: '1000', createdAt: 0, expiresAt: Date.now() + 3_600_000, nonce, sig: '' }) as unknown as SignedSwapOffer

const page = (...offers: SignedSwapOffer[]): OfferBookPage => ({ offers, filled: new Map() })

function bookCache(loads: Array<() => Promise<OfferBookPage>>) {
  let n = 0
  const cache = createChartCache<OfferBookPage>({ id: 'swap-offer-book', load: () => loads[Math.min(n++, loads.length - 1)]!(), ttl: 60_000 })
  return { cache, loads: () => n }
}

function chart(cache: ReturnType<typeof bookCache>['cache'], cancel: (nonce: string) => Promise<void> = async () => {}) {
  const machine = swapOffersMachine.provide({ actors: { book: cache.actor, cancel: fromPromise(({ input }) => cancel(input)) } })
  return createActor(machine, { input: { self: SELF, key: `${SELF}:main` } }).start()
}

describe('swapOffersMachine', () => {
  it('serves a reopened book from the cache without downloading and verifying it again', async () => {
    const { cache, loads } = bookCache([async () => page(offer('n1', OTHER))])
    const first = chart(cache)
    await waitFor(first, (s) => s.matches('ready'))
    first.stop()

    const second = chart(cache)
    expect(second.getSnapshot().matches('ready')).toBe(true)
    expect(second.getSnapshot().context.offers.map((o) => o.nonce)).toEqual(['n1'])
    expect(loads()).toBe(1)
  })

  it('drops a withdrawn offer at once and does not bring it back while the book revalidates', async () => {
    let release!: (book: OfferBookPage) => void
    const { cache, loads } = bookCache([async () => page(offer('mine', SELF), offer('n1', OTHER)), () => new Promise((resolve) => (release = resolve))])
    const actor = chart(cache)
    await waitFor(actor, (s) => s.matches('ready'))

    actor.send({ type: 'CANCEL', nonce: 'mine' })
    await waitFor(actor, (s) => s.matches('ready') && s.context.cache === 'refreshing')
    expect(actor.getSnapshot().context.offers.map((o) => o.nonce)).toEqual(['n1'])

    release(page(offer('n1', OTHER), offer('n2', OTHER)))
    await waitFor(actor, (s) => s.context.cache === 'ready')
    expect(actor.getSnapshot().context.offers.map((o) => o.nonce)).toEqual(['n1', 'n2'])
    expect(loads()).toBe(2)
  })

  it('names why the book is unavailable and recovers on refresh', async () => {
    const { cache } = bookCache([async () => Promise.reject(new Error('offer book unavailable: 503')), async () => page()])
    const actor = chart(cache)
    await waitFor(actor, (s) => s.matches('failed'))
    expect(actor.getSnapshot().context.failure).toBe('offer book unavailable: 503')

    actor.send({ type: 'REFRESH' })
    await waitFor(actor, (s) => s.matches('ready'))
    expect(actor.getSnapshot().context.failure).toBeNull()
  })

  it('ignores updates for another account\'s book', async () => {
    const { cache } = bookCache([async () => page(offer('n1', OTHER))])
    const actor = chart(cache)
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'CACHE.UPDATE', cache: 'swap-offer-book', key: 'someone:main', view: { state: 'ready', data: page(), error: null, loadedAt: 1 } })
    expect(actor.getSnapshot().context.offers.map((o) => o.nonce)).toEqual(['n1'])
  })
})
