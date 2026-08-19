import { describe, expect, it, vi } from 'vitest'
import { executeBurnLifecycle, type BurnExecutionEffects } from './burn'
import type { OneSatBurnPlan } from './burnPlan'

const plan: OneSatBurnPlan & { path: 'burnOneSat' } = {
  path: 'burnOneSat',
  asset: '1sat',
  inputs: [
    {
      outpoint: `${'ab'.repeat(32)}.0`,
      satoshis: 1,
      lockingScript: `76a914${'11'.repeat(20)}88ac`,
    },
  ],
  recoverSatoshis: 1,
}

function effects(): BurnExecutionEffects {
  return {
    build: vi.fn(async () => ({ reference: 'burn-ref' })),
    sign: vi.fn(async () => ({ txid: 'cd'.repeat(32) })),
    broadcast: vi.fn(async () => undefined),
    internalize: vi.fn(async () => undefined),
    relinquish: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    backup: vi.fn(),
    abort: vi.fn(async () => undefined),
  }
}

describe('executeBurnLifecycle', () => {
  it('runs signed burn effects in machine order', async () => {
    const fx = effects()
    await expect(executeBurnLifecycle(plan, fx)).resolves.toEqual({
      txid: 'cd'.repeat(32),
    })
    expect(fx.build).toHaveBeenCalledOnce()
    expect(fx.sign).toHaveBeenCalledOnce()
    expect(fx.broadcast).toHaveBeenCalledWith('cd'.repeat(32))
    expect(fx.internalize).toHaveBeenCalledWith('cd'.repeat(32))
    expect(fx.relinquish).toHaveBeenCalledOnce()
    expect(fx.refresh).toHaveBeenCalledOnce()
    expect(fx.backup).toHaveBeenCalledOnce()
    expect(fx.abort).not.toHaveBeenCalled()
  })

  it('aborts the exact action reference after an execution failure', async () => {
    const fx = effects()
    vi.mocked(fx.sign).mockRejectedValueOnce(new Error('signature rejected'))
    await expect(executeBurnLifecycle(plan, fx)).rejects.toThrow(
      'signature rejected',
    )
    expect(fx.abort).toHaveBeenCalledWith('burn-ref')
    expect(fx.broadcast).not.toHaveBeenCalled()
    expect(fx.backup).not.toHaveBeenCalled()
  })

  it('never releases inputs after a burn has been signed', async () => {
    const fx = effects()
    vi.mocked(fx.broadcast).mockRejectedValueOnce(new Error('ARC unavailable'))
    await expect(executeBurnLifecycle(plan, fx)).rejects.toThrow('ARC unavailable')
    expect(fx.abort).not.toHaveBeenCalled()
  })
})
