/**
 * Enough of a browser for toolbox IndexedDB + durableStorage in Node.
 * Used by the live send/receive harness — not by unit tests.
 */
const STORE = Symbol.for('handcash.headless-storage')

class MemoryStorage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value))
  }
}

function memoryStorage(): MemoryStorage {
  const g = globalThis as unknown as { [STORE]?: MemoryStorage }
  if (!g[STORE]) g[STORE] = new MemoryStorage()
  return g[STORE]
}

/** Idempotent. Safe to call from a Vitest setup file. */
export function installHeadlessDom(): void {
  const g = globalThis as typeof globalThis & { __hcHeadlessDom?: boolean }
  if (g.__hcHeadlessDom) return
  g.__hcHeadlessDom = true

  const storage = memoryStorage() as unknown as Storage
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  const addEventListener = (
    type: string,
    fn: EventListenerOrEventListenerObject,
  ) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(fn)
  }
  const removeEventListener = (
    type: string,
    fn: EventListenerOrEventListenerObject,
  ) => {
    listeners.get(type)?.delete(fn)
  }

  const navigatorLike = {
    onLine: true,
    userAgent: 'HandCash-headless',
    platform: 'headless',
    language: 'en-US',
  }

  const documentLike = {
    addEventListener,
    removeEventListener,
    dispatchEvent: () => true,
    hidden: false,
    visibilityState: 'visible',
  }

  Object.assign(g, {
    localStorage: storage,
    sessionStorage: storage,
    window: g,
    self: g,
    document: documentLike,
    addEventListener,
    removeEventListener,
    dispatchEvent: () => true,
  })

  try {
    Object.defineProperty(g, 'navigator', {
      configurable: true,
      get: () => navigatorLike,
    })
  } catch {
    // Node may already expose navigator.
  }
  try {
    if (typeof navigator !== 'undefined') {
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => true,
      })
    }
  } catch {
    // ignore
  }
}
