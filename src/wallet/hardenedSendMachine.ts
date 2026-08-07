/**
 * Hardened BRC-156 Commit → Settle send statechart.
 *
 * Parent: `collectableSendMachine` (no soft-latch edge from covenant paths).
 * This machine owns unlock-budget declaration and Commit/Settle phases so
 * `oneSatHardenedSend.ts` cannot freestyle the order — `advanceHardened`
 * asserts each transition lands in the expected state.
 */
import { assign, setup } from 'xstate'
import { HARDENED_UNLOCKING_SCRIPT_LENGTH } from './oneSatHardenedLatch'

export type HardenedSendPhase =
  | 'idle'
  | 'gating'
  | 'commitBuild'
  | 'commitSign'
  | 'settleBuild'
  | 'settleSign'
  | 'aborting'
  | 'done'
  | 'failed'

export type HardenedSendContext = {
  outpoint: string
  mode: 'genesis' | 'resend' | null
  commitTxid: string | null
  settleTxid: string | null
  unlockBudgetBytes: number
  error: string | null
}

/**
 * Bytes reserved for a covenant unlocking script.
 *
 * SDK compares `unlockingScript.length / 2` (bytes) to `unlockingScriptLength`.
 * Error messages often print the hex character length — do not confuse the units.
 *
 * Undersize → signAction throws. Oversize → slightly higher fee reserve only.
 */
export function estimateUnlockingLength(
  embeddedTxHexes: string[],
  extraScriptHexes: string[] = [],
): number {
  const pieces = [...embeddedTxHexes, ...extraScriptHexes].filter(
    (hex): hex is string => typeof hex === 'string' && hex.length > 0,
  )
  const payload = pieces.reduce((sum, hex) => sum + Math.ceil(hex.length / 2), 0)
  // OP_PUSHDATA4 ≈ 5–9 bytes per push; sig + pubkey + method selector ≈ 200.
  const pushOverhead = pieces.length * 16
  const framing = 20_480
  return Math.max(
    HARDENED_UNLOCKING_SCRIPT_LENGTH,
    Math.ceil(payload * 1.35) + pushOverhead + framing,
  )
}

/** Byte length of a hex unlocking script (what the toolbox compares against). */
export function unlockingScriptByteLength(unlockingScriptHex: string): number {
  return Math.ceil(unlockingScriptHex.length / 2)
}

export function spendsFitBudget(
  spends: Record<number, { unlockingScript: string }>,
  budgetBytes: number,
): { ok: true } | { ok: false; vin: number; actual: number; budget: number } {
  for (const [key, spend] of Object.entries(spends)) {
    const actual = unlockingScriptByteLength(spend.unlockingScript)
    if (actual > budgetBytes) {
      return { ok: false, vin: Number(key), actual, budget: budgetBytes }
    }
  }
  return { ok: true }
}

export type HardenedSendEvent =
  | { type: 'SEND'; outpoint: string; mode: 'genesis' | 'resend' }
  | { type: 'PROVEN_OK' }
  | { type: 'PROVEN_FAIL'; error: string }
  | { type: 'COMMIT_BUILT'; unlockBudgetBytes: number }
  | { type: 'COMMIT_SIGNED'; commitTxid: string }
  | { type: 'SETTLE_BUILT'; unlockBudgetBytes: number }
  | { type: 'SETTLE_SIGNED'; settleTxid: string }
  | { type: 'FAIL'; error: string }
  | { type: 'ABORT_DONE' }
  | { type: 'RESET' }

export const hardenedSendMachine = setup({
  types: {
    context: {} as HardenedSendContext,
    events: {} as HardenedSendEvent,
  },
  actions: {
    begin: assign(({ event }) => {
      if (event.type !== 'SEND') return {}
      return {
        outpoint: event.outpoint,
        mode: event.mode,
        commitTxid: null,
        settleTxid: null,
        unlockBudgetBytes: HARDENED_UNLOCKING_SCRIPT_LENGTH,
        error: null,
      }
    }),
    setCommitBudget: assign(({ event }) =>
      event.type === 'COMMIT_BUILT'
        ? { unlockBudgetBytes: event.unlockBudgetBytes }
        : {},
    ),
    setCommitTxid: assign(({ event }) =>
      event.type === 'COMMIT_SIGNED' ? { commitTxid: event.commitTxid } : {},
    ),
    setSettleBudget: assign(({ event }) =>
      event.type === 'SETTLE_BUILT'
        ? { unlockBudgetBytes: event.unlockBudgetBytes }
        : {},
    ),
    setSettleTxid: assign(({ event }) =>
      event.type === 'SETTLE_SIGNED' ? { settleTxid: event.settleTxid } : {},
    ),
    setError: assign(({ event }) =>
      event.type === 'FAIL' || event.type === 'PROVEN_FAIL'
        ? { error: event.error }
        : {},
    ),
    clear: assign({
      outpoint: '',
      mode: null,
      commitTxid: null,
      settleTxid: null,
      unlockBudgetBytes: HARDENED_UNLOCKING_SCRIPT_LENGTH,
      error: null,
    }),
  },
}).createMachine({
  id: 'hardenedSend',
  initial: 'idle',
  context: {
    outpoint: '',
    mode: null,
    commitTxid: null,
    settleTxid: null,
    unlockBudgetBytes: HARDENED_UNLOCKING_SCRIPT_LENGTH,
    error: null,
  },
  states: {
    idle: {
      on: { SEND: { target: 'gating', actions: 'begin' } },
    },
    gating: {
      on: {
        PROVEN_OK: 'commitBuild',
        PROVEN_FAIL: { target: 'failed', actions: 'setError' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    commitBuild: {
      on: {
        COMMIT_BUILT: { target: 'commitSign', actions: 'setCommitBudget' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    commitSign: {
      on: {
        COMMIT_SIGNED: { target: 'settleBuild', actions: 'setCommitTxid' },
        FAIL: { target: 'aborting', actions: 'setError' },
      },
    },
    settleBuild: {
      on: {
        SETTLE_BUILT: { target: 'settleSign', actions: 'setSettleBudget' },
        FAIL: { target: 'aborting', actions: 'setError' },
      },
    },
    settleSign: {
      on: {
        SETTLE_SIGNED: { target: 'done', actions: 'setSettleTxid' },
        FAIL: { target: 'aborting', actions: 'setError' },
      },
    },
    aborting: {
      on: {
        ABORT_DONE: 'failed',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    done: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
    failed: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
  },
})
