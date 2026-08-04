import type { AnyStateMachine, AnyStateNode, SnapshotFrom } from 'xstate'
import {
  createActor,
  getNextTransitions,
  getStateNodes,
  __unsafe_getAllOwnEventDescriptors,
} from 'xstate'

/** Hierarchical state-tree node for LLM / Generative UI consumption. */
export type AeonStateTreeNode = {
  key: string
  id: string
  type: string
  events: string[]
  transitions: Array<{
    event: string
    target: string[]
    guarded: boolean
  }>
  children: AeonStateTreeNode[]
}

/** Deterministic statechart JSON an agent can read at any micro-moment. */
export type AeonMachineSchema = {
  id: string
  initial: string | undefined
  events: string[]
  tree: AeonStateTreeNode
  /** Flat map: state id → events defined on that node */
  states: Record<string, { events: string[]; type: string }>
}

export type AeonSnapshotSchema = {
  machineId: string
  value: unknown
  /** Event types valid from the active configuration (no getNextEvents in XState v5). */
  validEvents: string[]
  /** Transition rows including guard presence — agents should prefer unguarded or known payloads. */
  nextTransitions: Array<{
    event: string
    target: string[]
    guarded: boolean
  }>
  activeStateIds: string[]
}

function isPublicEvent(event: string): boolean {
  return !event.startsWith('xstate.')
}

function filterPublicEvents(events: readonly string[]): string[] {
  return events.filter(isPublicEvent)
}

function walkNode(node: AnyStateNode): AeonStateTreeNode {
  const on = node.config.on ?? {}
  const transitionEntries = Object.entries(on as Record<string, unknown>)
    .filter(([event]) => isPublicEvent(event))
    .map(([event, def]) => {
      const targets: string[] = []
      const list = Array.isArray(def) ? def : [def]
      let guarded = false
      for (const item of list) {
        if (item == null) continue
        if (typeof item === 'string') {
          targets.push(item)
          continue
        }
        if (typeof item === 'object') {
          const row = item as { target?: string | string[]; guard?: unknown }
          if (row.guard != null) guarded = true
          if (typeof row.target === 'string') targets.push(row.target)
          else if (Array.isArray(row.target)) targets.push(...row.target)
        }
      }
      return { event, target: targets, guarded }
    })

  return {
    key: node.key,
    id: node.id,
    type: node.type,
    events: filterPublicEvents([...(node.events ?? [])]),
    transitions: transitionEntries,
    children: Object.values(node.states ?? {}).map(walkNode),
  }
}

function flattenNodes(node: AnyStateNode, out: AeonMachineSchema['states']) {
  out[node.id] = {
    events: filterPublicEvents([...(node.events ?? [])]),
    type: node.type,
  }
  for (const child of Object.values(node.states ?? {})) {
    flattenNodes(child, out)
  }
}

/**
 * Stringify an XState machine into a clean hierarchical state-tree JSON.
 * Use this as the runtime contract for agents that must know which events
 * (TOGGLE, SUBMIT, FETCH, …) are legal before calling `send`.
 * Internal timers (`xstate.after.*`) are omitted — agents send public events only.
 */
export function aeonToSchema(machine: AnyStateMachine): AeonMachineSchema {
  const tree = walkNode(machine.root)
  const flat: AeonMachineSchema['states'] = {}
  flattenNodes(machine.root, flat)

  const initial =
    typeof machine.config.initial === 'string' ? machine.config.initial : undefined

  return {
    id: machine.id,
    initial,
    events: filterPublicEvents([...(machine.events ?? [])]),
    tree,
    states: flat,
  }
}

/**
 * Snapshot-aware companion to `aeonToSchema`.
 * Call whenever the actor advances so the LLM only proposes legal next events.
 */
export function aeonSnapshotSchema(
  machine: AnyStateMachine,
  snapshot: SnapshotFrom<AnyStateMachine>,
): AeonSnapshotSchema {
  const active = getStateNodes(machine.root, snapshot.value)
  const next = getNextTransitions(snapshot)

  return {
    machineId: machine.id,
    value: snapshot.value,
    validEvents: [...__unsafe_getAllOwnEventDescriptors(snapshot)].filter(
      (e) => !e.startsWith('xstate.'),
    ),
    nextTransitions: next
      .filter((t) => !t.eventType.startsWith('xstate.'))
      .map((t) => ({
        event: t.eventType,
        target: (t.target ?? []).map((n) => n.id),
        guarded: Boolean(t.guard),
      })),
    activeStateIds: active.map((n) => n.id),
  }
}

/**
 * Turn a machine (+ optional live snapshot) into a deterministic system-prompt fragment.
 */
export function aeonToPrompt(
  machine: AnyStateMachine,
  snapshot?: SnapshotFrom<AnyStateMachine>,
): string {
  const schema = aeonToSchema(machine)
  const lines = [
    `## Aeon statechart: ${schema.id}`,
    `Initial: ${schema.initial ?? '(none)'}`,
    `All events: ${schema.events.join(', ') || '(none)'}`,
    '',
    '### State tree (JSON)',
    '```json',
    JSON.stringify(schema.tree, null, 2),
    '```',
    '',
    'Rules for agents:',
    '- Only send event types listed under the *active* configuration.',
    '- Never invent events or targets not present in this tree.',
    '- Prefer events with guarded:false unless you can satisfy the guard payload.',
  ]

  if (snapshot) {
    const live = aeonSnapshotSchema(machine, snapshot)
    lines.push(
      '',
      '### Live snapshot',
      `- value: ${JSON.stringify(live.value)}`,
      `- validEvents now: ${live.validEvents.join(', ') || '(none)'}`,
      `- nextTransitions: ${JSON.stringify(live.nextTransitions)}`,
    )
  }

  return lines.join('\n')
}

/**
 * Convenience: start a throwaway actor at the initial state and return both
 * static schema + snapshot schema for prompt injection.
 */
export function aeonInitialAgentContext(machine: AnyStateMachine): {
  schema: AeonMachineSchema
  snapshot: AeonSnapshotSchema
  prompt: string
} {
  const actor = createActor(machine)
  actor.start()
  const snap = actor.getSnapshot()
  actor.stop()
  return {
    schema: aeonToSchema(machine),
    snapshot: aeonSnapshotSchema(machine, snap),
    prompt: aeonToPrompt(machine, snap),
  }
}
