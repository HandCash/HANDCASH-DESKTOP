import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))
vi.mock('./session', () => ({
  getActiveWallet: () => ({ rootKeyHex: '11'.repeat(32) }),
}))
vi.mock('./messageboxAuth', () => ({
  freshMessageboxAuthHeaders: () => ({}),
}))
// `import.meta.env.DEV` is true under vitest, which blanks the real base URL.
vi.mock('./walletConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./walletConfig')>()),
  DEFAULT_BRC_CLOUD_BASE_URL: 'https://sink.test',
}))

import {
  __resetTransactionTelemetryForTests,
  activeTransactionTrace,
  beginTransactionTrace,
  bindTransactionTrace,
  flushTransactionTelemetry,
  recordPaymentProgressStage,
  recordTransactionStage,
} from './transactionTelemetry'

const QUEUE_KEY = 'handcash.wallet.transactionTelemetry.v1'

function queueDepth(): number {
  return (JSON.parse(store.get(QUEUE_KEY) || '[]') as unknown[]).length
}

describe('transactionTelemetry sink', () => {
  beforeEach(() => {
    store.clear()
    __resetTransactionTelemetryForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops the queue and stops dialling a 404 sink', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    beginTransactionTrace('payment')
    expect(queueDepth()).toBeGreaterThan(0)

    await flushTransactionTelemetry()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(queueDepth()).toBe(0)

    beginTransactionTrace('payment')
    await flushTransactionTelemetry()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the queue and keeps retrying a 500 sink', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    beginTransactionTrace('payment')
    const depth = queueDepth()
    expect(depth).toBeGreaterThan(0)

    await expect(flushTransactionTelemetry()).rejects.toThrow(/telemetry HTTP 500/)
    expect(queueDepth()).toBe(depth)

    await expect(flushTransactionTelemetry()).rejects.toThrow(/telemetry HTTP 500/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('transactionTelemetry trace ownership', () => {
  type Queued = { traceId: string; flow: string; stage: string; txidPrefix?: string }
  const queued = () => JSON.parse(store.get(QUEUE_KEY) || '[]') as Queued[]
  const importLeg = 'a1'.repeat(32)
  const payment = 'b2'.repeat(32)
  const laterLeg = 'c3'.repeat(32)

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    store.clear()
    __resetTransactionTelemetryForTests()
  })

  it('keeps an open send trace off other transactions it never signed', () => {
    recordPaymentProgressStage('brc29', 'preparing')
    const trace = activeTransactionTrace()!
    // minerSubmit copies the ambient trace onto whatever it propagates.
    recordTransactionStage('provider_accepted', { traceId: trace.traceId, flow: trace.flow, txid: importLeg })
    recordPaymentProgressStage('brc29', 'broadcasting')
    bindTransactionTrace(payment)
    recordTransactionStage('provider_accepted', { traceId: trace.traceId, flow: trace.flow, txid: payment })
    recordTransactionStage('propagation_queued', { traceId: trace.traceId, flow: trace.flow, txid: laterLeg })

    const byTx = (prefix: string) => queued().find((e) => e.txidPrefix === prefix)!
    expect(byTx(importLeg.slice(0, 12))).toMatchObject({ traceId: `trace-tx-${importLeg.slice(0, 12)}`, flow: 'payment' })
    expect(byTx(payment.slice(0, 12))).toMatchObject({ traceId: trace.traceId, flow: 'brc29' })
    expect(byTx(laterLeg.slice(0, 12))).toMatchObject({ traceId: `trace-tx-${laterLeg.slice(0, 12)}`, flow: 'payment' })
  })

  it('binds a flow without an explicit bind to its first txid once it is broadcasting', () => {
    recordPaymentProgressStage('p2pkh', 'broadcasting')
    const trace = activeTransactionTrace()!
    recordTransactionStage('provider_attempt', { traceId: trace.traceId, txid: payment })
    recordTransactionStage('provider_attempt', { traceId: trace.traceId, txid: laterLeg })
    expect(activeTransactionTrace()?.txid).toBe(payment)
    expect(queued().filter((e) => e.traceId === trace.traceId).map((e) => e.txidPrefix)).not.toContain(
      laterLeg.slice(0, 12),
    )
  })
})
