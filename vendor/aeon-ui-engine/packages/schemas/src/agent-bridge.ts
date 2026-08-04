import type { AnyEventObject, AnyActorRef } from 'xstate'

/** Streaming / tool-loop events from an LLM or automation. */
export type AgentStreamEvent =
  | { type: 'AGENT_STREAM_START'; taskId?: string }
  | { type: 'AGENT_STREAM_CHUNK'; taskId?: string; data?: unknown }
  | { type: 'AGENT_STREAM_END'; taskId?: string; data?: unknown }
  | { type: 'AGENT_STREAM_ERROR'; taskId?: string; error: string }
  | { type: 'AGENT_TOOL_CALL'; name: string; args?: unknown }
  | { type: 'AGENT_TOOL_RESULT'; name: string; result?: unknown }
  | { type: string; [key: string]: unknown }

export type AgentEventMap = Record<string, string | ((event: AgentStreamEvent) => AnyEventObject | null)>

export type AgentBridgeOptions = {
  /**
   * Map inbound agent event types → machine event types or transformers.
   * Example: `{ AGENT_STREAM_START: 'FETCH', AGENT_STREAM_ERROR: (e) => ({ type: 'REJECT', error: e.error }) }`
   */
  map: AgentEventMap
  /** Optional filter — return false to drop the event. */
  accept?: (event: AgentStreamEvent) => boolean
  /** Called when a mapped event is not allowed by `snapshot.can` (if actor exposes getSnapshot). */
  onIllegal?: (event: AnyEventObject, reason: string) => void
}

type Sendable = {
  send: (event: AnyEventObject) => void
  getSnapshot?: () => { can: (event: AnyEventObject) => boolean }
}

/**
 * Bind streaming LLM / tool-loop events to an Aeon machine actor.
 * Prevents agents from firing transitions the chart will reject.
 */
export function createAgentEventBridge(actor: Sendable | AnyActorRef, options: AgentBridgeOptions) {
  const { map, accept, onIllegal } = options

  const resolve = (incoming: AgentStreamEvent): AnyEventObject | null => {
    if (accept && !accept(incoming)) return null
    const binding = map[incoming.type]
    if (binding == null) return null
    if (typeof binding === 'function') return binding(incoming)
    return { type: binding }
  }

  const push = (incoming: AgentStreamEvent): boolean => {
    const event = resolve(incoming)
    if (!event) return false

    const snap = typeof actor.getSnapshot === 'function' ? actor.getSnapshot() : undefined
    if (snap && !snap.can(event)) {
      onIllegal?.(event, `Event ${event.type} is not valid in the current configuration`)
      return false
    }

    actor.send(event)
    return true
  }

  return {
    /** Push one agent/stream event through the map into `machine.send`. */
    push,
    /** Map of known agent → machine bindings (for prompts / docs). */
    map,
    /** Describe the bridge for system prompts. */
    toPrompt(): string {
      const rows = Object.entries(map).map(([from, to]) => {
        const dest = typeof to === 'string' ? to : '(transform)'
        return `- ${from} → ${dest}`
      })
      return [
        '## Agent event bridge',
        'Inbound stream events map to machine events:',
        ...rows,
        'Illegal events (rejected by snapshot.can) are dropped.',
      ].join('\n')
    },
  }
}

export type AgentEventBridge = ReturnType<typeof createAgentEventBridge>
