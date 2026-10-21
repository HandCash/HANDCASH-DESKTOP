import { stateToAttr } from '@aeon-ui/core'
import { assign, createActor, fromCallback, setup } from 'xstate'
import { createChartCache, isCacheableId, type CacheState, type CacheView, type ChartCache } from './cache.js'

/**
 * One store per app: every entity lives once, by id, in its slice. Charts and
 * components read through selectors and project state onto `data-aeon-*`
 * attributes; the only way to change anything is an event sent to the store.
 */

export interface SliceOptions<E, Q> {
  idOf: (entity: E) => string
  /** Loads the entities a query names. Slices without `load` are filled by events only. */
  load?: (query: Q, context: { signal: AbortSignal }) => Promise<readonly E[]>
  /** Milliseconds a query result stays fresh. Default 30 seconds. */
  ttl?: number | ((query: Q) => number)
  tags?: (query: Q) => readonly string[]
  /** Turns a query into the key its result is stored under. Defaults to `String` for strings, else JSON. */
  queryKey?: (query: Q) => string
  /** An incoming entity equal to the held one keeps the held object, so selectors stay quiet. Default: shallow equality. */
  equals?: (a: E, b: E) => boolean
  /** Saved by the store's persistence adapter. Default true. */
  persist?: boolean
}

export interface SliceDefinition<E, Q> extends SliceOptions<E, Q> {
  readonly __types?: { entity: E; query: Q }
}

