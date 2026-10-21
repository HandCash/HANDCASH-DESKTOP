import { assign, fromPromise, setup, type SnapshotFrom, type StateValue } from 'xstate'
import {
  type BoxMessage,
  type ChartApp,
  type ChartBlock,
  type ChartEffectPorts,
  type ChartFieldValue,
  type ChartNetwork,
  type ChartTransition,
  type ChartValues,
  type EffectResult,
  type ItemRef,
  type Recipient,
  type ResolvedEffect,
} from './chartTypes'
import { approvalFor, effectNeedsApproval, resolveEffect, type ApprovalCopy } from './chartEffects'

export type ChartRunnerContext = {
  values: ChartValues
  /** The resolved effect of the current effect state, with its approval copy when it needs one. */
  pending: { effect: ResolvedEffect; approval: ApprovalCopy | null } | null
  error: string | null
}

export type ChartRunnerEvent =
  | { type: 'SET'; field: string; value: unknown }
  | { type: 'TOGGLE'; field: string; id: string }
  | { type: 'APPROVE' }
  | { type: 'DECLINE' }
  | { type: string; row?: unknown }

const INPUT_BLOCKS: ReadonlySet<ChartBlock['block']> = new Set([
  'amountInput',
  'textInput',
  'friendPicker',
  'itemPicker',
])

const stateId = (name: string) => `s-${name}`
const ref = (name: string) => `#${stateId(name)}`

