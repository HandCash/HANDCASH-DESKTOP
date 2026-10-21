# Changelog

## [Unreleased]

## [1.9.0] - 2026-10-21

### Added

- **Chart cache (`@aeon-ui/primitives`).** `createChartCache({ id, load, ttl, tags? })` is a keyed cache charts invoke as `cache.actor`, shared by every chart instance. Each key is a `cacheEntryMachine` (`idle`, `loading`, `ready`, `stale`, `refreshing`, `failed`): one load per key, a time-to-live per key, stale data served while it revalidates, and `CACHE.INVALIDATE` by key or tag. `peek()` returns a stable view for selectors. Ids naming secrets, keys or spend decisions are refused.
- **Windowed lists.** `computeListWindow` (`@aeon-ui/core`) and `useWindowedRange` (`@aeon-ui/react`) mount only the rows in view, for vertical lists and horizontal strips.
- **Sounds (`@aeon-ui/core`).** `playSound(name)` plays short UI sounds synthesized with Web Audio (`tap`, `copy`, `send`, `success`, `attention`, `error`, `ready`); no audio files. Silent until the app calls `configureSounds({ enabled: true, volume })`. The same sound fired twice within 60 ms plays once. `createSoundPlayer` takes a context factory for tests.
- **`Clipboard` sounds.** `clipboardMachine` plays `copy` on entering `copied` and `error` on entering `failed`, through the `soundCopied` / `soundFailed` actions.
- **`Clipboard`.** One-click copy on `clipboardMachine` (idle, copying, copied, failed); the styled trigger swaps a copy icon for a check and a live region announces the result.
- **`Prose`.** Styles rendered markdown in em, so it follows the surrounding font size; draws list markers the reset strips, and `<ol start>` numbers correctly.
- **`Textarea`.** Grows with its content between `minRows` and `maxRows`; `outline` and `ghost` variants.
- **`SegmentGroup`.** Compact single choice on `tabsMachine`; arrow keys, Home and End move the selection and skip disabled items.
- **`Composer.Input` `minRows` / `maxRows`.** The input grows with its text (default 1 to 4 lines) instead of staying one fixed height.

### Changed

- **Panda CSS 2.** `@aeon-ui/panda` runs on `@pandacss/dev` 2.3 and lists `preset-base` and `preset-panda` itself, since v2 adds no presets on its own. Generated `styled-system` files are `.js` instead of `.mjs`.

- **`Select.Positioner` `anchorRef`, `placement`, `matchAnchorWidth`.** The same options `Popover.Positioner` takes: a compact trigger pinned to the end of a row can open its listbox across the row it belongs to, so option labels and details are not squeezed to the trigger's width.

### Fixed

- **Controlled `Tabs.Root` reports clicks.** With `value` set, a trigger click calls `onValueChange` with the clicked value; before, it changed only machine state the controlled value ignored, so the tab never switched. `Tabs.Root` also takes div attributes.
- **`RadioGroup.Root` takes `aria-label`.** Its props extend div attributes, so `aria-label`, `id` and the rest type-check (the root already passed them through).
- **`anatomy()` carries its `scope` at runtime.** The type promised `.scope`, but the object had none, so `scopeAttrs(x.scope, …)` emitted `data-aeon-scope="undefined"`.

## [1.8.0] - 2026-09-27

### Added

- **`Popover.Positioner` / `FloatingPositioner` `anchorRef` + `matchAnchorWidth`.** Position a surface against the region it belongs to instead of the small trigger pinned to its edge, so a wide panel lands where the eye already is rather than being clamped back from the viewport edge.
- **Optional philosophy note:** [docs/ANALOGY.md](./docs/ANALOGY.md) — Aeon as metaphor for formless truth and sensory projection (not product doctrine). Linked from [PHILOSOPHY.md](./PHILOSOPHY.md) and the docs index.
- `@aeon-ui/tree` — widget trees. A widget is immutable data describing one face
  of a chart, interpreted into DOM with `data-aeon-scope|part|state`. Flutter's
  Widget and Element layers only: no RenderObject (layout stays CSS), no
  `StatefulWidget` (the chart is the only state).
- `exclusiveActionWidget` — the shared face for "confirm, then await" regions
  (`idle → confirming → busy → idle | failure`): pending label, disabled set,
  failure copy and confirm slot are functions of the snapshot.
- `uncoveredStates(states, project)` — totality as a test: every state the chart
  names must appear on the tree projected for it.
- `interpret(tree, hosts)` — element layer; hosts slot existing compounds
  (`Prompt`, fields) into names the tree declares.
