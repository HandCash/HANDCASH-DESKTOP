# Changelog

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
