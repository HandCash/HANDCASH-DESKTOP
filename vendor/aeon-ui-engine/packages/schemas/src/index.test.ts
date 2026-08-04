import { describe, expect, it } from 'vitest'
import { catalog, componentSchemas } from './components.js'
import { machineRegistryId } from './machine-id.js'
import { AEON_SYSTEM_PROMPT } from './prompts.js'
import { registryCatalog } from './registry.js'

/** Machine-backed COMPONENTS / MACHINES rows that must have a schema entry. */
const MACHINE_BACKED_SCHEMA_IDS = [
  'async',
  'field',
  'button',
  'switch',
  'checkbox',
  'dialog',
  'tabs',
  'accordion',
  'menu',
  'popover',
  'select',
  'combobox',
  'toast',
  'radioGroup',
  'slider',
  'stickyBar',
  'appShell',
  'content',
  'nav',
  'panel',
  'appNav',
  'prompt',
  'tooltip',
] as const

const LAYOUT_SCHEMA_IDS = [
  'identity',
  'profileHeader',
  'metricStrip',
  'listRow',
  'entry',
  'conversation',
] as const

describe('@aeon-ui/schemas', () => {
  it('exposes a catalog of every component schema', () => {
    expect(catalog.components.length).toBeGreaterThan(10)
    expect(catalog.components).toContain('button')
    expect(componentSchemas.button['x-aeon']).toMatchObject({
      scope: 'button',
      runtime: 'status prop',
    })
  })

  it('keeps button statuses exhaustive for agents', () => {
    const states = (componentSchemas.button['x-aeon'] as { states: string[] }).states
    expect(states).toEqual(['idle', 'pending', 'success', 'failure', 'disabled'])
  })

  it('ships a non-empty system prompt', () => {
    expect(AEON_SYSTEM_PROMPT).toContain('UI = f(state)')
    expect(AEON_SYSTEM_PROMPT).toContain('Build the state machines first')
    expect(AEON_SYSTEM_PROMPT).toContain('data-aeon-state')
  })

  it('derives registry catalog from componentSchemas (no hand list drift)', () => {
    const schemaIds = Object.keys(componentSchemas).sort()
    const registryIds = registryCatalog.components.map((c) => c.id).sort()
    expect(registryIds).toEqual(schemaIds)
    expect(catalog.components.sort()).toEqual(schemaIds)
  })

  it('covers machine-backed components in the schema catalog', () => {
    for (const id of MACHINE_BACKED_SCHEMA_IDS) {
      expect(componentSchemas).toHaveProperty(id)
    }
    expect(componentSchemas.combobox['x-aeon']).toMatchObject({
      machine: 'popoverMachine',
      runtime: 'useAeonMachine',
    })
    expect(componentSchemas.tooltip['x-aeon']).toMatchObject({
      machine: 'popoverMachine',
      runtime: 'useAeonMachine',
    })
  })

  it('covers Instant-critical layout schemas', () => {
    for (const id of LAYOUT_SCHEMA_IDS) {
      expect(componentSchemas).toHaveProperty(id)
    }
    expect(componentSchemas.entry['x-aeon']).toMatchObject({
      scope: 'entry',
      runtime: 'props',
    })
  })

  it('maps machine export names to registry machine file ids', () => {
    expect(machineRegistryId('popoverMachine')).toBe('popover')
    expect(machineRegistryId('createAsyncMachine')).toBe('async')
    expect(machineRegistryId('buttonLifecycleMachine')).toBe('buttonLifecycle')
    expect(machineRegistryId(null)).toBeUndefined()
  })

  it('points registry machineUrl at the mapped machine id when present', () => {
    const select = registryCatalog.components.find((c) => c.id === 'select')
    expect(select?.machineUrl).toBe('https://aeon-ui.com/registry/machines/popover.json')
    const scroll = registryCatalog.components.find((c) => c.id === 'scroll')
    expect(scroll?.machineUrl).toBeUndefined()
  })
})
