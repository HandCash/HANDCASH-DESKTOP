/**
 * A polled signalling box, at the cadence of `webrtpay/1`'s MessageBox carrier
 * (§7.7): every 2.5 s while receiving, every second while a dial waits,
 * doubling after failures up to 30 s. Message ids are remembered, so a body is
 * handled once however often it is listed; one the handler leaves (a
 * sibling's signal) stays unacknowledged.
 */

import { DEFAULTS } from '@bsv/webrtpay'

export type PolledMessage = { messageId: string; body: string; sender: string }

export type PollIo = {
  list: () => Promise<PolledMessage[] | null>
  acknowledge: (messageIds: string[]) => Promise<void>
}

export type PollDecision = 'ack' | 'leave'

const MAX_BACKOFF_MS = 30_000
/** Reading less often while the window is hidden; dials from peers then fall back to the box. */
const HIDDEN_MS = 20_000
const MAX_SEEN = 10_000

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function createBoxPoller(o: {
  tag: string
  io: PollIo
  handle: (m: PolledMessage) => Promise<PollDecision>
  /** A dial of ours waits on this box. */
  dialing: () => boolean
  receiveMs?: number
  dialMs?: number
}) {
  const receiveMs = o.receiveMs ?? DEFAULTS.payeePollMs
  const dialMs = o.dialMs ?? DEFAULTS.payerPollMs
  const seen = new Map<string, PollDecision>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let dueAt = 0
  let running = false
  let failures = 0
  let inFlight: Promise<void> | null = null

  function remember(id: string, decision: PollDecision): void {
    seen.set(id, decision)
    if (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value!)
  }

  async function read(): Promise<void> {
    const listed = await o.io.list()
    if (!listed) {
      failures += 1
      return
    }
    failures = 0
    const ack: string[] = []
    for (const m of listed) {
      if (!m.messageId) continue
      let decision = seen.get(m.messageId)
      if (decision === undefined) {
        try {
          decision = await o.handle(m)
        } catch (err) {
          console.info(`[${o.tag}] signal failed — ${err instanceof Error ? err.message : String(err)}`)
          decision = 'ack'
        }
        remember(m.messageId, decision)
      }
      if (decision === 'ack') ack.push(m.messageId)
    }
    for (let i = 0; i < ack.length; i += 100) await o.io.acknowledge(ack.slice(i, i + 100))
  }

  function poll(): Promise<void> {
    inFlight ??= read()
      .catch((err: unknown) => {
        failures += 1
        console.info(`[${o.tag}] poll failed — ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  function delay(): number {
    if (failures > 0) return Math.min(MAX_BACKOFF_MS, receiveMs * 2 ** failures)
    if (o.dialing()) return dialMs
    return hidden() ? HIDDEN_MS : receiveMs
  }

  function schedule(ms = delay()): void {
    if (!running) return
    clearTimeout(timer)
    dueAt = Date.now() + ms
    timer = setTimeout(() => {
      void poll().finally(() => schedule())
    }, ms)
  }

  return {
    start(): void {
      if (running) return
      running = true
      schedule(0)
    },
    stop(): void {
      running = false
      clearTimeout(timer)
    },
    get running(): boolean {
      return running
    },
    /** A dial just went out: read at the dialling cadence from now. */
    nudge(): void {
      if (running && dueAt - Date.now() > dialMs) schedule(dialMs)
    },
    poll,
  }
}

export type BoxPoller = ReturnType<typeof createBoxPoller>
