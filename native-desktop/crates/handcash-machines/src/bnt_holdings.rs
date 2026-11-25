// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/bntHoldingsMachine.ts` and `parseTokenAmount` from `src/wallet/amounts.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BntAssetKind {
    Token,
    Item,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BntAssetSummary {
    pub asset_id: String,
    pub kind: BntAssetKind,
    pub mode: String,
    pub sym: Option<String>,
    pub dec: u8,
    pub issuers: Vec<String>,
    pub balance: String,
    pub outputs: usize,
    pub authority: bool,
    pub deploy: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CacheState {
    #[default]
    Idle,
    Loading,
    Ready,
    Refreshing,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheView<T> {
    pub state: CacheState,
    pub data: Option<T>,
    pub error: Option<String>,
    pub loaded_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BntHoldingsReadyState {
    Browsing,
    Composing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BntHoldingsState {
    Loading,
    Ready(BntHoldingsReadyState),
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BntHoldingsInput {
    pub key: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BntHoldingsContext {
    pub key: String,
    pub assets: Vec<BntAssetSummary>,
    pub composing: Option<String>,
    pub error: Option<String>,
    pub cache: CacheState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BntHoldingsEvent {
    Refresh {
        key: Option<String>,
    },
    Open {
        asset_id: String,
    },
    Close,
    CacheUpdate {
        cache: String,
        key: String,
        view: CacheView<Vec<BntAssetSummary>>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BntHoldingsEffect {
    CacheKey { key: String },
    CacheInvalidate,
}

pub struct BntHoldingsMachine;

impl Statechart for BntHoldingsMachine {
    type State = BntHoldingsState;
    type Context = BntHoldingsContext;
    type Event = BntHoldingsEvent;
    type Input = BntHoldingsInput;

    const ID: &'static str = "bntHoldings";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            BntHoldingsState::Loading,
            BntHoldingsContext {
                key: input.key,
                assets: Vec::new(),
                composing: None,
                error: None,
                cache: CacheState::Idle,
            },
        )
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            BntHoldingsState::Loading => StateValue::leaf("loading"),
            BntHoldingsState::Ready(BntHoldingsReadyState::Browsing) => {
                StateValue::compound("ready", StateValue::leaf("browsing"))
            }
            BntHoldingsState::Ready(BntHoldingsReadyState::Composing) => {
                StateValue::compound("ready", StateValue::leaf("composing"))
            }
            BntHoldingsState::Failed => StateValue::leaf("failed"),
        }
    }
}

impl HandCashChart for BntHoldingsMachine {
    const MANIFEST_ID: &'static str = "bntHoldings";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["loading", "ready", "failed"];
    type Effect = BntHoldingsEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match event {
            BntHoldingsEvent::CacheUpdate { key, view, .. } => {
                if key != ctx.key {
                    return (snapshot.clone(), effects);
                }
                let listed = view.loaded_at.is_some();
                let refused = view.state == CacheState::Failed;
                let composing_held = ctx.composing.as_ref().is_some_and(|id| {
                    view.data
                        .as_ref()
                        .is_some_and(|list| list.iter().any(|a| a.asset_id == *id))
                });
                if listed
                    && snapshot.value == BntHoldingsState::Ready(BntHoldingsReadyState::Composing)
                    && !composing_held
                {
                    ctx.assets = view.data.unwrap_or_default();
                    ctx.error = view.error;
                    ctx.cache = view.state;
                    ctx.composing = None;
                    BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
                } else if listed && matches!(snapshot.value, BntHoldingsState::Ready(_)) {
                    ctx.assets = view.data.unwrap_or_default();
                    ctx.error = view.error;
                    ctx.cache = view.state;
                    snapshot.value
                } else if listed && composing_held {
                    ctx.assets = view.data.unwrap_or_default();
                    ctx.error = view.error;
                    ctx.cache = view.state;
                    BntHoldingsState::Ready(BntHoldingsReadyState::Composing)
                } else if listed {
                    ctx.assets = view.data.unwrap_or_default();
                    ctx.error = view.error;
                    ctx.cache = view.state;
                    ctx.composing = None;
                    BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
                } else if refused {
                    ctx.assets = view.data.unwrap_or_default();
                    ctx.error = view.error;
                    ctx.cache = view.state;
                    BntHoldingsState::Failed
                } else if snapshot.value == BntHoldingsState::Loading {
                    ctx.cache = view.state;
                    BntHoldingsState::Loading
                } else {
                    ctx.assets = view.data.unwrap_or_default();
                    ctx.error = view.error;
                    ctx.cache = view.state;
                    ctx.composing = None;
                    BntHoldingsState::Loading
                }
            }
            BntHoldingsEvent::Refresh { key } => {
                if let Some(new_key) = key.filter(|k| *k != ctx.key) {
                    ctx.key = new_key.clone();
                    ctx.assets.clear();
                    ctx.composing = None;
                    ctx.error = None;
                    ctx.cache = CacheState::Idle;
                    effects.push(BntHoldingsEffect::CacheKey { key: new_key });
                    BntHoldingsState::Loading
                } else {
                    effects.push(BntHoldingsEffect::CacheInvalidate);
                    snapshot.value
                }
            }
            BntHoldingsEvent::Open { asset_id } => match snapshot.value {
                BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
                    if ctx.assets.iter().any(|a| a.asset_id == asset_id) =>
                {
                    ctx.composing = Some(asset_id);
                    BntHoldingsState::Ready(BntHoldingsReadyState::Composing)
                }
                BntHoldingsState::Ready(BntHoldingsReadyState::Composing)
                    if ctx.assets.iter().any(|a| a.asset_id == asset_id) =>
                {
                    ctx.composing = Some(asset_id);
                    BntHoldingsState::Ready(BntHoldingsReadyState::Composing)
                }
                _ => return (snapshot.clone(), effects),
            },
            BntHoldingsEvent::Close => match snapshot.value {
                BntHoldingsState::Loading => {
                    ctx.composing = None;
                    BntHoldingsState::Loading
                }
                BntHoldingsState::Ready(BntHoldingsReadyState::Composing) => {
                    ctx.composing = None;
                    BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
                }
                _ => return (snapshot.clone(), effects),
            },
        };
        (Snapshot::new(next, ctx), effects)
    }
}

/// Typed amount -> integer units with deploy decimals; `None` when not a positive amount that fits `dec`.
pub fn parse_token_amount(display: &str, dec: u32) -> Option<String> {
    let safe_dec = if dec <= 18 { dec as usize } else { 0 };
    let cleaned: String = display.trim().chars().filter(|&c| c != ',').collect();
    let mut parts = cleaned.split('.');
    let whole = parts.next()?;
    let frac_raw = parts.next();
    if parts.next().is_some() {
        return None;
    }
    if !whole.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let frac_part = frac_raw.unwrap_or("");
    if !frac_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if whole.is_empty() && frac_part.is_empty() {
        return None;
    }
    let frac = frac_part.trim_end_matches('0');
    if frac.len() > safe_dec {
        return None;
    }
    let whole_part = if whole.is_empty() { "0" } else { whole };
    let mut combined = String::with_capacity(whole_part.len() + safe_dec);
    combined.push_str(whole_part);
    combined.push_str(frac);
    for _ in 0..(safe_dec - frac.len()) {
        combined.push('0');
    }
    let units: u128 = combined.parse().ok()?;
    if units > 0 {
        Some(units.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn asset(asset_id: &str) -> BntAssetSummary {
        BntAssetSummary {
            asset_id: asset_id.to_string(),
            kind: BntAssetKind::Token,
            mode: "open".to_string(),
            sym: Some("GOLD".to_string()),
            dec: 2,
            issuers: Vec::new(),
            balance: "1000".to_string(),
            outputs: 1,
            authority: false,
            deploy: format!("{}_0", "a".repeat(64)),
        }
    }

    fn ready_update(key: &str, assets: Vec<BntAssetSummary>) -> BntHoldingsEvent {
        BntHoldingsEvent::CacheUpdate {
            cache: "bnt-holdings".to_string(),
            key: key.to_string(),
            view: CacheView {
                state: CacheState::Ready,
                data: Some(assets),
                error: None,
                loaded_at: Some(1),
            },
        }
    }

    #[test]
    fn serves_a_remounted_chart_from_the_cache_immediately() {
        let mut actor = EffectActor::<BntHoldingsMachine>::new(BntHoldingsInput {
            key: "alice:main".to_string(),
        });
        actor.send(ready_update("alice:main", vec![asset(&"1".repeat(40))]));
        assert_eq!(
            *actor.state(),
            BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
        );
        assert_eq!(actor.context().assets.len(), 1);
    }

    #[test]
    fn keeps_the_list_shown_while_activity_revalidates_it() {
        let mut actor = EffectActor::<BntHoldingsMachine>::new(BntHoldingsInput {
            key: "alice:main".to_string(),
        });
        let a1 = asset(&"1".repeat(40));
        let a2 = asset(&"2".repeat(40));
        actor.send(ready_update("alice:main", vec![a1.clone()]));
        let effects = actor.send(BntHoldingsEvent::Refresh {
            key: Some("alice:main".to_string()),
        });
        assert_eq!(effects, vec![BntHoldingsEffect::CacheInvalidate]);
        actor.send(BntHoldingsEvent::CacheUpdate {
            cache: "bnt-holdings".to_string(),
            key: "alice:main".to_string(),
            view: CacheView {
                state: CacheState::Refreshing,
                data: Some(vec![a1.clone()]),
                error: None,
                loaded_at: Some(1),
            },
        });
        assert!(matches!(*actor.state(), BntHoldingsState::Ready(_)));
        assert_eq!(actor.context().cache, CacheState::Refreshing);
        assert_eq!(actor.context().assets.len(), 1);

        actor.send(ready_update("alice:main", vec![a1, a2]));
        assert_eq!(actor.context().cache, CacheState::Ready);
        assert_eq!(actor.context().assets.len(), 2);
    }

    #[test]
    fn moves_to_the_open_account_on_a_switch_and_never_shows_the_last_accounts_list() {
        let mut actor = EffectActor::<BntHoldingsMachine>::new(BntHoldingsInput {
            key: "alice:main".to_string(),
        });
        actor.send(ready_update("alice:main", vec![asset(&"1".repeat(40))]));
        let effects = actor.send(BntHoldingsEvent::Refresh {
            key: Some("bob:main".to_string()),
        });
        assert_eq!(*actor.state(), BntHoldingsState::Loading);
        assert!(actor.context().assets.is_empty());
        assert_eq!(
            effects,
            vec![BntHoldingsEffect::CacheKey {
                key: "bob:main".to_string()
            }]
        );
        // Stale update for old key is ignored.
        actor.send(ready_update("alice:main", vec![asset(&"1".repeat(40))]));
        assert_eq!(*actor.state(), BntHoldingsState::Loading);
        assert!(actor.context().assets.is_empty());

        actor.send(ready_update("bob:main", Vec::new()));
        assert_eq!(
            *actor.state(),
            BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
        );
        assert!(actor.context().assets.is_empty());
    }

    #[test]
    fn loads_opens_a_held_asset_and_refuses_one_it_does_not_hold() {
        let mut actor = EffectActor::<BntHoldingsMachine>::new(BntHoldingsInput {
            key: "alice:main".to_string(),
        });
        actor.send(ready_update("alice:main", vec![asset(&"1".repeat(40))]));
        actor.send(BntHoldingsEvent::Open {
            asset_id: "2".repeat(40),
        });
        assert_eq!(
            *actor.state(),
            BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
        );
        actor.send(BntHoldingsEvent::Open {
            asset_id: "1".repeat(40),
        });
        assert_eq!(
            *actor.state(),
            BntHoldingsState::Ready(BntHoldingsReadyState::Composing)
        );
        assert_eq!(actor.state_attr(), "ready:composing");
        actor.send(BntHoldingsEvent::Close);
        assert_eq!(actor.context().composing, None);
        assert_eq!(
            *actor.state(),
            BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
        );
    }

    #[test]
    fn keeps_the_send_form_across_a_reload_while_the_asset_is_still_held() {
        let id = "1".repeat(40);
        let mut actor = EffectActor::<BntHoldingsMachine>::new(BntHoldingsInput {
            key: "alice:main".to_string(),
        });
        actor.send(ready_update("alice:main", vec![asset(&id)]));
        actor.send(BntHoldingsEvent::Open {
            asset_id: id.clone(),
        });
        actor.send(BntHoldingsEvent::Refresh { key: None });
        actor.send(ready_update("alice:main", vec![asset(&id)]));
        assert_eq!(
            *actor.state(),
            BntHoldingsState::Ready(BntHoldingsReadyState::Composing)
        );
    }

    #[test]
    fn closes_the_form_when_a_reload_shows_the_asset_is_gone() {
        let id = "1".repeat(40);
        let mut actor = EffectActor::<BntHoldingsMachine>::new(BntHoldingsInput {
            key: "alice:main".to_string(),
        });
        actor.send(ready_update("alice:main", vec![asset(&id)]));
        actor.send(BntHoldingsEvent::Open { asset_id: id });
        actor.send(BntHoldingsEvent::Refresh { key: None });
        actor.send(ready_update("alice:main", Vec::new()));
        assert_eq!(
            *actor.state(),
            BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
        );
        assert_eq!(actor.context().composing, None);
    }

    #[test]
    fn fails_with_a_reason_and_recovers_on_refresh() {
        let mut actor = EffectActor::<BntHoldingsMachine>::new(BntHoldingsInput {
            key: "alice:main".to_string(),
        });
        actor.send(BntHoldingsEvent::CacheUpdate {
            cache: "bnt-holdings".to_string(),
            key: "alice:main".to_string(),
            view: CacheView {
                state: CacheState::Failed,
                data: None,
                error: Some("locked".to_string()),
                loaded_at: None,
            },
        });
        assert_eq!(*actor.state(), BntHoldingsState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("locked"));
        actor.send(BntHoldingsEvent::Refresh { key: None });
        actor.send(ready_update("alice:main", Vec::new()));
        assert_eq!(
            *actor.state(),
            BntHoldingsState::Ready(BntHoldingsReadyState::Browsing)
        );
        assert_eq!(actor.context().error, None);
    }

    #[test]
    fn parse_token_amount_converts_typed_amounts_and_refuses_invalid() {
        assert_eq!(parse_token_amount("1.5", 2).as_deref(), Some("150"));
        assert_eq!(parse_token_amount("1,000", 0).as_deref(), Some("1000"));
        assert_eq!(parse_token_amount(".01", 2).as_deref(), Some("1"));
        assert_eq!(parse_token_amount("2.50", 1).as_deref(), Some("25"));
        for bad in ["", "0", "0.00", ".", "1.001", "-1", "1e3", "abc"] {
            assert_eq!(parse_token_amount(bad, 2), None, "bad={bad}");
        }
    }
}
