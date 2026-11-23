---
name: rust-aeon-ui-target
when: planning or porting HandCash Desktop UI to Rust
if: native-desktop/crates/handcash-app
---
The UI target is Rust Aeon (aeon-dioxus in handcash-app), not TS Aeon in a webview; the TS UI is the reference and interim ship until parity.
Prove screen parity by replaying normalized TS DOM fixtures against dioxus-ssr output (docs/rust-conversion-fast-plan.md), not by eye.
