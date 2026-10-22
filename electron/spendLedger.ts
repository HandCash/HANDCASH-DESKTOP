import { createHash } from 'node:crypto'

/**
 * One wallet run per spend request, so a retry after a timeout cannot pay twice.
 *
 * A spend that outlives its deadline is answered `WALLET_BRIDGE_PENDING` and
 * keeps running in the wallet. The same request again (same origin, path and
 * body) joins that run while it lasts and, once it ends, gets its result a
 * single time instead of starting a second payment. A run whose caller got its
 * answer is forgotten, so a deliberate repeat payment still goes through.
 */

export type BridgeReply = { status: number; body: string }

export const UNCLAIMED_SPEND_TTL_MS = 15 * 60_000

type Run = {
  requestId: number
  orphaned: boolean
  lost: BridgeReply | null
  settled: BridgeReply | null
  waiters: Set<(reply: BridgeReply) => void>
  /** When the run last stopped having a caller of its own. */
  idleSince: number | null
}

export type SpendBegin =
  | { kind: 'dispatch' }
  | { kind: 'join'; reply: Promise<BridgeReply>; leave: () => void }
  | { kind: 'replay'; reply: BridgeReply }

export function spendRequestKey(origin: string | undefined, path: string, body: string): string {
  return createHash('sha256').update(`${origin ?? ''}\n${path}\n${body}`).digest('hex')
}

export class SpendLedger {
  private readonly runs = new Map<string, Run>()
  private readonly keyById = new Map<number, string>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = UNCLAIMED_SPEND_TTL_MS,
  ) {}

  begin(key: string, requestId: number): SpendBegin {
    this.prune()
    const run = this.runs.get(key)
    if (!run) {
      this.runs.set(key, {
        requestId,
        orphaned: false,
        lost: null,
        settled: null,
        waiters: new Set(),
        idleSince: null,
      })
      this.keyById.set(requestId, key)
      return { kind: 'dispatch' }
    }
    if (run.settled) {
      this.forget(key)
      return { kind: 'replay', reply: run.settled }
    }
    if (run.lost) return { kind: 'replay', reply: run.lost }
    let waiter!: (reply: BridgeReply) => void
    const reply = new Promise<BridgeReply>((resolve) => {
      waiter = resolve
    })
    run.waiters.add(waiter)
    return { kind: 'join', reply, leave: () => run.waiters.delete(waiter) }
  }

  /** The wallet answered the run this request started. */
  settle(requestId: number, reply: BridgeReply): void {
    const key = this.keyById.get(requestId)
    const run = key ? this.runs.get(key) : undefined
    if (!key || !run) return
    const claimed = run.waiters.size > 0
    for (const waiter of run.waiters) waiter(reply)
    run.waiters.clear()
    if (claimed && run.orphaned) {
      this.forget(key)
      return
    }
    run.settled = reply
    if (run.orphaned) run.idleSince = this.now()
  }

  /** The caller that started the run was answered pending, or hung up. */
  orphan(requestId: number): void {
    const run = this.runOf(requestId)
    if (!run || run.orphaned) return
    run.orphaned = true
    run.idleSince = this.now()
  }

  /** The caller that started the run received its answer. */
  done(requestId: number): void {
    const key = this.keyById.get(requestId)
    if (key) this.forget(key)
  }

  /**
   * The wallet went away with runs unanswered: whether they paid is unknown, so
   * every caller of them, now and until they expire, gets `reply`.
   */
  loseAll(reply: BridgeReply): void {
    for (const run of this.runs.values()) {
      if (run.settled) continue
      for (const waiter of run.waiters) waiter(reply)
      run.waiters.clear()
      run.lost = reply
      run.orphaned = true
      run.idleSince = this.now()
    }
  }

  private runOf(requestId: number): Run | undefined {
    const key = this.keyById.get(requestId)
    return key ? this.runs.get(key) : undefined
  }

  private forget(key: string): void {
    const run = this.runs.get(key)
    if (!run) return
    this.runs.delete(key)
    this.keyById.delete(run.requestId)
  }

  private prune(): void {
    const now = this.now()
    for (const [key, run] of this.runs) {
      if (run.orphaned && run.waiters.size === 0 && run.idleSince !== null && now - run.idleSince > this.ttlMs) {
        this.forget(key)
      }
    }
  }
}
