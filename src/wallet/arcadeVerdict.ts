/**
 * Every miner round ends with Arcade's own answer.
 *
 * Arcade is the broadcaster that hands a transaction to Teranode and reports
 * what the network said; its acceptance is what pins the cheque and starts
 * the landing watch. The toolbox's UntilSuccess round can end without it:
 * a soft timeout on a large body moves on to the next provider, and one
 * service error moves Arcade to the back for the rest of the session. A
 * fallback's "success" then settled the post, and nothing followed the
 * transaction to the chain — import packages were accepted and never mined.
 */
import type { Services } from '@bsv/wallet-toolbox-client'
import {
  isArcadeNamedService,
  postBeefResultsArcadeAccepted,
  postBeefResultsArcadeHardReject,
  type PostBeefServiceResult,
} from './postBeefResult'

export type ArcadeRoundVerdict =
  /** Arcade accepted or named a defect — the round has its verdict. */
  | { kind: 'answered' }
  /** No Arcade broadcaster on this wallet (dev, tests). */
  | { kind: 'not-configured' }
  | { kind: 'missing'; reason: 'not-asked' | 'timed-out' | 'service-error' | 'no-verdict' }

type ArcadeEntry = {
  name: string
  service: (beef: unknown, txids: string[]) => Promise<unknown>
}

function arcadeEntry(services: Services | null | undefined): ArcadeEntry | null {
  const list = (
    services as unknown as { postBeefServices?: { services?: ArcadeEntry[] } } | null | undefined
  )?.postBeefServices?.services
  if (!Array.isArray(list)) return null
  return list.find((s) => isArcadeNamedService(s.name) && typeof s.service === 'function') ?? null
}

export function arcadeRoundVerdict(
  results: PostBeefServiceResult[],
  configured: boolean,
): ArcadeRoundVerdict {
  if (!configured) return { kind: 'not-configured' }
  if (postBeefResultsArcadeAccepted(results) || postBeefResultsArcadeHardReject(results)) {
    return { kind: 'answered' }
  }
  const arcade = results.filter((r) => isArcadeNamedService(r.name))
  if (arcade.length === 0) return { kind: 'missing', reason: 'not-asked' }
  const rows = arcade.flatMap((r) => r.txidResults ?? [])
  if (rows.some((t) => (t.notes ?? []).some((n) => n.what === 'postBeefServiceTimeout'))) {
    return { kind: 'missing', reason: 'timed-out' }
  }
  if (arcade.some((r) => r.error) || (rows.length > 0 && rows.every((t) => t.serviceError))) {
    return { kind: 'missing', reason: 'service-error' }
  }
  return { kind: 'missing', reason: 'no-verdict' }
}

/** Upload time scales with the body; a phone uplink moves a 2MB package in tens of seconds. */
export function arcadeAskTimeoutMs(bytes: number): number {
  return Math.min(180_000, 20_000 + Math.ceil(bytes / 1024) * 40)
}

/** Replace whatever the round recorded for Arcade with its direct answer. */
export function withArcadeAnswer(
  results: PostBeefServiceResult[],
  answer: PostBeefServiceResult,
): PostBeefServiceResult[] {
  return [answer, ...results.filter((r) => !isArcadeNamedService(r.name))]
}

/**
 * Post the same body to Arcade alone and wait for its answer. Re-posting a
 * body the toolbox round already handed it is safe: Arcade answers a known
 * transaction with its current status.
 */
export async function askArcadeDirectly(
  services: Services,
  txid: string,
  beefBytes: number[],
): Promise<PostBeefServiceResult | null> {
  const entry = arcadeEntry(services)
  if (!entry) return null
  const { Beef } = await import('@bsv/sdk')
  const timeoutMs = arcadeAskTimeoutMs(beefBytes.length)
  let timer: ReturnType<typeof setTimeout> | undefined
  const failed = (what: string, message?: string): PostBeefServiceResult => ({
    name: entry.name,
    status: 'error',
    txidResults: [{ txid, status: 'error', serviceError: true, notes: [{ what, message }] }],
  })
  try {
    const answer = await Promise.race([
      entry.service(Beef.fromBinary(beefBytes), [txid]).then(
        (result) => ({ name: entry.name, ...(result as object) }) as PostBeefServiceResult,
      ),
      new Promise<PostBeefServiceResult>((resolve) => {
        timer = setTimeout(() => resolve(failed('arcadeDirectTimeout')), timeoutMs)
      }),
    ])
    return answer
  } catch (err) {
    return failed('arcadeDirectError', err instanceof Error ? err.message : String(err))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function hasArcadeBroadcaster(services: Services | null | undefined): boolean {
  return arcadeEntry(services) != null
}
