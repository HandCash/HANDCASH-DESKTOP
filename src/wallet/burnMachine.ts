import { assign, createActor, setup, type SnapshotFrom } from 'xstate'
import type { BurnPlan } from './burnPlan'

export type BurnMachineContext = {
  plan: BurnPlan | null
  reference: string | null
  txid: string | null
  error: string | null
}

export type BurnMachineEvent =
  | { type: 'START'; plan: BurnPlan }
  | { type: 'BUILT'; reference?: string }
  | { type: 'SIGNED'; txid: string }
  | { type: 'BROADCASTED' }
  | { type: 'INTERNALIZED' }
  | { type: 'REFRESHED' }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export const burnMachine = setup({
  types: {
    context: {} as BurnMachineContext,
    events: {} as BurnMachineEvent,
  },
  guards: {
    executable: ({ context }) =>
      context.plan?.path === 'burnBsv21' ||
      context.plan?.path === 'burnOneSat',
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? { plan: event.plan, reference: null, txid: null, error: null }
        : {},
    ),
    setReference: assign(({ event }) =>
      event.type === 'BUILT' ? { reference: event.reference ?? null } : {},
    ),
    setTxid: assign(({ event }) =>
      event.type === 'SIGNED' ? { txid: event.txid } : {},
    ),
    setError: assign(({ event }) =>
      event.type === 'FAIL' ? { error: event.error } : {},
    ),
    clear: assign({ plan: null, reference: null, txid: null, error: null }),
  },
}).createMachine({
  id: 'burn',
  initial: 'idle',
  context: { plan: null, reference: null, txid: null, error: null },
  states: {
    idle: { on: { START: { target: 'planning', actions: 'begin' } } },
    planning: {
      always: [
        { guard: 'executable', target: 'building' },
        {
          target: 'failed',
          actions: assign(({ context }) => ({
            error:
              context.plan?.path === 'refuse'
                ? context.plan.reason
                : 'Burn plan was not classified',
          })),
        },
      ],
    },
    building: {
      on: {
        BUILT: { target: 'signing', actions: 'setReference' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    signing: {
      on: {
        SIGNED: { target: 'broadcasting', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    broadcasting: {
      on: {
        BROADCASTED: { target: 'internalizing' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    internalizing: {
      on: {
        INTERNALIZED: { target: 'refreshing' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    refreshing: {
      on: {
        REFRESHED: { target: 'done' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    done: { on: { RESET: { target: 'idle', actions: 'clear' } } },
    failed: { on: { RESET: { target: 'idle', actions: 'clear' } } },
  },
})

export type BurnSnapshot = SnapshotFrom<typeof burnMachine>

export type BurnExecutionEffects = {
  build: () => Promise<{ reference?: string }>
  sign: () => Promise<{ txid: string }>
  broadcast: (txid: string) => Promise<void>
  internalize: (txid: string) => Promise<void>
  relinquish: (txid: string) => Promise<void>
  refresh: () => Promise<void>
  backup: () => void
  abort: (reference?: string) => Promise<void>
}

/**
 * Execute the machine-owned burn phases. The chart refuses a `refuse` plan
 * before any effect runs. Effects are injectable for focused tests.
 */
export async function executeBurnLifecycle(
  plan: BurnPlan,
  effects: BurnExecutionEffects
): Promise<{ txid: string }> {
  const chart = createActor(burnMachine).start()
  chart.send({ type: 'START', plan })
  const planned = chart.getSnapshot()
  if (!planned.matches('building')) {
    chart.stop()
    throw new Error(`Burn refused: ${planned.context.error ?? 'unclassified plan'}`)
  }
  let reference: string | undefined
  let signedTxid: string | null = null
  try {
    const built = await effects.build()
    reference = built.reference
    chart.send({ type: 'BUILT', reference })
    const signed = await effects.sign()
    signedTxid = signed.txid
    chart.send({ type: 'SIGNED', txid: signed.txid })
    await effects.broadcast(signed.txid)
    chart.send({ type: 'BROADCASTED' })
    await effects.internalize(signed.txid)
    chart.send({ type: 'INTERNALIZED' })
    await effects.relinquish(signed.txid)
    await effects.refresh()
    chart.send({ type: 'REFRESHED' })
    if (!chart.getSnapshot().matches('done')) {
      throw new Error('Burn state machine did not reach done')
    }
    effects.backup()
    chart.stop()
    return { txid: signed.txid }
  } catch (error) {
    chart.send({
      type: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    })
    // Only an unsigned action is safe to abort. Once a transaction is signed it
    // may already be propagating; releasing its inputs would permit a competing
    // burn. Keep the signed action reserved for review/rebroadcast instead.
    if (!signedTxid) await effects.abort(reference)
    chart.stop()
    throw error
  }
}
