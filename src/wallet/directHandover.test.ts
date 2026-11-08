import { describe, expect, it, vi } from 'vitest'
import { createDirectHandover } from './directHandover'

const identityKey = 'ab'.repeat(33)
const part = (n = 0, data = 'history') => JSON.stringify({
  v: 1, type: 'handover', identityKey, deviceId: 'source', handoverId: 'transfer',
  part: n, parts: 2, data,
})
const frame = (sealed: string) => JSON.stringify({ type: 'direct-handover', identityKey, sealed })

describe('direct history handover', () => {
  it('reassembles out of order and receipts only after merge succeeds', async () => {
    let finish!: () => void
    const merge = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const send = vi.fn(async () => 'direct' as const)
    const receiver = createDirectHandover({ send, inbox: () => ({ open: s => s, merge }) })
    await receiver.receive(frame(part(1, 'B')), 'source')
    expect(merge).not.toHaveBeenCalled()
    const receiving = receiver.receive(frame(part(0, 'A')), 'source')
    await vi.waitFor(() => expect(merge).toHaveBeenCalledWith('AB', undefined))
    expect(send).not.toHaveBeenCalled()
    finish()
    await receiving
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({ type: 'direct-handover-merged', handoverId: 'transfer' })
  })

  it('passes the custody kind to the merge and refuses a part of another kind', async () => {
    const merge = vi.fn(async () => {})
    const send = vi.fn(async () => 'direct' as const)
    const receiver = createDirectHandover({ send, inbox: () => ({ open: s => s, merge }) })
    const custody = (n: number, data: string, kind?: string) => JSON.stringify({
      ...JSON.parse(part(n, data)), handoverId: 'transfer-custody', ...(kind ? { kind } : {}),
    })
    await receiver.receive(frame(custody(0, '[1,', 'custody')), 'source')
    await receiver.receive(frame(custody(1, 'mixed')), 'source')
    expect(merge).not.toHaveBeenCalled()
    await receiver.receive(frame(custody(1, '2]', 'custody')), 'source')
    expect(merge).toHaveBeenCalledWith('[1,2]', 'custody')
  })

  it('rejects unauthenticated, non-holder, oversized and conflicting parts', async () => {
    const merge = vi.fn(async () => {})
    const send = vi.fn(async () => 'direct' as const)
    const receiver = createDirectHandover({ send, inbox: key => key === identityKey ? { open: s => s, merge } : null })
    await receiver.receive(frame(part()), 'impostor')
    await receiver.receive(JSON.stringify({ type: 'direct-handover', identityKey: 'other', sealed: part() }), 'source')
    await receiver.receive(frame(part(0, 'x'.repeat(150_001))), 'source')
    await receiver.receive(frame(part(0, 'A')), 'source')
    await receiver.receive(frame(part(0, 'conflict')), 'source')
    await receiver.receive(frame(part(1, 'B')), 'source')
    expect(merge).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('never receipts a failed merge', async () => {
    const send = vi.fn(async () => 'direct' as const)
    const receiver = createDirectHandover({ send, inbox: () => ({ open: s => s, merge: async () => { throw new Error('disk full') } }) })
    await receiver.receive(frame(part(0)), 'source')
    await expect(receiver.receive(frame(part(1)), 'source')).rejects.toThrow('disk full')
    expect(send).not.toHaveBeenCalled()
  })

  it('requires an application receipt from the intended device, not just a frame ACK', async () => {
    const sender = createDirectHandover({ send: async () => 'direct', inbox: () => null })
    let done = false
    const sending = sender.send('holder', identityKey, 'transfer', ['sealed']).then(value => { done = true; return value })
    const receipt = JSON.stringify({ type: 'direct-handover-merged', identityKey, handoverId: 'transfer' })
    await sender.receive(receipt, 'impostor')
    expect(done).toBe(false)
    await sender.receive(receipt, 'holder')
    expect(await sending).toBe(true)
  })

  it('times out without dropping the caller durable retry', async () => {
    vi.useFakeTimers()
    try {
      const sender = createDirectHandover({ send: async () => 'direct', inbox: () => null })
      const sending = sender.send('holder', identityKey, 'transfer', ['sealed'])
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await sending).toBe(false)
      sender.stop()
    } finally { vi.useRealTimers() }
  })
})
