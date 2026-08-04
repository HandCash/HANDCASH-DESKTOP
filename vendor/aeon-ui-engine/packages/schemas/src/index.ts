export { componentSchema, type JsonSchema } from './schema-builder.js'
export { catalog, componentSchemas, type ComponentSchemaId } from './components.js'
export {
  AEON_SYSTEM_PROMPT,
  CURSOR_RULES_SNIPPET,
  GENERATIVE_UI_EXAMPLE,
  STATECHART_PROMPTS,
} from './prompts.js'
export {
  aeonToSchema,
  aeonToPrompt,
  aeonSnapshotSchema,
  aeonInitialAgentContext,
  type AeonMachineSchema,
  type AeonSnapshotSchema,
  type AeonStateTreeNode,
} from './aeon-to-schema.js'
export {
  createAgentEventBridge,
  type AgentStreamEvent,
  type AgentEventMap,
  type AgentBridgeOptions,
  type AgentEventBridge,
} from './agent-bridge.js'
export { registryCatalog, REGISTRY_BASE, type RegistryEntry } from './registry.js'
export { machineRegistryId } from './machine-id.js'
