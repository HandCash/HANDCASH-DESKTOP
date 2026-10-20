import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBoxPoller, type PolledMessage } from './boxPoller'

afterEach(() => {
  vi.useRealTimers()
})

function box(messages: PolledMessage[]) {
  const acked: string[] = []
  let lists = 0
  return {
    acked,
    get lists() {
      return lists
    },
    io: {
      list: async () => {
        lists += 1
        return messages.filter((m) => !acked.includes(m.messageId))
      },
      acknowledge: async (ids: string[]) => void acked.push(...ids),
    },
  }
}

describe('box poller', () => {
  it('handles each message once, acks what is handled and leaves what is not this install\u2019s', async () => {
    const b = box([
      { messageId: 'mine', body: 'a', sender: 'k' },
      { messageId: 'sibling', body: 'b', sender: 'k' },
    ])
    const handle = vi.fn(async (m: PolledMessage) => (m.messageId === 'sibling' ? ('leave' as const) : ('ack' as const)))
    const poller = createBoxPoller({ tag: 't', io: b.io, handle, dialing: () => false })
    await poller.poll()
    await poller.poll()
    expect(handle).toHaveBeenCalledTimes(2)
    expect(b.acked).toEqual(['mine'])
  })

  it('reads every 2.5 s, every second while dialling, and doubles the gap after failures', async () => {
    vi.useFakeTimers()
    let dialing = false
    let fail = false
    let attempts = 0
    const b = box([])
    const io = { ...b.io, list: async () => (++attempts, fail ? null : b.io.list()) }
    const poller = createBoxPoller({ tag: 't', io, handle: async () => 'ack', dialing: () => dialing })
    const after = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      return attempts
    }
    poller.start()
    expect(await after(0)).toBe(1)
    expect(await after(2_499)).toBe(1)
    expect(await after(1)).toBe(2)
    dialing = true
    poller.nudge()
    expect(await after(1_000)).toBe(3)
    expect(await after(1_000)).toBe(4)
    dialing = false
    fail = true
    expect(await after(1_000)).toBe(5)
    expect(await after(4_999)).toBe(5)
    expect(await after(1)).toBe(6)
    expect(await after(9_999)).toBe(6)
    expect(await after(1)).toBe(7)
    fail = false
    expect(await after(20_000)).toBe(8)
    expect(await after(2_500)).toBe(9)
    poller.stop()
    expect(await after(60_000)).toBe(9)
  })

  it('reads every 20 s while the window is open but unfocused', async () => {
    vi.useFakeTimers()
    let focused = false
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => focused })
    try {
      const b = box([])
      const poller = createBoxPoller({ tag: 't', io: b.io, handle: async () => 'ack', dialing: () => false })
      poller.start()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(19_999)
      expect(b.lists).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(b.lists).toBe(2)
      focused = true
      await vi.advanceTimersByTimeAsync(20_000)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(b.lists).toBe(4)
      poller.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
