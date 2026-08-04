import { componentSchemas } from './components.js'
import { machineRegistryId } from './machine-id.js'
import type { JsonSchema } from './schema-builder.js'

/**
 * Aeon UI agent registry — machine-legible component contracts for Generative UI.
 * Fetch at runtime: GET https://aeon-ui.com/registry/catalog.json
 * Per component: GET https://aeon-ui.com/registry/components/{id}.json
 * Machines: GET https://aeon-ui.com/registry/machines/{id}.json
 *
 * Components are derived from `componentSchemas` — do not hand-maintain a parallel list.
 */
export type RegistryEntry = {
  id: string
  title: string
  scope: string
  schemaUrl: string
  machineUrl?: string
  runtime: string
  description: string
}

export const REGISTRY_BASE = 'https://aeon-ui.com/registry' as const

function entryFromSchema(id: string, schema: JsonSchema): RegistryEntry {
  const x = schema['x-aeon'] as {
    scope: string
    machine: string | null
    runtime: string
  }
  const mid = machineRegistryId(x.machine)
  return {
    id,
    title: String(schema.title ?? id),
    scope: x.scope,
    schemaUrl: `${REGISTRY_BASE}/components/${id}.json`,
    ...(mid ? { machineUrl: `${REGISTRY_BASE}/machines/${mid}.json` } : {}),
    runtime: x.runtime,
    description: String(schema.description ?? ''),
  }
}

export const registryCatalog = {
  $id: `${REGISTRY_BASE}/catalog.json`,
  version: '0.1.0',
  principle: 'UI = f(state)',
  description:
    'Lightweight runtime registry — fetch Aeon component schemas and state-tree JSON on demand instead of bundling every primitive.',
  endpoints: {
    catalog: `${REGISTRY_BASE}/catalog.json`,
    component: `${REGISTRY_BASE}/components/{id}.json`,
    machine: `${REGISTRY_BASE}/machines/{id}.json`,
  },
  components: Object.entries(componentSchemas).map(([id, schema]) =>
    entryFromSchema(id, schema),
  ) satisfies RegistryEntry[],
  client: {
    fetchCatalog: `fetch('${REGISTRY_BASE}/catalog.json').then(r => r.json())`,
    fetchComponent: `id => fetch(\`${REGISTRY_BASE}/components/\${id}.json\`).then(r => r.json())`,
    fetchMachine: `id => fetch(\`${REGISTRY_BASE}/machines/\${id}.json\`).then(r => r.json())`,
  },
}
