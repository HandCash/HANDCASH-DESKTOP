# @aeon-ui/tree

Widget trees for Aeon. A widget is configuration — immutable data describing one face of a chart — interpreted into DOM that carries `data-aeon-scope`, `data-aeon-part`, and `data-aeon-state`.

This is Flutter's Widget and Element layers only. There is no RenderObject (layout stays CSS) and no `StatefulWidget` (the chart is the only state). A tree that stored `busy` itself would be the boolean twin the philosophy rules out.

```ts
import { exclusiveActionWidget, interpret, uncoveredStates, EXCLUSIVE_ACTION_STATES } from '@aeon-ui/tree'

const tree = exclusiveActionWidget({
  scope: 'settings-change-password',
  part: 'change-password-form',
  state,            // snapshot token
  busy,
  error,
  body: { type: 'host', id: 'body' },
  idleLabel: 'Update password',
  pendingLabel: 'Updating…',
  onSubmit,
  confirm: confirm !== null,
})

uncoveredStates(EXCLUSIVE_ACTION_STATES, (s) => exclusiveActionWidget({ ...args, state: s }))
// [] — every state of the chart has a face
```

`interpret(tree, hosts)` is the element layer. Hosts are where an existing compound (a field, a `Prompt`) fills a slot the tree names. Product CSS restyles the anatomy attributes; class names are passed in by the app, not invented here.

`exclusiveActionWidget` is the one face shared by every "confirm, then await" region: `idle → confirming → busy → idle | failure`.
