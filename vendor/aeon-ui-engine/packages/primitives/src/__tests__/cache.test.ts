import { assign, createActor, sendTo, setup, waitFor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChartCache, isCacheableId, type CacheUpdate, type CacheView } from '../machines/cache.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createChartCache', () => {
  afterEach(() => vi.useRealTimers())

  it('runs one load for every caller while it is in flight', async () => {
    const pending = deferred<string[]>()
    const load = vi.fn(() => pending.promise)
    const cache = createChartCache({ id: 'items', load, ttl: 1000 })

    const reads = [cache.read('a'), cache.read('a')]
    cache.fetch('a')
    expect(cache.peek('a').state).toBe('loading')
    pending.resolve(['x'])

    expect(await Promise.all(reads)).toEqual([['x'], ['x']])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('serves a fresh entry from memory and goes stale after its time-to-live', async () => {
    vi.useFakeTimers()
    let n = 0
    const cache = createChartCache({ id: 'items', load: async () => ++n, ttl: (key: string) => (key === 'short' ? 100 : 1000) })

    expect(await cache.read('short')).toBe(1)
    expect(await cache.read('long')).toBe(2)
    cache.fetch('short')
    expect(n).toBe(2)

    vi.advanceTimersByTime(100)
    expect(cache.peek('short').state).toBe('stale')
    expect(cache.peek('long').state).toBe('ready')
  })

  it('serves stale data at once while it revalidates', async () => {
    vi.useFakeTimers()
    const second = deferred<string>()
    const loads = [async () => 'old', () => second.promise]
    let n = 0
    const cache = createChartCache({ id: 'items', load: () => loads[n++]!(), ttl: 50 })

    expect(await cache.read('a')).toBe('old')
    vi.advanceTimersByTime(50)
    expect(await cache.read('a')).toBe('old')
    expect(cache.peek('a')).toMatchObject({ state: 'refreshing', data: 'old' })

    vi.useRealTimers()
    second.resolve('new')
    await flush()
    expect(cache.peek('a')).toMatchObject({ state: 'ready', data: 'new' })
  })

  it('revalidates an expired entry even when its timer has not fired', async () => {
    let now = 0
    let n = 0
    const cache = createChartCache({ id: 'items', load: async () => ++n, ttl: 100, now: () => now })
    await cache.read('a')
    now = 150
    cache.fetch('a')
    expect(cache.peek('a').state).toBe('refreshing')
  })

  it('invalidates by key and by tag, reloading only entries someone watches', async () => {
    let n = 0
    const cache = createChartCache({ id: 'items', load: async (key: string) => `${key}${++n}`, ttl: 60_000, tags: (key) => (key.startsWith('w1') ? ['wallet:w1'] : []) })
    await cache.read('w1:a')
    await cache.read('w1:b')
    await cache.read('w2:a')
    const seen: CacheView<string>[] = []
    const stop = cache.subscribe('w1:a', (view) => seen.push(view))

    cache.invalidate({ tag: 'wallet:w1' })
    expect(cache.peek('w1:a').state).toBe('refreshing')
    expect(cache.peek('w1:b').state).toBe('stale')
    expect(cache.peek('w2:a').state).toBe('ready')
    await vi.waitFor(() => expect(cache.peek('w1:a').state).toBe('ready'))
    expect(seen.map((v) => v.state)).toEqual(['refreshing', 'ready'])

    stop()
    cache.invalidate({ key: 'w2:a' })
    expect(cache.peek('w2:a').state).toBe('stale')
  })

  it('loads once more when invalidated mid-load, since the result may predate the write', async () => {
    const first = deferred<number>()
    const loads = [() => first.promise, async () => 2]
    let n = 0
    const cache = createChartCache({ id: 'items', load: () => loads[n++]!(), ttl: 60_000 })
    cache.fetch('a')
    cache.invalidate({ key: 'a' })
    first.resolve(1)
    await vi.waitFor(() => expect(cache.peek('a')).toMatchObject({ state: 'ready', data: 2 }))
    expect(n).toBe(2)
  })

  it('fails with a reason, keeps stale data when a refresh fails, and recovers', async () => {
    const results: Array<() => Promise<string>> = [
      async () => Promise.reject(new Error('offline')),
      async () => 'ok',
      async () => Promise.reject(new Error('timeout')),
    ]
    let n = 0
    const cache = createChartCache({ id: 'items', load: () => results[n++]!(), ttl: 60_000 })

    await expect(cache.read('a')).rejects.toThrow('offline')
    expect(cache.peek('a')).toMatchObject({ state: 'failed', error: 'offline', data: undefined })

    expect(await cache.read('a')).toBe('ok')
    cache.refresh('a')
    await vi.waitFor(() => expect(cache.peek('a').state).toBe('stale'))
    expect(cache.peek('a')).toMatchObject({ data: 'ok', error: 'timeout' })
  })

  it('clear drops data and cancels a running load so its result never lands', async () => {
    const pending = deferred<string>()
    const signals: AbortSignal[] = []
    const cache = createChartCache({
      id: 'items',
      load: (_key: string, { signal }) => {
        signals.push(signal)
        return pending.promise
      },
      ttl: 60_000,
    })
    const stop = cache.subscribe('a', () => {})
    cache.fetch('a')
    cache.clear()
    pending.resolve('late')
    await flush()
    expect(cache.peek('a')).toMatchObject({ state: 'idle', data: undefined })
    expect(signals[0]!.aborted).toBe(true)
    stop()
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('hands out the same view and data until the entry changes', async () => {
    vi.useFakeTimers()
    const list = [{ id: 1 }]
    const cache = createChartCache({ id: 'items', load: async () => list, ttl: 10 })
    await cache.read('a')
    const view = cache.peek('a')
    cache.fetch('a')
    expect(cache.peek('a')).toBe(view)
    vi.advanceTimersByTime(10)
    expect(cache.peek('a')).not.toBe(view)
    expect(cache.peek('a').data).toBe(view.data)
  })

  it('keeps memory bounded by evicting the least recently used unwatched entries', async () => {
    const cache = createChartCache({ id: 'items', load: async (key: string) => key, ttl: 60_000, maxEntries: 2 })
    const stop = cache.subscribe('watched', () => {})
    await cache.read('watched')
    await cache.read('a')
    await cache.read('b')
    expect(cache.size).toBe(2)
    expect(cache.peek('watched').state).toBe('ready')
    expect(cache.peek('a').state).toBe('idle')
    stop()
  })

  it('refuses to cache secrets, keys and spend decisions', () => {
    for (const id of ['wallet-secret', 'private key', 'mnemonic', 'seed', 'signing-key', 'spend-plan', 'xprv']) {
      expect(isCacheableId(id)).toBe(false)
      expect(() => createChartCache({ id, load: async () => 0, ttl: 1 })).toThrow(/never cached/)
    }
    expect(isCacheableId('spendable-balance')).toBe(true)
    expect(isCacheableId('token-holdings')).toBe(true)
  })
})

describe('cache actor in a chart', () => {
  type Ctx = { state: string; data: string | undefined }

  function chart(cache: ReturnType<typeof createChartCache<string>>) {
    return setup({
      types: { context: {} as Ctx, events: {} as CacheUpdate<string, string> | { type: 'WRITE' } | { type: 'SWITCH'; key: string } },
      actors: { cache: cache.actor },
    }).createMachine({
      context: { state: 'idle', data: undefined },
      invoke: { id: 'cache', src: 'cache', input: { key: 'a' } },
      on: {
        'CACHE.UPDATE': { actions: assign(({ event }) => ({ state: event.view.state, data: event.view.data })) },
        WRITE: { actions: sendTo('cache', { type: 'CACHE.INVALIDATE' }) },
        SWITCH: { actions: sendTo('cache', ({ event }) => ({ type: 'CACHE.KEY', key: event.key })) },
      },
    })
  }

  it('shares entries across chart instances, so a remount does not load again', async () => {
    const load = vi.fn(async (key: string) => `${key}:${load.mock.calls.length}`)
    const cache = createChartCache({ id: 'items', load, ttl: 60_000 })

    const first = createActor(chart(cache)).start()
    await waitFor(first, (s) => s.context.state === 'ready')
    first.stop()

    const second = createActor(chart(cache)).start()
    expect(second.getSnapshot().context).toEqual({ state: 'ready', data: 'a:1' })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('takes invalidation and re-keying as chart events', async () => {
    let n = 0
    const cache = createChartCache({ id: 'items', load: async (key: string) => `${key}${++n}`, ttl: 60_000 })
    const actor = createActor(chart(cache)).start()
    await waitFor(actor, (s) => s.context.data === 'a1')

    actor.send({ type: 'WRITE' })
    expect(actor.getSnapshot().context).toEqual({ state: 'refreshing', data: 'a1' })
    await waitFor(actor, (s) => s.context.data === 'a2')

    actor.send({ type: 'SWITCH', key: 'b' })
    await waitFor(actor, (s) => s.context.data === 'b3')
    expect(cache.peek('a').data).toBe('a2')
  })
})
