import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Telemetry } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox-client'
import { traceSlowToolboxSteps } from './toolboxTelemetry'

function tracedWallet(): { telemetry: Telemetry } {
  const wallet = {} as { telemetry: Telemetry }
  traceSlowToolboxSteps(wallet as unknown as Wallet)
  return wallet
}

function runSpan(wallet: { telemetry: Telemetry }, name: string, ms: number): void {
  let clock = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  wallet.telemetry.withSpan(name, { component: 'wallet-toolbox' }, () => {
    clock += ms
  })
}

describe('traceSlowToolboxSteps', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs a slow Toolbox step in the triage workload format', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    runSpan(tracedWallet(), 'wallet.create_action.storage_plan', 2_400)
    expect(info).toHaveBeenCalledWith('[toolbox] create_action.storage_plan done 2400ms')
  })

  it('stays quiet for fast steps', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    runSpan(tracedWallet(), 'wallet.validate_args', 3)
    expect(info).not.toHaveBeenCalled()
  })

  it('names a failed step', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const wallet = tracedWallet()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    expect(() =>
      wallet.telemetry.withSpan('wallet.create_action.process', { component: 'wallet-toolbox' }, () => {
        clock += 900
        throw new Error('refused')
      }),
    ).toThrow('refused')
    expect(info).toHaveBeenCalledWith('[toolbox] create_action.process done 900ms error')
  })
})
