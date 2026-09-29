import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A toolbox that never answers — storage held by something else.
const listOutputs = vi.fn(() => new Promise<never>(() => {}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: '02'.padEnd(66, 'a'),
    chain: 'main',
    wallet: { listOutputs },
  }),
  formatBsvSignificant: (sats: number) => `${sats} sats`,
}))

vi.mock('./marketInventory', () => ({
  cachedMarketListOutputs: (basket: unknown) =>
    basket === 'bsv21'
      ? {
          outputs: [
            {
              outpoint: `${'f'.repeat(64)}.0`,
              satoshis: 1,
              tags: [`bsv21:${'f'.repeat(64)}_0`, 'sym:HNDC', 'op:transfer'],
            },
          ],
          totalOutputs: 1,
        }
      : null,
}))

const ORIGIN = 'https://brc-cloud.bcryderman.workers.dev'

describe('listOutputs view gate never waits on the toolbox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listOutputs.mockClear()
    globalThis.localStorage?.clear?.()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names a new token prompt from the painted basket when the live read stalls', async () => {
    const { requestTokenViewApproval, subscribePermissionRequests, resolvePermission } =
      await import('./permissions')
    let prompt: { id: number; title?: string; details?: string[] } | null = null
    const unsubscribe = subscribePermissionRequests((next) => {
      prompt = next as typeof prompt
    })

    const decision = requestTokenViewApproval(ORIGIN, { basket: 'bsv21' })
    expect(listOutputs).toHaveBeenCalledTimes(1)
    // Before the fix this promise never resolved; the app saw no prompt and no reply.
    await vi.advanceTimersByTimeAsync(6_100)
    expect(prompt).not.toBeNull()
    expect(prompt!.title).toBe('View tokens')
    expect(prompt!.details?.some((line) => line.includes('HNDC'))).toBe(true)

    resolvePermission(prompt!.id, 'allow')
    await expect(decision).resolves.toBe('allow')
    unsubscribe()
  })

  it('answers a granted origin from memory — no basket read at all', async () => {
    const { requestTokenViewApproval, subscribePermissionRequests, resolvePermission } =
      await import('./permissions')
    const origin = 'https://other-demo.example'
    let prompt: { id: number } | null = null
    const unsubscribe = subscribePermissionRequests((next) => {
      prompt = next as typeof prompt
    })
    const first = requestTokenViewApproval(origin, { basket: 'bsv21' })
    await vi.advanceTimersByTimeAsync(6_100)
    resolvePermission(prompt!.id, 'allow')
    await expect(first).resolves.toBe('allow')
    listOutputs.mockClear()

    const second = requestTokenViewApproval(origin, { basket: 'bsv21' })
    await expect(second).resolves.toBe('allow')
    expect(listOutputs).not.toHaveBeenCalled()
    unsubscribe()
  })
})
