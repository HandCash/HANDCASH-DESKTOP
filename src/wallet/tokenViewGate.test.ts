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

vi.mock('./inventoryProjection', () => ({
  heldInventoryOutputs: (basket: unknown) =>
    basket === 'bntft'
      ? {
          outputs: [
            {
              tags: ['bntft', `bntft:${'f'.repeat(40)}`],
              customInstructions: JSON.stringify({ sym: 'HNDC' }),
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

  it('names a new token prompt from the painted projection without a basket read', async () => {
    const { requestTokenViewApproval, subscribePermissionRequests, resolvePermission } =
      await import('./permissions')
    let prompt: { id: number; title?: string; details?: string[] } | null = null
    const unsubscribe = subscribePermissionRequests((next) => {
      prompt = next as typeof prompt
    })

    const decision = requestTokenViewApproval(ORIGIN, { basket: 'p bntft all' })
    await vi.advanceTimersByTimeAsync(0)
    expect(listOutputs).not.toHaveBeenCalled()
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
    const first = requestTokenViewApproval(origin, { basket: 'p bntft all' })
    await vi.advanceTimersByTimeAsync(0)
    resolvePermission(prompt!.id, 'allow')
    await expect(first).resolves.toBe('allow')
    listOutputs.mockClear()

    const second = requestTokenViewApproval(origin, { basket: 'p bntft all' })
    await expect(second).resolves.toBe('allow')
    expect(listOutputs).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stores the held token ids when a third party is allowed every token', async () => {
    const { requestTokenViewApproval, subscribePermissionRequests, resolvePermission, getTokenAccess } =
      await import('./permissions')
    const origin = 'https://all-tokens.example'
    let prompt: { id: number } | null = null
    const unsubscribe = subscribePermissionRequests((next) => {
      prompt = next as typeof prompt
    })
    const decision = requestTokenViewApproval(origin, { basket: 'p bntft all' })
    await vi.advanceTimersByTimeAsync(0)
    resolvePermission(prompt!.id, 'allow')
    await expect(decision).resolves.toBe('allow')
    const access = getTokenAccess(origin)
    expect(access.view).toBe('filtered')
    expect(access.ids).toContain('f'.repeat(40))
    unsubscribe()
  })
})
