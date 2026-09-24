import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A value larger than the small-key mirror cap (64KB) — e.g. Activity. */
const BIG = 'x'.repeat(200 * 1024)

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return store.size
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  })
  return store
}

async function loadDurable() {
  vi.resetModules()
  const mod = await import('./durableStorage')
  mod.__resetDurableStoreOwnerForTests()
  mod.durableForgetCached()
  return mod
}

describe('durable store ownership', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes large values to origin storage when no shell store exists', async () => {
    const local = installLocalStorage()
    vi.stubGlobal('window', { handcash: undefined })
    const { durableSetItem } = await loadDurable()

    expect(durableSetItem('handcash.brc100.appActivity', BIG)).toBe(true)
    expect(local.get('handcash.brc100.appActivity')).toBe(BIG)

    // A relaunch reads the same origin store back rather than starting empty.
    const { durableGetItem } = await loadDurable()
    expect(durableGetItem('handcash.brc100.appActivity')).toBe(BIG)
  })

  it('removes the unscoped wallet copy after account migration', async () => {
    const local = installLocalStorage()
    vi.stubGlobal('window', { handcash: undefined })
    const { durableGetItem } = await loadDurable()
    const base = 'handcash.brc150.remittance.v1'
    const scoped = `${base}:wallet:main:0:identity-root`
    local.set(base, BIG)

    expect(durableGetItem(scoped)).toBe(BIG)
    expect(local.get(scoped)).toBe(BIG)
    expect(local.has(base)).toBe(false)
  })

  it('removes a leftover legacy copy when the scoped value already exists', async () => {
    const local = installLocalStorage()
    vi.stubGlobal('window', { handcash: undefined })
    const base = 'handcash.messages.v1'
    const scoped = `${base}:wallet:main:0:identity-root`
    local.set(base, 'old')
    local.set(scoped, 'current')
    const { durableGetItem } = await loadDurable()

    expect(durableGetItem(scoped)).toBe('current')
    expect(local.has(base)).toBe(false)
  })

  it('sweeps cold legacy copies when any key in the account is read', async () => {
    const local = installLocalStorage()
    vi.stubGlobal('window', { handcash: undefined })
    const suffix = ':wallet:main:0:identity-root'
    local.set('handcash.brc100.appActivity', 'old activity')
    local.set(`handcash.brc100.appActivity${suffix}`, 'current activity')
    local.set('handcash.brc150.remittance.v1', BIG)
    local.set(`handcash.brc150.remittance.v1${suffix}`, 'current remittance')
    local.set('handcash.messages.v1', BIG)
    local.set(`handcash.messages.v1${suffix}`, 'current messages')
    const { durableGetItem } = await loadDurable()

    // Activity is the first feature mounted. Its read reclaims cold BRC-150
    // and Messages duplicates too, rather than waiting for those panels.
    expect(durableGetItem(`handcash.brc100.appActivity${suffix}`)).toBe(
      'current activity',
    )
    expect(local.has('handcash.brc100.appActivity')).toBe(false)
    expect(local.has('handcash.brc150.remittance.v1')).toBe(false)
    expect(local.has('handcash.messages.v1')).toBe(false)
    expect(local.get(`handcash.brc150.remittance.v1${suffix}`)).toBe(
      'current remittance',
    )
  })

  it('does not believe a shell that reports success and stores nothing', async () => {
    const local = installLocalStorage()
    // The mobile shell answered these to avoid a duplicate WebView write. Every
    // durable value over the mirror cap then reached no store at all.
    const setSync = vi.fn(() => true)
    vi.stubGlobal('window', {
      handcash: { storageGetSync: () => null, storageSetSync: setSync },
    })
    const { durableSetItem } = await loadDurable()

    expect(durableSetItem('handcash.brc100.appActivity', BIG)).toBe(true)
    expect(local.get('handcash.brc100.appActivity')).toBe(BIG)
  })

  it('keeps origin storage a small-key mirror when the shell really stores', async () => {
    const local = installLocalStorage()
    const shell = new Map<string, string>()
    vi.stubGlobal('window', {
      handcash: {
        storageGetSync: (key: string) => shell.get(key) ?? null,
        storageSetSync: (key: string, value: string) => {
          shell.set(key, value)
          return true
        },
      },
    })
    const { durableSetItem, durableGetItem } = await loadDurable()

    expect(durableSetItem('handcash.brc100.appActivity', BIG)).toBe(true)
    expect(shell.get('handcash.brc100.appActivity')).toBe(BIG)
    // Multi-megabyte values must not be paid for twice on the renderer thread.
    expect(local.has('handcash.brc100.appActivity')).toBe(false)

    expect(durableSetItem('handcash.appearance', 'dark')).toBe(true)
    expect(local.get('handcash.appearance')).toBe('dark')
    expect(durableGetItem('handcash.brc100.appActivity')).toBe(BIG)
  })
})
