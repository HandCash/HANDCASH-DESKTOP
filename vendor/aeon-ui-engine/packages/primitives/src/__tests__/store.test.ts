import { assign, createActor, sendTo, setup, waitFor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import {
  createAeonStore,
  defineSlice,
  entityAttrs,
  isStorableName,
  memoryAdapter,
  queryAttrs,
  type StoreOptions,
  type StoreUpdate,
} from '../machines/store.js'

interface Wallet {
  id: string
  label: string
  balance: number
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function appSlices(load: (query: string) => Promise<Wallet[]>) {
  return {
    wallets: defineSlice<Wallet>({ idOf: (w) => w.id, load: (query) => load(query) }),
    contacts: defineSlice<{ id: string; name: string }>({ idOf: (c) => c.id }),
  }
}

type AppSlices = ReturnType<typeof appSlices>

function walletStore(load = vi.fn(async (_query: string) => [] as Wallet[]), extra: Omit<StoreOptions<AppSlices>, 'id' | 'slices'> = {}) {
  return createAeonStore<AppSlices>({ id: 'app', slices: appSlices(load), ...extra })
}

const main: Wallet = { id: 'w1', label: 'Main', balance: 10 }
const savings: Wallet = { id: 'w2', label: 'Savings', balance: 50 }

describe('createAeonStore: reading', () => {
  it('loads a query once and holds each entity once, by id, across queries', async () => {
    const load = vi.fn(async (query: string) => (query === 'all' ? [main, savings] : [{ ...savings }]))
    const store = walletStore(load)

    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'all' })
    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'all' })
    expect(store.query('wallets', 'all').state).toBe('loading')
    await flush()
    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'savings' })
    await flush()

    expect(load).toHaveBeenCalledTimes(2)
    const all = store.query('wallets', 'all')
    expect(all.state).toBe('ready')
    expect(all.entities).toEqual([main, savings])
    expect(store.query('wallets', 'savings').entities[0]).toBe(all.entities[1])
    expect(store.getSnapshot().slices.wallets.ids).toEqual(['w1', 'w2'])
    expect(store.entity('wallets', 'w2')).toBe(savings)
  })

  it('keeps a query result identical until its view or one of its entities changes', async () => {
    const store = walletStore(vi.fn(async () => [main, savings]))
    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'all' })
    await flush()
    const first = store.query('wallets', 'all')

    store.send({ type: 'ENTITY.UPSERT', slice: 'contacts', entities: [{ id: 'c1', name: 'Ann' }] })
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [{ id: 'w9', label: 'Other', balance: 0 }] })
    expect(store.query('wallets', 'all')).toBe(first)

    store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { balance: 11 } })
    expect(store.query('wallets', 'all')).not.toBe(first)
    expect(store.query('wallets', 'all').entities[0]!.balance).toBe(11)
  })

  it('projects state only through data-aeon attributes', async () => {
    const store = walletStore(vi.fn(async () => [main]))
    expect(queryAttrs(store.query('wallets', 'all'))).toEqual({ 'data-aeon-state': 'idle', 'data-aeon-count': '0' })
    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'all' })
    await flush()
    expect(queryAttrs(store.query('wallets', 'all'))).toEqual({ 'data-aeon-state': 'ready', 'data-aeon-count': '1' })
    expect(entityAttrs(store.getSnapshot().slices.wallets, 'wallets', 'w1')).toEqual({ 'data-aeon-entity': 'wallets', 'data-aeon-state': 'settled' })
  })
})

