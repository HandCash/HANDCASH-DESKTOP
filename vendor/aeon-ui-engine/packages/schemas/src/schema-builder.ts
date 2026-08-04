/** JSON Schema 2020-12 helpers for Aeon component contracts. */

export type JsonSchema = Record<string, unknown>

export function componentSchema(opts: {
  id: string
  title: string
  description: string
  scope: string
  parts: readonly string[]
  states: readonly string[]
  props?: Record<string, JsonSchema>
  slots?: Record<string, string>
  machine?: string | null
  runtime?: string
  events?: readonly string[]
  examples?: readonly string[]
}): JsonSchema {
  const props = opts.props ?? {}
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: opts.id,
    title: opts.title,
    description: opts.description,
    type: 'object',
    additionalProperties: false,
    required: ['component', 'scope'],
    properties: {
      component: { const: opts.title.replace(/\s+/g, '') },
      scope: { const: opts.scope },
      parts: {
        type: 'array',
        description: 'Anatomy part keys — map to data-aeon-part',
        items: { type: 'string', enum: [...opts.parts] },
        uniqueItems: true,
      },
      states: {
        type: 'array',
        description: 'Allowed data-aeon-state values (stable states only)',
        items: { type: 'string', enum: [...opts.states] },
        uniqueItems: true,
      },
      props: {
        type: 'object',
        additionalProperties: false,
        properties: props,
      },
      slots: {
        type: 'object',
        description: 'Named composition slots / compound parts',
        additionalProperties: { type: 'string' },
        properties: Object.fromEntries(
          Object.entries(opts.slots ?? {}).map(([k, v]) => [k, { const: v, description: v }]),
        ),
      },
      machine: {
        type: ['string', 'null'],
        description: 'XState machine export from @aeon-ui/primitives, or null if prop/React driven',
        const: opts.machine ?? null,
      },
      runtime: {
        type: 'string',
        description: 'How headless state is driven at runtime',
        const: opts.runtime ?? 'useAeonMachine',
      },
      events: {
        type: 'array',
        items: { type: 'string', enum: [...(opts.events ?? [])] },
      },
      examples: {
        type: 'array',
        items: { type: 'string' },
        default: opts.examples ?? [],
      },
    },
    'x-aeon': {
      scope: opts.scope,
      parts: [...opts.parts],
      states: [...opts.states],
      machine: opts.machine ?? null,
      runtime: opts.runtime ?? 'useAeonMachine',
      events: [...(opts.events ?? [])],
      slots: opts.slots ?? {},
      examples: [...(opts.examples ?? [])],
    },
  }
}
