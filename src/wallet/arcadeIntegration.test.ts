import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./durableStorage', () => {
  const store = new Map<string, string>()
  return {
    durableGetItem: (key: string) => store.get(key) ?? null,
    durableSetItem: (key: string, value: string) => {
      store.set(key, value)
      return true
    },
  }
})

vi.mock('./dualLayerSend', () => ({
  applyDualLayerArc: vi.fn(),
  tryFinalizeDualLayerTx: vi.fn(async () => null),
}))

vi.mock('./txStore', () => ({
  getTxByTxid: vi.fn(),
}))

import { applyDualLayerArc, tryFinalizeDualLayerTx } from './dualLayerSend'
import { getTxByTxid } from './txStore'
import {
  getOrCreateArcadeCallbackToken,
  onArcadeTransactionStatusChanged,
  wireArcadeMonitor,
} from './arcadeIntegration'
import { parseArcStatus } from './arcStatusMap'

describe('arcadeIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists a stable callback token', () => {
    const a = getOrCreateArcadeCallbackToken()
    const b = getOrCreateArcadeCallbackToken()
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(16)
  })

  it('forwards Arcade SSE status into dual-layer by txid', async () => {
    vi.mocked(getTxByTxid).mockReturnValue({
      id: 'local-1',
      txid: 'abc',
      status: 'BROADCASTING',
    } as never)

    await onArcadeTransactionStatusChanged('ABC', 'SEEN_ON_NETWORK')

    expect(applyDualLayerArc).toHaveBeenCalledWith('local-1', 'SEEN_ON_NETWORK')
    expect(tryFinalizeDualLayerTx).toHaveBeenCalledWith('local-1')
  })

  it('ignores statuses for txids not in dual-layer store', async () => {
    vi.mocked(getTxByTxid).mockReturnValue(null)

    await onArcadeTransactionStatusChanged('missing', 'REJECTED')

    expect(applyDualLayerArc).not.toHaveBeenCalled()
  })

  it('wires monitor SSE options onto the existing Monitor interface', () => {
    const monitor = {
      options: {} as {
        callbackToken?: string
        EventSourceClass?: unknown
        loadLastSSEEventId?: () => Promise<string | undefined>
        saveLastSSEEventId?: (id: string) => Promise<void>
      },
    }
    wireArcadeMonitor(monitor, 'token-xyz')
    expect(monitor.options.callbackToken).toBe('token-xyz')
    expect(typeof monitor.options.EventSourceClass).toBe('function')
    expect(typeof monitor.options.loadLastSSEEventId).toBe('function')
    expect(typeof monitor.options.saveLastSSEEventId).toBe('function')
  })
})

describe('Arcade status map', () => {
  it('maps Arcade lifecycle codes into ArcStatus', () => {
    expect(parseArcStatus('RECEIVED')).toBe('STORED')
    expect(parseArcStatus('ACCEPTED_BY_NETWORK')).toBe('ANNOUNCED_TO_NETWORK')
    expect(parseArcStatus('SEEN_MULTIPLE_NODES')).toBe('SEEN_ON_NETWORK')
    expect(parseArcStatus('IMMUTABLE')).toBe('MINED')
  })
})
