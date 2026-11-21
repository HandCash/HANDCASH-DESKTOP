# Rust Desktop and Mobile migration

## Target and current boundary

User direction (2026-11-21): complete the native conversion, plan Mobile updates,
and keep no TypeScript where a verified replacement is possible. This is not
permission to remove working wallet code before its replacement exists.

Windows/Linux already use native-desktop (47c7b8a8). This slice replaces the
Mac Node bridge and static UI sidecars with handcash-sidecar, compiled from the
same Rust server modules. Swift still owns WKWebView, Keychain, durable storage,
native dialogs and Mac updates. Node remains a development/build dependency,
not a packaged runtime. The renderer and wallet still use shared TypeScript.
Do not describe this slice as an all-Rust wallet or an all-Rust Mac shell.

## Linux-first continuation (2026-11-21)

The user deferred Mac verification: "idc about mac atm keep going on this machine".
Mac work remains staged and unverified, not a prerequisite for Linux development.
Upstream aeon-ui already contains Rust aeon-core, aeon-primitives, aeon-dioxus
and aeon-ui crates (inspected locally, MIT-licensed, Dioxus 0.7); absence of a
Rust UI library is not a blocker. On 2026-11-21 the user directed dropping
Open BSV on HandCash's own code and choosing Apache-2.0 or MIT based on
strategic value; **Apache-2.0** was selected (decision `a5a9844b`) for newly
authored Rust code (`native-desktop/Cargo.toml`) for its explicit patent grant,
retaliation clause, and alignment with BSVA's 2026-11-11 Apache-2.0 relicense
of `bsv-blockchain/ts-stack`. Existing upstream third-party notices
(`packages/wallet-engine/LICENSE.upstream.txt`, `THIRD_PARTY_NOTICES.md`, and
installed `@bsv/sdk@2.8.11` / `@bsv/verifast@0.3.6` / `@bsv/webrtpay@0.2.1`)
remain intact until those JS dependencies are replaced or upgraded to Apache-2.0
npm releases; this does not replace independent signing/security review.

Platform-neutral Rust services now live in a shared library crate
(`native-desktop/src/lib.rs`, `handcash_shell`), imported directly by both
`handcash-shell` and `handcash-sidecar` without `#[path]` duplication.
`native-desktop/src/wallet_core/` adds the read-only Meridian foundation:
M1 strict lowercase hex and SHA-256/HMAC-SHA-256 (`encoding.rs`), the frozen
versioned scoped request language v1 with fail-closed origin/session/account/
generation/network/capability/cap/expiry/replay enforcement (`contract.rs`),
and type-level wallet layers, BRC-150 authenticity, 15s holding-freshness gap
tracking and 100-row generation-fenced display projections (`layers.rs`).
Read-only `walletCoreInfo`, `walletCoreStrictHex` and `walletCoreValidateRequest`
IPC methods are wired in `bridge.rs` and `handcash-page.js`. All 19 prior host
Clippy warnings are fixed (`cargo clippy --all-targets --no-deps -- -D warnings`
passes cleanly). `src/wallet/liveIdbPersist.ts` and
`src/wallet/liveSendReceiveEnv.ts` now import `src/wallet/atomicFile.ts`,
leaving no runtime `src/` imports from `electron/`.

Linux/Windows release checks, native architecture selection, persisted update
mode, scheduling and release status now run in Rust. HTTPS has a 25-second
deadline, no redirects and a 2 MiB JSON cap. Only an exact repository/tag/asset
download URL can be selected. Network and browser launch run outside the WebView
event loop; mode changes invalidate late HTTP results. The existing Aeon/XState
chart projects native status. The previous TypeScript implementation is removed;
its file now contains only the IPC type contract. Mobile and Mac update paths
are unchanged. A download still opens a zip in the browser; it never installs it.

This does not remove the shared TypeScript wallet or UI. They require the
ordered replacement and verification gates below, not deletion or renaming.

## Compatibility contract

- BRC-100 HTTP :3321 / HTTPS :2121; device-peer :3340. Existing Rust
  deadlines, pending-spend reconciliation, origin checks and TLS files apply.
- Newline JSON v1: ready, to-renderer and fatal to Swift; renderer-ready,
  from-renderer and shutdown to Rust. EOF stops servers. Malformed, unsupported,
  truncated and oversized input fails closed; payloads are never logged.
- Static UI stays at http://localhost:5173 to preserve IndexedDB origin.
  A port conflict refuses startup rather than loading an unrelated page.
- Keep HandCashDesktopNative user-data paths, Keychain service identifiers,
  durable-store keys, BRC-39 archives, account identities and holding semantics.
  No automatic vault migration, reset, rekey or fund movement.
- Preserve the Swift app identity and update artifact names for older clients.
  Verify both Intel and Apple Silicon bundles before deleting the old runtime.

## Ordered replacement plan (one shared implementation)

1. Freeze a versioned Rust request/response contract and synthetic golden
   fixtures for every host method and wallet operation. Inventory all
   src/wallet and packages/wallet-engine dependencies, protocol sections and
   license notices before porting. Exposed contributors must not claim a
   clean-room rewrite; the licensing/replacement review remains a gate.