- Vite aliases, optimizeDeps exclude and tsconfig paths include `@aeon-ui/tree`.

## [1.7.7] - 2026-08-18

### Added

- **Three more primitives in the live section, chosen for chart complexity.** `Slider` is hierarchical — the snapshot reports `interaction.dragging`, so the chart lights the region *and* the leaf inside it while you drag, and an arrow key shows `SET_VALUE` writing context without leaving the state. `FileUpload` runs a real drag-and-drop lifecycle (`idle` / `dragging` / `rejected`), driveable by dragging a file or by sending the same events from buttons. `Toast` is the one chart that moves without you: `visible` carries a delayed `TIMEOUT` that retires it on the machine's own clock.
- **`useSliderContext`** exported from `@aeon-ui/react`, so a slider's live machine state (including the nested `interaction` value) is readable from inside `Slider.Root` — matching `useAsyncContext` / `useFieldContext` / `useStickyBarContext`.

### Fixed

- **The live chart never highlighted a component's *initial* state.** A late SVG swap replaced the diagram after the highlight was painted, so the first snapshot silently went dark until you interacted. The explorer now repaints when the rendered chart changes.
- **`valid` also lit up `invalid`.** Node matching compared id substrings, so any state whose name contained another's was highlighted too. Matching is now segment-aware, and a region's `[*]` marker no longer inherits its parent's highlight.
- **Nested snapshot values are highlighted properly.** A dotted path such as `interaction.dragging` now lights every node on the path, since the ancestors are genuinely active.
- **Live charts are readable.** The explorer box was short enough that parallel and nested diagrams auto-fit to ~30%; it now has room, and the slider's nested region lays out left-to-right.

## [1.7.6] - 2026-08-18

### Changed

- **Hero video: resolved an apparent contradiction in the narration.** "Nothing else exists" (about the async machine) could read as conflicting with the later child-machine states (broadcasting, seen, mined). The closed-world line is now scoped — "that's this machine's entire world" — and the hierarchy scene opens with the bridge: "Need more states? Charts nest." Transcript re-aligned (61s).

## [1.7.5] - 2026-08-18

### Changed

- **Hero video narration re-recorded for clarity.** "Statechart" is now fed to TTS as "state chart" so it isn't mispronounced (the on-screen subtitle keeps the correct spelling — `speak` overrides audio only, the same mechanism the closing URL already used). The parallel-regions explanation is rebuilt around three plain questions — "Has it been edited? Does it pass? Is it sending?" — and each chart lane now prints its question next to the region name, so the words and the diagram agree. Also clearer: "no in-between states" replaces "no half states", "your CSS targets that attribute" replaces "your styles key off it", and the child machine's middle state is spoken as "seen on the network" rather than a bare "seen". Transcript re-aligned (59s).

## [1.7.4] - 2026-08-18

### Changed

