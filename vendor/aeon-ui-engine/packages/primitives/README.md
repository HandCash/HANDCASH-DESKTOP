# @aeon-ui/primitives

**XState v5 machines** — behavior only, no DOM.

Agents: [docs/MACHINES.md](../../docs/MACHINES.md) lists every machine and events.

## Install

```bash
pnpm add @aeon-ui/primitives
```

Pair with `@aeon-ui/react` (`useAeonMachine`) or your own XState bindings.

## Exported machines

| Export | File | Use |
|--------|------|-----|
| `toggleMachine` | `machines/toggle.ts` | Switch, Checkbox |
| `dialogMachine` | `machines/dialog.ts` | Dialog |
| `tabsMachine` | `machines/tabs.ts` | Tabs |
| `accordionMachine` | `machines/accordion.ts` | Accordion |
| `createAsyncMachine` | `machines/async.ts` | Async regions |
| `asyncMachine` | default instance | |
| `buttonLifecycleMachine` | `machines/button.ts` | App/demo — not wired inside headless Button |
| `fieldMachine` | `machines/field.ts` | Field (parallel) |
| `popoverMachine` | `machines/popover.ts` | Menu, Popover, Select |
| `toastMachine` | `machines/toast.ts` | Toast item |

## Helpers

```ts
import { ASYNC_LIFECYCLE_STATES, isEmptyAsyncData, createAsyncMachine } from '@aeon-ui/primitives'
```

## Async example

```ts
const machine = createAsyncMachine<User[]>()
// send: FETCH | RESOLVE | REJECT | RESET | STALE | REFRESH
```

## Extend

1. Add `src/machines/<name>.ts`
2. Export from `src/index.ts`
3. Wire in `@aeon-ui/react`
4. Update `apps/demo/src/aeonDiagrams.ts`
5. [docs/COMPONENT_CHECKLIST.md](../../docs/COMPONENT_CHECKLIST.md)

## Related

- [STATES.md](../../STATES.md)
- [packages/react/README.md](../react/README.md)
