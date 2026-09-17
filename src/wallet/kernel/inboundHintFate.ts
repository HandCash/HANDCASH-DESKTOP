/**
 * Fate of an inbound payment/item hint that failed to internalize.
 *
 * Tip validity is Arcade, not an explorer 404 — a provider outage must never
 * ACK away real money. But "never give up" left a third case with no exit: a
 * hint whose sender never broadcast. We hold no body to broadcast ourselves,
 * no provider has ever had one, and no explorer can see it, so every poll
 * re-ran a full BEEF chase that could not possibly succeed and the card sat on
 * "Receiving (SPV)" indefinitely.
 *
 * The missing ingredient is corroboration over time rather than a single 404:
 * nothing deliverable on our side, a durable multi-provider body miss, a
 * definite on-chain absence, and a grace window. A later AtomicBEEF revives it.
 */

export type InboundHintFate =
  | { kind: 'retry' }
  /** Arcade hard-rejected our broadcast — ACK the inbox card away. */
  | { kind: 'arcadeGhost' }
  /** Not recoverable by retrying; the sender has to send again. */
  | { kind: 'unresolvable'; reason: string }

export type InboundHintFacts = {
  isArcadeGhost: boolean
  /** A signed body we hold or can fetch, so we could still broadcast it. */
  hasDeliverableBeef: boolean
  /** Durable multi-provider raw-transaction lookup. */
  bodyLookup: 'hit' | 'miss' | 'unknown'
  /** Explorer existence. `null` when no explorer could answer. */
  onChain: boolean | null
  /** When the hint first arrived. */
  firstSeenAt: number
  now: number
}

/**
 * A BRC-29 sender broadcasts inside `createAction`, so a real payment reaches
 * some provider within seconds. Two hours is far past propagation while still
 * absorbing a long offline stretch or an indexer outage on our side.
 */
export const UNRESOLVABLE_GRACE_MS = 2 * 60 * 60_000

function ageMs(facts: Pick<InboundHintFacts, 'firstSeenAt' | 'now'>): number {
  const first = Number.isFinite(facts.firstSeenAt) ? facts.firstSeenAt : 0
  // An unknown arrival time reads as brand new, which keeps it retrying.
  if (first <= 0) return 0
  return Math.max(0, facts.now - first)
}

/**
 * Cheap pre-check: worth spending an explorer round-trip to retire this hint?
 *
 * Keeps the on-chain probe off the common path, where a hint is simply young
 * or still has a body we have not chased yet.
 */
export function mayBeUnresolvable(facts: Omit<InboundHintFacts, 'onChain'>): boolean {
  if (facts.isArcadeGhost) return false
  if (facts.hasDeliverableBeef) return false
  if (facts.bodyLookup !== 'miss') return false
  return ageMs(facts) >= UNRESOLVABLE_GRACE_MS
}

export function decideInboundHintFate(facts: InboundHintFacts): InboundHintFate {
  if (facts.isArcadeGhost) return { kind: 'arcadeGhost' }

  // We could still rescue this by broadcasting it ourselves.
  if (facts.hasDeliverableBeef) return { kind: 'retry' }

  // Never asked every provider, or one of them has the body.
  if (facts.bodyLookup !== 'miss') return { kind: 'retry' }

  // Absence has to be positively established; `null` is "nobody answered".
  if (facts.onChain !== false) return { kind: 'retry' }

  if (ageMs(facts) < UNRESOLVABLE_GRACE_MS) return { kind: 'retry' }

  return {
    kind: 'unresolvable',
    reason: 'sender never broadcast — no body at any provider and absent on chain',
  }
}

/** Chat status pinned on a hint we have stopped chasing. */
export const UNRESOLVABLE_HINT_STATUS = 'Unavailable — sender never broadcast'

/**
 * Statuses that take a card out of the pending-hint sweep.
 *
 * Matched on the `unavailable` prefix so the reason stays readable in chat
 * without a second vocabulary for the sweep to keep in sync.
 */
export function isTerminalInboundHintStatus(status: string | undefined): boolean {
  const s = (status ?? '').trim().toLowerCase()
  if (!s) return false
  return s === 'received' || s.startsWith('unavailable')
}
