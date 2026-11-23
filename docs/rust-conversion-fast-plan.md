# Faster Rust conversion plan (2026-11-22)

Decision (user, 2026-11-22): the UI target is **Rust Aeon**: `aeon-ui` /
`aeon-dioxus` in `crates/handcash-app` on Dioxus Native (Blitz). TS Aeon is
not the target. The TS app is the **reference** to match and the **interim
shipped build** until the Rust app reaches parity.

This plan supersedes the ordering in `rust-desktop-mobile-migration.md`,
`rust-settings-parity-plan.md` and `rust-ui-port-roadmap.md`.
`rust-ui-parity-matrix.md` remains the per-screen scoreboard.

## Why it has been slow

- **Hand-porting, one panel at a time.** Every panel means rereading TSX,
  retyping the markup, then running the full clippy, test and release build
  cycle. We are at about 18% exact parity (11 of 61 rows) after 11.8k lines.
- **Parity is checked by eye.** Nothing proves a screen matches, so screens
  get rechecked and partial rows stay partial.
- **UI and backend are tangled.** About half of the missing rows wait on wallet
  logic (broadcast, BRC-38 backup, messagebox, BRC-100 dialogs), so screen
  work stalls behind backend work.
- **One serial chat, four overlapping plan documents, almost nothing committed.**

## Method (adapted from rust-anything)

From github.com/erkamyaman/rust-anything we take three ideas:

- **Record the original and replay it against the port.**
- **A per-unit gate:** a unit counts as done only when every recorded case
  matches.
- **A switch per unit.**

We apply them to screens as well as logic. The tool itself isn't used: its
bridges target Node, and its analyzer leaves UI out of scope.

## Track A: screens (Rust Aeon), with automated parity

1. **DOM parity harness (build first).**
   - **TS recorder.** A vitest script renders each TS component with
     `react-dom/server` `renderToStaticMarkup`, using fixture props for each
     state (empty, loading, error, filled, unavailable). It writes normalized
     HTML to `native-desktop/fixtures/ui/<component>/<state>.html`.
     Normalized means: classes, `data-aeon-*`, role/aria and text are kept;
     React-only attributes and whitespace are dropped.
   - **Rust replay.** A cargo test renders the matching Dioxus component with
     `dioxus-ssr` (already a dev-dependency) using the same fixture state,
     applies the same normalizer, and requires an exact match. The diff output
     shows exactly what is wrong.
   - **Same CSS.** `handcash-app` already embeds the TS CSS, so a DOM match
     means a visual match, except for Blitz rendering gaps. Those are logged as
     Aeon upstream issues, never forked here.
   - **Composed screens** that can't render in isolation: a dev-only hook dumps
     `outerHTML` of the live TS screen to the same fixture folder.
2. **Mechanical markup conversion.** A script (`scripts/tsx-to-rsx`) converts
   each TSX component's JSX into an `rsx!` skeleton:
   - `className` becomes `class` and attributes are mapped.
   - Text copy is kept exactly.
   - `{cond && …}` and `.map` become `if` and `for`.
   - Aeon React parts become their `aeon-dioxus` parts.

   Hand work is then limited to state and event wiring, and the harness says
   when the screen is done.
3. **State machines.** `src/machines/*` XState charts are ported to the Rust
   Aeon machine model in `machines.rs`. Their tests become Rust tests that
   replay recorded transition traces (event in, state and context out).
4. **Unavailable is a valid finished state.** A screen whose backend isn't in
   Rust yet must match TS exactly in its fixture states, with actions
   disabled and honest copy. That counts as UI parity, so the screen track
   never waits on Track B.

## Track B: wallet logic to Rust (runs in parallel)

The same record-and-replay approach applies to logic:

- **Recorder.** A TS recorder runs each unit on synthetic keys and fixture
  chain data and writes `native-desktop/fixtures/<unit>/*.json`.
- **Replay.** A cargo test must match those outputs byte for byte.
- **Approved differences.** Any intended difference goes in `known-diffs.json`,
  only with the user's approval.

Units are done in this order:

1. Refresh and chain ingest (UTXO scan, BEEF hydrate).
2. Display reads: balance, items, activity pages (engine phase 1 already exists).
3. BRC-38 history export and import, and the BRC-39 replica. This unblocks
   backup and wipe.
4. Vault and onboarding: wrap secret, lock modes, restore roles. Mostly done
   and uncommitted.
5. Unsigned transaction building.
6. Signing and broadcast. This waits for the independent crypto review and
   stays default-off.
7. Messagebox and PeerPay, and the BRC-100 permission logic. The migrate
   contract stays mirrored with items-market `/migrate`.

Wallet layers stay separate as defined in `src/wallet/layers.ts`.

## Working rules

- **Parallel chats.** Once the harness exists, assign one chat per screen
  group or per logic unit, each owning separate files. Suggested screen
  groups: auth and onboarding, dashboard and activity, settings, send and
  receive, collectables, messages and friends, apps and the browser.
- **Fast loop.** For each slice, run `cargo check -p handcash-app` plus that
  screen's parity test. Run full clippy and `cargo test --workspace` once per
  merged slice, and the release build only at milestones.
- **Commit each slice** after you approve it. The matrix is updated from the
  harness results, not by hand.
- **Ship.** The TS webview build stays the shipped app until every matrix row
  is either a DOM match or a matching unavailable state. Then
  `handcash-native` replaces it, with your approval.

## Sequence

1. Commit the current uncommitted Rust work (with approval).
2. Build the DOM parity harness and the TSX-to-RSX script. Prove them on
   finished screens: their 11 "match" rows must pass the harness.
3. Run the harness over every TS component to get a real, automatic scoreboard.
4. Fan out the screen groups and the logic units across parallel chats.
5. Cut over when the scoreboard is complete. Signing waits for the crypto review.

## Unchanged

- No signing or broadcast from Rust until the independent crypto review.
- No commit, push, install or release without approval.
- Aeon fixes go upstream in `~/AeonUI` and its Rust crates.
- `.env` files are never touched.
