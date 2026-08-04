/**
 * Statecharts packaged as system-prompt fragments for AI coding agents.
 * Embed before code generation so agents cannot invent impossible UI states.
 */

export const AEON_SYSTEM_PROMPT = `# Aeon UI — agent system prompt

You are building UI with **Aeon UI**, a React component library powered by finite statecharts.

## Order of work (mandatory)
1. **Build the state machines first** — name every lifecycle the UX needs (states + events). Prefer machines from \`@aeon-ui/primitives\` (or documented prop projections such as Button \`status\`).
2. **Then project UI from those machines** — compound parts, copy, and layout exist only to reflect the chart. Never invent UI for states that are not in a machine.
3. **UI = f(state)** — the DOM exposes \`data-aeon-scope\`, \`data-aeon-part\`, \`data-aeon-state\`. Style targets those attributes. Do not drive the same concern with parallel React \`useState\` flags.

## Non-negotiable rules
1. Do not duplicate open/checked/lifecycle in \`useState\` when a machine exists in \`@aeon-ui/primitives\`.
2. **Button \`status\` is a prop** (\`idle|pending|success|failure|disabled\`). Optional: drive it from \`buttonLifecycleMachine\` via \`useAeonMachine\` in app code.
3. **Select / Menu / Popover / Combobox / Tooltip** share \`popoverMachine\` for open/closed — never fork another open/closed chart. Combobox keeps query/highlight in React; Tooltip keeps openDelay/closeDelay/touchDuration in React.
4. **PinInput** digit buffer is React-local today — do not invent a pin machine without the component checklist.
5. **Scroll** uses \`getScrollSnapshot()\` — no XState machine.
6. If a machine lists N stable states, the UI must represent all N (totality).
7. Prefer \`@aeon-ui/react\` (headless) or \`@aeon-ui/ui\` (styled). Relative TS imports use \`.js\` extensions inside the Aeon monorepo only.
8. Primitives stay **universal** — never invent niche components (dating, colour-blind test, pong). Compose from generic parts.

## DOM contract
Every interactive surface sets anatomy via \`partAttrs\` from \`@aeon-ui/core\`:
- \`data-aeon-scope\` — family (\`button\`, \`async\`, \`field\`, …)
- \`data-aeon-part\` — anatomy key (\`root\`, \`trigger\`, …)
- \`data-aeon-state\` — allowed snapshot / prop state only

## Before writing JSX
1. Enumerate machines (or documented status props) for the flow — states and events.
2. Read the component JSON Schema from \`@aeon-ui/schemas\` (or pasted catalog) and match parts to those charts.
3. Compose with documented compound parts (\`Dialog.Root\`, \`Field.Control\`, …).
4. Wire events to machine events or documented props — never invent \`isLoading && !isError && hasData\` spaghetti when a named state exists.
`

