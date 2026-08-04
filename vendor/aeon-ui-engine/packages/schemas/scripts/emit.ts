import { mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  accordionMachine,
  appNavMachine,
  appShellMachine,
  asyncMachine,
  buttonLifecycleMachine,
  contentRegionMachine,
  dialogMachine,
  fieldMachine,
  panelMachine,
  popoverMachine,
  sliderMachine,
  stickyBarMachine,
  tabsMachine,
  toastMachine,
  toggleMachine,
} from '@aeon-ui/primitives'
import { catalog, componentSchemas } from '../src/components.js'
import { AEON_SYSTEM_PROMPT, CURSOR_RULES_SNIPPET, STATECHART_PROMPTS } from '../src/prompts.js'
import { aeonToSchema } from '../src/aeon-to-schema.js'
import { registryCatalog } from '../src/registry.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const jsonDir = join(root, 'json')
const promptsDir = join(root, 'prompts')
const registryDir = join(root, 'registry')
const demoRegistry = join(root, '../../apps/demo/public/registry')

mkdirSync(jsonDir, { recursive: true })
mkdirSync(promptsDir, { recursive: true })
mkdirSync(join(registryDir, 'components'), { recursive: true })
mkdirSync(join(registryDir, 'machines'), { recursive: true })

writeFileSync(join(jsonDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)

for (const [id, schema] of Object.entries(componentSchemas)) {
  writeFileSync(join(jsonDir, `${id}.json`), `${JSON.stringify(schema, null, 2)}\n`)
  writeFileSync(join(registryDir, 'components', `${id}.json`), `${JSON.stringify(schema, null, 2)}\n`)
}

/** Every primitives machine agents may fetch for validEvents / state trees. */
const machines = {
  async: asyncMachine,
  buttonLifecycle: buttonLifecycleMachine,
  dialog: dialogMachine,
  field: fieldMachine,
  popover: popoverMachine,
  toggle: toggleMachine,
  tabs: tabsMachine,
  accordion: accordionMachine,
  toast: toastMachine,
  slider: sliderMachine,
  panel: panelMachine,
  appShell: appShellMachine,
  appNav: appNavMachine,
  stickyBar: stickyBarMachine,
  contentRegion: contentRegionMachine,
} as const

for (const [id, machine] of Object.entries(machines)) {
  const schema = aeonToSchema(machine)
  writeFileSync(join(registryDir, 'machines', `${id}.json`), `${JSON.stringify(schema, null, 2)}\n`)
}

writeFileSync(join(registryDir, 'catalog.json'), `${JSON.stringify(registryCatalog, null, 2)}\n`)

writeFileSync(join(promptsDir, 'system.md'), `${AEON_SYSTEM_PROMPT.trim()}\n`)
writeFileSync(join(promptsDir, 'cursorrules.md'), `${CURSOR_RULES_SNIPPET.trim()}\n`)
writeFileSync(
  join(promptsDir, 'statecharts.md'),
  `# Aeon UI statecharts (agent prompts)\n\n${Object.values(STATECHART_PROMPTS).join('\n\n')}\n`,
)

mkdirSync(demoRegistry, { recursive: true })
if (existsSync(registryDir)) {
  cpSync(registryDir, demoRegistry, { recursive: true })
}

console.log(
  `Emitted ${Object.keys(componentSchemas).length} schemas + ${Object.keys(machines).length} machines → registry/ (+ demo public)`,
)
