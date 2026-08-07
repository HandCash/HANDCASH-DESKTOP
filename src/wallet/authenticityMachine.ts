/**
 * Per-outpoint authenticity statechart (BRC-156 → BRC-150 → unproven).
 *
 * Owns transition policy. Durable projection lives in `provenCache.ts`.
 * UI (list badge / spinner) reads snapshot + verificationProgress — never
 * invents its own ladder order.
 */
import { assign, setup } from 'xstate'
import {
  canAcceptVerdict,
  isProvenTier,
  type AuthenticityTier,
  type ProvenVerdict,
} from './provenCache'

export type AuthenticityPhase =
  | 'unknown'
  | 'verifying'
  | 'proven'
  | 'unproven'
  | 'budgetExhausted'

export type AuthenticityContext = {
  outpoint: string
  tier: AuthenticityTier
  origin?: string
  originScriptHash?: string
  reason: string | null
  verifiedAt: number
}

export type AuthenticityEvent =
  | { type: 'HYDRATE'; verdict: ProvenVerdict }
  | { type: 'START_VERIFY' }
  | {
      type: 'PROVEN'
      tier: 'brc156' | 'brc150'
      origin?: string
      originScriptHash?: string
    }
  | { type: 'UNPROVEN'; reason?: string | null }
  | { type: 'ABORT' }
  | { type: 'BUDGET_EXHAUSTED' }
  | { type: 'RETRY' }

export function authenticityContextFromVerdict(
  outpoint: string,
  verdict: ProvenVerdict | null,
): AuthenticityContext {
  return {
    outpoint,
    tier: verdict?.tier ?? 'unproven',
    origin: verdict?.origin,
    originScriptHash: verdict?.originScriptHash,
    reason: null,
    verifiedAt: verdict?.verifiedAt ?? 0,
  }
}

export const authenticityMachine = setup({
  types: {
    context: {} as AuthenticityContext,
    events: {} as AuthenticityEvent,
  },
  guards: {
    hydrateProven: ({ event }) =>
      event.type === 'HYDRATE' && isProvenTier(event.verdict.tier),
    hydrateUnproven: ({ event }) =>
      event.type === 'HYDRATE' && event.verdict.tier === 'unproven',
    acceptProven: ({ context, event }) =>
      event.type === 'PROVEN' && canAcceptVerdict(context.tier, event.tier),
  },
  actions: {
    applyHydrate: assign(({ event }) => {
      if (event.type !== 'HYDRATE') return {}
      return {
        tier: event.verdict.tier,
        origin: event.verdict.origin,
        originScriptHash: event.verdict.originScriptHash,
        verifiedAt: event.verdict.verifiedAt,
        reason: null,
      }
    }),
    applyProven: assign(({ event }) => {
      if (event.type !== 'PROVEN') return {}
      return {
        tier: event.tier,
        origin: event.origin,
        originScriptHash: event.originScriptHash,
        verifiedAt: Date.now(),
        reason: null,
      }
    }),
    applyUnproven: assign(({ event }) => ({
      tier: 'unproven' as const,
      reason: event.type === 'UNPROVEN' ? (event.reason ?? null) : null,
      verifiedAt: Date.now(),
    })),
  },
}).createMachine({
  id: 'authenticity',
  initial: 'unknown',
  context: {
    outpoint: '',
    tier: 'unproven',
    reason: null,
    verifiedAt: 0,
  },
  states: {
    unknown: {
      on: {
        HYDRATE: [
          { guard: 'hydrateProven', target: 'proven', actions: 'applyHydrate' },
          { guard: 'hydrateUnproven', target: 'unproven', actions: 'applyHydrate' },
        ],
        START_VERIFY: 'verifying',
        PROVEN: { guard: 'acceptProven', target: 'proven', actions: 'applyProven' },
        UNPROVEN: { target: 'unproven', actions: 'applyUnproven' },
      },
    },
    verifying: {
      on: {
        PROVEN: { guard: 'acceptProven', target: 'proven', actions: 'applyProven' },
        UNPROVEN: { target: 'unproven', actions: 'applyUnproven' },
        ABORT: 'unknown',
        BUDGET_EXHAUSTED: 'budgetExhausted',
      },
    },
    proven: {
      on: {
        // Monotonic: ignore UNPROVEN / weaker tiers.
        PROVEN: { guard: 'acceptProven', actions: 'applyProven' },
        START_VERIFY: undefined,
      },
    },
    unproven: {
      on: {
        RETRY: 'verifying',
        START_VERIFY: 'verifying',
        PROVEN: { guard: 'acceptProven', target: 'proven', actions: 'applyProven' },
        UNPROVEN: { actions: 'applyUnproven' },
      },
    },
    budgetExhausted: {
      on: {
        RETRY: 'verifying',
        START_VERIFY: 'verifying',
      },
    },
  },
})

export function phaseFromSnapshot(value: unknown): AuthenticityPhase {
  if (typeof value === 'string') return value as AuthenticityPhase
  return 'unknown'
}
