import { assign, createActor, fromCallback, fromPromise, setup, type ActorRefFrom, type SnapshotFrom } from 'xstate'

/** Stable lifecycle states of one cache entry (see STATES.md). */
export const CACHE_STATES = ['idle', 'loading', 'ready', 'stale', 'refreshing', 'failed'] as const

export type CacheState = (typeof CACHE_STATES)[number]

/** Longest delay a timer can hold; a longer time-to-live is checked again when read. */
const MAX_DELAY_MS = 2_147_483_647

/**
 * Caches named for secrets, keys or spend decisions are refused: those must be
 * read fresh every time, never served from memory.
 */
const NEVER_CACHE = /\b(secrets?|private[-_ ]?keys?|mnemonics?|seeds?|passwords?|passphrases?|wif|xprv|signing[-_ ]?keys?|spend)\b/i

export function isCacheableId(id: string): boolean {
  return id.trim().length > 0 && !NEVER_CACHE.test(id)
}

export interface CacheEntryContext<T, K> {
  key: K
  ttl: number
  data: T | undefined
  error: string | null
  /** When `data` was loaded; null while there is none. */
  loadedAt: number | null
  /** An invalidation landed mid-load: the result may predate the write, so load once more. */
  dirty: boolean
  now: () => number
}

export type CacheEntryEvent =
  | { type: 'FETCH' }
  | { type: 'REFRESH' }
  | { type: 'INVALIDATE'; refetch?: boolean }
  | { type: 'CLEAR' }