function hasValue(v: ChartFieldValue | undefined): boolean {
  if (v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (typeof v === 'number') return v > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

function isRecipient(v: unknown): v is Recipient {
  const r = v as Recipient
  return typeof v === 'object' && v !== null && typeof r.id === 'string' && typeof r.label === 'string' &&
    typeof r.identityKey === 'string' && /^0[23][0-9a-f]{64}$/i.test(r.identityKey)
}

/** Coerce an input to its field's type; undefined clears the field. Anything else is refused. */
export function coerceFieldValue(chart: ChartApp, field: string, value: unknown): ChartFieldValue | undefined | null {
  const def = chart.fields[field]
  if (!def) return null
  if (value === undefined || value === '' || value === null) return undefined
  switch (def.type) {
    case 'amount': {
      const n = typeof value === 'string' ? Number(value.replace(/[,\s_]/g, '')) : value
      return Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : null
    }
    case 'text':
      return typeof value === 'string' ? value.slice(0, def.maxLength ?? 140) : null
    case 'friend':
      return isRecipient(value) ? { id: value.id, label: value.label, identityKey: value.identityKey.toLowerCase() } : null
    case 'friends':
      return Array.isArray(value) && value.every(isRecipient)
        ? value.map((r) => ({ id: r.id, label: r.label, identityKey: r.identityKey.toLowerCase() }))
        : null
    case 'item': {
      const item = value as ItemRef
      return typeof value === 'object' && typeof item.outpoint === 'string' && typeof item.name === 'string'
        ? { outpoint: item.outpoint, name: item.name }
        : null
    }
    default:
      return null
  }
}

function inputFieldsOf(chart: ChartApp, state: string): Set<string> {
  const fields = new Set<string>()
  for (const block of chart.states[state]?.view ?? []) {
    if (INPUT_BLOCKS.has(block.block) && 'field' in block) fields.add(block.field)
  }
  return fields
}

function applyResult(chart: ChartApp, effectId: string, values: ChartValues, result: EffectResult, ran: ResolvedEffect): ChartValues {
  const effect = chart.effects[effectId]
  const next: ChartValues = { ...values }
  const clearSelections = () => {
    for (const [name, f] of Object.entries(chart.fields)) if (f.type === 'selection') next[name] = undefined
  }
  if (result.kind === 'messages' && effect.kind === 'listMessages') {
    next[effect.result] = result.messages
    if (effect.blocked) next[effect.blocked] = result.blocked
    clearSelections()
  }
  if (result.kind === 'signature' && effect.kind === 'signMessage') next[effect.result] = result.value
  if (result.kind === 'fetched' && effect.kind === 'fetch') next[effect.result] = result.value
  if (ran.kind === 'acknowledgeMessages' || ran.kind === 'deleteMessages') {
    const gone = new Set(ran.messages.map((m) => m.id))
    for (const [name, f] of Object.entries(chart.fields)) {
      if (f.type === 'messages' && Array.isArray(next[name])) {
        next[name] = (next[name] as BoxMessage[]).filter((m) => !gone.has(m.id))
      }
    }
    clearSelections()
  }
  return next
}

function normalizeTransition(t: ChartTransition) {
  return typeof t === 'string' ? { target: t, requires: [], assign: {} } : { requires: [], assign: {}, ...t }
}

/**
 * Build the executable chart. Every chart state becomes an XState state; an
 * effect state resolves its effect on entry, waits in `approving` when the
 * effect needs approval, then `running` hands it to the wallet's ports.
 */
export function machineFromChart(
  chart: ChartApp,
  options: { ports: ChartEffectPorts; network: ChartNetwork },
) {
  const app = { id: chart.id, name: chart.name }
  const states: Record<string, object> = {}

  for (const [name, state] of Object.entries(chart.states)) {
    if (state.effect) {
      const effectId = state.effect
      const needsApproval = effectNeedsApproval(chart.effects[effectId].kind)
      states[name] = {
        id: stateId(name),
        entry: assign(({ context }: { context: ChartRunnerContext }) => {
          try {
            const effect = resolveEffect(chart, effectId, context.values, options.network)
            return { pending: { effect, approval: needsApproval ? approvalFor(effect, app) : null }, error: null }
          } catch (err) {
            return { pending: null, error: err instanceof Error ? err.message : String(err) }
          }
        }),
        always: { guard: ({ context }: { context: ChartRunnerContext }) => context.pending === null, target: ref(state.onError!) },
        initial: needsApproval ? 'approving' : 'running',
        states: {
          approving: {
            on: { APPROVE: 'running', DECLINE: ref(state.onDecline ?? state.onError!) },
          },
          running: {
            invoke: {
              src: 'runEffect',
              input: ({ context }: { context: ChartRunnerContext }) => context.pending!.effect,
              onDone: {
                target: ref(state.onDone!),
                actions: assign(({ context, event }: { context: ChartRunnerContext; event: { type: string; output?: unknown } }) => ({
                  values: applyResult(chart, effectId, context.values, event.output as EffectResult, context.pending!.effect),
                  error: null,
                })),
              },
              onError: {
                target: ref(state.onError!),
                actions: assign(({ event }: { event: { error: unknown } }) => ({
                  error: event.error instanceof Error ? event.error.message : String(event.error),
                })),
              },
            },
          },
        },
      }
      continue
    }

    if (state.final) {
      states[name] = { id: stateId(name), type: 'final' }
      continue
    }

    const inputs = inputFieldsOf(chart, name)
    const selections = new Map<string, string>()
    const opens = new Map<string, { field: string; list: string }>()
    for (const block of state.view ?? []) {
      if (block.block !== 'list') continue
      if (block.select) selections.set(block.select, block.field)
      if (block.open) opens.set(block.open.event, { field: block.open.field, list: block.field })
    }

    const on: Record<string, unknown> = {
      SET: {
        guard: ({ event }: { event: ChartRunnerEvent }) =>
          event.type === 'SET' && inputs.has((event as { field: string }).field) &&
          coerceFieldValue(chart, (event as { field: string }).field, (event as { value: unknown }).value) !== null,
        actions: assign(({ context, event }: { context: ChartRunnerContext; event: ChartRunnerEvent }) => {
          const e = event as { field: string; value: unknown }
          return {
            values: { ...context.values, [e.field]: coerceFieldValue(chart, e.field, e.value) ?? undefined },
            error: null,
          }
        }),
      },
      TOGGLE: {
        guard: ({ event }: { event: ChartRunnerEvent }) => selections.has((event as { field: string }).field),
        actions: assign(({ context, event }: { context: ChartRunnerContext; event: ChartRunnerEvent }) => {
          const e = event as { field: string; id: string }
          const listed = context.values[selections.get(e.field)!]
          const known = Array.isArray(listed) && (listed as Array<{ id?: string; identityKey?: string }>)
            .some((row) => (row.id ?? row.identityKey) === e.id)
          if (!known) return {}
          const held = context.values[e.field]
          const current = Array.isArray(held) ? (held as string[]) : []
          const next = current.includes(e.id) ? current.filter((id) => id !== e.id) : [...current, e.id]
          return { values: { ...context.values, [e.field]: next } }
        }),
      },
    }

    for (const [event, raw] of Object.entries(state.on ?? {})) {
      const t = normalizeTransition(raw)
      const open = opens.get(event)
      on[event] = {
        target: ref(t.target),
        guard: ({ context, event: e }: { context: ChartRunnerContext; event: ChartRunnerEvent }) => {
          if (open) {
            const row = (e as { row?: { id?: string; identityKey?: string } }).row
            const listed = context.values[open.list]
            if (!row || !Array.isArray(listed)) return false
            const key = row.id ?? row.identityKey
            if (!(listed as Array<{ id?: string; identityKey?: string }>).some((r) => (r.id ?? r.identityKey) === key)) return false
          }
          return t.requires.every((f: string) => hasValue(context.values[f]))
        },
        actions: assign(({ context, event: e }: { context: ChartRunnerContext; event: ChartRunnerEvent }) => {
          const values: ChartValues = { ...context.values, ...(t.assign as ChartValues) }
          if (open) {
            const row = (e as { row: { id?: string; identityKey?: string } }).row
            const listed = context.values[open.list] as Array<{ id?: string; identityKey?: string }>
            values[open.field] = listed.find((r) => (r.id ?? r.identityKey) === (row.id ?? row.identityKey)) as ChartFieldValue
          }
          return { values, error: null }
        }),
      }
    }
    states[name] = { id: stateId(name), on }
  }

  return setup({
    types: {
      context: {} as ChartRunnerContext,
      events: {} as ChartRunnerEvent,
    },
    actors: {
      runEffect: fromPromise<EffectResult, ResolvedEffect>(({ input }) => options.ports.run(input, app)),
    },
  }).createMachine({
    id: `chartApp-${chart.id}`,
    initial: chart.initial,
    context: { values: {}, pending: null, error: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    states: states as any,
  })
}

export type ChartRunnerMachine = ReturnType<typeof machineFromChart>
export type ChartRunnerSnapshot = SnapshotFrom<ChartRunnerMachine>

/** The chart state a snapshot is in, and the effect step when it is an effect state. */
export function chartPosition(value: StateValue): { state: string; step: 'approving' | 'running' | null } {
  if (typeof value === 'string') return { state: value, step: null }
  const [state, inner] = Object.entries(value)[0] ?? ['', null]
  return { state, step: inner === 'approving' || inner === 'running' ? inner : null }
}