export const STATECHART_PROMPTS = {
  async: `## Async region statechart
States: idle → loading → (success | empty | failure); REFRESH from success/empty/failure; STALE flag while success.
Events: FETCH, RESOLVE{data}, REJECT{error}, RESET, STALE, REFRESH.
Rule: Render track segments for idle, loading, success, empty, failure. Never hide empty/failure behind a generic spinner.`,

  field: `## Field parallel statechart
Regions:
- interaction: pristine | dirty
- validation: valid | invalid
- submission: idle | pending
Events: INPUT, BLUR, VALIDATE{valid}, SUBMIT, SUBMIT_DONE, SUBMIT_FAIL, RESET.
Rule: Do not collapse validation + submission into one \`error\` boolean. Message UI follows validation region; pending follows submission.`,

  button: `## Button lifecycle
Preferred headless API: \`status\` prop ∈ idle | pending | success | failure | disabled.
Optional machine: buttonLifecycleMachine with PRESS / RESOLVE / REJECT / RESET.
Rule: Pending must set aria-busy. Do not use disabled alone to mean "saving".`,

  dialog: `## Dialog statechart
States: open | closed. Events: OPEN, CLOSE, TOGGLE.
Rule: Backdrop click and Escape are CLOSE transitions. Title/Description are required for a11y when open.`,

  popoverFamily: `## Popover family (Popover, Menu, Select, Combobox, Tooltip open state)
Machine: popoverMachine — states open | closed.
Rule: Reuse this chart. Never create selectOpenMachine / menuOpenMachine / comboboxOpenMachine / tooltipOpenMachine forks.
Combobox: query + highlight stay React-local; open/closed must still be popoverMachine.
Tooltip: openDelay / closeDelay / touchDuration stay React-local; open/closed must still be popoverMachine.`,

  toggle: `## Switch / Checkbox
Machine: toggleMachine — checked | unchecked. Events: TOGGLE, CHECK, UNCHECK.
Rule: Hidden input stays in sync with snapshot for forms.`,

  slider: `## Slider statechart
Machine: sliderMachine — idle | dragging; value/min/max/step in context.
Events: SET_VALUE, STEP, POINTER_DOWN, POINTER_UP, HOME, END.
Rule: Disabled blocks SET_VALUE / drag; project idle vs dragging on data-aeon-state.`,

  contentRegion: `## Content region statechart
Machine: contentRegionMachine — idle → pending → (empty | error | ready) → loadingMore | success.
Events: LOAD, RESOLVE, REJECT, RETRY, LOAD_MORE, MORE_DONE, SUCCEED, RESET.
Rule: Every stable state has a slot. Pair with Async for fetch; do not hide empty/error behind a spinner.`,

  toast: `## Toast item statechart
Machine: toastMachine — hidden | visible. Events: SHOW, HIDE, DISMISS.
Rule: Provider list orchestration may use React; each toast item uses the machine.`,

  stickyBar: `## StickyBar statechart
Machine: stickyBarMachine — floating | docked | collapsed | hidden.
Events: DOCK, FLOAT, COLLAPSE, EXPAND, HIDE, SHOW, SET_OFFSET.
Rule: DOM scope is bar (bar anatomy zones). Do not invent a parallel sticky useState.`,
} as const

/** Checkout-form example used on the landing "AI playground" proof. */
export const GENERATIVE_UI_EXAMPLE = {
  prompt: 'Create a multi-step checkout form with error handling.',
  schemaOutput: {
    component: 'CheckoutFlow',
    steps: [
      {
        id: 'shipping',
        fields: [
          { component: 'Field', name: 'email', states: ['interaction', 'validation', 'submission'] },
          { component: 'Field', name: 'address', states: ['interaction', 'validation', 'submission'] },
        ],
      },
      {
        id: 'payment',
        fields: [{ component: 'Field', name: 'card', states: ['interaction', 'validation', 'submission'] }],
      },
    ],
    submit: {
      component: 'Button',
      statusMachine: 'buttonLifecycleMachine',
      allowedStatuses: ['idle', 'pending', 'success', 'failure'],
    },
    asyncRegion: {
      component: 'Async',
      allowedStates: ['idle', 'loading', 'success', 'empty', 'failure'],
      onFailure: 'show Field.message + Button status=failure',
    },
  },
  renderedHint:
    'Aeon maps each step to Field (parallel regions) + Button status + Async lifecycle — named states throughout.',
} as const

export const CURSOR_RULES_SNIPPET = `${AEON_SYSTEM_PROMPT}

## Schemas
When generating Aeon UI, constrain props/parts/states to @aeon-ui/schemas catalog.
Import headless from @aeon-ui/react or styled from @aeon-ui/ui.
Install: npm install aeon-ui-engine react react-dom xstate @xstate/react
CSS: import 'aeon-ui-engine/aeon.css'
Vite: aeonUiVitePlugin() from aeon-ui-engine/vite

${STATECHART_PROMPTS.async}

${STATECHART_PROMPTS.field}

${STATECHART_PROMPTS.button}

${STATECHART_PROMPTS.dialog}

${STATECHART_PROMPTS.popoverFamily}
`