export interface CacheEntryInput<K> {
  key: K
  ttl: number
  now?: () => number
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One keyed entry: idle until fetched, loading the first time, ready while
 * younger than its time-to-live, then stale. FETCH on a stale or expired entry
 * revalidates in `refreshing` while the old data stays readable; FETCH while a
 * load runs is dropped, so one load serves every caller. INVALIDATE marks the
 * entry stale (and reloads when `refetch`); CLEAR drops the data and cancels a
 * running load so its result never lands.
 */
export function createCacheEntryMachine<T, K = string>() {
  return setup({
    types: {
      context: {} as CacheEntryContext<T, K>,
      events: {} as CacheEntryEvent,
      input: {} as CacheEntryInput<K>,
    },
    actors: {
      load: fromPromise<T, { key: K }>(async () => {
        throw new Error('cache entry load is not provided')
      }),
    },
    delays: {
      ttl: ({ context }) => {
        const age = context.loadedAt === null ? 0 : context.now() - context.loadedAt
        return Math.min(Math.max(0, context.ttl - age), MAX_DELAY_MS)
      },
    },
    guards: {
      expired: ({ context }) => context.loadedAt !== null && context.now() - context.loadedAt >= context.ttl,
      dirty: ({ context }) => context.dirty,
      refetch: ({ event }) => event.type === 'INVALIDATE' && event.refetch === true,
    },
    actions: {
      markDirty: assign({ dirty: true }),
      clear: assign({ data: undefined, error: null, loadedAt: null, dirty: false }),
    },
  }).createMachine({
    id: 'cacheEntry',
    context: ({ input }) => ({
      key: input.key,
      ttl: input.ttl,
      data: undefined,
      error: null,
      loadedAt: null,
      dirty: false,
      now: input.now ?? Date.now,
    }),
    initial: 'idle',
    on: { CLEAR: { target: '.idle', actions: 'clear' } },
    states: {
      idle: {
        on: { FETCH: 'loading', REFRESH: 'loading', INVALIDATE: { guard: 'refetch', target: 'loading' } },
      },
      loading: {
        invoke: {
          src: 'load',
          input: ({ context }) => ({ key: context.key }),
          onDone: [
            {
              guard: 'dirty',
              target: 'refreshing',
              actions: assign(({ context, event }) => ({ data: event.output, error: null, loadedAt: context.now(), dirty: false })),
            },
            {
              target: 'ready',
              actions: assign(({ context, event }) => ({ data: event.output, error: null, loadedAt: context.now() })),
            },
          ],
          onError: { target: 'failed', actions: assign(({ event }) => ({ error: message(event.error), dirty: false })) },
        },
        on: { INVALIDATE: { actions: 'markDirty' } },
      },
      ready: {
        after: { ttl: { guard: 'expired', target: 'stale' } },
        on: {
          FETCH: { guard: 'expired', target: 'refreshing' },
          REFRESH: 'refreshing',
          INVALIDATE: [{ guard: 'refetch', target: 'refreshing' }, { target: 'stale' }],
        },
      },
      stale: {
        on: { FETCH: 'refreshing', REFRESH: 'refreshing', INVALIDATE: { guard: 'refetch', target: 'refreshing' } },
      },
      refreshing: {
        invoke: {
          src: 'load',
          input: ({ context }) => ({ key: context.key }),
          onDone: [
            {
              guard: 'dirty',
              target: 'refreshing',
              reenter: true,
              actions: assign(({ context, event }) => ({ data: event.output, error: null, loadedAt: context.now(), dirty: false })),
            },
            {
              target: 'ready',
              actions: assign(({ context, event }) => ({ data: event.output, error: null, loadedAt: context.now() })),
            },
          ],
          onError: { target: 'stale', actions: assign(({ event }) => ({ error: message(event.error), dirty: false })) },
        },
        on: { INVALIDATE: { actions: 'markDirty' } },
      },
      failed: {
        on: { FETCH: 'loading', REFRESH: 'loading', INVALIDATE: { guard: 'refetch', target: 'loading' } },
      },
    },
  })
}

export const cacheEntryMachine = createCacheEntryMachine()

export type CacheEntryActor<T, K = string> = ActorRefFrom<ReturnType<typeof createCacheEntryMachine<T, K>>>
type CacheEntrySnapshot<T, K> = SnapshotFrom<ReturnType<typeof createCacheEntryMachine<T, K>>>

/**
 * What a reader sees of one entry. The same object comes back until the entry
 * changes, and `data` keeps its identity across ready, stale and refreshing,
 * so selectors over a view never cause a re-render on their own.
 */
export interface CacheView<T> {
  readonly state: CacheState
  readonly data: T | undefined
  readonly error: string | null
  readonly loadedAt: number | null
}

const IDLE_VIEW: CacheView<never> = Object.freeze({ state: 'idle', data: undefined, error: null, loadedAt: null })

/** Commands a chart sends the cache, directly or through the invoked cache actor. */
export type CacheCommand<K> =
  | { type: 'CACHE.FETCH'; key?: K }
  | { type: 'CACHE.REFRESH'; key?: K }
  | { type: 'CACHE.INVALIDATE'; key?: K; tag?: string }
  | { type: 'CACHE.KEY'; key: K }
  | { type: 'CACHE.CLEAR' }

/** What the invoked cache actor sends its parent chart whenever its entry changes. */
export interface CacheUpdate<T, K> {
  type: 'CACHE.UPDATE'
  cache: string
  key: K
  view: CacheView<T>
}

export interface ChartCacheOptions<T, K> {
  /** Names the cache in logs and errors. Names of secrets, keys or spend decisions are refused. */
  id: string
  load: (key: K, context: { signal: AbortSignal }) => Promise<T>
  /** Milliseconds an entry stays fresh, for every key or per key. */
  ttl: number | ((key: K) => number)
  tags?: (key: K) => readonly string[]
  /** Turns a key into the string entries are stored under. Defaults to `String` for strings, else JSON. */
  keyOf?: (key: K) => string
  /** Most entries kept; the least recently used unwatched, settled ones go first. Default 100. */
  maxEntries?: number
  now?: () => number
}

export interface ChartCache<T, K = string> {
  readonly id: string
  /** Entries currently held. */
  readonly size: number
  /** The entry's current view, without loading it. Stable until the entry changes. */
  peek(key: K): CacheView<T>
  /** Loads the entry if it is missing, failed, stale or expired; a running load is reused. */
  fetch(key: K): void
  /** Reloads now, keeping the old data readable meanwhile. */
  refresh(key: K): void
  /** Resolves with the entry's data, serving stale data at once while it revalidates. */
  read(key: K): Promise<T>
  /** Marks entries stale; watched ones reload at once. */
  invalidate(target: { key: K } | { tag: string }): void
  /** Drops every entry's data and cancels running loads (lock, account or network switch). */
  clear(): void
  subscribe(key: K, listener: (view: CacheView<T>) => void): () => void
  send(command: CacheCommand<K>): void
  /**
   * Invoke from a chart: `invoke: { id: 'cache', src: cache.actor, input: { key } }`.
   * It fetches the key, sends `CACHE.UPDATE` on every change, and takes
   * `CACHE.*` commands from the parent (`sendTo('cache', …)`); commands without
   * a key apply to its own, and `CACHE.KEY` moves it to another key.
   */
  readonly actor: ReturnType<typeof fromCallback<CacheCommand<K>, { key: K; fetch?: boolean }>>
}

interface Slot<T, K> {
  key: K
  tags: readonly string[]
  actor: CacheEntryActor<T, K>
  view: CacheView<T>
  listeners: Set<(view: CacheView<T>) => void>
  usedAt: number
}

const defaultKeyOf = (key: unknown) => (typeof key === 'string' ? key : JSON.stringify(key))

function viewOf<T, K>(snapshot: CacheEntrySnapshot<T, K>, previous: CacheView<T>): CacheView<T> {
  const state = snapshot.value as CacheState
  const { data, error, loadedAt } = snapshot.context
  if (previous.state === state && previous.data === data && previous.error === error && previous.loadedAt === loadedAt) return previous
  return Object.freeze({ state, data, error, loadedAt })
}

/**
 * A keyed cache shared by every chart that reads it, so a remounted chart is
 * served from memory instead of loading again. Each entry is its own
 * `cacheEntryMachine`; create one cache per kind of data at module scope.
 */
export function createChartCache<T, K = string>(options: ChartCacheOptions<T, K>): ChartCache<T, K> {
  if (!isCacheableId(options.id)) throw new Error(`refusing to cache "${options.id}": secrets, keys and spend decisions are never cached`)
  const keyOf = options.keyOf ?? defaultKeyOf
  const maxEntries = Math.max(1, options.maxEntries ?? 100)
  const ttlOf = typeof options.ttl === 'function' ? options.ttl : () => options.ttl as number
  const machine = createCacheEntryMachine<T, K>().provide({
    actors: { load: fromPromise<T, { key: K }>(({ input, signal }) => options.load(input.key, { signal })) },
  })
  const slots = new Map<string, Slot<T, K>>()
  let clock = 0

  const busy = (slot: Slot<T, K>) => slot.view.state === 'loading' || slot.view.state === 'refreshing'

  const evict = (keep?: Slot<T, K>) => {
    if (slots.size <= maxEntries) return
    const idle = [...slots.entries()]
      .filter(([, slot]) => slot !== keep && slot.listeners.size === 0 && !busy(slot))
      .sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [id, slot] of idle) {
      if (slots.size <= maxEntries) break
      slot.actor.stop()
      slots.delete(id)
    }
  }

