// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless pure-Rust HandCash statecharts built on [`aeon_core`] and [`aeon_primitives`].
//!
//! Every chart from `src/machines/machineManifest.ts` (62 total) is ported here with:
//! - closed hierarchical / parallel `State` types projecting through `aeon_core::state_to_attr`,
//! - lossless `Context`, `Event`, and `Input` types,
//! - pure declarative `Effect` emission via [`HandCashChart::step`] (no hidden I/O inside transitions),
//! - full [`aeon_primitives::Statechart`] implementation so every chart plugs directly into
//!   `aeon_dioxus::use_aeon_machine` and `aeon_primitives::Actor`,
//! - 1:1 ported Vitest unit test suites.

pub use aeon_core::{state_to_attr, StateValue};
pub use aeon_primitives::{Actor, Region, Snapshot, Statechart};

pub mod account_move;
pub mod action_lifecycle;
pub mod app;
pub mod app_browser;
pub mod app_browser_page;
pub mod app_launcher;
pub mod asset_burn_ui;
pub mod asset_send;
pub mod async_action;
pub mod authenticity;
pub mod bnt;
pub mod bnt_holdings;
pub mod brc29_send;
pub mod bsv_send;
pub mod burn;
pub mod call;
pub mod call_view;
pub mod chart_apps;
pub mod coin;
pub mod collectable_send;
pub mod collectable_send_run;
pub mod dev_keys_panel;
pub mod device_backup;
pub mod email_recovery;
pub mod entry_mesh;
pub mod fiat_currency_menu;
pub mod grant_expiry;
pub mod history_recovery;
pub mod import_item_browser;
pub mod import_queue;
pub mod import_write_grant;
pub mod ipt_accept_request;
pub mod item_send;
pub mod legacy_import;
pub mod manifest;
pub mod market_purchase;
pub mod market_seller_settlement;
pub mod model_viewer;
pub mod notes;
pub mod offer;
pub mod onboard_email;
pub mod pairing_code;
pub mod permission_decision;
pub mod public_identities;
pub mod qr_reveal;
pub mod qr_scanner;
pub mod recording_player;
pub mod relay_signin;
pub mod send;
pub mod server_wallet_recover;
pub mod settings_preferences;
pub mod swap;
pub mod swap_offers;
pub mod swap_settle;
pub mod ticker;
pub mod tx_lifecycle;
pub mod unlock;
pub mod update;
pub mod wallet_account_menu;
pub mod wallet_coordinator;
pub mod wallet_job;
pub mod wallet_status;
pub mod wipe;

use core::fmt;
use core::marker::PhantomData;

/// Extension of [`aeon_primitives::Statechart`] for HandCash charts that also
/// declare manifest metadata, guard/transition availability (`can`), and pure
/// declarative side-effects (`Effect`) emitted during a transition.
pub trait HandCashChart: Statechart {
    /// Exact key in `src/machines/machineManifest.ts`.
    const MANIFEST_ID: &'static str;

    /// Exact top-level state keys matching `machineStateManifest()` in TypeScript.
    const TOP_LEVEL_STATES: &'static [&'static str];

    /// Pure declarative side-effect emitted by transitions (use `()` if none).
    type Effect: Clone + PartialEq + fmt::Debug;

    /// Pure transition returning the next snapshot plus any effects triggered by `event`.
    #[allow(clippy::type_complexity)]
    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>);

    /// Returns `true` if `event` triggers an enabled transition in `snapshot`
    /// (mirrors XState `snapshot.can(event)`).
    fn can(snapshot: &Snapshot<Self::State, Self::Context>, event: &Self::Event) -> bool {
        let (next, effects) = Self::step(snapshot, event.clone());
        next != *snapshot || !effects.is_empty()
    }

    /// Returns `true` when the machine has reached a `type: 'final'` state
    /// (mirrors XState `snapshot.status === 'done'`).
    fn is_done(_state: &Self::State) -> bool {
        false
    }
}

/// Synchronous actor that tracks both the [`Snapshot`] and declarative [`HandCashChart::Effect`]s.
pub struct EffectActor<M: HandCashChart> {
    snapshot: Snapshot<M::State, M::Context>,
    effects: Vec<M::Effect>,
    _machine: PhantomData<M>,
}

impl<M: HandCashChart> fmt::Debug for EffectActor<M> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EffectActor")
            .field("id", &M::ID)
            .field("snapshot", &self.snapshot)
            .field("effects", &self.effects)
            .finish()
    }
}

impl<M: HandCashChart> Clone for EffectActor<M> {
    fn clone(&self) -> Self {
        Self {
            snapshot: self.snapshot.clone(),
            effects: self.effects.clone(),
            _machine: PhantomData,
        }
    }
}

impl<M: HandCashChart> Default for EffectActor<M> {
    fn default() -> Self {
        Self::new(M::Input::default())
    }
}

impl<M: HandCashChart> EffectActor<M> {
    pub fn new(input: M::Input) -> Self {
        Self {
            snapshot: M::initial(input),
            effects: Vec::new(),
            _machine: PhantomData,
        }
    }

    pub fn snapshot(&self) -> &Snapshot<M::State, M::Context> {
        &self.snapshot
    }

    pub fn state(&self) -> &M::State {
        &self.snapshot.value
    }

    pub fn context(&self) -> &M::Context {
        &self.snapshot.context
    }

    pub fn state_value(&self) -> StateValue {
        M::state_value(&self.snapshot.value)
    }

    pub fn state_attr(&self) -> String {
        M::state_attr(&self.snapshot.value)
    }

    pub fn is_done(&self) -> bool {
        M::is_done(&self.snapshot.value)
    }

    pub fn can(&self, event: &M::Event) -> bool {
        M::can(&self.snapshot, event)
    }

    /// Send an event, advance the snapshot, append effects to the log, and return effects from this step.
    pub fn send(&mut self, event: M::Event) -> Vec<M::Effect> {
        let (next, emitted) = M::step(&self.snapshot, event);
        self.snapshot = next;
        self.effects.extend(emitted.iter().cloned());
        emitted
    }

    /// All accumulated effects since creation or last [`Self::take_effects`].
    pub fn effects(&self) -> &[M::Effect] {
        &self.effects
    }

    /// Drain and return all accumulated effects.
    pub fn take_effects(&mut self) -> Vec<M::Effect> {
        core::mem::take(&mut self.effects)
    }

    pub fn reset(&mut self, input: M::Input) {
        self.snapshot = M::initial(input);
        self.effects.clear();
    }
}
