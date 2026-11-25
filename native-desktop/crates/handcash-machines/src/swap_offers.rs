// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/swapOffersMachine.ts` and swap offer room/fee helpers.

use std::collections::BTreeMap;

use crate::bnt_holdings::{CacheState, CacheView};
use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const SWAP_FEE_BPS: u128 = 50;
const FEE_FLOOR_CLAIMS: u128 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapAsset {
    Bsv,
    Ltc,
    Bch,
    Btc,
    Doge,
    ArcUsd,
}

impl SwapAsset {
    pub const fn direct_claim_cost(self) -> u128 {
        match self {
            Self::Bsv => 100,
            Self::Ltc => 1_000,
            Self::Bch => 500,
            Self::Btc => 5_000,
            Self::Doge => 200_000,
            Self::ArcUsd => 100_000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapLegId {
    Taker,
    Maker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapFee {
    pub leg: SwapLegId,
    pub amount: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedSwapOffer {
    pub v: u8,
    pub maker: String,
    pub give: SwapAsset,
    pub get: SwapAsset,
    pub price_give: u128,
    pub price_get: u128,
    pub min_get: u128,
    pub max_get: u128,
    pub created_at: u64,
    pub expires_at: u64,
    pub nonce: String,
    pub sig: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OfferBookPage {
    /// Identity token distinguishing successive loaded book snapshots (mirrors JS object identity).
    pub id: u64,
    pub offers: Vec<SignedSwapOffer>,
    pub filled: BTreeMap<String, u128>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TakeInput {
    pub offer: SignedSwapOffer,
    pub pay: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TakePreview {
    pub pays: u128,
    pub receives: u128,
    pub fee: u128,
    pub fee_leg: Option<SwapLegId>,
}

pub fn fill_offer(offer: &SignedSwapOffer, pay: u128, filled: u128) -> Option<u128> {
    if offer.price_get == 0 {
        return None;
    }
    let max = offer.max_get.checked_sub(filled)?;
    if pay < offer.min_get || pay > max {
        return None;
    }
    Some(pay.saturating_mul(offer.price_give) / offer.price_get)
}

pub fn offer_room(offer: &SignedSwapOffer, filled: u128) -> Option<(u128, u128)> {
    let max = offer.max_get.checked_sub(filled)?;
    let min = offer.min_get;
    if max >= min {
        Some((min, max))
    } else {
        None
    }
}

pub fn fee_leg_of(offer: &SignedSwapOffer) -> SwapLegId {
    if offer.get == SwapAsset::Bsv {
        SwapLegId::Taker
    } else {
        SwapLegId::Maker
    }
}

pub fn swap_fee(offer: &SignedSwapOffer, pay: u128, receive: u128) -> Option<SwapFee> {
    let leg = fee_leg_of(offer);
    let chain = match leg {
        SwapLegId::Taker => offer.get,
        SwapLegId::Maker => offer.give,
    };
    let base = match leg {
        SwapLegId::Taker => pay,
        SwapLegId::Maker => receive,
    };
    let amount = (base.saturating_mul(SWAP_FEE_BPS)) / 10_000;
    if amount < chain.direct_claim_cost() * FEE_FLOOR_CLAIMS {
        return None;
    }
    Some(SwapFee { leg, amount })
}

pub fn preview_take(offer: &SignedSwapOffer, pay: u128) -> Option<TakePreview> {
    let receive = fill_offer(offer, pay, 0)?;
    let fee = swap_fee(offer, pay, receive);
    let fee_amt = fee.map_or(0, |f| f.amount);
    let on_taker = matches!(fee.map(|f| f.leg), Some(SwapLegId::Taker));
    let pays = pay.saturating_add(if on_taker { fee_amt } else { 0 });
    let receives = receive.checked_sub(if on_taker { 0 } else { fee_amt })?;
    if receives <= offer.give.direct_claim_cost() {
        return None;
    }
    Some(TakePreview {
        pays,
        receives,
        fee: fee_amt,
        fee_leg: fee.map(|f| f.leg),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapOffersState {
    Loading,
    Ready,
    Cancelling,
    Reviewing,
    Taking,
    Taken,
    Failed,
}

impl SwapOffersState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Cancelling => "cancelling",
            Self::Reviewing => "reviewing",
            Self::Taking => "taking",
            Self::Taken => "taken",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SwapOffersInput {
    pub self_key: Option<String>,
    pub key: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SwapOffersContext {
    pub self_key: Option<String>,
    pub key: String,
    pub cache: CacheState,
    pub book_id: Option<u64>,
    pub offers: Vec<SignedSwapOffer>,
    pub filled: BTreeMap<String, u128>,
    pub pay: Option<u128>,
    pub cancelling: Option<String>,
    pub taking: Option<String>,
    pub failure: Option<String>,
}

impl SwapOffersContext {
    pub fn room_of(&self, offer: &SignedSwapOffer) -> Option<(u128, u128)> {
        let filled = self.filled.get(&offer.nonce).copied().unwrap_or(0);
        offer_room(offer, filled)
    }

    pub fn reviewed(&self) -> Option<&SignedSwapOffer> {
        let taking = self.taking.as_deref()?;
        self.offers.iter().find(|o| o.nonce == taking)
    }

    pub fn amount_fits(&self) -> bool {
        let Some(offer) = self.reviewed() else {
            return false;
        };
        let Some((min, max)) = self.room_of(offer) else {
            return false;
        };
        let Some(pay) = self.pay else {
            return false;
        };
        pay >= min && pay <= max && preview_take(offer, pay).is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapOffersEvent {
    Refresh,
    Cancel {
        nonce: String,
    },
    CancelDone,
    CancelError {
        error: String,
    },
    Review {
        nonce: String,
        now_ms: u64,
    },
    Amount {
        pay: Option<u128>,
    },
    Back,
    Confirm {
        now_ms: u64,
    },
    TakeDone,
    TakeError {
        error: String,
    },
    CacheUpdate {
        cache: String,
        key: String,
        view: CacheView<OfferBookPage>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapOffersEffect {
    CacheInvalidate,
    Cancel { nonce: String },
    Take { input: TakeInput },
}

pub struct SwapOffersMachine;

impl Statechart for SwapOffersMachine {
    type State = SwapOffersState;
    type Context = SwapOffersContext;
    type Event = SwapOffersEvent;
    type Input = SwapOffersInput;

    const ID: &'static str = "swapOffers";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            SwapOffersState::Loading,
            SwapOffersContext {
                self_key: input.self_key,
                key: input.key,
                cache: CacheState::Idle,
                ..SwapOffersContext::default()
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
        StateValue::leaf(state.as_str())
    }
}

impl HandCashChart for SwapOffersMachine {
    const MANIFEST_ID: &'static str = "swapOffers";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "loading",
        "ready",
        "cancelling",
        "reviewing",
        "taking",
        "taken",
        "failed",
    ];
    type Effect = SwapOffersEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let apply_take = |ctx: &mut SwapOffersContext, view: CacheView<OfferBookPage>| {
            ctx.cache = view.state;
            if let Some(book) = view.data {
                ctx.book_id = Some(book.id);
                ctx.offers = book.offers;
                ctx.filled = book.filled;
            }
        };
        let next = match (snapshot.value, event) {
            (_, SwapOffersEvent::CacheUpdate { key, view, .. }) => {
                if key != ctx.key {
                    return (snapshot.clone(), effects);
                }
                let listed = view.loaded_at.is_some();
                let new_book = view.data.as_ref().map(|b| b.id) != ctx.book_id;
                let refused = view.state == CacheState::Failed;
                if listed
                    && matches!(
                        snapshot.value,
                        SwapOffersState::Loading | SwapOffersState::Failed
                    )
                {
                    apply_take(&mut ctx, view);
                    ctx.failure = None;
                    SwapOffersState::Ready
                } else if listed && new_book {
                    apply_take(&mut ctx, view);
                    snapshot.value
                } else if listed {
                    ctx.cache = view.state;
                    snapshot.value
                } else if refused {
                    ctx.cache = view.state;
                    ctx.failure = view.error;
                    SwapOffersState::Failed
                } else if snapshot.value == SwapOffersState::Failed {
                    ctx.cache = view.state;
                    SwapOffersState::Loading
                } else {
                    ctx.cache = view.state;
                    snapshot.value
                }
            }
            (SwapOffersState::Ready, SwapOffersEvent::Refresh) => {
                effects.push(SwapOffersEffect::CacheInvalidate);
                SwapOffersState::Ready
            }
            (SwapOffersState::Ready, SwapOffersEvent::Cancel { nonce })
                if ctx.self_key.as_ref().is_some_and(|me| {
                    ctx.offers
                        .iter()
                        .any(|o| o.nonce == nonce && o.maker == *me)
                }) =>
            {
                ctx.cancelling = Some(nonce.clone());
                ctx.failure = None;
                effects.push(SwapOffersEffect::Cancel { nonce });
                SwapOffersState::Cancelling
            }
            (SwapOffersState::Ready, SwapOffersEvent::Review { nonce, now_ms })
                if ctx.self_key.as_ref().is_some_and(|me| {
                    ctx.offers
                        .iter()
                        .any(|o| o.nonce == nonce && o.maker != *me && o.expires_at > now_ms)
                }) =>
            {
                let pay = ctx
                    .offers
                    .iter()
                    .find(|o| o.nonce == nonce)
                    .and_then(|o| ctx.room_of(o).map(|(_, max)| max));
                ctx.taking = Some(nonce);
                ctx.pay = pay;
                ctx.failure = None;
                SwapOffersState::Reviewing
            }
            (SwapOffersState::Cancelling, SwapOffersEvent::CancelDone) => {
                if let Some(nonce) = ctx.cancelling.take() {
                    ctx.offers.retain(|o| o.nonce != nonce);
                }
                effects.push(SwapOffersEffect::CacheInvalidate);
                SwapOffersState::Ready
            }
            (SwapOffersState::Cancelling, SwapOffersEvent::CancelError { error }) => {
                ctx.cancelling = None;
                ctx.failure = Some(error);
                SwapOffersState::Ready
            }
            (SwapOffersState::Reviewing, SwapOffersEvent::Amount { pay }) => {
                ctx.pay = pay;
                ctx.failure = None;
                SwapOffersState::Reviewing
            }
            (SwapOffersState::Reviewing, SwapOffersEvent::Back) => {
                ctx.taking = None;
                ctx.pay = None;
                SwapOffersState::Ready
            }
            (SwapOffersState::Reviewing, SwapOffersEvent::Confirm { now_ms }) => {
                let still_listed = ctx.taking.as_deref().is_some_and(|taking| {
                    ctx.offers
                        .iter()
                        .any(|o| o.nonce == taking && o.expires_at > now_ms)
                });
                if still_listed && ctx.amount_fits() {
                    if let (Some(offer), Some(pay)) = (ctx.reviewed().cloned(), ctx.pay) {
                        effects.push(SwapOffersEffect::Take {
                            input: TakeInput { offer, pay },
                        });
                    }
                    SwapOffersState::Taking
                } else if still_listed {
                    SwapOffersState::Reviewing
                } else {
                    ctx.taking = None;
                    ctx.pay = None;
                    ctx.failure = Some("This offer has expired.".to_string());
                    SwapOffersState::Ready
                }
            }
            (SwapOffersState::Taking, SwapOffersEvent::TakeDone) => {
                effects.push(SwapOffersEffect::CacheInvalidate);
                SwapOffersState::Taken
            }
            (SwapOffersState::Taking, SwapOffersEvent::TakeError { error }) => {
                ctx.failure = Some(error);
                SwapOffersState::Reviewing
            }
            (SwapOffersState::Taken, SwapOffersEvent::Refresh) => {
                ctx.taking = None;
                ctx.pay = None;
                effects.push(SwapOffersEffect::CacheInvalidate);
                SwapOffersState::Ready
            }
            (SwapOffersState::Failed, SwapOffersEvent::Refresh) => {
                effects.push(SwapOffersEffect::CacheInvalidate);
                SwapOffersState::Failed
            }
            _ => return (snapshot.clone(), effects),
        };
        (Snapshot::new(next, ctx), effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    const NOW: u64 = 1_000_000;

    fn self_key() -> String {
        format!("02{}", "a".repeat(64))
    }

    fn other_key() -> String {
        format!("03{}", "b".repeat(64))
    }

    fn make_offer(nonce: &str, maker: String, min_get: u128, max_get: u128) -> SignedSwapOffer {
        SignedSwapOffer {
            v: 1,
            maker,
            give: SwapAsset::Bsv,
            get: SwapAsset::Ltc,
            price_give: 350_000_000,
            price_get: 100_000_000,
            min_get,
            max_get,
            created_at: 0,
            expires_at: NOW + 3_600_000,
            nonce: nonce.to_string(),
            sig: String::new(),
        }
    }

    fn ready_book(key: &str, page: OfferBookPage) -> SwapOffersEvent {
        SwapOffersEvent::CacheUpdate {
            cache: "swap-offer-book".to_string(),
            key: key.to_string(),
            view: CacheView {
                state: CacheState::Ready,
                data: Some(page),
                error: None,
                loaded_at: Some(1),
            },
        }
    }

    #[test]
    fn serves_a_reopened_book_from_cache_and_ignores_other_accounts() {
        let key = format!("{}:main", self_key());
        let mut actor = EffectActor::<SwapOffersMachine>::new(SwapOffersInput {
            self_key: Some(self_key()),
            key: key.clone(),
        });
        actor.send(ready_book(
            &key,
            OfferBookPage {
                id: 1,
                offers: vec![make_offer("n1", other_key(), 100_000_000, 100_000_000)],
                filled: BTreeMap::new(),
            },
        ));
        assert_eq!(*actor.state(), SwapOffersState::Ready);
        assert_eq!(actor.context().offers.len(), 1);

        actor.send(ready_book(
            "someone:main",
            OfferBookPage {
                id: 2,
                offers: Vec::new(),
                filled: BTreeMap::new(),
            },
        ));
        assert_eq!(actor.context().offers.len(), 1);
        assert_eq!(actor.context().offers[0].nonce, "n1");
    }

    #[test]
    fn drops_withdrawn_offer_at_once_and_does_not_bring_it_back_while_revalidating() {
        let key = format!("{}:main", self_key());
        let mut actor = EffectActor::<SwapOffersMachine>::new(SwapOffersInput {
            self_key: Some(self_key()),
            key: key.clone(),
        });
        let mine = make_offer("mine", self_key(), 100_000_000, 100_000_000);
        let n1 = make_offer("n1", other_key(), 100_000_000, 100_000_000);
        let n2 = make_offer("n2", other_key(), 100_000_000, 100_000_000);
        let initial_page = OfferBookPage {
            id: 1,
            offers: vec![mine.clone(), n1.clone()],
            filled: BTreeMap::new(),
        };
        actor.send(ready_book(&key, initial_page.clone()));
        // Cannot cancel someone else's offer.
        actor.send(SwapOffersEvent::Cancel {
            nonce: "n1".to_string(),
        });
        assert_eq!(*actor.state(), SwapOffersState::Ready);

        // Cancel own offer.
        let effects = actor.send(SwapOffersEvent::Cancel {
            nonce: "mine".to_string(),
        });
        assert_eq!(*actor.state(), SwapOffersState::Cancelling);
        assert_eq!(
            effects,
            vec![SwapOffersEffect::Cancel {
                nonce: "mine".to_string()
            }]
        );
        let done_effects = actor.send(SwapOffersEvent::CancelDone);
        assert_eq!(*actor.state(), SwapOffersState::Ready);
        assert_eq!(done_effects, vec![SwapOffersEffect::CacheInvalidate]);
        assert_eq!(
            actor
                .context()
                .offers
                .iter()
                .map(|o| o.nonce.as_str())
                .collect::<Vec<_>>(),
            vec!["n1"]
        );

        // Cache emits Refreshing with same book id=1 -> must NOT bring `mine` back!
        actor.send(SwapOffersEvent::CacheUpdate {
            cache: "swap-offer-book".to_string(),
            key: key.clone(),
            view: CacheView {
                state: CacheState::Refreshing,
                data: Some(initial_page),
                error: None,
                loaded_at: Some(1),
            },
        });
        assert_eq!(actor.context().cache, CacheState::Refreshing);
        assert_eq!(
            actor
                .context()
                .offers
                .iter()
                .map(|o| o.nonce.as_str())
                .collect::<Vec<_>>(),
            vec!["n1"]
        );

        // Next load with id=2 arrives.
        actor.send(ready_book(
            &key,
            OfferBookPage {
                id: 2,
                offers: vec![n1, n2],
                filled: BTreeMap::new(),
            },
        ));
        assert_eq!(
            actor
                .context()
                .offers
                .iter()
                .map(|o| o.nonce.as_str())
                .collect::<Vec<_>>(),
            vec!["n1", "n2"]
        );
    }

    #[test]
    fn takes_only_someone_elses_offer_and_only_on_confirm_after_review() {
        let key = "k".to_string();
        let mine = make_offer("mine", self_key(), 100_000_000, 100_000_000);
        let theirs = make_offer("theirs", other_key(), 100_000_000, 100_000_000);
        let mut actor = EffectActor::<SwapOffersMachine>::new(SwapOffersInput {
            self_key: Some(self_key()),
            key: key.clone(),
        });
        actor.send(ready_book(
            &key,
            OfferBookPage {
                id: 1,
                offers: vec![mine, theirs.clone()],
                filled: BTreeMap::new(),
            },
        ));
        actor.send(SwapOffersEvent::Review {
            nonce: "mine".to_string(),
            now_ms: NOW,
        });
        assert_eq!(*actor.state(), SwapOffersState::Ready);
        actor.send(SwapOffersEvent::Review {
            nonce: "theirs".to_string(),
            now_ms: NOW,
        });
        assert_eq!(*actor.state(), SwapOffersState::Reviewing);
        actor.send(SwapOffersEvent::Back);
        assert_eq!(actor.context().taking, None);
        actor.send(SwapOffersEvent::Review {
            nonce: "theirs".to_string(),
            now_ms: NOW,
        });
        actor.take_effects();
        let effects = actor.send(SwapOffersEvent::Confirm { now_ms: NOW });
        assert_eq!(*actor.state(), SwapOffersState::Taking);
        assert_eq!(
            effects,
            vec![SwapOffersEffect::Take {
                input: TakeInput {
                    offer: theirs,
                    pay: 100_000_000,
                }
            }]
        );
        actor.send(SwapOffersEvent::TakeDone);
        assert_eq!(*actor.state(), SwapOffersState::Taken);
    }

    #[test]
    fn takes_a_part_of_a_part_fillable_offer_never_more_than_remaining() {
        let key = "k".to_string();
        let parts = make_offer("parts", other_key(), 20_000_000, 100_000_000);
        let mut filled = BTreeMap::new();
        filled.insert("parts".to_string(), 30_000_000);
        let mut actor = EffectActor::<SwapOffersMachine>::new(SwapOffersInput {
            self_key: Some(self_key()),
            key: key.clone(),
        });
        actor.send(ready_book(
            &key,
            OfferBookPage {
                id: 1,
                offers: vec![parts.clone()],
                filled,
            },
        ));
        actor.send(SwapOffersEvent::Review {
            nonce: "parts".to_string(),
            now_ms: NOW,
        });
        assert_eq!(actor.context().pay, Some(70_000_000));
        for pay in [Some(80_000_000), Some(10_000_000), None] {
            actor.send(SwapOffersEvent::Amount { pay });
            actor.send(SwapOffersEvent::Confirm { now_ms: NOW });
            assert_eq!(*actor.state(), SwapOffersState::Reviewing);
        }
        actor.send(SwapOffersEvent::Amount {
            pay: Some(25_000_000),
        });
        let effects = actor.send(SwapOffersEvent::Confirm { now_ms: NOW });
        assert_eq!(*actor.state(), SwapOffersState::Taking);
        assert_eq!(
            effects,
            vec![SwapOffersEffect::Take {
                input: TakeInput {
                    offer: parts,
                    pay: 25_000_000,
                }
            }]
        );
        actor.send(SwapOffersEvent::TakeDone);
        assert_eq!(*actor.state(), SwapOffersState::Taken);
    }

    #[test]
    fn returns_to_review_with_reason_when_take_refused_and_recovers_from_book_failure() {
        let key = "k".to_string();
        let theirs = make_offer("theirs", other_key(), 100_000_000, 100_000_000);
        let mut actor = EffectActor::<SwapOffersMachine>::new(SwapOffersInput {
            self_key: Some(self_key()),
            key: key.clone(),
        });
        actor.send(SwapOffersEvent::CacheUpdate {
            cache: "swap-offer-book".to_string(),
            key: key.clone(),
            view: CacheView {
                state: CacheState::Failed,
                data: None,
                error: Some("offer book unavailable: 503".to_string()),
                loaded_at: None,
            },
        });
        assert_eq!(*actor.state(), SwapOffersState::Failed);
        assert_eq!(
            actor.context().failure.as_deref(),
            Some("offer book unavailable: 503")
        );
        actor.send(SwapOffersEvent::Refresh);
        actor.send(ready_book(
            &key,
            OfferBookPage {
                id: 1,
                offers: vec![theirs],
                filled: BTreeMap::new(),
            },
        ));
        assert_eq!(*actor.state(), SwapOffersState::Ready);
        assert_eq!(actor.context().failure, None);

        actor.send(SwapOffersEvent::Review {
            nonce: "theirs".to_string(),
            now_ms: NOW,
        });
        actor.send(SwapOffersEvent::Confirm { now_ms: NOW });
        actor.send(SwapOffersEvent::TakeError {
            error: "Not enough LTC to lock for this swap.".to_string(),
        });
        assert_eq!(*actor.state(), SwapOffersState::Reviewing);
        assert_eq!(
            actor.context().failure.as_deref(),
            Some("Not enough LTC to lock for this swap.")
        );
    }
}
