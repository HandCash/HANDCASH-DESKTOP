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

## Verification and cleanup gates

Linux can test the shared Rust transport and stdio contract. It cannot prove
Swift compilation, WKWebView behaviour, Mac signing or Keychain continuity.
Mac CI must compile Swift, test Rust, package, reject Node/CJS resources,
verify signatures and smoke-test startup/shutdown/port-conflict behaviour.

Keep external-agent docs, photos, live tests, rebuilt sidecars and pre-ship-711
stash untouched until their current contents and dependencies are rechecked
and exact deletion is approved. No branch deletion is needed for this slice.
Existing electron/atomicFile imports in live test helpers and electron/logPrivacy
test parity mean deleting electron/ wholesale would currently break callers.
