# Aeon UI statecharts (agent prompts)

## Async region statechart
States: idle → loading → (success | empty | failure); REFRESH from success/empty/failure; STALE flag while success.
Events: FETCH, RESOLVE{data}, REJECT{error}, RESET, STALE, REFRESH.
Rule: Render track segments for idle, loading, success, empty, failure. Never hide empty/failure behind a generic spinner.

## Field parallel statechart
Regions:
- interaction: pristine | dirty
- validation: valid | invalid
- submission: idle | pending
Events: INPUT, BLUR, VALIDATE{valid}, SUBMIT, SUBMIT_DONE, SUBMIT_FAIL, RESET.
Rule: Do not collapse validation + submission into one `error` boolean. Message UI follows validation region; pending follows submission.

## Button lifecycle
Preferred headless API: `status` prop ∈ idle | pending | success | failure | disabled.
Optional machine: buttonLifecycleMachine with PRESS / RESOLVE / REJECT / RESET.
Rule: Pending must set aria-busy. Do not use disabled alone to mean "saving".

## Dialog statechart
States: open | closed. Events: OPEN, CLOSE, TOGGLE.
Rule: Backdrop click and Escape are CLOSE transitions. Title/Description are required for a11y when open.

## Popover family (Popover, Menu, Select, Combobox, Tooltip open state)
Machine: popoverMachine — states open | closed.
Rule: Reuse this chart. Never create selectOpenMachine / menuOpenMachine / comboboxOpenMachine / tooltipOpenMachine forks.
Combobox: query + highlight stay React-local; open/closed must still be popoverMachine.
Tooltip: openDelay / closeDelay / touchDuration stay React-local; open/closed must still be popoverMachine.

## Switch / Checkbox
Machine: toggleMachine — checked | unchecked. Events: TOGGLE, CHECK, UNCHECK.
Rule: Hidden input stays in sync with snapshot for forms.

## Slider statechart
Machine: sliderMachine — idle | dragging; value/min/max/step in context.
Events: SET_VALUE, STEP, POINTER_DOWN, POINTER_UP, HOME, END.
Rule: Disabled blocks SET_VALUE / drag; project idle vs dragging on data-aeon-state.

## Content region statechart
Machine: contentRegionMachine — idle → pending → (empty | error | ready) → loadingMore | success.
Events: LOAD, RESOLVE, REJECT, RETRY, LOAD_MORE, MORE_DONE, SUCCEED, RESET.
Rule: Every stable state has a slot. Pair with Async for fetch; do not hide empty/error behind a spinner.

## Toast item statechart
Machine: toastMachine — hidden | visible. Events: SHOW, HIDE, DISMISS.
Rule: Provider list orchestration may use React; each toast item uses the machine.

## StickyBar statechart
Machine: stickyBarMachine — floating | docked | collapsed | hidden.
Events: DOCK, FLOAT, COLLAPSE, EXPAND, HIDE, SHOW, SET_OFFSET.
Rule: DOM scope is bar (bar anatomy zones). Do not invent a parallel sticky useState.
