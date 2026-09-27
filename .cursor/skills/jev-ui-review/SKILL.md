---
name: jev-ui-review
description: >-
  Review HandCash wallet UI (Desktop, Mobile shell, Market) against the Aeon
  trajectory with Jev, TypeSafe's System One model, so each surface lands with
  less debt than it found. Use when building or touching components in
  src/components, when asked about UI debt, UI performance, Aeon alignment,
  boolean state twins, stateToAttr projection, or before bumping a release.
  Runs `npm run ui:review`; code computes facts, Jev judges, code decides.
---

# Jev UI review (Aeon trajectory)

Jev does not write or read UI for us. It answers narrow typed questions about
facts code already extracted, with calibrated probabilities. Code owns the
verdict. This is the TypeSafe skill
(https://docs.typesafe.ai/agent-skill.md) narrowed to one job: keep every
component moving toward **UI = f(statechart snapshot)**.

## Run

```bash
cd handcash-desktop
npm run ui:review                 # components changed vs HEAD (+ untracked) — the default while building
npm run ui:review -- --base origin/master
npm run ui:review -- --file src/components/SendPanel.tsx
npm run ui:review:all             # whole tree; ~330k tokens ≈ $0.014
npm run ui:facts                  # exact facts only, no API call
npm run ui:review -- --json > /tmp/review.json
```

Key: `JEV_KEY` (or `JEV_API_KEY`) from the environment, `HandCash/.env`, or
`handcash-desktop/.env`. Never expose it to the renderer.

Mobile has no components of its own: it renders `@handcash/wallet-ui`
(Desktop `src/`), so reviewing Desktop reviews Mobile. Market
(`BRC-MARKET`) shares the engine; point `--file` at its components from its
own checkout when the script is ported there.

## Read the report

```
▲ src/components/PaymentDetailsPanel.tsx
    debt ███████████████····· 2.98  Component-local flow …  (model read 2.97, act @ 0.91)
    fix first: move_flags_to_chart (conf 1.00)
    - [machine] act      6 exclusive busy booleans (retrying, clearing, …) gate buttons and reset in finally
    - [machine] act      booleans model phases (p=0.97); owner → new_chart (conf 0.95)
    - [compound] review   3 window.confirm call(s) — Prompt compound driven by a chart state.
```

- **debt** is a code composite (`WEIGHTS` in `scripts/jev-ui-review.mjs`) on
  the 0–4 legend: Aeon-native · minor drift · mixed · component-local flow ·
  second UI system. `▲` marks ≥ 2.
- **model read** is Jev's own holistic score, kept for comparison. When it
  disagrees with the composite by more than one level, read the excerpt
  yourself — either a fact regex missed something or a question needs tuning.
- **act / review / escalate** is confidence-gated per `POLICY`. Act without a
  second look ≥ 0.6; read the code ≥ 0.35; below that the answer is a hint.
- Findings are ordered by the layer ladder from `aeon-ui.mdc`:
  **domain path → machine → projection → compound → CSS**. Fix the lowest
  layer first; higher-layer findings often disappear with it.
- Findings marked from exact facts (busy-boolean sets, raw `.value`
  projections) are also ratcheted in `src/machines/aeonAdherence.test.ts`.
  The review and the gate share `scripts/ui-facts.mjs`, so they cannot drift.

## Act on `fix first`

| fix first | Do this |
| --- | --- |
| `move_flags_to_chart` | Booleans set before an `await` and cleared in `finally`, OR-ed into `disabled`. Bind a chart. For exclusive row/list actions use `useActivityAction()` (`activityActionMachine`); for a distinct flow add a machine in `src/machines/`, register it in `machineManifest.ts`, bump the manifest count test. |
| `project_with_state_to_attr` | `data-aeon-state={stateToAttr(snapshot.value)}`. Never `snapshot.value`, `String(state.value)`, or a boolean ternary restating chart state. |
| `replace_confirm_with_prompt` | `window.confirm` → Aeon `Prompt` opened by a chart state (`confirming`), so the confirm step is a state, not a modal call. |
| `compose_compound` | Replace the hand-rolled chrome with the named compound (`Dialog`, `StatusBanner`, `ListRow`, `Tabs`, `Menu`) from `@aeon-ui/react` / `@aeon-ui/ui`. Missing primitive → change the engine, not a wallet-only widget. |
| `window_or_defer_render` | Window wallet-scale lists, subscribe once, route bitmaps through `DeferredImage` / `AppAvatar`. |
| `split_component` | Split by chart before touching anything else. |
| `css_to_attr_selectors` | Move class-keyed state styling in `handcash.css` to `[data-aeon-scope][data-aeon-state]` selectors. |
| `nothing` | Composite < 1 and no proven finding. Leave it. |

Keep toasts, sounds, confirms and re-classification in the component; the
chart only names phases and keeps the failure reason. See
`PaymentDetailsPanel.tsx` and `RecentActivity.tsx` after their migration for
the reference shape.

## Loop while building

1. Chart first, then JSX (per `aeon-ui.mdc`).
2. `npm run ui:review` on the diff. Target: composite < 1 and `fix first: nothing` for every touched file, no `▲`.
3. `npx vitest run src/machines/aeonAdherence.test.ts` — allowlists only shrink; if you must add a file, that is an architectural decision to state in the commit.
4. Re-run the review after the fix and quote the before/after debt in the commit body.

## Tune the questions, not the prose

All questions live in `questionsFor()`; thresholds in `POLICY`; weights in
`WEIGHTS`. If Jev over-fires on a class of component, add the disambiguating
**fact** to `scripts/ui-facts.mjs` and reference it in the question
(`facts.presentationOnlyBooleans` was added this way when a show/hide password
toggle scored as a flow). Do not ask Jev to count or to read whole files; the
excerpt is capped at 18k chars against a 32k-token state budget.

## Do not

- Trust a low-confidence `fix first` over a proven finding — the script already
  prefers proven findings; keep it that way.
- Add a second reviewer or a Tailwind/shadcn-style lint. This is the one gate.
- Pass raw Jev output to users. Report the composite, the ladder finding, and
  the change made.