describe('createAeonStore: writing through events', () => {
  it('upserts, patches and removes only through events', () => {
    const store = walletStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main, savings] })
    store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { label: 'Daily' } })
    store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'missing', patch: { label: 'x' } })
    store.send({ type: 'ENTITY.REMOVE', slice: 'wallets', ids: ['w2'] })

    const wallets = store.getSnapshot().slices.wallets
    expect(wallets.byId).toEqual({ w1: { ...main, label: 'Daily' } })
    expect(wallets.ids).toEqual(['w1'])
  })

  it('keeps the held object when an equal entity arrives, so nothing re-renders', () => {
    const store = walletStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main] })
    const before = store.getSnapshot()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [{ ...main }] })
    expect(store.getSnapshot()).toBe(before)
  })

  it('applies an optimistic write at once, marks it pending, and clears the mark on confirm', () => {
    const store = walletStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main] })
    store.send({ type: 'WRITE.BEGIN', slice: 'wallets', write: 'rename-1', upsert: [{ ...main, label: 'Daily' }] })

    let wallets = store.getSnapshot().slices.wallets
    expect(wallets.byId.w1!.label).toBe('Daily')
    expect(entityAttrs(wallets, 'wallets', 'w1')['data-aeon-state']).toBe('pending')

    store.send({ type: 'WRITE.CONFIRM', write: 'rename-1' })
    wallets = store.getSnapshot().slices.wallets
    expect(wallets.byId.w1!.label).toBe('Daily')
    expect(entityAttrs(wallets, 'wallets', 'w1')['data-aeon-state']).toBe('settled')
    expect(store.getSnapshot().writes).toEqual({})
  })

  it('rolls back a rejected write, restoring removed entities, and marks them failed', () => {
    const store = walletStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main, savings] })
    store.send({ type: 'WRITE.BEGIN', slice: 'wallets', write: 'w', upsert: [{ ...main, balance: 0 }], remove: ['w2'] })
    expect(store.entity('wallets', 'w2')).toBeUndefined()

    store.send({ type: 'WRITE.ROLLBACK', write: 'w', error: 'insufficient funds' })
    const wallets = store.getSnapshot().slices.wallets
    expect(wallets.byId).toEqual({ w1: main, w2: savings })
    expect(wallets.failed).toEqual({ w1: 'insufficient funds', w2: 'insufficient funds' })
    expect(entityAttrs(wallets, 'wallets', 'w1')['data-aeon-state']).toBe('failed')

    store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { balance: 12 } })
    expect(store.getSnapshot().slices.wallets.failed).toEqual({ w2: 'insufficient funds' })
  })

  it('lets a server push made after an optimistic write stand when the write rolls back', () => {
    const store = walletStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main] })
    store.send({ type: 'WRITE.BEGIN', slice: 'wallets', write: 'w', upsert: [{ ...main, balance: 0 }] })
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [{ ...main, balance: 7 }] })
    store.send({ type: 'WRITE.ROLLBACK', write: 'w' })
    expect(store.entity('wallets', 'w1')!.balance).toBe(7)
    expect(store.getSnapshot().slices.wallets.failed).toEqual({})
  })

  it('holds the optimistic value against a load that may predate it, and restores the loaded value on rollback', async () => {
    const load = vi.fn(async () => [{ ...main, balance: 99 }])
    const store = walletStore(load)
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main] })
    store.send({ type: 'WRITE.BEGIN', slice: 'wallets', write: 'w', upsert: [{ ...main, balance: 0 }] })
    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'all' })
    await flush()
    expect(store.entity('wallets', 'w1')!.balance).toBe(0)

    store.send({ type: 'WRITE.ROLLBACK', write: 'w' })
    expect(store.entity('wallets', 'w1')!.balance).toBe(99)
  })

  it('reloads watched queries on invalidation', async () => {
    let balance = 10
    const store = walletStore(vi.fn(async () => [{ ...main, balance }]))
    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'all' })
    await flush()
    balance = 20
    store.send({ type: 'STORE.INVALIDATE' })
    expect(store.query('wallets', 'all').state).toBe('refreshing')
    expect(store.entity('wallets', 'w1')!.balance).toBe(10)
    await flush()
    expect(store.entity('wallets', 'w1')!.balance).toBe(20)
  })

  it('refuses secrets in store ids, slice names and entity fields at any depth', () => {
    expect(isStorableName('privateKey')).toBe(false)
    expect(isStorableName('seedPhrase')).toBe(false)
    expect(isStorableName('balance')).toBe(true)
    expect(() => createAeonStore({ id: 'wallet-secrets', slices: {} })).toThrow(/refusing store/)
    expect(() => createAeonStore({ id: 'app', slices: { mnemonics: defineSlice<Wallet>({ idOf: (w) => w.id }) } })).toThrow(/refusing slice/)

    const store = walletStore()
    const leaky = { ...main, meta: { recovery: { seedPhrase: 'x' } } } as Wallet
    expect(() => store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [leaky] })).toThrow(/refusing field "seedPhrase"/)
    expect(() => store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { privateKey: 'x' } as Partial<Wallet> })).toThrow(/privateKey/)
    expect(store.getSnapshot().slices.wallets.ids).toEqual([])
  })

  it('applies events a sync feed sends, and stops the feed with the store', () => {
    const stopFeed = vi.fn()
    let push: ((wallet: Wallet) => void) | null = null
    const store = walletStore(undefined, {
      sync: (send) => {
        push = (wallet) => send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [wallet] })
        return stopFeed
      },
    })
    push!(main)
    expect(store.entity('wallets', 'w1')).toBe(main)
    store.stop()
    expect(stopFeed).toHaveBeenCalledOnce()
  })
})

