# @aeon-ui/schemas

Deterministic **JSON Schemas**, **statechart → LLM prompts**, and **agent event bridges** for Aeon UI.

## Install

```bash
npm install @aeon-ui/schemas
npx aeon-ui init
```

## Statechart-as-a-prompt

```ts
import { createActor } from 'xstate'
import { asyncMachine } from '@aeon-ui/primitives'
import { aeonToSchema, aeonToPrompt, aeonSnapshotSchema, createAgentEventBridge } from '@aeon-ui/schemas'

const schema = aeonToSchema(asyncMachine)
// hierarchical tree + events — feed to tools / zod enums

const actor = createActor(asyncMachine)
actor.start()
const prompt = aeonToPrompt(asyncMachine, actor.getSnapshot())
const live = aeonSnapshotSchema(asyncMachine, actor.getSnapshot())
// live.validEvents → only what the agent may send *now*

const bridge = createAgentEventBridge(actor, {
  map: {
    AGENT_STREAM_START: 'FETCH',
    AGENT_STREAM_ERROR: (e) =>
      e.type === 'AGENT_STREAM_ERROR' ? { type: 'REJECT', error: e.error } : null,
  },
})
bridge.push({ type: 'AGENT_STREAM_START' })
```

## Registry

Runtime fetch (also mirrored on the demo at `/registry/`):

- `https://aeon-ui.com/registry/catalog.json`
- `https://aeon-ui.com/registry/components/button.json`
- `https://aeon-ui.com/registry/machines/async.json`

## Cookbook

[Vercel AI SDK + streamUI](../../docs/cookbook/vercel-ai-sdk.md)

## Principle

**UI = f(state)** — if it is not on the chart / in `validEvents`, do not send it.