export function defineSlice<E, Q = string>(options: SliceOptions<E, Q>): SliceDefinition<E, Q> {
  return options
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySlices = Record<string, SliceDefinition<any, any>>
export type EntityOf<D> = D extends { readonly __types?: { entity: infer E } } ? E : never
export type QueryOf<D> = D extends { readonly __types?: { query: infer Q } } ? Q : never

/** One query's result: its load state and the ids it returned, in order. */
export interface QueryView {
  readonly state: CacheState
  readonly ids: readonly string[]
  readonly error: string | null
  readonly loadedAt: number | null
}

export interface SliceState<E> {
  readonly byId: Readonly<Record<string, E>>
  /** Every held id, in arrival order. */
  readonly ids: readonly string[]
  readonly queries: Readonly<Record<string, QueryView>>
  /** Entity id → the optimistic write it waits on. */
  readonly pending: Readonly<Record<string, string>>
  /** Entity id → why its last write was rolled back. Cleared by the next write to it. */
  readonly failed: Readonly<Record<string, string>>
}

export type StoreStatus = 'hydrating' | 'ready'

interface PendingWrite {
  slice: string
  /** Values before the write, restored on rollback. */
  before: Record<string, unknown>
  /** Values the write put in place; rollback only restores entities still holding them. */
  after: Record<string, unknown>
}

export interface StoreState<S extends AnySlices> {
  readonly status: StoreStatus
  readonly slices: { readonly [N in keyof S]: SliceState<EntityOf<S[N]>> }
  readonly writes: Readonly<Record<string, PendingWrite>>
}

type SliceEvent<N extends string, E, Q> =
  | { type: 'ENTITY.UPSERT'; slice: N; entities: readonly E[] }
  | { type: 'ENTITY.PATCH'; slice: N; id: string; patch: Partial<E> }
  | { type: 'ENTITY.REMOVE'; slice: N; ids: readonly string[] }
  | { type: 'QUERY.FETCH'; slice: N; query: Q }
  | { type: 'QUERY.REFRESH'; slice: N; query: Q }
  | { type: 'QUERY.INVALIDATE'; slice: N; query?: Q; tag?: string }
  /** Applies at once and marks the entities pending until WRITE.CONFIRM or WRITE.ROLLBACK. */
  | { type: 'WRITE.BEGIN'; slice: N; write: string; upsert?: readonly E[]; remove?: readonly string[] }

/** Everything a store accepts. Writes, loads and invalidations all go through here. */
export type StoreEvent<S extends AnySlices> =
  | { [N in keyof S & string]: SliceEvent<N, EntityOf<S[N]>, QueryOf<S[N]>> }[keyof S & string]
  | { type: 'WRITE.CONFIRM'; write: string }
  | { type: 'WRITE.ROLLBACK'; write: string; error?: string }
  /** Marks every query stale; watched ones reload (reconnect, window focus). */
  | { type: 'STORE.INVALIDATE' }
  /** Drops all data, running loads and saved data (lock, account or network switch). */
  | { type: 'STORE.CLEAR' }

export interface StoreAdapter {
  load(key: string): string | null | undefined | Promise<string | null | undefined>
  save(key: string, value: string): void | Promise<void>
  remove(key: string): void | Promise<void>
}

export interface StorePersistOptions {
  adapter: StoreAdapter
  /** Bump when the saved shape changes; older data goes through `migrate` or is dropped. */
  version: number
  migrate?: (saved: PersistedSlices, fromVersion: number) => PersistedSlices | null | undefined
  /** Milliseconds of quiet before a save. Default 250. */
  delayMs?: number
}

export type PersistedSlices = Record<string, { byId: Record<string, unknown>; ids: string[] }>

export interface StoreOptions<S extends AnySlices> {
  /** Names the store and its saved data. Names of secrets, keys or spend decisions are refused. */
  id: string
  slices: S
  persist?: StorePersistOptions
  /** Starts a server or disk feed that sends store events; returns its stop function. */
  sync?: (send: (event: StoreEvent<S>) => void) => (() => void) | void
  now?: () => number
}

/** A query's view with its entities resolved. Stable until the view or one of its entities changes. */
export interface QueryResult<E> extends QueryView {
  readonly entities: readonly E[]
}

export interface Selection<T> {
  get(): T
  /** Calls back only when the selected value changes under `equals`. */
  subscribe(listener: (value: T) => void): () => void
}

/** What the invoked store actor sends its parent chart whenever its selection changes. */
export interface StoreUpdate<T> {
  type: 'STORE.UPDATE'
  store: string
  value: T
}

export interface AeonStore<S extends AnySlices> {
  readonly id: string
  getSnapshot(): StoreState<S>
  /** For `useSyncExternalStore`: calls back after every change. */
  subscribe(listener: () => void): () => void
  send(event: StoreEvent<S>): void
  select<T>(selector: (state: StoreState<S>) => T, equals?: (a: T, b: T) => boolean): Selection<T>
  entity<N extends keyof S & string>(slice: N, id: string): EntityOf<S[N]> | undefined
  query<N extends keyof S & string>(slice: N, query: QueryOf<S[N]>): QueryResult<EntityOf<S[N]>>
  /** Resolves once saved data has loaded (at once without persistence). */
  readonly ready: Promise<void>
  /** Saves now instead of after the quiet delay (app quit). */
  flush(): Promise<void>
  stop(): void
  /**
   * Invoke from a chart: `invoke: { id: 'store', src: store.actor, input: { select } }`.
   * It sends `STORE.UPDATE` whenever the selection changes and forwards store
   * events the chart sends it (`sendTo('store', …)`).
   */
  readonly actor: ReturnType<typeof fromCallback<StoreEvent<S>, { select: (state: StoreState<S>) => unknown; equals?: (a: unknown, b: unknown) => boolean }>>
}

const DEFAULT_TTL = 30_000
const ALL_TAG = '*'
const EMPTY_IDS: readonly string[] = Object.freeze([])
const IDLE_QUERY: QueryView = Object.freeze({ state: 'idle', ids: EMPTY_IDS, error: null, loadedAt: null })
const EMPTY_SLICE: SliceState<never> = Object.freeze({ byId: {}, ids: EMPTY_IDS, queries: {}, pending: {}, failed: {} })

const defaultKeyOf = (key: unknown) => (typeof key === 'string' ? key : JSON.stringify(key))

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((key) => Object.hasOwn(b, key) && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** Field and slice names are checked word by word, so `seedPhrase` and `privateKey` are caught. */
export function isStorableName(name: string): boolean {
  return isCacheableId(name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
}

/** The first field name, at any depth, that names a secret, key or spend decision. */
export function unstorableField(value: unknown, depth = 0): string | null {
  if (depth > 8 || typeof value !== 'object' || value === null) return null
  for (const [key, inner] of Object.entries(value)) {
    if (!Array.isArray(value) && !isStorableName(key)) return key
    const nested = unstorableField(inner, depth + 1)
    if (nested !== null) return nested
  }
  return null
}

/** `data-aeon-*` projection of a query: its load state and how many entities it holds. */
export function queryAttrs(result: QueryView): Record<string, string> {
  return { 'data-aeon-state': stateToAttr(result.state), 'data-aeon-count': String(result.ids.length) }
}

/** `data-aeon-*` projection of one entity: pending while a write waits on the server, failed after a rollback. */
export function entityAttrs<E>(slice: SliceState<E>, sliceName: string, id: string): Record<string, string> {
  const state = slice.pending[id] !== undefined ? 'pending' : slice.failed[id] !== undefined ? 'failed' : 'settled'
  return { 'data-aeon-entity': sliceName, 'data-aeon-state': state }
}

export function memoryAdapter(initial: Record<string, string> = {}): StoreAdapter & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    load: (key) => data.get(key) ?? null,
    save: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  }
}

export function webStorageAdapter(storage: Storage = globalThis.localStorage): StoreAdapter {
  return {
    load: (key) => storage.getItem(key),
    save: (key, value) => storage.setItem(key, value),
    remove: (key) => storage.removeItem(key),
  }
}

// ---- reducer -------------------------------------------------------------

type AnyEntity = unknown
type AnySliceState = SliceState<AnyEntity>
interface Data {
  status: StoreStatus
  slices: Record<string, AnySliceState>
  writes: Record<string, PendingWrite>
}

type InternalEvent =
  | StoreEvent<AnySlices>
  | { type: 'QUERY.UPDATE'; slice: string; key: string; view: CacheView<readonly AnyEntity[]> }
  | { type: 'STORE.HYDRATED'; slices: PersistedSlices | null }

interface Reducer {
  defs: AnySlices
}

function omit<T>(record: Readonly<Record<string, T>>, keys: Iterable<string>): Readonly<Record<string, T>> {
  let next: Record<string, T> | null = null
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue
    next ??= { ...record }
    delete next[key]
  }
  return next ?? record
}

