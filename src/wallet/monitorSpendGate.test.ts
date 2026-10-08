import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spend = vi.hoisted(() => ({ needs: false }))
vi.mock('./walletCoordinator', () => ({
  spendNeedsStorage: () => spend.needs,
}))

import { gateMonitorTasksOnSpend, resetMonitorSpendGateForTests } from './monitorSpendGate'

function fakeMonitor() {
  const ran: string[] = []
  const monitor = {
    async runScheduledTask(task: { name: string; lastRunMsecsSinceEpoch?: number }) {
      ran.push(task.name)
      task.lastRunMsecsSinceEpoch = Date.now()
    },
  }
  return { monitor, ran }
}

describe('monitor tasks yield to a send', () => {
  let info: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    spend.needs = false
    resetMonitorSpendGateForTests()
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })
  afterEach(() => info.mockRestore())

  it('skips a due task while a send needs the wallet and leaves it due', async () => {
    const { monitor, ran } = fakeMonitor()
    gateMonitorTasksOnSpend(monitor)
    const task = { name: 'ReviewStatus' } as { name: string; lastRunMsecsSinceEpoch?: number }
    spend.needs = true
    await monitor.runScheduledTask(task)
    await monitor.runScheduledTask(task)
    expect(ran).toEqual([])
    expect(task.lastRunMsecsSinceEpoch).toBeUndefined()
    expect(info.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      '[monitor] ReviewStatus deferred — a send needs the wallet',
    ])

    spend.needs = false
    await monitor.runScheduledTask(task)
    expect(ran).toEqual(['ReviewStatus'])
    expect(info.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(
      '[monitor] resumed after send — 1 task(s) were deferred',
    )
  })

  it('runs tasks untouched when no send is waiting and installs once', async () => {
    const { monitor, ran } = fakeMonitor()
    gateMonitorTasksOnSpend(monitor)
    gateMonitorTasksOnSpend(monitor)
    await monitor.runScheduledTask({ name: 'NewHeader' })
    expect(ran).toEqual(['NewHeader'])
    expect(info).not.toHaveBeenCalled()
  })
})
