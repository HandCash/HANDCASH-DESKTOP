import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

const { SEND_SETTLE_MS, isSendSettleGraceActive, noteSendBroadcast } = await import(
  './sendSettleGuard'
)

describe('sendSettleGuard', () => {
  beforeEach(() => {
    store.clear()
  })

  it('is inactive before any send', () => {
    expect(isSendSettleGraceActive()).toBe(false)
  })

  it('holds the release for the settle window after a broadcast', () => {
    const at = 1_000_000
    vi.useFakeTimers()
    vi.setSystemTime(at)
    noteSendBroadcast('a'.repeat(64))
    vi.useRealTimers()

    expect(isSendSettleGraceActive(at)).toBe(true)
    expect(isSendSettleGraceActive(at + SEND_SETTLE_MS - 1)).toBe(true)
    expect(isSendSettleGraceActive(at + SEND_SETTLE_MS)).toBe(false)
  })

  it('survives a reload — the window lives in durable storage', async () => {
    const at = 2_000_000
    vi.useFakeTimers()
    vi.setSystemTime(at)
    noteSendBroadcast()
    vi.useRealTimers()

    vi.resetModules()
    const reloaded = await import('./sendSettleGuard')
    expect(reloaded.isSendSettleGraceActive(at + 1_000)).toBe(true)
  })

  it('records a send with no txid — the change still needs protecting', () => {
    const at = 3_000_000
    vi.useFakeTimers()
    vi.setSystemTime(at)
    noteSendBroadcast(undefined)
    vi.useRealTimers()

    expect(isSendSettleGraceActive(at + 1)).toBe(true)
  })

  it('does not stay open forever when the clock moves backwards', () => {
    const at = 4_000_000
    vi.useFakeTimers()
    vi.setSystemTime(at)
    noteSendBroadcast()
    vi.useRealTimers()

    expect(isSendSettleGraceActive(at - 60_000)).toBe(false)
  })

  it('ignores unusable stored state', () => {
    store.set('handcash.send.lastBroadcast.v1', 'not json')
    expect(isSendSettleGraceActive()).toBe(false)
  })
})