function withSlice(data: Data, name: string, slice: AnySliceState): Data {
  return slice === data.slices[name] ? data : { ...data, slices: { ...data.slices, [name]: slice } }
}

/** Puts entities in place, keeping held objects that are equal to the incoming ones. */
function putEntities(r: Reducer, name: string, slice: AnySliceState, entities: readonly AnyEntity[]): AnySliceState {
  const def = r.defs[name]!
  const equals = def.equals ?? shallowEqual
  let byId: Record<string, AnyEntity> | null = null
  let added: string[] | null = null
  let failed = slice.failed
  for (const entity of entities) {
    const id = def.idOf(entity)
    const held = (byId ?? slice.byId)[id]
    failed = omit(failed, [id])
    if (held !== undefined && (held === entity || equals(held, entity))) continue
    byId ??= { ...slice.byId }
    if (held === undefined && !Object.hasOwn(byId, id)) (added ??= []).push(id)
    byId[id] = entity
  }
  if (!byId && failed === slice.failed) return slice
  return { ...slice, byId: byId ?? slice.byId, ids: added ? [...slice.ids, ...added] : slice.ids, failed }
}

function removeEntities(slice: AnySliceState, ids: readonly string[]): AnySliceState {
  const byId = omit(slice.byId, ids)
  if (byId === slice.byId) return slice
  const gone = new Set(ids)
  return { ...slice, byId, ids: slice.ids.filter((id) => !gone.has(id)) }
}

