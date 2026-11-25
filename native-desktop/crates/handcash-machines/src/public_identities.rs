// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/publicIdentitiesMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IssuerIdentityFields {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssuerIdentityField {
    Name,
    Description,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuerIdentityImage {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IdentityPublishRequest {
    Profile {
        identity_key: String,
        fields: IssuerIdentityFields,
        image: Option<IssuerIdentityImage>,
    },
    Rotate {
        identity_key: String,
    },
    Link {
        identity_key: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityRecordPurpose {
    Image,
    Publish,
    Update,
    Rotate,
    Link,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityRecordOutput {
    pub description: String,
    pub bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityRecordTx {
    pub purpose: IdentityRecordPurpose,
    pub description: String,
    pub outputs: Vec<IdentityRecordOutput>,
    pub fee_sats: u64,
    pub max_fee_sats: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityPlanKey {
    pub seq: u32,
    pub public_key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityPlanKind {
    Publish,
    Update,
    Rotate,
    Link,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityPlanSigner {
    Wallet,
    Imported,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IdentityPlanImage {
    New {
        bytes: usize,
        content_type: String,
    },
    Reused {
        txid: String,
    },
}

/// Everything the user approves before an identity record is signed. Public data only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityPublishPlan {
    pub kind: IdentityPlanKind,
    pub identity_key: String,
    pub bap_id: String,
    pub signer: IdentityPlanSigner,
    pub name: String,
    pub description: String,
    pub image: IdentityPlanImage,
    pub signing_key: IdentityPlanKey,
    pub retired_key: Option<IdentityPlanKey>,
    pub transactions: Vec<IdentityRecordTx>,
    pub fee_sats: u64,
    pub max_fee_sats: u64,
    pub digest: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicIdentitiesTag {
    Review,
    Busy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicIdentitiesState {
    Browsing,
    Composing,
    Saving,
    Importing,
    Quoting,
    Reviewing,
    Publishing,
    Refused,
}

impl PublicIdentitiesState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Browsing => "browsing",
            Self::Composing => "composing",
            Self::Saving => "saving",
            Self::Importing => "importing",
            Self::Quoting => "quoting",
            Self::Reviewing => "reviewing",
            Self::Publishing => "publishing",
            Self::Refused => "refused",
        }
    }

    pub const fn has_tag(self, tag: PublicIdentitiesTag) -> bool {
        matches!(
            (self, tag),
            (Self::Saving, PublicIdentitiesTag::Busy)
                | (
                    Self::Quoting | Self::Reviewing | Self::Publishing | Self::Refused,
                    PublicIdentitiesTag::Review | PublicIdentitiesTag::Busy
                )
        )
    }
}

/// Public-only chart context: no private keys ever live in chart context.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublicIdentitiesContext {
    pub identity_key: Option<String>,
    pub fields: IssuerIdentityFields,
    pub image: Option<IssuerIdentityImage>,
    pub request: Option<IdentityPublishRequest>,
    pub plan: Option<IdentityPublishPlan>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublicIdentitiesEvent {
    Compose {
        identity_key: String,
        fields: Option<IssuerIdentityFields>,
        image: Option<IssuerIdentityImage>,
    },
    ImportKey,
    Field {
        field: IssuerIdentityField,
        value: String,
    },
    Image {
        image: IssuerIdentityImage,
    },
    ClearImage,
    Close,
    Save,
    SaveDone,
    SaveError {
        error: String,
    },
    PublishBap {
        identity_key: String,
        fields: IssuerIdentityFields,
        image: IssuerIdentityImage,
    },
    Rotate {
        identity_key: String,
    },
    Link {
        identity_key: String,
    },
    QuoteDone {
        plan: IdentityPublishPlan,
    },
    QuoteError {
        error: String,
    },
    Approve,
    PublishDone,
    PublishError {
        error: String,
    },
    Cancel,
    Dismiss,
}

#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublicIdentitiesEffect {
    SaveProfile {
        identity_key: String,
        fields: IssuerIdentityFields,
        image: Option<IssuerIdentityImage>,
    },
    QuoteBap {
        request: IdentityPublishRequest,
    },
    PublishBap {
        request: IdentityPublishRequest,
        plan: IdentityPublishPlan,
    },
}

pub struct PublicIdentitiesMachine;

impl PublicIdentitiesMachine {
    fn draft_named(ctx: &PublicIdentitiesContext) -> bool {
        ctx.identity_key.as_deref().is_some_and(|k| !k.is_empty())
            && !ctx.fields.name.trim().is_empty()
    }
}

impl Statechart for PublicIdentitiesMachine {
    const ID: &'static str = "publicIdentities";
    type State = PublicIdentitiesState;
    type Context = PublicIdentitiesContext;
    type Event = PublicIdentitiesEvent;
    type Input = ();

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            PublicIdentitiesState::Browsing,
            PublicIdentitiesContext::default(),
        )
    }

    fn state_value(state: &Self::State) -> StateValue {
        StateValue::leaf(state.as_str())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }
}

impl HandCashChart for PublicIdentitiesMachine {
    const MANIFEST_ID: &'static str = "publicIdentities";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "browsing",
        "composing",
        "saving",
        "importing",
        "quoting",
        "reviewing",
        "publishing",
        "refused",
    ];
    type Effect = PublicIdentitiesEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (
                PublicIdentitiesState::Browsing,
                PublicIdentitiesEvent::Compose {
                    identity_key,
                    fields,
                    image,
                },
            ) => {
                ctx.identity_key = Some(identity_key);
                ctx.fields = fields.unwrap_or_default();
                ctx.image = image;
                ctx.error = None;
                PublicIdentitiesState::Composing
            }
            (PublicIdentitiesState::Browsing, PublicIdentitiesEvent::ImportKey) => {
                ctx = PublicIdentitiesContext::default();
                PublicIdentitiesState::Importing
            }
            (
                PublicIdentitiesState::Browsing,
                PublicIdentitiesEvent::PublishBap {
                    identity_key,
                    fields,
                    image,
                },
            ) => {
                let request = IdentityPublishRequest::Profile {
                    identity_key,
                    fields,
                    image: Some(image),
                };
                ctx.request = Some(request.clone());
                ctx.plan = None;
                ctx.error = None;
                effects.push(PublicIdentitiesEffect::QuoteBap { request });
                PublicIdentitiesState::Quoting
            }
            (
                PublicIdentitiesState::Browsing,
                PublicIdentitiesEvent::Rotate { identity_key },
            ) => {
                let request = IdentityPublishRequest::Rotate { identity_key };
                ctx.request = Some(request.clone());
                ctx.plan = None;
                ctx.error = None;
                effects.push(PublicIdentitiesEffect::QuoteBap { request });
                PublicIdentitiesState::Quoting
            }
            (PublicIdentitiesState::Browsing, PublicIdentitiesEvent::Link { identity_key }) => {
                let request = IdentityPublishRequest::Link { identity_key };
                ctx.request = Some(request.clone());
                ctx.plan = None;
                ctx.error = None;
                effects.push(PublicIdentitiesEffect::QuoteBap { request });
                PublicIdentitiesState::Quoting
            }
            (PublicIdentitiesState::Composing, PublicIdentitiesEvent::Field { field, value }) => {
                match field {
                    IssuerIdentityField::Name => ctx.fields.name = value,
                    IssuerIdentityField::Description => ctx.fields.description = value,
                }
                ctx.error = None;
                PublicIdentitiesState::Composing
            }
            (PublicIdentitiesState::Composing, PublicIdentitiesEvent::Image { image }) => {
                ctx.image = Some(image);
                ctx.error = None;
                PublicIdentitiesState::Composing
            }
            (PublicIdentitiesState::Composing, PublicIdentitiesEvent::ClearImage) => {
                ctx.image = None;
                ctx.error = None;
                PublicIdentitiesState::Composing
            }
            (PublicIdentitiesState::Composing, PublicIdentitiesEvent::Save)
                if Self::draft_named(&ctx) =>
            {
                effects.push(PublicIdentitiesEffect::SaveProfile {
                    identity_key: ctx.identity_key.clone().unwrap_or_default(),
                    fields: ctx.fields.clone(),
                    image: ctx.image.clone(),
                });
                PublicIdentitiesState::Saving
            }
            (PublicIdentitiesState::Composing, PublicIdentitiesEvent::Close) => {
                ctx = PublicIdentitiesContext::default();
                PublicIdentitiesState::Browsing
            }
            (PublicIdentitiesState::Saving, PublicIdentitiesEvent::SaveDone) => {
                ctx = PublicIdentitiesContext::default();
                PublicIdentitiesState::Browsing
            }
            (PublicIdentitiesState::Saving, PublicIdentitiesEvent::SaveError { error }) => {
                ctx.error = Some(error);
                PublicIdentitiesState::Composing
            }
            (PublicIdentitiesState::Importing, PublicIdentitiesEvent::Close) => {
                ctx = PublicIdentitiesContext::default();
                PublicIdentitiesState::Browsing
            }
            (PublicIdentitiesState::Quoting, PublicIdentitiesEvent::QuoteDone { plan }) => {
                ctx.plan = Some(plan);
                PublicIdentitiesState::Reviewing
            }
            (PublicIdentitiesState::Quoting, PublicIdentitiesEvent::QuoteError { error }) => {
                ctx.error = Some(error);
                PublicIdentitiesState::Refused
            }
            (PublicIdentitiesState::Quoting, PublicIdentitiesEvent::Cancel) => {
                ctx = PublicIdentitiesContext::default();
                PublicIdentitiesState::Browsing
            }
            (PublicIdentitiesState::Reviewing, PublicIdentitiesEvent::Approve) => {
                if let (Some(request), Some(plan)) = (ctx.request.clone(), ctx.plan.clone()) {
                    effects.push(PublicIdentitiesEffect::PublishBap { request, plan });
                }
                PublicIdentitiesState::Publishing
            }
            (PublicIdentitiesState::Reviewing, PublicIdentitiesEvent::Cancel) => {
                ctx = PublicIdentitiesContext::default();
                PublicIdentitiesState::Browsing
            }
            (PublicIdentitiesState::Publishing, PublicIdentitiesEvent::PublishDone) => {
                ctx = PublicIdentitiesContext::default();
                PublicIdentitiesState::Browsing
            }
            (PublicIdentitiesState::Publishing, PublicIdentitiesEvent::PublishError { error }) => {
                ctx.plan = None;
                ctx.error = Some(error);
                PublicIdentitiesState::Refused
            }
            (PublicIdentitiesState::Refused, PublicIdentitiesEvent::Dismiss) => {
                ctx = PublicIdentitiesContext::default();
                PublicIdentitiesState::Browsing
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

    fn sample_image() -> IssuerIdentityImage {
        IssuerIdentityImage {
            content_type: "image/webp".into(),
            bytes: vec![1, 2, 3],
        }
    }

    fn sample_plan(kind: IdentityPlanKind) -> IdentityPublishPlan {
        IdentityPublishPlan {
            kind,
            identity_key: "pubkey".into(),
            bap_id: "bap".into(),
            signer: IdentityPlanSigner::Wallet,
            name: "Studio".into(),
            description: String::new(),
            image: IdentityPlanImage::New {
                bytes: 3,
                content_type: "image/webp".into(),
            },
            signing_key: IdentityPlanKey {
                seq: 1,
                public_key: format!("02{}", "a".repeat(64)),
            },
            retired_key: None,
            transactions: Vec::new(),
            fee_sats: 50,
            max_fee_sats: 320,
            digest: "d".repeat(64),
        }
    }

    fn publish_bap(actor: &mut EffectActor<PublicIdentitiesMachine>) {
        actor.send(PublicIdentitiesEvent::PublishBap {
            identity_key: "pubkey".into(),
            fields: IssuerIdentityFields {
                name: "Studio".into(),
                description: String::new(),
            },
            image: sample_image(),
        });
    }

    #[test]
    fn keeps_private_keys_out_of_context_and_clears_drafts_on_close() {
        let mut actor = EffectActor::<PublicIdentitiesMachine>::default();
        actor.send(PublicIdentitiesEvent::ImportKey);
        assert_eq!(*actor.state(), PublicIdentitiesState::Importing);
        actor.send(PublicIdentitiesEvent::Field {
            field: IssuerIdentityField::Name,
            value: "ignored".into(),
        });
        assert_eq!(actor.context().fields.name, "");
        actor.send(PublicIdentitiesEvent::Close);
        assert_eq!(*actor.state(), PublicIdentitiesState::Browsing);
    }

    #[test]
    fn composes_new_version_and_image_only_enters_or_leaves_by_event() {
        let mut actor = EffectActor::<PublicIdentitiesMachine>::default();
        actor.send(PublicIdentitiesEvent::Compose {
            identity_key: "pubkey".into(),
            fields: Some(IssuerIdentityFields {
                name: "Studio".into(),
                description: "Awards".into(),
            }),
            image: Some(sample_image()),
        });
        assert_eq!(*actor.state(), PublicIdentitiesState::Composing);
        actor.send(PublicIdentitiesEvent::Field {
            field: IssuerIdentityField::Name,
            value: "Studio 2".into(),
        });
        let next = IssuerIdentityImage {
            content_type: "image/png".into(),
            bytes: vec![9],
        };
        actor.send(PublicIdentitiesEvent::Image {
            image: next.clone(),
        });
        assert_eq!(actor.context().fields.name, "Studio 2");
        assert_eq!(actor.context().image, Some(next));
        actor.send(PublicIdentitiesEvent::ClearImage);
        assert_eq!(actor.context().image, None);
        actor.send(PublicIdentitiesEvent::Close);
        assert_eq!(actor.context().identity_key, None);
        assert_eq!(actor.context().fields, IssuerIdentityFields::default());
        assert_eq!(actor.context().image, None);
        actor.send(PublicIdentitiesEvent::Compose {
            identity_key: "fresh".into(),
            fields: None,
            image: None,
        });
        assert_eq!(actor.context().image, None);
    }

    #[test]
    fn saves_draft_without_quote_or_transaction_then_returns_to_list() {
        let mut actor = EffectActor::<PublicIdentitiesMachine>::default();
        actor.send(PublicIdentitiesEvent::Compose {
            identity_key: "pubkey".into(),
            fields: None,
            image: None,
        });
        actor.send(PublicIdentitiesEvent::Save);
        assert_eq!(*actor.state(), PublicIdentitiesState::Composing);
        actor.send(PublicIdentitiesEvent::Field {
            field: IssuerIdentityField::Name,
            value: "Studio".into(),
        });
        let effects = actor.send(PublicIdentitiesEvent::Save);
        assert!(actor.state().has_tag(PublicIdentitiesTag::Busy));
        assert_eq!(
            effects,
            vec![PublicIdentitiesEffect::SaveProfile {
                identity_key: "pubkey".into(),
                fields: IssuerIdentityFields {
                    name: "Studio".into(),
                    description: String::new(),
                },
                image: None,
            }]
        );
        actor.send(PublicIdentitiesEvent::SaveDone);
        assert_eq!(*actor.state(), PublicIdentitiesState::Browsing);
        assert_eq!(actor.context().identity_key, None);
        assert_eq!(actor.context().error, None);
    }

    #[test]
    fn failed_save_keeps_draft_and_names_reason_until_next_edit() {
        let mut actor = EffectActor::<PublicIdentitiesMachine>::default();
        actor.send(PublicIdentitiesEvent::Compose {
            identity_key: "pubkey".into(),
            fields: Some(IssuerIdentityFields {
                name: "Studio".into(),
                description: String::new(),
            }),
            image: Some(sample_image()),
        });
        actor.send(PublicIdentitiesEvent::Save);
        actor.send(PublicIdentitiesEvent::SaveError {
            error: "Could not save the profile. No changes were committed.".into(),
        });
        assert_eq!(*actor.state(), PublicIdentitiesState::Composing);
        assert_eq!(actor.context().fields.name, "Studio");
        assert_eq!(actor.context().image, Some(sample_image()));
        assert!(actor.context().error.is_some());
        actor.send(PublicIdentitiesEvent::Field {
            field: IssuerIdentityField::Name,
            value: "Studio 2".into(),
        });
        assert_eq!(actor.context().error, None);
    }

    #[test]
    fn signs_nothing_until_quoted_plan_approved_and_publishes_exact_plan() {
        let mut actor = EffectActor::<PublicIdentitiesMachine>::default();
        actor.send(PublicIdentitiesEvent::Approve);
        assert_eq!(*actor.state(), PublicIdentitiesState::Browsing);
        publish_bap(&mut actor);
        assert_eq!(*actor.state(), PublicIdentitiesState::Quoting);
        let plan = sample_plan(IdentityPlanKind::Publish);
        actor.send(PublicIdentitiesEvent::QuoteDone { plan: plan.clone() });
        assert_eq!(*actor.state(), PublicIdentitiesState::Reviewing);
        let expected_req = IdentityPublishRequest::Profile {
            identity_key: "pubkey".into(),
            fields: IssuerIdentityFields {
                name: "Studio".into(),
                description: String::new(),
            },
            image: Some(sample_image()),
        };
        assert_eq!(actor.context().request.as_ref(), Some(&expected_req));
        let effects = actor.send(PublicIdentitiesEvent::Approve);
        assert_eq!(*actor.state(), PublicIdentitiesState::Publishing);
        assert_eq!(
            effects,
            vec![PublicIdentitiesEffect::PublishBap {
                request: expected_req,
                plan,
            }]
        );
        actor.send(PublicIdentitiesEvent::PublishDone);
        assert_eq!(*actor.state(), PublicIdentitiesState::Browsing);
        assert_eq!(actor.context().identity_key, None);
        assert_eq!(actor.context().plan, None);
        assert_eq!(actor.context().request, None);
    }

    #[test]
    fn cancelling_review_or_rotation_returns_to_list() {
        let mut actor = EffectActor::<PublicIdentitiesMachine>::default();
        publish_bap(&mut actor);
        actor.send(PublicIdentitiesEvent::QuoteDone {
            plan: sample_plan(IdentityPlanKind::Publish),
        });
        assert_eq!(*actor.state(), PublicIdentitiesState::Reviewing);
        actor.send(PublicIdentitiesEvent::Cancel);
        assert_eq!(*actor.state(), PublicIdentitiesState::Browsing);
        assert_eq!(actor.context().plan, None);
        assert_eq!(actor.context().request, None);
        actor.send(PublicIdentitiesEvent::Rotate {
            identity_key: "pubkey".into(),
        });
        actor.send(PublicIdentitiesEvent::QuoteDone {
            plan: sample_plan(IdentityPlanKind::Rotate),
        });
        assert_eq!(
            actor.context().plan.as_ref().map(|p| p.kind),
            Some(IdentityPlanKind::Rotate)
        );
        actor.send(PublicIdentitiesEvent::Cancel);
        assert_eq!(*actor.state(), PublicIdentitiesState::Browsing);
    }

    #[test]
    fn refused_publish_names_reason_and_returns_to_list() {
        let mut actor = EffectActor::<PublicIdentitiesMachine>::default();
        publish_bap(&mut actor);
        actor.send(PublicIdentitiesEvent::QuoteDone {
            plan: sample_plan(IdentityPlanKind::Publish),
        });
        actor.send(PublicIdentitiesEvent::Approve);
        actor.send(PublicIdentitiesEvent::PublishError {
            error: "This identity changed since you reviewed it. Review the publish again.".into(),
        });
        assert_eq!(*actor.state(), PublicIdentitiesState::Refused);
        assert_eq!(actor.context().plan, None);
        assert!(actor
            .context()
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("changed since"));
        assert!(actor.state().has_tag(PublicIdentitiesTag::Review));
        actor.send(PublicIdentitiesEvent::Dismiss);
        assert_eq!(*actor.state(), PublicIdentitiesState::Browsing);
        assert_eq!(actor.context().error, None);
    }
}