  const slotFor = (key: K): Slot<T, K> => {
    const id = keyOf(key)
    const existing = slots.get(id)
    if (existing) {
      existing.usedAt = ++clock
      return existing
    }
    const actor = createActor(machine, { input: { key, ttl: ttlOf(key), now: options.now } })
    const slot: Slot<T, K> = { key, tags: options.tags?.(key) ?? [], actor, view: IDLE_VIEW, listeners: new Set(), usedAt: ++clock }
    actor.subscribe((snapshot) => {
      const next = viewOf(snapshot, slot.view)
      if (next === slot.view) return
      slot.view = next
      for (const listener of [...slot.listeners]) listener(next)
    })
    slots.set(id, slot)
    actor.start()
    evict(slot)
    return slot
  }

  const invalidateSlot = (slot: Slot<T, K>) => slot.actor.send({ type: 'INVALIDATE', refetch: slot.listeners.size > 0 })

  const cache: Omit<ChartCache<T, K>, 'actor' | 'size'> & { actor?: ChartCache<T, K>['actor'] } = {
    id: options.id,
    peek: (key) => slots.get(keyOf(key))?.view ?? IDLE_VIEW,
    fetch: (key) => slotFor(key).actor.send({ type: 'FETCH' }),
    refresh: (key) => slotFor(key).actor.send({ type: 'REFRESH' }),
    read: (key) =>
      new Promise<T>((resolve, reject) => {
        const slot = slotFor(key)
        const settle = (view: CacheView<T>) => {
          if (view.loadedAt !== null && view.state !== 'loading') resolve(view.data as T)
          else if (view.state === 'failed') reject(new Error(view.error ?? `${options.id} failed to load`))
          else return false
          return true
        }
        slot.actor.send({ type: 'FETCH' })
        if (settle(slot.view)) return
        const stop = cache.subscribe(key, (view) => {
          if (settle(view)) stop()
        })
      }),
    invalidate: (target) => {
      if ('key' in target) {
        const slot = slots.get(keyOf(target.key))
        if (slot) invalidateSlot(slot)
        return
      }
      for (const slot of slots.values()) if (slot.tags.includes(target.tag)) invalidateSlot(slot)
    },
    clear: () => {
      for (const [id, slot] of [...slots.entries()]) {
        slot.actor.send({ type: 'CLEAR' })
        if (slot.listeners.size === 0) {
          slot.actor.stop()
          slots.delete(id)
        }
      }
    },
    subscribe: (key, listener) => {
      const slot = slotFor(key)
      slot.listeners.add(listener)
      return () => {
        slot.listeners.delete(listener)
        evict()
      }
    },
    send: (command) => {
      switch (command.type) {
        case 'CACHE.FETCH':
          if (command.key !== undefined) cache.fetch(command.key)
          return
        case 'CACHE.REFRESH':
          if (command.key !== undefined) cache.refresh(command.key)
          return
        case 'CACHE.INVALIDATE':
          if (command.tag !== undefined) cache.invalidate({ tag: command.tag })
          else if (command.key !== undefined) cache.invalidate({ key: command.key })
          return
        case 'CACHE.KEY':
          cache.fetch(command.key)
          return
        case 'CACHE.CLEAR':
          cache.clear()
          return
      }
    },
  }

  cache.actor = fromCallback<CacheCommand<K>, { key: K; fetch?: boolean }>(({ input, sendBack, receive }) => {
    let key = input.key
    let stop = () => {}
    const watch = (next: K, fetch: boolean) => {
      stop()
      key = next
      const report = (view: CacheView<T>) => sendBack({ type: 'CACHE.UPDATE', cache: options.id, key: next, view } satisfies CacheUpdate<T, K>)
      stop = cache.subscribe(next, report)
      report(cache.peek(next))
      if (fetch) cache.fetch(next)
    }
    watch(key, input.fetch !== false)
    receive((command) => {
      if (command.type === 'CACHE.KEY') {
        if (keyOf(command.key) !== keyOf(key)) watch(command.key, true)
        return
      }
      if (command.type === 'CACHE.CLEAR') return cache.clear()
      if (command.type === 'CACHE.INVALIDATE' && command.tag !== undefined) return cache.send(command)
      cache.send({ ...command, key: command.key ?? key } as CacheCommand<K>)
    })
    return () => stop()
  })

  return Object.defineProperty(cache, 'size', { get: () => slots.size, enumerable: true }) as ChartCache<T, K>
}