- **Hero video intro now shows the pain, and the ending is de-branded.** The opening scene names the actual symptoms of boolean soup — a mystery spinner with no context, two buttons wired to the same job (`Retry` / `Reload`), and "state is a mess" — instead of an abstract truth count. The narration no longer says the word "dirty" (the state node still shows it, since that's the real machine state). The hierarchy scene presents the nested send flow as "a real example / wallet · send" without naming the product. Transcript re-aligned (57s).

## [1.7.3] - 2026-08-18

### Changed

- **Hero video: plainer intro, glossed jargon, and a real hierarchical chart from a shipping product.** The intro now shows three plain `loading` / `empty` / `error` toggles with what each means in English, instead of prop-name jargon. The parallel-regions scene explains `dirty` outright ("dirty just means the user typed") and prints a plain-English gloss under the composite value. The machine catalog scene is replaced with the send flow from HandCash Desktop: the `sendPayment` chart (`editing → confirming → handoff`) with the `txLifecycle` child machine (`broadcasting → seenInMempool → mined`) nested inside `handoff` — the wallet surface and the breadcrumb (`handoff › broadcasting`) stay in lockstep with the chart. Also fixed a renderer bug where PIL ignored text alpha, so every text fade-in had been popping at full opacity (visible as floating state labels before their nodes appeared). Transcript re-aligned (55s).

## [1.7.2] - 2026-08-18

### Changed

- **New hero video, built from scratch to teach statecharts — not one animated state.** Seven scenes: three booleans producing a screen with a spinner and an error at once; the async machine with every state named and every edge labelled with its event; an event with no matching edge blocked at the door; the field machine's three parallel regions all true at once beside the surface that projects them; `state → data-aeon-state → pixels`; and four components each running their own machine on their own clock. Real system typography (SF / SF Mono), a poster frame from the chart scene, faststart streaming, and re-aligned transcript cues (52s).

## [1.7.1] - 2026-08-18

### Changed

- **Hero video now shows the actual thesis.** Previously the statechart node swept on its own float while the phone face animated separately, so the chart and the screen never agreed. The centrepiece is now one coupled demo: the component face and the highlighted chart node are the same state, driven by a single step timeline, with the causing event (`FETCH`, `RESOLVE`, `REJECT`, `REFRESH`) labelled on the transition edge — the same idea as the live section. The closing card points at "See it live" instead of the removed builder; transcript cues re-aligned.

## [1.7.0] - 2026-08-18

### Added

- **Live section: real components beside the chart that tracks them.** Async, Button, Field, and Dialog run their shipped machines; the Mermaid chart highlights the state the component is actually in and names the event that caused the move. Field reports all three regions at once, because a field has no single state.
- Machine-accurate diagrams for `buttonLifecycleMachine`, `dialogMachine`, and `fieldMachine`; the async chart now shows its `REFRESH` and re-fetch edges. `aeonDiagrams.test.ts` fails if a chart misses a machine state or invents one.

### Fixed

- **A controlled `Dialog`, `Popover`, or `Menu` could never be opened by its own trigger.** `onOpenChange` reported the resolved prop, so an owner holding `open` never heard the machine's intent — the trigger, escape key, and outside click were all dead. Each root now reports the machine's own transition (and no longer fires on mount).

### Removed

- **The generative app builder is gone** — sandbox, chart→schema compiler, live composer, model client, cost meter, and the `/api/aeon-generate` and `/api/aeon-scrape` endpoints, plus the OpenRouter proxy plugin and its env keys (~6,000 lines). Landing nav, hero, and header CTAs point at the live section.
- The static "Determinism" diagram section, now that the live charts replace it. `expandActiveStates` lost its builder-specific token aliases.

## [1.6.1] - 2026-08-18

### Changed

- **Builder previews read like designs, not state dumps.** The first screen now leads with the site's own hero headline and description (scraped, never invented); other screens are titled by their state once. Actions promote one primary button and group the rest instead of stacking equal buttons. The app bar no longer repeats the state label the dock already shows.
- **Device selector is back** — phone / tablet / desktop toggle above the preview, with the desktop frame showing the scraped host in its address bar.

## [1.6.0] - 2026-08-18

### Added

- **Redesign any site from its URL** — paste a domain into the builder and `/api/aeon-scrape` reads the page for its name, description, nav, actions, logo, and `theme-color`. The brand becomes chrome (logo in the app bar, accent palette scoped to the preview) and the page content becomes the prompt. Private and non-HTTP hosts are refused.
- `builder/projectFaces.ts` — generic chart projection: states become screens, transitions become actions, `collect` demos add a field, `async` demos add an async region.
- Demo tests now run in CI (`pnpm test`), covering projection, scraping, palette derivation, and a server render of the builder output.

### Changed

- **App builder rebuilt around one input.** Prompt or URL, Build, preview. The starter chips, engine bar, cost meter, inspector tabs, device picker, and build loader are gone.
- **The model returns a chart and nothing else; the UI is projected from it.** Previously ~1,900 lines of prompt keyword matching decided that "match" meant a dating app, "faq" meant an accordion, and "pong" meant paddles, then filled screens with seeded catalogs, listings, and test stimuli. All of it is deleted, along with the preset app schemas it produced.
- Empty nav tabs are dropped instead of being filled with placeholder screens, and the offline fallback chart is deliberately shapeless rather than a product guess.

## [1.5.2] - 2026-08-18

### Changed

- **Landing page trimmed to essentials** — removed the pillars grid, the numbered setup box, and the full rule-file dump; the Cursor section is now one command plus a copy button. Hero shows a single install line, the why section keeps only the same-prompt contrast, specs show one chart, and the FAQ is four questions.

## [1.5.1] - 2026-08-18

### Added

- **Scoped package linking (Next.js works without aliases)** — `postinstall` and `npx aeon-ui link` symlink `node_modules/@aeon-ui/*` → `aeon-ui-engine/packages/*`. Next.js consumers now need only `transpilePackages` plus `"use client"`; the Vite plugin is optional (optimizeDeps convenience).
- **`aeon-ui link` CLI command** — `--cwd`, `--force`, `--quiet`; also runs at the end of `npx aeon-ui init`. Exported as `aeon-ui-engine/link`.

### Changed

- CONSUMER.md, README, INTEGRATION, VITE_CONSUMER, MIGRATION_FROM_ARK, PUBLISHING: install once, link automatically, Vite plugin optional; `file:` link workaround for Next.js removed.
- Landing FAQ and Cursor rules snippet state that Aeon is React-first with Next.js supported, and that Vue / Solid / Svelte are thin adapters rather than the main catalog.

## [1.4.1] - 2026-08-17

### Fixed

- **Floating surfaces are collision aware** — `Menu` / `Popover` / `Tooltip` / `Select` positioners now accept `bottom-end` / `top-end` / `*-center` placements, flip when the preferred side has no room, and clamp inside the viewport. Right-aligned triggers (avatar menus in a sticky header) no longer render offscreen.
- **Positioner stacking is configurable** — `gutter` and `zIndex` props on `Menu.Positioner`, `Popover.Positioner`, `Tooltip.Positioner` replace the hardcoded 4px gap and `z-index: 50`, so menus can sit above app chrome.
- **Menu keyboard behavior** — `Menu.Content` takes focus while open, restores focus to the trigger on dismiss, and closes on Escape from anywhere on the page (previously only when focus was already inside the surface).
- **Controlled `Slider` reports interaction** — pointer and keyboard input now call `onValueChange` even when `value` is set, so a controlled thumb (audio seek bar) follows its prop instead of Aeon's internal value. `onValueChange` no longer fires on mount or echoes the controlled prop.
- **`sliderMachine` bounds follow the host** — new `SET_BOUNDS` / `SET_DISABLED` events, sent by `Slider.Root` on prop change, so a range that grows later (track duration arriving) stops clamping to the initial `max`.

### Added

- Positioners publish `data-side`, `data-align`, `--aeon-available-height`, and `--aeon-anchor-width` for recipes that cap their own scroll area.

## [1.4.0] - 2026-08-17

### Added

- **RangeSlider** — `rangeSliderMachine` + headless/styled compound (two thumbs, `minStepsBetween`).
- **FileUpload** — `fileUploadMachine` + dropzone compound (`idle | dragging | rejected`; file bytes in React).
- **Button `asChild`** + exported `Slot` — merge button attrs onto `Link` / `<a>`.
- **`npx aeon-ui migrate`** — scan known workarounds + write `AEON_MIGRATION_CHECKLIST.md`.
- **docs/MIGRATION.md** — greenfield + upgrade playbook for future app migrations.

### Changed

- COMPONENTS / MACHINES / PRIMITIVE_COVERAGE / API_PATTERNS updated for 1.4 primitives.
- **aeon-ui.com** hero, FAQ, Cursor docs, CONSUMER, and README now lead with `npx aeon-ui migrate` for existing apps.

## [1.3.6] - 2026-07-31

### Changed

- **Landing hero** — “A better way to build with AI” (title, OG, tagline).
- **Builder statecharts** — live chart follows the active UX scope/machine and highlights more reliably as you interact.

### Earlier in 1.3.6

- **Landing why-first** — philosophy, pillars, FAQ, and charts/totality support that outcome instead of leading with mechanics.

## [1.3.5] - 2026-07-31

### Added

- Layout schemas for Instant/agent surfaces: identity, profileHeader, metricStrip, listRow, entry, conversation (38 total schemas).

### Fixed

- **Tooltip open/closed** — uses `popoverMachine` like Popover/Select/Combobox; openDelay / closeDelay / touchDuration stay React-local.
- Agent prompts and MACHINES/COMPONENTS/FILE_MAP now treat Tooltip as popover-family.

## [1.3.4] - 2026-07-31

### Fixed

- Instant/Build no longer shows chart-only stubs like “States: idle · discover · … Project faces in a second pass.” — projects concept/prompt faces while keeping the authored chart.

## [1.3.3] - 2026-07-31

### Fixed

- **Agent registry lag** — runtime `registry/catalog.json` now derives from `componentSchemas` (was stuck at 4 entries while schemas existed).
- **Machine emit coverage** — schema emit writes all 15 primitives machines (was only async/button/dialog/field), unlocking `validEvents` trees for popover family, slider, shells, etc.
- **Combobox open/closed** — uses `popoverMachine` like Select; query/highlight stay React-local.
- Stale docs claiming Select/Combobox were pure `useState`; checklist now requires schema + emit steps.

### Added

- Component schemas for machine-backed and high-traffic surfaces: radioGroup, slider, content, panel, appShell, stickyBar, nav, appNav, prompt, statusBanner, pinInput, avatar, bar, separator, composer, thread (32 total).

## [1.3.2] - 2026-07-31

### Changed

- Restore state-first landing messaging (remove BETA chrome from hero, meta, and builder).

## [1.3.1] - 2026-07-30

### Changed

- Describe this release.

All notable changes to **aeon-ui-engine** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-07-30

### Changed

- **Consumer shell defaults** aligned with dense Electron wallet chrome:
  - Headless Dialog backdrop / positioner / content (so Prompt works without `@aeon-ui/ui` recipe classes)
  - Prompt title + description typography (`--aeon-font-display`)
  - StatusBanner sticky top placement
  - AppNav dense 28px breadcrumb / back rail
- **`applyBrandPalette` fonts** also set `--fonts-ui`, `--fonts-body`, `--fonts-display` so recipes pick up brand typefaces
- **Electron CSS** — fill-height `.app-shell` / `.stage`, `.titlebar` alias, compact 3px scrollbars, hover-reveal scroll helper

### Docs

- [PRODUCT_SHELL.md](./docs/PRODUCT_SHELL.md) — headless Prompt requires consumer-shell; do not re-copy shell CSS into products

## [1.2.0] - 2026-07-30

### Added

- **Brand palette bridge** — `applyBrandPalette`, `normalizeBrandPalette`, `brandPaletteToCssText` map product tokens onto Aeon CSS vars without a parallel token sheet.
- **AppNav** — `appNavMachine` + `AppNav` / `useAppNavMachine` for section + detail stack navigation with breadcrumb/back parts.
- **Prompt** — confirm/permission-style compound on top of Dialog (`eyebrow`, `meta`, `amount`, `actions`).
- **StatusBanner** — non-blocking top-of-app notice compound.
- **`useFitText`** — shrink-to-fit metric/title helper.
- **Consumer shell CSS** — baseline Prompt / StatusBanner / AppNav styles in `aeon.css`.
- **Electron chrome CSS** — optional `@aeon-ui/panda/electron.css` titlebar drag helpers.
- Docs: [PRODUCT_SHELL.md](./docs/PRODUCT_SHELL.md).

### Changed

- Avatar root also projects `ready` alongside `loaded` for friendlier product CSS.
- `aeonUiVitePlugin` aliases include consumer-shell and electron CSS paths.

## [1.1.0] - 2026-07-30

### Added

- App-shell and layout primitives: Panel, Nav, StickyBar, ListRow, MetricStrip, ProfileHeader.
- Messaging / conversation surfaces: Entry, Field updates, Thread, Identity.
- ThemeSwitcher and expanded Instant / compose demo tooling.
- Schema catalog and generative compose improvements for chart-first Instant projection.

### Changed

- Instant runs as a two-pass chart→faces compiler with real XState.
- Demo landing and builder aligned to state-first UX and per-page statecharts.

## [1.0.3] - 2026-06-02

### Added

- `aeon-ui-engine/vite` export — `aeonUiViteAliases()` and `aeonUiOptimizeDeps()` for npm consumers.
- **[CONSUMER.md](./CONSUMER.md)** — accurate install, Vite alias, and TypeScript path setup.

### Changed

- npm tarball excludes monorepo dev apps (`.npmignore`); ships `packages/`, `scripts/`, and consumer docs only.
- Site hero and FAQ document peer deps plus required Vite wiring (not `import` alone after `npm install aeon-ui-engine`).

## [1.0.2] - 2026-06-02

### Added

- Shared Panda tokens `controlMinHXs`, `controlMinHSm`, `controlMinHMd`, and `controlMinHLg` so compact control heights stay aligned across components.

### Changed

- Button, select trigger, and combobox input recipes reference the shared control-height tokens instead of hardcoded `rem` values.
- Demo header toolbar uses `size="sm"` for buttons alongside the select (same compact tier) without page-level height overrides.

## [1.0.1] - 2026-06-02

### Changed

- Open Graph preview image shows `npm install aeon-ui-engine` and is served at `/og-aeon-ui-engine.png` for cache-friendly social sharing.
- Demo site copy standardized on the `aeon-ui-engine` npm package name.

### Fixed

- Mobile header theme preset select shows a visible **Theme** label instead of chevron-only.

## [1.0.0] - 2026-06-02

### Added

- Initial npm release of **aeon-ui-engine** — monorepo bundle with headless statechart primitives, React bindings, Panda styled layer, and themes.

[1.2.0]: https://github.com/GenericCPU/aeon-ui/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/GenericCPU/aeon-ui/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/GenericCPU/aeon-ui/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/GenericCPU/aeon-ui/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/GenericCPU/aeon-ui/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/GenericCPU/aeon-ui/releases/tag/v1.0.0
