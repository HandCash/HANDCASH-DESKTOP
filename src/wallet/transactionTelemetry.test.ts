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
  beginTransactionTrace,
  flushTransactionTelemetry,
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
