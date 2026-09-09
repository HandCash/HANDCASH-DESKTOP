import { describe, expect, it, vi, beforeEach } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }),
}))

describe('spendLease', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.unstubAllGlobals()
    store.set(
      'handcash.brc100.historyBackup.v1',
      JSON.stringify({ baseUrl: 'https://backup.example', lastUploadedAt: null, lastError: null }),
    )
    store.set('handcash.brc100.deviceId.v1', 'local-device')
  })

  it('blocks when another device holds an active lease', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input)
        if (url.includes('spend-lease') && !url.includes('PUT')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              v: 1,
              identityKey:
                '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              deviceId: 'other-device',
              label: 'Phone',
              until: Date.now() + 30_000,
            }),
          }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      }),
    )

    const { acquireSpendLease } = await import('./spendLease')
    await expect(acquireSpendLease()).rejects.toThrow(/Phone is sending/i)
  })

  it('acquires and releases when host is free', async () => {
    const state: {
      lease: {
        deviceId?: string
        until?: number
        released?: boolean
      } | null
    } = { lease: null }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input)
        if (!url.includes('spend-lease')) {
          return { ok: true, status: 200, json: async () => ({}) }
        }
        if ((init?.method ?? 'GET') === 'PUT') {
          state.lease = JSON.parse(String(init?.body ?? '{}')) as NonNullable<
            typeof state.lease
          >
          return { ok: true, status: 200, json: async () => ({}) }
        }
        if (!state.lease || state.lease.until === 0) {
          return { ok: false, status: 404, json: async () => ({}) }
        }
        return { ok: true, status: 200, json: async () => state.lease }
      }),
    )

    const { acquireSpendLease } = await import('./spendLease')
    const release = await acquireSpendLease()
    expect(state.lease?.deviceId).toBe('local-device')
    await release()
    expect(
      state.lease?.released === true ||
        state.lease?.until === 0 ||
        state.lease?.deviceId === '',
    ).toBe(true)
  })

  it('bounds a stalled release so the spend coordinator can continue', async () => {
    vi.useFakeTimers()
    try {
      let call = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
          call += 1
          if (call === 1) {
            return { ok: false, status: 404, json: async () => ({}) }
          }
          if (call === 2) {
            return { ok: true, status: 200, json: async () => ({}) }
          }
          if (call === 3) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                v: 1,
                identityKey:
                  '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                deviceId: 'local-device',
                label: 'This device',
                until: Date.now() + 45_000,
              }),
            }
          }
          return await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          })
        }),
      )
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { acquireSpendLease } = await import('./spendLease')
      const release = await acquireSpendLease()
      const releasing = release()
      await vi.advanceTimersByTimeAsync(2_100)

      await expect(releasing).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
