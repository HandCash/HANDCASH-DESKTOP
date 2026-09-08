import { APP_VERSION } from '../version'
import { durableGetItem, durableSetItem } from './durableStorage'
import { freshMessageboxAuthHeaders } from './messageboxAuth'
import { getActiveWallet } from './session'
import { DEFAULT_BRC_CLOUD_BASE_URL } from './walletConfig'
import { logDiag } from './diagnosticLog'

const QUEUE_KEY = 'handcash.wallet.transactionTelemetry.v1'
const HISTORY_KEY = 'handcash.wallet.transactionTelemetryDurations.v1'
const MAX_QUEUE = 500
const MAX_HISTORY_PER_FLOW = 50
const BATCH_SIZE = 50

export type TransactionFlow =
  | 'p2pkh'
  | 'brc29'
  | 'item_transfer'
  | 'token_transfer'
  | 'burn'
  | 'market_listing'
  | 'market_cancel'
  | 'market_purchase'
  | 'consolidation'
  | 'inbound_internalization'
  | 'brc100_action'
  | 'payment'

export type TransactionStage =
  | 'requested'
  | 'preparing'
  | 'building'
  | 'signing'
  | 'signed'
  | 'propagation_queued'
  | 'provider_attempt'
  | 'provider_accepted'
  | 'peer_delivery_queued'
  | 'peer_delivered'
  | 'mempool_seen'
  | 'mined'
  | 'hard_rejected'
  | 'retry_exhausted'
  | 'completed'

export type TransactionTelemetryEvent = {
  eventId: string
  traceId: string
  requestId: string
  flow: TransactionFlow
  stage: TransactionStage
  outcome?: 'active' | 'completed' | 'hard_rejected' | 'retry_exhausted'
  occurredAt: number
  durationMs?: number
  queueWaitMs?: number
  projectedRemainingMs?: number
  provider?: string
  blockerCode?: string
  retryCount?: number
  txidPrefix?: string
  platform: string
  appVersion: string
}

type ActiveTrace = {
  traceId: string
  requestId: string
  flow: TransactionFlow
  startedAt: number
  stageAt: number
}

type DurationHistory = Record<string, number[]>

let activeTrace: ActiveTrace | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushInFlight: Promise<void> | null = null

