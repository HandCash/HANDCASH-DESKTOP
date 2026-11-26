---
name: rust-aeon-ui-target
when: planning or porting HandCash Desktop UI to Rust
if: native-desktop/crates/handcash-app
---
The UI target is Rust Aeon (aeon-dioxus in handcash-app), not TS Aeon in a webview; the TS UI is the reference and interim ship until parity.
Blitz `handcash-native` (feature `native`) stays the default, packaged binary; aeon-native runs side by side as `handcash-aeon` (feature `aeon`), following Alignity's c6ca2030 pattern. Never replace main.rs or flip the default feature until screen parity is proven.
aeon-native ≤0.1.3 hides `style {}` tags and ignores `class`, styling only 21 generic `data-aeon-scope`s; Alignity's c6ca2030 aeon build is not a styling match either (its 46 `alignity-*` scopes live in CSS).
Prove screen parity by replaying normalized TS DOM fixtures against dioxus-ssr output (docs/rust-conversion-fast-plan.md), not by eye.
