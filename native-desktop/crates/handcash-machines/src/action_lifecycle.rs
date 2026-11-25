// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/actionLifecycleMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionStage {
    Approving,
    Preparing,
    Signing,
    Broadcasting,
    Settling,
}

pub const ACTION_STAGES: [ActionStage; 5] = [
    ActionStage::Approving,
    ActionStage::Preparing,
    ActionStage::Signing,
    ActionStage::Broadcasting,
    ActionStage::Settling,
];

impl ActionStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approving => "approving",
            Self::Preparing => "preparing",
            Self::Signing => "signing",
            Self::Broadcasting => "broadcasting",
            Self::Settling => "settling",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Approving => "Approving",
            Self::Preparing => "Preparing",
            Self::Signing => "Signing",
            Self::Broadcasting => "Broadcasting",
            Self::Settling => "Verifying",
        }
    }

    pub const fn index(self) -> usize {
        match self {
            Self::Approving => 0,
            Self::Preparing => 1,
            Self::Signing => 2,
            Self::Broadcasting => 3,
            Self::Settling => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionLifecycleState {
    Approving,
    Preparing,
    Signing,
    Broadcasting,
    Settling,
    Settled,
    Failed,
}

impl ActionLifecycleState {
    pub const fn from_stage(stage: ActionStage) -> Self {
        match stage {
            ActionStage::Approving => Self::Approving,
            ActionStage::Preparing => Self::Preparing,
            ActionStage::Signing => Self::Signing,
            ActionStage::Broadcasting => Self::Broadcasting,
            ActionStage::Settling => Self::Settling,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approving => "approving",
            Self::Preparing => "preparing",
            Self::Signing => "signing",
            Self::Broadcasting => "broadcasting",
            Self::Settling => "settling",
            Self::Settled => "settled",
            Self::Failed => "failed",
        }
    }

    pub const fn is_live(self) -> bool {
        !matches!(self, Self::Settled | Self::Failed)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionLifecycleContext {
    pub id: String,
    pub origin: String,
    pub method: String,
    pub description: Option<String>,
    pub txid: Option<String>,
    pub outpoints: Vec<String>,
    pub started_at: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionLifecycleInput {
    pub id: String,
    pub origin: String,
    pub method: String,
    pub description: Option<String>,
    pub outpoints: Vec<String>,
    pub started_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActionLifecycleEvent {
    Stage(ActionStage),
    Txid(String),
    Touch(Vec<String>),
    Settle,
    Fail { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ActionProgress {
    pub value: f64,
    pub max: usize,
}

pub fn normalize_outpoint(outpoint: &str) -> String {
    let lower = outpoint.trim().to_ascii_lowercase();
    if let Some((prefix, suffix)) = lower.rsplit_once('_') {
        if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
            return format!("{prefix}.{suffix}");
        }
    }
    lower
}

pub fn action_lifecycle_face(
    snapshot: &Snapshot<ActionLifecycleState, ActionLifecycleContext>,
) -> &'static str {
    snapshot.value.as_str()
}

pub fn action_stage_index(
    snapshot: &Snapshot<ActionLifecycleState, ActionLifecycleContext>,
) -> Option<usize> {
    match snapshot.value {
        ActionLifecycleState::Settled => Some(ACTION_STAGES.len()),
        ActionLifecycleState::Failed => None,
        ActionLifecycleState::Approving => Some(0),
        ActionLifecycleState::Preparing => Some(1),
        ActionLifecycleState::Signing => Some(2),
        ActionLifecycleState::Broadcasting => Some(3),
        ActionLifecycleState::Settling => Some(4),
    }
}

pub fn action_progress(
    snapshot: &Snapshot<ActionLifecycleState, ActionLifecycleContext>,
) -> Option<ActionProgress> {
    let index = action_stage_index(snapshot)?;
    let max = ACTION_STAGES.len();
    let value = if snapshot.value == ActionLifecycleState::Settled {
        max as f64
    } else {
        index as f64 + 0.5
    };
    Some(ActionProgress { value, max })
}

pub struct ActionLifecycleMachine;

impl Statechart for ActionLifecycleMachine {
    type State = ActionLifecycleState;
    type Context = ActionLifecycleContext;
    type Event = ActionLifecycleEvent;
    type Input = ActionLifecycleInput;

    const ID: &'static str = "actionLifecycle";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        let description = input
            .description
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        let outpoints = input
            .outpoints
            .iter()
            .map(|o| normalize_outpoint(o))
            .collect();
        Snapshot::new(
            ActionLifecycleState::Approving,
            ActionLifecycleContext {
                id: input.id,
                origin: input.origin,
                method: input.method,
                description,
                txid: None,
                outpoints,
                started_at: input.started_at,
                error: None,
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

impl HandCashChart for ActionLifecycleMachine {
    const MANIFEST_ID: &'static str = "actionLifecycle";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "approving",
        "preparing",
        "signing",
        "broadcasting",
        "settling",
        "settled",
        "failed",
    ];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        !state.is_live()
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        if !snapshot.value.is_live() {
            return (snapshot.clone(), Vec::new());
        }
        let mut ctx = snapshot.context.clone();
        let next_state = match event {
            ActionLifecycleEvent::Stage(stage) => ActionLifecycleState::from_stage(stage),
            ActionLifecycleEvent::Txid(txid) => {
                ctx.txid = Some(txid.trim().to_ascii_lowercase());
                snapshot.value
            }
            ActionLifecycleEvent::Touch(outpoints) => {
                for o in outpoints {
                    let norm = normalize_outpoint(&o);
                    if !ctx.outpoints.contains(&norm) {
                        ctx.outpoints.push(norm);
                    }
                }
                snapshot.value
            }
            ActionLifecycleEvent::Settle => ActionLifecycleState::Settled,
            ActionLifecycleEvent::Fail { reason } => {
                ctx.error = Some(reason);
                ActionLifecycleState::Failed
            }
        };
        (Snapshot::new(next_state, ctx), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn start(outpoints: Vec<&str>) -> EffectActor<ActionLifecycleMachine> {
        EffectActor::new(ActionLifecycleInput {
            id: "action:1".into(),
            origin: "app.example".into(),
            method: "createAction".into(),
            description: None,
            outpoints: outpoints.into_iter().map(String::from).collect(),
            started_at: 1,
        })
    }

    #[test]
    fn walks_every_stage_in_domain_order_and_settles() {
        let mut actor = start(vec![]);
        assert_eq!(action_lifecycle_face(actor.snapshot()), "approving");
        for &stage in &ACTION_STAGES[1..] {
            actor.send(ActionLifecycleEvent::Stage(stage));
            assert_eq!(action_lifecycle_face(actor.snapshot()), stage.as_str());
        }
        actor.send(ActionLifecycleEvent::Settle);
        assert_eq!(action_lifecycle_face(actor.snapshot()), "settled");
        assert!(actor.is_done());
        assert_eq!(
            action_progress(actor.snapshot()),
            Some(ActionProgress {
                value: ACTION_STAGES.len() as f64,
                max: ACTION_STAGES.len(),
            })
        );
    }

    #[test]
    fn keeps_the_txid_and_touched_outputs_it_learns_along_the_way() {
        let mut actor = start(vec!["AA_0"]);
        actor.send(ActionLifecycleEvent::Stage(ActionStage::Signing));
        actor.send(ActionLifecycleEvent::Txid("AB".repeat(32)));
        actor.send(ActionLifecycleEvent::Touch(vec![
            "bb.1".into(),
            "aa_0".into(),
        ]));
        assert_eq!(actor.context().txid.as_deref(), Some("ab".repeat(32).as_str()));
        assert_eq!(actor.context().outpoints, vec!["aa.0", "bb.1"]);
    }

    #[test]
    fn fails_from_any_live_stage_with_the_reason_kept() {
        let mut actor = start(vec![]);
        actor.send(ActionLifecycleEvent::Stage(ActionStage::Broadcasting));
        actor.send(ActionLifecycleEvent::Fail {
            reason: "Insufficient funds".into(),
        });
        assert_eq!(action_lifecycle_face(actor.snapshot()), "failed");
        assert_eq!(actor.context().error.as_deref(), Some("Insufficient funds"));
        assert_eq!(action_stage_index(actor.snapshot()), None);
        assert_eq!(action_progress(actor.snapshot()), None);
    }

    #[test]
    fn projects_live_stage_as_half_done_so_the_bar_moves_on_entry() {
        let mut actor = start(vec![]);
        assert_eq!(
            action_progress(actor.snapshot()),
            Some(ActionProgress { value: 0.5, max: 5 })
        );
        actor.send(ActionLifecycleEvent::Stage(ActionStage::Settling));
        assert_eq!(
            action_progress(actor.snapshot()),
            Some(ActionProgress { value: 4.5, max: 5 })
        );
    }

    #[test]
    fn is_a_flat_chart_every_face_is_a_css_token() {
        let mut actor = start(vec![]);
        actor.send(ActionLifecycleEvent::Stage(ActionStage::Signing));
        assert_eq!(actor.state_value(), StateValue::leaf("signing"));
        assert_eq!(actor.state_attr(), "signing");
    }
}