function id(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${random}`
}

function platformTag(): string {
  if (typeof window === 'undefined') return 'node'
  const declared = window.handcash?.platform
  if (typeof declared === 'string' && declared) return declared
  if (typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)) {
    return 'android'
  }
  return 'web'
}

function readQueue(): TransactionTelemetryEvent[] {
  try {
    const parsed = JSON.parse(durableGetItem(QUEUE_KEY) || '[]') as unknown
    return Array.isArray(parsed) ? (parsed as TransactionTelemetryEvent[]) : []
  } catch {
    return []
  }
}

function writeQueue(events: TransactionTelemetryEvent[]): void {
  durableSetItem(QUEUE_KEY, JSON.stringify(events.slice(-MAX_QUEUE)))
}

function readHistory(): DurationHistory {
  try {
    const parsed = JSON.parse(durableGetItem(HISTORY_KEY) || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DurationHistory)
      : {}
  } catch {
    return {}
  }
}

function rememberCompletedDuration(flow: TransactionFlow, durationMs: number): void {
  const history = readHistory()
  const values = Array.isArray(history[flow]) ? history[flow]! : []
  history[flow] = [...values, durationMs].slice(-MAX_HISTORY_PER_FLOW)
  durableSetItem(HISTORY_KEY, JSON.stringify(history))
}

function projectedRemaining(flow: TransactionFlow, elapsedMs: number): number | undefined {
  const values = readHistory()[flow]
  if (!Array.isArray(values) || values.length < 5) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  return Math.max(0, median - elapsedMs)
}

function enqueue(event: TransactionTelemetryEvent): void {
  const queue = readQueue()
  queue.push(event)
  writeQueue(queue)
  logDiag('tx-trace', event.blockerCode ? 'warn' : 'info', event.stage, {
    traceId: event.traceId,
    flow: event.flow,
    durationMs: event.durationMs,
    etaMs: event.projectedRemainingMs,
    provider: event.provider,
    blocker: event.blockerCode,
    retry: event.retryCount,
    txid: event.txidPrefix,
  })
  scheduleTransactionTelemetryFlush()
}

export function beginTransactionTrace(
  flow: TransactionFlow,
  requestId = id('request'),
): string {
  const now = Date.now()
  const traceId = id('trace')
  activeTrace = { traceId, requestId, flow, startedAt: now, stageAt: now }
  enqueue({
    eventId: id('event'),
    traceId,
    requestId,
    flow,
    stage: 'requested',
    outcome: 'active',
    occurredAt: now,
    platform: platformTag(),
    appVersion: APP_VERSION,
  })
  return traceId
}

export function activeTransactionTrace(): ActiveTrace | null {
  return activeTrace ? { ...activeTrace } : null
}

export function recordTransactionStage(
  stage: TransactionStage,
  fields: {
    flow?: TransactionFlow
    traceId?: string
    requestId?: string
    provider?: string
    blockerCode?: string
    retryCount?: number
    queueWaitMs?: number
    txid?: string
    outcome?: TransactionTelemetryEvent['outcome']
  } = {},
): void {
  const now = Date.now()
  const trace =
    activeTrace && (!fields.traceId || fields.traceId === activeTrace.traceId)
      ? activeTrace
      : null
  const flow = fields.flow ?? trace?.flow ?? 'payment'
  const traceId = fields.traceId ?? trace?.traceId ?? id('trace')
  const requestId = fields.requestId ?? trace?.requestId ?? id('request')
  const durationMs = trace ? Math.max(0, now - trace.stageAt) : undefined
  const elapsedMs = trace ? Math.max(0, now - trace.startedAt) : 0
  const outcome =
    fields.outcome ??
    (stage === 'completed'
      ? 'completed'
      : stage === 'hard_rejected'
        ? 'hard_rejected'
        : stage === 'retry_exhausted'
          ? 'retry_exhausted'
          : 'active')
  enqueue({
    eventId: id('event'),
    traceId,
    requestId,
    flow,
    stage,
    outcome,
    occurredAt: now,
    durationMs,
    queueWaitMs: fields.queueWaitMs,
    projectedRemainingMs: projectedRemaining(flow, elapsedMs),
    provider: fields.provider?.slice(0, 60),
    blockerCode: fields.blockerCode?.slice(0, 80),
    retryCount: fields.retryCount,
    txidPrefix: /^[0-9a-f]{64}$/i.test(fields.txid || '')
      ? fields.txid!.slice(0, 12).toLowerCase()
      : undefined,
    platform: platformTag(),
    appVersion: APP_VERSION,
  })
  if (trace) trace.stageAt = now
  if (
    trace &&
    (stage === 'completed' || stage === 'hard_rejected' || stage === 'retry_exhausted')
  ) {
    if (stage === 'completed') rememberCompletedDuration(flow, elapsedMs)
    activeTrace = null
  }
}

export function recordPaymentProgressStage(
  flow: TransactionFlow,
  stage: 'preparing' | 'building' | 'signing' | 'broadcasting' | 'finishing',
): void {
  if (!activeTrace) beginTransactionTrace(flow)
  else activeTrace.flow = flow
  const mapped: TransactionStage =
    stage === 'broadcasting'
      ? 'provider_attempt'
      : stage === 'finishing'
        ? 'signed'
        : stage
  recordTransactionStage(mapped, { flow })
}

export async function flushTransactionTelemetry(): Promise<void> {
  if (flushInFlight) return flushInFlight
  const run = (async () => {
    const active = getActiveWallet()
    const base = DEFAULT_BRC_CLOUD_BASE_URL.trim().replace(/\/+$/, '')
    const queued = readQueue()
    if (!active?.rootKeyHex || !base || queued.length === 0) return
    const batch = queued.slice(0, BATCH_SIZE)
    const response = await fetch(`${base}/v1/telemetry/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...freshMessageboxAuthHeaders({
          rootKeyHex: active.rootKeyHex,
          method: 'sendMessage',
          messageBox: 'telemetry',
        }),
      },
      body: JSON.stringify({ version: 1, events: batch }),
    })
    if (!response.ok) {
      throw new Error(`telemetry HTTP ${response.status}`)
    }
    const sent = new Set(batch.map((event) => event.eventId))
    writeQueue(readQueue().filter((event) => !sent.has(event.eventId)))
  })()
  flushInFlight = run.then(
    () => {
      flushInFlight = null
    },
    (error) => {
      flushInFlight = null
      throw error
    },
  )
  return flushInFlight
}

export function scheduleTransactionTelemetryFlush(delayMs = 750): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushTransactionTelemetry().catch((error) => {
      console.warn(
        '[tx-trace] flush deferred',
        error instanceof Error ? error.message : String(error),
      )
    })
  }, delayMs)
}

export function __resetTransactionTelemetryForTests(): void {
  activeTrace = null
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  flushInFlight = null
  durableSetItem(QUEUE_KEY, '[]')
  durableSetItem(HISTORY_KEY, '{}')
}
