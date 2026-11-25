// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/swapMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const SWAP_QUOTE_TTL_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapRequest {
    pub from: String,
    pub to: String,
    pub pay: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapRoute {
    pub kind: String,
    pub label: String,
    pub receive: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapQuote {
    pub routes: Vec<SwapRoute>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapRefusal {
    BadRequest { detail: String },
    NoRoute { detail: Option<String> },
    Failed { detail: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapQuoteResult {
    Ok { quote: SwapQuote },
    Refused { refusal: SwapRefusal },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapStart {
    pub via: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapFailure {
    pub reason: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapPrice {
    pub give: String,
    pub get: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapOfferDraft {
    pub give: String,
    pub get: String,
    pub pay: u128,
    pub want: u128,
    pub min_want: u128,
    pub part_want: u128,
    pub price: SwapPrice,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedSwapOffer {
    pub nonce: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapState {
    Editing,
    Quoting,
    Quoted,
    Reviewing,
    Swapping,
    Stale,
    Refused,
    Offering,
    Publishing,
    Published,
    Done,
    Failed,
}

impl SwapState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Editing => "editing",
            Self::Quoting => "quoting",
            Self::Quoted => "quoted",
            Self::Reviewing => "reviewing",
            Self::Swapping => "swapping",
            Self::Stale => "stale",
            Self::Refused => "refused",
            Self::Offering => "offering",
            Self::Publishing => "publishing",
            Self::Published => "published",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SwapContext {
    pub request: Option<SwapRequest>,
    pub quote: Option<SwapQuote>,
    pub picked: usize,
    pub refusal: Option<SwapRefusal>,
    pub started: Option<SwapStart>,
    pub failure: Option<SwapFailure>,
    pub draft: Option<SwapOfferDraft>,
    pub published: Option<PublishedSwapOffer>,
}

impl SwapContext {
    pub fn route(&self) -> Option<&SwapRoute> {
        self.quote.as_ref().and_then(|q| q.routes.get(self.picked))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapEvent {
    Quote { request: SwapRequest },
    QuoteDone { result: SwapQuoteResult },
    QuoteError { detail: String },
    QuoteExpired,
    Pick { index: usize },
    Review,
    Back,
    Confirm,
    ExecuteDone { started: SwapStart },
    ExecuteError { reason: Option<String>, message: String },
    Offer { draft: SwapOfferDraft },
    Parts { allow: bool },
    Publish,
    PublishDone { published: PublishedSwapOffer },
    PublishError { message: String },
    Reset,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapEffect {
    Quote { request: SwapRequest },
    ScheduleQuoteTtl { delay_ms: u64 },
    Execute { route: SwapRoute },
    Publish { draft: SwapOfferDraft },
}

pub struct SwapMachine;

impl Statechart for SwapMachine {
    type State = SwapState;
    type Context = SwapContext;
    type Event = SwapEvent;
    type Input = ();

    const ID: &'static str = "swap";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(SwapState::Editing, SwapContext::default())
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

impl HandCashChart for SwapMachine {
    const MANIFEST_ID: &'static str = "swap";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "editing",
        "quoting",
        "quoted",
        "reviewing",
        "swapping",
        "stale",
        "refused",
        "offering",
        "publishing",
        "published",
        "done",
        "failed",
    ];
    type Effect = SwapEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let apply_request = |ctx: &mut SwapContext, request: SwapRequest, effects: &mut Vec<SwapEffect>| {
            ctx.request = Some(request.clone());
            ctx.quote = None;
            ctx.picked = 0;
            ctx.refusal = None;
            ctx.failure = None;
            effects.push(SwapEffect::Quote { request });
        };
        let next = match (snapshot.value, event) {
            (SwapState::Editing, SwapEvent::Quote { request })
            | (SwapState::Quoting, SwapEvent::Quote { request })
            | (SwapState::Quoted, SwapEvent::Quote { request })
            | (SwapState::Stale, SwapEvent::Quote { request })
            | (SwapState::Refused, SwapEvent::Quote { request }) => {
                apply_request(&mut ctx, request, &mut effects);
                SwapState::Quoting
            }
            (SwapState::Offering, SwapEvent::Quote { request }) => {
                apply_request(&mut ctx, request, &mut effects);
                ctx.draft = None;
                SwapState::Quoting
            }
            (SwapState::Quoting, SwapEvent::QuoteDone { result }) => match result {
                SwapQuoteResult::Ok { quote } => {
                    ctx.quote = Some(quote);
                    ctx.picked = 0;
                    effects.push(SwapEffect::ScheduleQuoteTtl {
                        delay_ms: SWAP_QUOTE_TTL_MS,
                    });
                    SwapState::Quoted
                }
                SwapQuoteResult::Refused { refusal } => {
                    ctx.refusal = Some(refusal);
                    SwapState::Refused
                }
            },
            (SwapState::Quoting, SwapEvent::QuoteError { detail }) => {
                ctx.refusal = Some(SwapRefusal::Failed { detail });
                SwapState::Refused
            }
            (SwapState::Quoted, SwapEvent::QuoteExpired)
            | (SwapState::Reviewing, SwapEvent::QuoteExpired) => SwapState::Stale,
            (SwapState::Quoted, SwapEvent::Pick { index })
                if index < ctx.quote.as_ref().map_or(0, |q| q.routes.len()) =>
            {
                ctx.picked = index;
                SwapState::Quoted
            }
            (SwapState::Quoted, SwapEvent::Review) if ctx.route().is_some() => {
                effects.push(SwapEffect::ScheduleQuoteTtl {
                    delay_ms: SWAP_QUOTE_TTL_MS,
                });
                SwapState::Reviewing
            }
            (SwapState::Reviewing, SwapEvent::Back) => {
                effects.push(SwapEffect::ScheduleQuoteTtl {
                    delay_ms: SWAP_QUOTE_TTL_MS,
                });
                SwapState::Quoted
            }
            (SwapState::Reviewing, SwapEvent::Confirm) => {
                if let Some(route) = ctx.route().cloned() {
                    effects.push(SwapEffect::Execute { route });
                }
                SwapState::Swapping
            }
            (SwapState::Swapping, SwapEvent::ExecuteDone { started }) => {
                ctx.started = Some(started);
                SwapState::Done
            }
            (SwapState::Swapping, SwapEvent::ExecuteError { reason, message }) => {
                ctx.failure = Some(SwapFailure {
                    reason: reason.unwrap_or_else(|| "failed".to_string()),
                    message,
                });
                SwapState::Failed
            }
            (SwapState::Refused, SwapEvent::Offer { draft })
                if matches!(ctx.refusal, Some(SwapRefusal::NoRoute { .. })) =>
            {
                ctx.draft = Some(draft);
                ctx.failure = None;
                SwapState::Offering
            }
            (SwapState::Offering, SwapEvent::Parts { allow })
                if ctx.draft.as_ref().is_some_and(|d| d.part_want < d.want) =>
            {
                if let Some(draft) = ctx.draft.as_mut() {
                    draft.min_want = if allow { draft.part_want } else { draft.want };
                }
                SwapState::Offering
            }
            (SwapState::Offering, SwapEvent::Publish) => {
                if let Some(draft) = ctx.draft.clone() {
                    effects.push(SwapEffect::Publish { draft });
                }
                SwapState::Publishing
            }
            (SwapState::Offering, SwapEvent::Back) => {
                ctx.draft = None;
                ctx.failure = None;
                SwapState::Refused
            }
            (SwapState::Publishing, SwapEvent::PublishDone { published }) => {
                ctx.published = Some(published);
                ctx.failure = None;
                SwapState::Published
            }
            (SwapState::Publishing, SwapEvent::PublishError { message }) => {
                ctx.failure = Some(SwapFailure {
                    reason: "publish-failed".to_string(),
                    message,
                });
                SwapState::Offering
            }
            (SwapState::Published, SwapEvent::Reset)
            | (SwapState::Done, SwapEvent::Reset)
            | (SwapState::Failed, SwapEvent::Reset) => {
                ctx = SwapContext::default();
                SwapState::Editing
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

    fn req() -> SwapRequest {
        SwapRequest {
            from: "ltc".to_string(),
            to: "bsv".to_string(),
            pay: 100_000_000,
        }
    }

    fn two_routes() -> SwapQuote {
        SwapQuote {
            routes: vec![
                SwapRoute {
                    kind: "direct".to_string(),
                    label: "direct offer".to_string(),
                    receive: 350_000_000,
                },
                SwapRoute {
                    kind: "exolix".to_string(),
                    label: "exolix".to_string(),
                    receive: 324_000_000,
                },
            ],
        }
    }

    #[test]
    fn quotes_picks_a_ranked_route_and_goes_stale() {
        let mut actor = EffectActor::<SwapMachine>::default();
        actor.send(SwapEvent::Quote { request: req() });
        actor.send(SwapEvent::QuoteDone {
            result: SwapQuoteResult::Ok {
                quote: two_routes(),
            },
        });
        assert_eq!(*actor.state(), SwapState::Quoted);
        assert_eq!(actor.context().picked, 0);
        actor.send(SwapEvent::Pick { index: 1 });
        assert_eq!(actor.context().picked, 1);
        actor.send(SwapEvent::Pick { index: 5 });
        assert_eq!(actor.context().picked, 1);
        actor.send(SwapEvent::QuoteExpired);
        assert_eq!(*actor.state(), SwapState::Stale);
    }

    #[test]
    fn moves_coins_only_on_confirm_whichever_route_is_picked() {
        let mut actor = EffectActor::<SwapMachine>::default();
        actor.send(SwapEvent::Quote { request: req() });
        actor.send(SwapEvent::QuoteDone {
            result: SwapQuoteResult::Ok {
                quote: two_routes(),
            },
        });
        actor.send(SwapEvent::Review);
        assert_eq!(*actor.state(), SwapState::Reviewing);
        actor.send(SwapEvent::Back);
        actor.send(SwapEvent::Pick { index: 1 });
        actor.send(SwapEvent::Review);
        assert_eq!(*actor.state(), SwapState::Reviewing);
        actor.send(SwapEvent::Back);
        actor.take_effects();
        actor.send(SwapEvent::Review);
        assert!(!actor
            .effects()
            .iter()
            .any(|e| matches!(e, SwapEffect::Execute { .. })));
        let effects = actor.send(SwapEvent::Confirm);
        assert_eq!(*actor.state(), SwapState::Swapping);
        assert_eq!(
            effects,
            vec![SwapEffect::Execute {
                route: two_routes().routes[1].clone()
            }]
        );
        actor.send(SwapEvent::ExecuteDone {
            started: SwapStart {
                via: "exolix".to_string(),
                id: "ex123".to_string(),
            },
        });
        assert_eq!(*actor.state(), SwapState::Done);
        assert_eq!(
            actor.context().started,
            Some(SwapStart {
                via: "exolix".to_string(),
                id: "ex123".to_string(),
            })
        );
        actor.send(SwapEvent::Reset);
        assert_eq!(*actor.state(), SwapState::Editing);
    }

    #[test]
    fn names_why_a_swap_failed() {
        let mut actor = EffectActor::<SwapMachine>::default();
        actor.send(SwapEvent::Quote { request: req() });
        actor.send(SwapEvent::QuoteDone {
            result: SwapQuoteResult::Ok {
                quote: two_routes(),
            },
        });
        actor.send(SwapEvent::Pick { index: 1 });
        actor.send(SwapEvent::Review);
        actor.send(SwapEvent::Confirm);
        actor.send(SwapEvent::ExecuteError {
            reason: Some("terms-changed".to_string()),
            message: "Exolix now pays less. Nothing was paid.".to_string(),
        });
        assert_eq!(*actor.state(), SwapState::Failed);
        assert_eq!(
            actor.context().failure,
            Some(SwapFailure {
                reason: "terms-changed".to_string(),
                message: "Exolix now pays less. Nothing was paid.".to_string(),
            })
        );
    }

    #[test]
    fn is_refused_with_the_named_reason_and_never_offers_on_bad_request() {
        let mut actor = EffectActor::<SwapMachine>::default();
        actor.send(SwapEvent::Quote {
            request: SwapRequest {
                from: "ltc".to_string(),
                to: "ltc".to_string(),
                pay: 100_000_000,
            },
        });
        actor.send(SwapEvent::QuoteDone {
            result: SwapQuoteResult::Refused {
                refusal: SwapRefusal::BadRequest {
                    detail: "pick two different coins".to_string(),
                },
            },
        });
        assert_eq!(*actor.state(), SwapState::Refused);
        actor.send(SwapEvent::Offer {
            draft: SwapOfferDraft {
                give: "ltc".to_string(),
                get: "ltc".to_string(),
                pay: 1,
                want: 1,
                min_want: 1,
                part_want: 1,
                price: SwapPrice {
                    give: "1".to_string(),
                    get: "1".to_string(),
                },
            },
        });
        assert_eq!(*actor.state(), SwapState::Refused);
    }

    #[test]
    fn offers_to_publish_only_on_no_route_and_publishes_only_on_publish() {
        let draft = SwapOfferDraft {
            give: "bsv".to_string(),
            get: "ltc".to_string(),
            pay: 1_000,
            want: 300,
            min_want: 300,
            part_want: 30,
            price: SwapPrice {
                give: "333333333".to_string(),
                get: "100000000".to_string(),
            },
        };
        let mut actor = EffectActor::<SwapMachine>::default();
        actor.send(SwapEvent::Quote { request: req() });
        actor.send(SwapEvent::QuoteDone {
            result: SwapQuoteResult::Refused {
                refusal: SwapRefusal::NoRoute {
                    detail: Some("below-min".to_string()),
                },
            },
        });
        actor.send(SwapEvent::Offer {
            draft: draft.clone(),
        });
        assert_eq!(*actor.state(), SwapState::Offering);
        actor.send(SwapEvent::Back);
        assert_eq!(*actor.state(), SwapState::Refused);
        actor.send(SwapEvent::Offer {
            draft: draft.clone(),
        });
        actor.send(SwapEvent::Parts { allow: true });
        assert_eq!(actor.context().draft.as_ref().unwrap().min_want, 30);
        actor.send(SwapEvent::Parts { allow: false });
        assert_eq!(actor.context().draft.as_ref().unwrap().min_want, 300);
        actor.send(SwapEvent::Parts { allow: true });
        let effects = actor.send(SwapEvent::Publish);
        assert_eq!(*actor.state(), SwapState::Publishing);
        assert_eq!(
            effects,
            vec![SwapEffect::Publish {
                draft: SwapOfferDraft {
                    min_want: 30,
                    ..draft.clone()
                }
            }]
        );
        actor.send(SwapEvent::PublishError {
            message: "offer book refused the offer: rate-limited".to_string(),
        });
        assert_eq!(*actor.state(), SwapState::Offering);
        assert_eq!(
            actor.context().failure,
            Some(SwapFailure {
                reason: "publish-failed".to_string(),
                message: "offer book refused the offer: rate-limited".to_string(),
            })
        );
        actor.send(SwapEvent::Publish);
        actor.send(SwapEvent::PublishDone {
            published: PublishedSwapOffer {
                nonce: "n1".to_string(),
            },
        });
        assert_eq!(*actor.state(), SwapState::Published);
        assert_eq!(
            actor.context().published,
            Some(PublishedSwapOffer {
                nonce: "n1".to_string()
            })
        );
    }
}