describe('createAeonStore: selectors', () => {
  it('calls back only when the selected data changes', async () => {
    const store = walletStore(vi.fn(async () => [{ ...main }, { ...savings }]))
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main, savings] })
    const listener = vi.fn()
    const selection = store.select((state) => state.slices.wallets.byId.w1)
    selection.subscribe(listener)

    store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w2', patch: { balance: 51 } })
    store.send({ type: 'ENTITY.UPSERT', slice: 'contacts', entities: [{ id: 'c1', name: 'Ann' }] })
    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'all' })
    await flush()
    expect(listener).not.toHaveBeenCalled()

    store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { balance: 11 } })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ ...main, balance: 11 })
    expect(selection.get()).toBe(store.entity('wallets', 'w1'))
  })

  it('uses the equality it is given for derived values', () => {
    const store = walletStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main, savings] })
    const listener = vi.fn()
    const total = store.select((state) => Object.values(state.slices.wallets.byId).reduce((sum, w) => sum + w.balance, 0))
    total.subscribe(listener)

    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [{ ...main, balance: 20 }, { ...savings, balance: 40 }] })
    expect(listener).not.toHaveBeenCalled()
    store.send({ type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { balance: 21 } })
    expect(listener).toHaveBeenCalledExactlyOnceWith(61)
  })

  it('feeds a chart through the invoked store actor, which forwards the chart events', async () => {
    const store = walletStore()
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main] })
    const chart = setup({
      types: { context: {} as { balance: number | undefined }, events: {} as StoreUpdate<number | undefined> | { type: 'SPEND' } },
      actors: { store: store.actor },
    }).createMachine({
      context: { balance: undefined },
      invoke: { id: 'store', src: 'store', input: { select: (state) => state.slices.wallets.byId.w1?.balance } },
      on: {
        'STORE.UPDATE': { actions: assign({ balance: ({ event }) => event.value }) },
        SPEND: { actions: sendTo('store', { type: 'ENTITY.PATCH', slice: 'wallets', id: 'w1', patch: { balance: 4 } }) },
      },
    })
    const actor = createActor(chart).start()
    expect(actor.getSnapshot().context.balance).toBe(10)
    actor.send({ type: 'SPEND' })
    await waitFor(actor, (s) => s.context.balance === 4)
    expect(store.entity('wallets', 'w1')!.balance).toBe(4)
    actor.stop()
  })
})