2. Extract native-desktop services into platform-neutral crates. Add Android
   and iOS host adapters with the same account/generation fences. Keep the
   current storage and key providers as adapters until migration is proven.
   Never move private keys over a general-purpose renderer transport.
3. Port read-only wallet projections, proof checking and ingestion first,
   followed by history replica and coordination. Test 100-row yielding,
   cancellation/late-result isolation, suspension and offline recovery.
   Refresh stays chain ingest; recompose alone combines history and chain.
4. Port signing/custody and transaction construction only after golden vectors,
   independently checked crypto and protocol fixtures pass. Preserve
   never-abort-signed, holding freshness, handover, permission expiry and
   spend reconciliation. Differential tests use synthetic keys only.
5. Replace shared XState/React UI with the upstream Aeon Rust implementation;
   do not invent an app-local UI engine or fork Desktop/Mobile panels.
   Coordinate with aeon-ui task cf259d54 (Rust statechart core and Dioxus
   vertical slice). Preserve chart-before-view, data-aeon attributes,
   accessibility, keyboard approval safety and visual behaviour.
6. Remove TS modules, Electron runtime/dependencies and compatibility adapters
   only when their callers have switched and equivalent tests pass. Remove
   build-time Node/TypeScript last, after CSS/assets/versioning/release tooling
   has a Rust replacement. File-extension changes are not a Rust migration.

## Mobile update and recovery plan

Today Mobile 0.1.819 consumes Desktop packages/wallet-ui and wallet-engine via
file dependencies and aliases Desktop src. Do not unpin it or fork the UI.

- During transition, pin Desktop SHA/version as today and add Rust core commit,
  contract version and per-ABI artifact hashes to the build provenance.
  Android arm64-v8a/x86_64 and iOS device/simulator builds must use the same
  core version as Desktop. Validate package contents, not just version strings.
- First ship an opt-in read-only Rust adapter behind the existing Mobile
  interface. Compare synthetic projections; never dual-execute writes/signing.
  Retain the JS fallback until Android/iOS parity evidence is recorded.
- Keep Android Keystore / iOS Keychain providers and existing WebView origin,
  database name, account IDs and permission records unchanged initially.
  Rust storage migration later requires a versioned, restartable journal,
  verified encrypted backup, read-only validation and rollback before commit.
  Downgrade must refuse incompatible writes, not silently create a new vault.
- Test upgrade from the last public APK/IPA with empty and populated fixtures:
  unlock, accounts held elsewhere, interrupted history restore, Activity,
  NFT proofs, send/reconcile, permissions, camera/mic and suspend/resume.
  Record device versions and exact binary hashes; local tests are not device evidence.
- After parity, switch core authority once per account; never allow JS and
  Rust to sign concurrently. Then replace the shared UI with Aeon Rust and
  remove Capacitor/TS only after native plugin equivalents are verified.
- Release requires separately approved Desktop/Mobile version bumps, immutable
  tags, successful installer/APK/IPA CI, provenance artifacts and actual device
  upgrade/relaunch checks. This task does not authorize publication or install.

## Local verification (2026-11-21)

In isolated worktree cmwps1c72fr, job j15f passed: sidecar cargo test
(16 tests including HTTP/HTTPS/device-peer, TLS, static UI and bounded framing),
cargo clippy --bin handcash-sidecar --no-deps, cargo build, tsc --noEmit,
and nativeDesktopPage/mobileReleaseSync (8 tests). Script syntax and diff checks
passed. A subsequent subprocess check passed missing-UI-root and unknown-mode
fatal contracts using a temporary user-data directory, without wallet state.
read_lints reported no TypeScript errors in touched files; this is not a Swift
compiler check. Mac compilation, signing and startup remain unverified.

Shared library + wallet-core foundation continuation (2026-11-21): job j1rs
passed `cargo test --offline --all-targets` (61 passed: 47 lib including 12 new
wallet_core tests, 10 host binary, 4 sidecar binary), strict
`cargo clippy --offline --all-targets --no-deps -- -D warnings` (0 warnings),
`cargo build --offline`, 5 focused Vitest files / 21 tests (including new
`walletCore*` IPC facade tests and `atomicFile` tests), `tsc -p tsconfig.json --noEmit`,
`tsc -p tsconfig.electron.json --noEmit`, and `git diff --check`. `read_lints`
is clean on touched TypeScript files. Changes remain local and uncommitted on
HEAD e4d5d207; no live download, install, push, signing cutover or device
verification was performed.

## Verification and cleanup gates

Linux can test the shared Rust transport and stdio contract. It cannot prove
Swift compilation, WKWebView behaviour, Mac signing or Keychain continuity.
Mac CI must compile Swift, test Rust, package, reject Node/CJS resources,
verify signatures and smoke-test startup/shutdown/port-conflict behaviour.

Keep external-agent docs, photos, live tests, rebuilt sidecars and pre-ship-711
stash untouched until their current contents and dependencies are rechecked
and exact deletion is approved. No branch deletion is needed for this slice.
The Electron shell (`electron/`, `dist-sidecar/`, `tsconfig.electron.json`,
electron-builder config and Electron-only scripts) is deleted on the `rust` branch.
The Rust host log (`native-desktop/src/host_log.rs`) now scrubs every appended
line through `native-desktop/src/log_privacy.rs` with parity to `src/wallet/logPrivacy.ts`.
