/**
 * Complete Arcade (bsv-blockchain/arcade) integration for the BRC wallet.
 *
 * Wires:
 * - Shared X-CallbackToken on Services (broadcast) + Monitor (SSE)
 * - EventSource polyfill with header support for /events
 * - SSE / onTransactionStatusChanged → applyDualLayerArc (existing interface)
 *
 * Legacy ARC is not used for BRC wallet broadcasts (Cloud keeps it for free consolidations).
 */
import { EventSource } from 'eventsource'
import { parseArcStatus } from './arcStatusMap'
import { durableGetItem, durableSetItem } from './durableStorage'
import { applyDualLayerArc, tryFinalizeDualLayerTx } from './dualLayerSend'
import { getTxByTxid } from './txStore'

const CALLBACK_TOKEN_KEY = 'handcash.arcade.callbackToken.v1'
const LAST_EVENT_ID_KEY = 'handcash.arcade.sse.lastEventId.v1'

/** Stable per-install token — must match X-CallbackToken on Arcade POST /tx. */
export function getOrCreateArcadeCallbackToken(): string {
  const existing = durableGetItem(CALLBACK_TOKEN_KEY)
  if (existing && existing.length >= 16) return existing
  const token =
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `${crypto.randomUUID()}${crypto.randomUUID()}`
      : `${Date.now()}-${Math.random()}`
    ).replace(/-/g, '')
  durableSetItem(CALLBACK_TOKEN_KEY, token)
  return token
}

/**
 * Adapter for toolbox TaskArcadeSSE / ArcSSEClient.
 * ArcSSEClient constructs `new EventSourceClass(url, { headers, … })` (RN-SSE shape).
 * eventsource@3 takes headers via a custom `fetch` instead.
 */
export function createArcadeEventSourceClass(): new (
  url: string,
  init?: { headers?: Record<string, string>; debug?: boolean; pollingInterval?: number },
) => EventSource {
  return class ArcadeEventSource extends EventSource {
    constructor(
      url: string,
      init?: { headers?: Record<string, string>; debug?: boolean; pollingInterval?: number },
    ) {
      const extra = init?.headers ?? {}
      super(url, {
        fetch: (input, initDict) => {
          const merged = new Headers(initDict?.headers as HeadersInit | undefined)
          for (const [key, value] of Object.entries(extra)) {
            if (value != null && value !== '') merged.set(key, value)
          }
          return fetch(input, { ...initDict, headers: merged })
        },
      })
    }
  }
}

/**
 * Forward Arcade SSE / monitor status into the dual-layer confirmation interface.
 * Does not treat SSE MINED as hard finality — still runs SPV finalize.
 */
export async function onArcadeTransactionStatusChanged(
  txid: string,
  newStatus: string,
): Promise<void> {
  const id = txid?.toLowerCase?.() ?? txid
  const rec = getTxByTxid(id)
  if (!rec) {
    console.info('[arcade] status for untracked txid', id, newStatus)
    return
  }

  applyDualLayerArc(rec.id, newStatus)

  const parsed = parseArcStatus(newStatus)
  if (
    parsed === 'SEEN_ON_NETWORK' ||
    parsed === 'MINED' ||
    /SEEN_MULTIPLE_NODES|ACCEPTED_BY_NETWORK|IMMUTABLE/i.test(newStatus)
  ) {
    void tryFinalizeDualLayerTx(rec.id)
  }
}

type ArcadeMonitor = {
  options: {
    callbackToken?: string
    EventSourceClass?: unknown
    loadLastSSEEventId?: () => Promise<string | undefined>
    saveLastSSEEventId?: (lastEventId: string) => Promise<void>
  }
  onTransactionStatusChanged?: (txid: string, newStatus: string) => Promise<void>
  services?: unknown
  fetchSSEEvents?: () => Promise<number>
}

/** Attach SSE + status bridge on the live toolbox Monitor (before startTasks). */
export function wireArcadeMonitor(monitor: unknown, token: string): void {
  const m = monitor as ArcadeMonitor | null | undefined
  if (!m?.options) return

  m.options.callbackToken = token
  m.options.EventSourceClass = createArcadeEventSourceClass()
  m.options.loadLastSSEEventId = async () => {
    const id = durableGetItem(LAST_EVENT_ID_KEY)
    return id || undefined
  }
  m.options.saveLastSSEEventId = async (lastEventId: string) => {
    if (lastEventId) durableSetItem(LAST_EVENT_ID_KEY, lastEventId)
  }
  m.onTransactionStatusChanged = onArcadeTransactionStatusChanged
  console.info('[arcade] monitor SSE + dual-layer status bridge enabled')
}

export async function fetchArcadeStatusEvents(
  monitor: ArcadeMonitor | null | undefined,
): Promise<number> {
  if (!monitor || typeof monitor.fetchSSEEvents !== 'function') return 0
  try {
    return await monitor.fetchSSEEvents()
  } catch (err) {
    console.warn('[arcade] fetchSSEEvents failed', err)
    return 0
  }
}