describe('createAeonStore: persistence', () => {
  const persistOf = (adapter = memoryAdapter(), version = 1) => ({ adapter, version, delayMs: 0 })

  it('saves confirmed data and loads it back into a new store', async () => {
    const adapter = memoryAdapter()
    const first = walletStore(undefined, { persist: persistOf(adapter) })
    expect(first.getSnapshot().status).toBe('hydrating')
    await first.ready
    expect(first.getSnapshot().status).toBe('ready')
    first.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main] })
    first.send({ type: 'WRITE.BEGIN', slice: 'wallets', write: 'w', upsert: [{ ...main, balance: 0 }, savings] })
    await first.flush()
    first.stop()

    const second = walletStore(undefined, { persist: persistOf(adapter) })
    await second.ready
    expect(second.getSnapshot().slices.wallets.byId).toEqual({ w1: main })
    expect(second.getSnapshot().slices.wallets.pending).toEqual({})
  })

  it('saves on its own after the quiet delay', async () => {
    const adapter = memoryAdapter()
    const store = walletStore(undefined, { persist: persistOf(adapter) })
    await store.ready
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main] })
    expect(adapter.data.size).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(JSON.parse(adapter.data.get('aeon-store:app')!)).toEqual({ version: 1, slices: { wallets: { byId: { w1: main }, ids: ['w1'] }, contacts: { byId: {}, ids: [] } } })
  })

  it('lets data written during start-up win over the saved copy', async () => {
    const adapter = memoryAdapter({ 'aeon-store:app': JSON.stringify({ version: 1, slices: { wallets: { byId: { w1: main, w2: savings }, ids: ['w1', 'w2'] } } }) })
    const store = walletStore(undefined, { persist: persistOf(adapter) })
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [{ ...main, balance: 1 }] })
    await store.ready
    expect(store.entity('wallets', 'w1')!.balance).toBe(1)
    expect(store.entity('wallets', 'w2')).toEqual(savings)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(JSON.parse(adapter.data.get('aeon-store:app')!).slices.wallets.byId.w1.balance).toBe(1)
  })

  it('migrates older saved data, and drops it when there is no migration or it is unreadable', async () => {
    const old = JSON.stringify({ version: 1, slices: { wallets: { byId: { w1: { id: 'w1', name: 'Main', balance: 10 } }, ids: ['w1'] } } })
    const migrate = vi.fn((saved, from: number) => {
      expect(from).toBe(1)
      const byId = Object.fromEntries(Object.entries(saved.wallets!.byId).map(([id, w]) => [id, { id, label: (w as { name: string }).name, balance: (w as Wallet).balance }]))
      return { wallets: { byId, ids: saved.wallets!.ids } }
    })
    const migrated = walletStore(undefined, { persist: { ...persistOf(memoryAdapter({ 'aeon-store:app': old }), 2), migrate } })
    await migrated.ready
    expect(migrated.entity('wallets', 'w1')).toEqual(main)

    const dropped = walletStore(undefined, { persist: persistOf(memoryAdapter({ 'aeon-store:app': old }), 2) })
    await dropped.ready
    expect(dropped.getSnapshot().slices.wallets.ids).toEqual([])

    const broken = walletStore(undefined, { persist: persistOf(memoryAdapter({ 'aeon-store:app': '{not json' })) })
    await broken.ready
    expect(broken.getSnapshot().status).toBe('ready')
  })

  it('skips slices marked persist: false and saved entities that hold secrets', async () => {
    const adapter = memoryAdapter({
      'aeon-store:app': JSON.stringify({ version: 1, slices: { wallets: { byId: { w1: main, w3: { id: 'w3', label: 'x', balance: 0, wif: 'k' } }, ids: ['w1', 'w3'] } } }),
    })
    const store = createAeonStore({
      id: 'app',
      slices: {
        wallets: defineSlice<Wallet>({ idOf: (w) => w.id }),
        drafts: defineSlice<{ id: string }>({ idOf: (d) => d.id, persist: false }),
      },
      persist: persistOf(adapter),
    })
    await store.ready
    expect(store.getSnapshot().slices.wallets.ids).toEqual(['w1'])
    store.send({ type: 'ENTITY.UPSERT', slice: 'drafts', entities: [{ id: 'd1' }] })
    await store.flush()
    expect(Object.keys(JSON.parse(adapter.data.get('aeon-store:app')!).slices)).toEqual(['wallets'])
  })

  it('clears memory, running loads and the saved copy on STORE.CLEAR', async () => {
    const adapter = memoryAdapter()
    let resolve!: (wallets: Wallet[]) => void
    const store = walletStore(vi.fn(() => new Promise<Wallet[]>((r) => (resolve = r))), { persist: persistOf(adapter) })
    await store.ready
    store.send({ type: 'ENTITY.UPSERT', slice: 'wallets', entities: [main] })
    await store.flush()
    store.send({ type: 'QUERY.FETCH', slice: 'wallets', query: 'all' })
    store.send({ type: 'STORE.CLEAR' })
    resolve([savings])
    await flush()

    expect(store.getSnapshot().slices.wallets).toMatchObject({ byId: {}, ids: [], queries: {} })
    expect(adapter.data.has('aeon-store:app')).toBe(false)
  })
})