function sameIds(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function applyQueryUpdate(r: Reducer, data: Data, name: string, key: string, view: CacheView<readonly AnyEntity[]>): Data {
  const def = r.defs[name]!
  let slice = data.slices[name] ?? EMPTY_SLICE
  let writes = data.writes
  const previous = slice.queries[key] ?? IDLE_QUERY
  let ids = previous.ids
  if (view.data !== undefined) {
    const incoming = view.data
    const settled: AnyEntity[] = []
    for (const entity of incoming) {
      const id = def.idOf(entity)
      const write = slice.pending[id]
      // A load may predate the pending write: hold the optimistic value, refresh what rollback restores.
      if (write !== undefined && writes[write]) {
        writes = { ...writes, [write]: { ...writes[write]!, before: { ...writes[write]!.before, [id]: entity } } }
      } else settled.push(entity)
    }
    slice = putEntities(r, name, slice, settled)
    const nextIds = incoming.map(def.idOf)
    if (!sameIds(nextIds, ids)) ids = nextIds
  } else if (view.state === 'idle') ids = EMPTY_IDS
  const query =
    previous.state === view.state && previous.ids === ids && previous.error === view.error && previous.loadedAt === view.loadedAt
      ? previous
      : Object.freeze({ state: view.state, ids, error: view.error, loadedAt: view.loadedAt })
  if (query !== previous) slice = { ...slice, queries: { ...slice.queries, [key]: query } }
  const next = withSlice(data, name, slice)
  return writes === data.writes ? next : { ...next, writes }
}

function beginWrite(r: Reducer, data: Data, event: Extract<StoreEvent<AnySlices>, { type: 'WRITE.BEGIN' }>): Data {
  if (data.writes[event.write]) return data
  const def = r.defs[event.slice]!
  let slice = data.slices[event.slice] ?? EMPTY_SLICE
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const ids: string[] = []
  for (const entity of event.upsert ?? []) {
    const id = def.idOf(entity)
    before[id] = slice.byId[id]
    ids.push(id)
  }
  for (const id of event.remove ?? []) {
    before[id] = slice.byId[id]
    ids.push(id)
  }
  slice = putEntities(r, event.slice, slice, event.upsert ?? [])
  slice = removeEntities(slice, event.remove ?? [])
  for (const id of ids) after[id] = slice.byId[id]
  const pending = { ...slice.pending }
  for (const id of ids) pending[id] = event.write
  slice = { ...slice, pending, failed: omit(slice.failed, ids) }
  return { ...withSlice(data, event.slice, slice), writes: { ...data.writes, [event.write]: { slice: event.slice, before, after } } }
}

function settleWrite(data: Data, writeId: string, rollback: string | null): Data {
  const write = data.writes[writeId]
  if (!write) return data
  let slice = data.slices[write.slice] ?? EMPTY_SLICE
  const ids = Object.keys(write.after)
  const mine = ids.filter((id) => slice.pending[id] === writeId)
  slice = { ...slice, pending: omit(slice.pending, mine) }
  if (rollback !== null) {
    const failed = { ...slice.failed }
    for (const id of ids) {
      // A later write or a server push replaced the optimistic value: theirs stands.
      if (slice.byId[id] !== write.after[id]) continue
      const restore = write.before[id]
      if (restore === undefined) slice = removeEntities(slice, [id])
      else {
        const had = Object.hasOwn(slice.byId, id)
        slice = { ...slice, byId: { ...slice.byId, [id]: restore }, ids: had ? slice.ids : [...slice.ids, id] }
      }
      failed[id] = rollback
    }
    slice = { ...slice, failed }
  }
  const writes = { ...data.writes }
  delete writes[writeId]
  return { ...withSlice(data, write.slice, slice), writes }
}

function hydrate(r: Reducer, data: Data, saved: PersistedSlices | null): Data {
  let next: Data = { ...data, status: 'ready' }
  if (!saved) return next
  for (const [name, stored] of Object.entries(saved)) {
    const def = r.defs[name]
    if (!def || def.persist === false || !stored || typeof stored.byId !== 'object') continue
    const slice = next.slices[name] ?? EMPTY_SLICE
    const order = Array.isArray(stored.ids) ? stored.ids : Object.keys(stored.byId)
    // Data written since start-up is newer than the saved copy.
    const missing = order
      .map((id) => stored.byId[id])
      .filter((entity) => entity !== undefined && unstorableField(entity) === null && !Object.hasOwn(slice.byId, def.idOf(entity)))
    next = withSlice(next, name, putEntities(r, name, slice, missing))
  }
  return next
}

function reduce(r: Reducer, data: Data, event: InternalEvent): Data {
  switch (event.type) {
    case 'ENTITY.UPSERT':
      return withSlice(data, event.slice, putEntities(r, event.slice, data.slices[event.slice] ?? EMPTY_SLICE, event.entities))
    case 'ENTITY.PATCH': {
      const slice = data.slices[event.slice] ?? EMPTY_SLICE
      const held = slice.byId[event.id]
      if (held === undefined) return data
      return withSlice(data, event.slice, putEntities(r, event.slice, slice, [{ ...(held as object), ...event.patch }]))
    }
    case 'ENTITY.REMOVE': {
      const slice = removeEntities(data.slices[event.slice] ?? EMPTY_SLICE, event.ids)
      return withSlice(data, event.slice, { ...slice, failed: omit(slice.failed, event.ids) })
    }
    case 'WRITE.BEGIN':
      return beginWrite(r, data, event)
    case 'WRITE.CONFIRM':
      return settleWrite(data, event.write, null)
    case 'WRITE.ROLLBACK':
      return settleWrite(data, event.write, event.error ?? 'write failed')
    case 'QUERY.UPDATE':
      return applyQueryUpdate(r, data, event.slice, event.key, event.view)
    case 'STORE.HYDRATED':
      return hydrate(r, data, event.slices)
    case 'STORE.CLEAR':
      return { ...data, slices: Object.fromEntries(Object.keys(r.defs).map((name) => [name, EMPTY_SLICE])), writes: {} }
    default:
      return data
  }
}

/**
 * The store's chart: `hydrating` until saved data has loaded, then `ready`.
 * Every event folds into one immutable snapshot (`context.data`) that keeps
 * its identity, and that of every untouched slice and entity, when an event
 * changes nothing.
 */
export function createStoreMachine(defs: AnySlices) {
  const r: Reducer = { defs }
  return setup({
    types: {
      context: {} as { data: Data },
      events: {} as InternalEvent,
      input: {} as { hydrate: boolean },
    },
  }).createMachine({
    id: 'aeonStore',
    context: ({ input }) => ({
      data: {
        status: input.hydrate ? 'hydrating' : 'ready',
        slices: Object.fromEntries(Object.keys(defs).map((name) => [name, EMPTY_SLICE])),
        writes: {},
      },
    }),
    initial: 'boot',
    states: {
      boot: { always: [{ guard: ({ context }) => context.data.status === 'hydrating', target: 'hydrating' }, { target: 'ready' }] },
      hydrating: { on: { 'STORE.HYDRATED': { target: 'ready', actions: assign(({ context, event }) => ({ data: reduce(r, context.data, event) })) } } },
      ready: {},
    },
    on: {
      '*': { actions: assign(({ context, event }) => (event.type === 'STORE.HYDRATED' ? {} : { data: reduce(r, context.data, event) })) },
    },
  })
}

// ---- store ---------------------------------------------------------------

function persistable(defs: AnySlices, data: Data): PersistedSlices {
  const out: PersistedSlices = {}
  for (const [name, def] of Object.entries(defs)) {
    if (def.persist === false) continue
    const slice = data.slices[name] ?? EMPTY_SLICE
    const byId: Record<string, unknown> = { ...slice.byId }
    const ids = [...slice.ids]
    // Only confirmed values are saved: a pending write is saved as what it replaced.
    for (const [id, writeId] of Object.entries(slice.pending)) {
      const before = data.writes[writeId]?.before[id]
      if (before === undefined) {
        delete byId[id]
        const at = ids.indexOf(id)
        if (at >= 0) ids.splice(at, 1)
      } else {
        if (!Object.hasOwn(byId, id)) ids.push(id)
        byId[id] = before
      }
    }
    out[name] = { byId, ids }
  }
  return out
}

function parseSaved(raw: string | null | undefined, options: StorePersistOptions): PersistedSlices | null {
  if (!raw) return null
  try {
    const saved = JSON.parse(raw) as { version?: unknown; slices?: unknown }
    if (typeof saved !== 'object' || saved === null || typeof saved.slices !== 'object' || saved.slices === null) return null
    const slices = saved.slices as PersistedSlices
    if (saved.version === options.version) return slices
    if (typeof saved.version !== 'number' || !options.migrate) return null
    return options.migrate(slices, saved.version) ?? null
  } catch {
    return null
  }
}

export function createAeonStore<S extends AnySlices>(options: StoreOptions<S>): AeonStore<S> {
  if (!isStorableName(options.id)) throw new Error(`refusing store "${options.id}": secrets, keys and spend decisions are never stored`)
  for (const name of Object.keys(options.slices)) {
    if (!isStorableName(name)) throw new Error(`refusing slice "${name}" in store "${options.id}": secrets, keys and spend decisions are never stored`)
  }
  const defs = options.slices as AnySlices
  const persist = options.persist
  const storageKey = `aeon-store:${options.id}`
  const actor = createActor(createStoreMachine(defs), { input: { hydrate: persist !== undefined } })
  const listeners = new Set<() => void>()
  const caches = new Map<string, ChartCache<readonly AnyEntity[], unknown>>()
  const watched = new Map<string, Map<string, () => void>>()
  let data = actor.getSnapshot().context.data
  let stopped = false

  for (const [name, def] of Object.entries(defs)) {
    if (!def.load) continue
    const load = def.load
    const userTags = def.tags
    caches.set(
      name,
      createChartCache<readonly AnyEntity[], unknown>({
        id: `${options.id}.${name}`,
        load: (query, context) => load(query, context),
        ttl: def.ttl ?? DEFAULT_TTL,
        tags: (query) => [ALL_TAG, ...(userTags?.(query) ?? [])],
        keyOf: def.queryKey ?? defaultKeyOf,
        // Watched queries are pinned; this bounds the unwatched ones.
        maxEntries: 200,
        now: options.now,
      }),
    )
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const save = async () => {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = null
    if (!persist || stopped || data.status !== 'ready') return
    await persist.adapter.save(storageKey, JSON.stringify({ version: persist.version, slices: persistable(defs, data) }))
  }
  const persisted = Object.keys(defs).filter((name) => defs[name]!.persist !== false)
  const persistChanged = (previous: Data, next: Data) =>
    persisted.some((name) => previous.slices[name]?.byId !== next.slices[name]?.byId || previous.slices[name]?.pending !== next.slices[name]?.pending)
  // Writes that landed while saved data was loading are not on disk yet.
  const heldBeforeHydration = (previous: Data) => persisted.some((name) => (previous.slices[name]?.ids.length ?? 0) > 0)

  actor.subscribe((snapshot) => {
    const next = snapshot.context.data
    if (next === data) return
    const previous = data
    data = next
    if (persist && next.status === 'ready' && (previous.status === 'ready' ? persistChanged(previous, next) : heldBeforeHydration(previous))) {
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => void save().catch(() => {}), persist.delayMs ?? 250)
    }
    for (const listener of [...listeners]) listener()
  })
  actor.start()

  const keyOf = (name: string, query: unknown) => (defs[name]!.queryKey ?? defaultKeyOf)(query)

  const watch = (name: string, query: unknown) => {
    const cache = caches.get(name)
    if (!cache) throw new Error(`slice "${name}" in store "${options.id}" has no load, so it has no queries`)
    const key = keyOf(name, query)
    let forSlice = watched.get(name)
    if (!forSlice) watched.set(name, (forSlice = new Map()))
    if (!forSlice.has(key)) {
      const forward = (view: CacheView<readonly AnyEntity[]>) => actor.send({ type: 'QUERY.UPDATE', slice: name, key, view })
      forSlice.set(key, cache.subscribe(query, forward))
      forward(cache.peek(query))
    }
    return cache
  }

  const unwatchAll = () => {
    for (const forSlice of watched.values()) for (const stop of forSlice.values()) stop()
    watched.clear()
  }

  const checkFields = (entities: readonly unknown[]) => {
    for (const entity of entities) {
      const field = unstorableField(entity)
      if (field !== null) throw new Error(`refusing field "${field}" in store "${options.id}": secrets, keys and spend decisions are never stored`)
    }
  }

  const send = (event: StoreEvent<S>) => {
    if (stopped) return
    const e = event as StoreEvent<AnySlices>
    if ('slice' in e && !Object.hasOwn(defs, e.slice)) throw new Error(`store "${options.id}" has no slice "${e.slice}"`)
    switch (e.type) {
      case 'ENTITY.UPSERT':
        checkFields(e.entities)
        break
      case 'ENTITY.PATCH':
        checkFields([e.patch])
        break
      case 'WRITE.BEGIN':
        checkFields(e.upsert ?? [])
        break
      case 'QUERY.FETCH':
        watch(e.slice, e.query).fetch(e.query)
        return
      case 'QUERY.REFRESH':
        watch(e.slice, e.query).refresh(e.query)
        return
      case 'QUERY.INVALIDATE': {
        const cache = caches.get(e.slice)
        if (!cache) return
        if (e.tag !== undefined) cache.invalidate({ tag: e.tag })
        else if (e.query !== undefined) cache.invalidate({ key: e.query })
        else cache.invalidate({ tag: ALL_TAG })
        return
      }
      case 'STORE.INVALIDATE':
        for (const cache of caches.values()) cache.invalidate({ tag: ALL_TAG })
        return
      case 'STORE.CLEAR':
        unwatchAll()
        for (const cache of caches.values()) cache.clear()
        actor.send(e)
        if (saveTimer !== null) clearTimeout(saveTimer)
        saveTimer = null
        if (persist) void Promise.resolve(persist.adapter.remove(storageKey)).catch(() => {})
        return
    }
    actor.send(e)
  }

  const results = new Map<string, { view: QueryView; byId: Readonly<Record<string, unknown>>; result: QueryResult<unknown> }>()
  const query = (name: string, q: unknown): QueryResult<unknown> => {
    const key = keyOf(name, q)
    const slice = data.slices[name] ?? EMPTY_SLICE
    const view = slice.queries[key] ?? IDLE_QUERY
    const memoKey = `${name}\u0000${key}`
    const held = results.get(memoKey)
    if (held && held.view === view && held.byId === slice.byId) return held.result
    const entities = view.ids.map((id) => slice.byId[id]).filter((entity) => entity !== undefined)
    const result =
      held && held.view === view && sameEntities(held.result.entities, entities) ? held.result : Object.freeze({ ...view, entities: Object.freeze(entities) })
    results.set(memoKey, { view, byId: slice.byId, result })
    return result
  }

  const select = <T>(selector: (state: StoreState<S>) => T, equals: (a: T, b: T) => boolean = Object.is): Selection<T> => {
    let from = data
    let value = selector(data as unknown as StoreState<S>)
    const get = () => {
      if (from !== data) {
        const next = selector(data as unknown as StoreState<S>)
        from = data
        if (!equals(value, next)) value = next
      }
      return value
    }
    return {
      get,
      subscribe: (listener) => {
        let last = get()
        return store.subscribe(() => {
          const next = get()
          if (next === last) return
          last = next
          listener(next)
        })
      },
    }
  }

  let stopSync: (() => void) | void = undefined
  const ready = persist
    ? Promise.resolve()
        .then(() => persist.adapter.load(storageKey))
        .then((raw) => parseSaved(raw, persist), () => null)
        .then((slices) => {
          if (!stopped) actor.send({ type: 'STORE.HYDRATED', slices })
        })
    : Promise.resolve()

  const store: AeonStore<S> = {
    id: options.id,
    getSnapshot: () => data as unknown as StoreState<S>,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    send,
    select,
    entity: (name, id) => (data.slices[name] ?? EMPTY_SLICE).byId[id] as EntityOf<S[typeof name]> | undefined,
    query: (name, q) => query(name, q) as QueryResult<EntityOf<S[typeof name]>>,
    ready,
    flush: () => ready.then(save),
    stop: () => {
      if (stopped) return
      stopped = true
      if (saveTimer !== null) clearTimeout(saveTimer)
      if (typeof stopSync === 'function') stopSync()
      unwatchAll()
      actor.stop()
      listeners.clear()
    },
    actor: fromCallback<StoreEvent<S>, { select: (state: StoreState<S>) => unknown; equals?: (a: unknown, b: unknown) => boolean }>(
      ({ input, sendBack, receive }) => {
        const selection = select(input.select, input.equals)
        const report = (value: unknown) => sendBack({ type: 'STORE.UPDATE', store: options.id, value } satisfies StoreUpdate<unknown>)
        report(selection.get())
        receive((event) => send(event))
        return selection.subscribe(report)
      },
    ),
  }

  stopSync = options.sync?.(send)
  return store
}

function sameEntities(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((entity, i) => entity === b[i])
}
