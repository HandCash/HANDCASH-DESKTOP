/**
 * Keep miners off the `internalizeAction` reply path.
 *
 * The toolbox credits a payment whose txid it has never seen only after an
 * in-line `postBeef` round: `newInternalize` → `shareReqsWithWorld(isDelayed:
 * false)` → `attemptToPostReqsToNetwork`, awaited, and a provider miss
 * restores the spent inputs and answers without storing the payment. That
 * made Arcade both the clock and the gate on every BRC-29 receive, bounce
 * refund, item settle and app `internalizeAction` — one round trip measured
 * 4.7s, and an Arcade outage turned a valid, SPV-checked payment into a
 * refusal.
 *
 * The Atomic BEEF on the call is the exchange; it is SPV-valid locally before
 * the toolbox ever reaches a miner. Miners are a propagation double-check and
 * a reject oracle, the same as for every signed send. So while an internalize
 * is in flight, a `postBeef` for exactly that subject answers `success` at
 * once and the real submission runs afterwards in the background through
 * `broadcastAtomicBeef` (durable outbox, hard-reject → ghost suppression).
 *
 * Only the toolbox's own in-line round is intercepted: wallet code that posts
 * to miners itself goes through {@link directPostBeef}, which is the service
 * as configured, never the interceptor.
 *
 * Crediting before any miner sees the body means no miner's finality gate
 * runs first, so a non-final package is refused here ({@link assertIncomingFinal}).
 */
import { Transaction } from '@bsv/sdk'
import type { Services, Wallet } from '@bsv/wallet-toolbox-client'
import { assertIncomingFinal } from './incomingFinality'

type PostBeef = Services['postBeef']

const DIRECT = new WeakMap<object, PostBeef>()
const DEFERRED = new WeakMap<object, Set<string>>()

const TXID = /^[0-9a-f]{64}$/

function normalizeTxid(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** The `postBeef` as configured, bypassing the internalize interceptor. */
export function directPostBeef(services: Services): PostBeef {
  return DIRECT.get(services) ?? services.postBeef.bind(services)
}

/** True while an `internalizeAction` for `txid` holds the miner round. */
export function isInternalizeMinerDeferred(
  services: Services,
  txid: string,
): boolean {
  return DEFERRED.get(services)?.has(normalizeTxid(txid)) ?? false
}

/** Subject txid + bytes from an `internalizeAction` request, or null. */
export function internalizeSubject(
  args: unknown,
): { txid: string; atomic: number[] } | null {
  const raw =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { tx?: unknown }).tx
      : undefined
  let atomic: number[] | null = null
  if (raw instanceof Uint8Array) atomic = Array.from(raw)
  else if (Array.isArray(raw) && raw.length > 0 && raw.every((b) => typeof b === 'number')) {
    atomic = raw as number[]
  }
  if (!atomic?.length) return null
  try {
    const txid = Transaction.fromAtomicBEEF(Uint8Array.from(atomic)).id('hex')
    return TXID.test(txid) ? { txid, atomic } : null
  } catch {
    return null
  }
}

/**
 * Install once per wallet boot. Idempotent for the same `services`.
 *
 * `broadcast` is the background propagation for a credited subject; defaults
 * to `broadcastAtomicBeef` and is injectable for tests.
 */
export function installInternalizeMinerDeferral(
  wallet: Wallet,
  services: Services,
  broadcast?: (txid: string, atomic: number[]) => Promise<unknown>,
): void {
  if (DIRECT.has(services)) return
  const original: PostBeef = services.postBeef.bind(services)
  DIRECT.set(services, original)
  const deferred = new Set<string>()
  DEFERRED.set(services, deferred)

  services.postBeef = (async (
    beef: Parameters<PostBeef>[0],
    txids: Parameters<PostBeef>[1],
    ...rest: unknown[]
  ) => {
    const ids = (Array.isArray(txids) ? txids : []).map(normalizeTxid)
    if (ids.length > 0 && ids.every((id) => deferred.has(id))) {
      console.info(
        `[internalize] miners deferred for ${ids.map((id) => id.slice(0, 12)).join(',')} — crediting from the BEEF`,
      )
      return [
        {
          name: 'internalize-deferred',
          status: 'success',
          txidResults: ids.map((txid) => ({ txid, status: 'success' })),
          notes: [],
        },
      ]
    }
    return (original as (...a: unknown[]) => ReturnType<PostBeef>)(beef, txids, ...rest)
  }) as PostBeef

  const propagate =
    broadcast ??
    (async (txid: string, atomic: number[]) => {
      const { broadcastAtomicBeef } = await import('./sendBrc29Payment')
      return broadcastAtomicBeef(txid, atomic, { skipIfOnChain: true })
    })

  const originalInternalize = wallet.internalizeAction.bind(wallet)
  const patched: Wallet['internalizeAction'] = async (args, originator) => {
    const subject = internalizeSubject(args)
    if (!subject) return originalInternalize(args, originator)
    await assertIncomingFinal(subject.atomic, () => services.getHeight())
    deferred.add(subject.txid)
    let result: Awaited<ReturnType<Wallet['internalizeAction']>>
    try {
      result = await originalInternalize(args, originator)
    } finally {
      deferred.delete(subject.txid)
    }
    void propagate(subject.txid, subject.atomic).catch((err) => {
      console.warn(
        `[internalize] ${subject.txid.slice(0, 12)}… background miner submit failed`,
        err instanceof Error ? err.message : String(err),
      )
    })
    return result
  }
  ;(wallet as { internalizeAction: Wallet['internalizeAction'] }).internalizeAction = patched
}
