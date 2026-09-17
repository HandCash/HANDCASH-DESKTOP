import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The OS keeps one presence prompt on screen. A second `promptPresence` while
 * one is open answers the loser `cancelled`, which the lock screen reads as the
 * user declining — so overlapping callers must share a single prompt.
 */
describe('deviceAuthUnlock', () => {
  beforeEach(() => {
    vi.resetModules()
    // @ts-expect-error test bridge
    delete globalThis.window
  })

  it('serves overlapping callers from one native prompt', async () => {
    let calls = 0
    let release: ((secret: string) => void) | null = null
    // @ts-expect-error test bridge
    globalThis.window = {
      handcash: {
        deviceAuthUnlock: () => {
          calls += 1
          return new Promise<{ ok: true; secret: string }>((resolve) => {
            release = (secret) => resolve({ ok: true, secret })
          })
        },
      },
    }

    const { deviceAuthUnlock } = await import('./deviceAuth.js')
    const first = deviceAuthUnlock('Unlock HandCash')
    const second = deviceAuthUnlock('Unlock HandCash')
    expect(calls).toBe(1)

    release!('dek-b64')
    expect(await first).toEqual({ ok: true, secret: 'dek-b64' })
    expect(await second).toEqual({ ok: true, secret: 'dek-b64' })
  })

  it('prompts again once the previous prompt has settled', async () => {
    let calls = 0
    // @ts-expect-error test bridge
    globalThis.window = {
      handcash: {
        deviceAuthUnlock: async () => {
          calls += 1
          return { ok: true as const, secret: `dek-${calls}` }
        },
      },
    }

    const { deviceAuthUnlock } = await import('./deviceAuth.js')
    expect(await deviceAuthUnlock()).toEqual({ ok: true, secret: 'dek-1' })
    expect(await deviceAuthUnlock()).toEqual({ ok: true, secret: 'dek-2' })
    expect(calls).toBe(2)
  })

  it('does not strand later callers when a prompt is declined', async () => {
    let calls = 0
    // @ts-expect-error test bridge
    globalThis.window = {
      handcash: {
        deviceAuthUnlock: async () => {
          calls += 1
          if (calls === 1) return { ok: false as const, error: 'cancelled' }
          return { ok: true as const, secret: 'dek-b64' }
        },
      },
    }

    const { deviceAuthUnlock } = await import('./deviceAuth.js')
    expect(await deviceAuthUnlock()).toEqual({ ok: false, error: 'cancelled' })
    expect(await deviceAuthUnlock()).toEqual({ ok: true, secret: 'dek-b64' })
  })

  it('reports a thrown bridge error to every waiting caller', async () => {
    // @ts-expect-error test bridge
    globalThis.window = {
      handcash: {
        deviceAuthUnlock: async () => {
          throw new Error('keychain unavailable')
        },
      },
    }

    const { deviceAuthUnlock } = await import('./deviceAuth.js')
    const first = deviceAuthUnlock()
    const second = deviceAuthUnlock()
    expect(await first).toEqual({ ok: false, error: 'keychain unavailable' })
    expect(await second).toEqual({ ok: false, error: 'keychain unavailable' })
  })
})
