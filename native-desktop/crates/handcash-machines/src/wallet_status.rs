// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/walletStatusMachine.ts` plus its value types
//! from `walletHealth.ts`, `cloudBackupHealth.ts`, and `walletProgress.ts`.

use crate::wallet_coordinator::CoordinatorRegionState;
use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WalletSession {
    Boot,
    Onboarding,
    Locked,
    #[default]
    Ready,
    Sending,
    Failure,
}

impl WalletSession {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Boot => "boot",
            Self::Onboarding => "onboarding",
            Self::Locked => "locked",
            Self::Ready => "ready",
            Self::Sending => "sending",
            Self::Failure => "failure",
        }
    }
}

pub const fn is_unlocked_session(session: WalletSession) -> bool {
    matches!(session, WalletSession::Ready | WalletSession::Sending)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncReason {
    Timeout,
    StillImporting,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SyncHealthPhase {
    #[default]
    Idle,
    Syncing,
    Ok,
    Error,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncHealth {
    pub phase: SyncHealthPhase,
    pub reason: Option<SyncReason>,
    pub message: Option<String>,
    pub held_one_sats: u32,
    pub pending_tips: u32,
    pub updated_at: u64,
    pub identity_key: Option<String>,
    pub account_index: Option<u32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CloudBackupPhase {
    #[default]
    Off,
    Checking,
    Pending,
    Ok,
    Delayed,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudBackupHealth {
    pub phase: CloudBackupPhase,
    pub label: String,
    pub message: Option<String>,
    pub checked_at: u64,
    pub local_action_count: Option<u64>,
    pub remote_action_count: Option<u64>,
}

impl Default for CloudBackupHealth {
    fn default() -> Self {
        Self {
            phase: CloudBackupPhase::Off,
            label: "Off".to_string(),
            message: None,
            checked_at: 0,
            local_action_count: None,
            remote_action_count: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupCatchup {
    Unknown,
    Behind,
    Current,
    RemoteNewer,
}

pub const fn backup_catchup_state(
    local_action_count: Option<u64>,
    remote_action_count: Option<u64>,
) -> BackupCatchup {
    match (local_action_count, remote_action_count) {
        (Some(local), Some(remote)) if remote < local => BackupCatchup::Behind,
        (Some(local), Some(remote)) if remote == local => BackupCatchup::Current,
        (Some(_), Some(_)) => BackupCatchup::RemoteNewer,
        _ => BackupCatchup::Unknown,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalletProgressKind {
    Refresh,
    PhraseImport,
    OneSatImport,
    ItemImport,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WalletProgressStatus {
    #[default]
    Idle,
    Running,
    Done,
    Failed,
    NeedsResume,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalletProgress {
    pub kind: Option<WalletProgressKind>,
    pub phase: Option<String>,
    pub current: Option<u64>,
    pub total: Option<u64>,
    pub failed: u64,
    pub skipped: u64,
    pub status: WalletProgressStatus,
    pub message: Option<String>,
    pub updated_at: u64,
    pub identity_key: Option<String>,
    pub account_index: Option<u32>,
}

pub const fn is_wallet_progress_busy(snapshot: &WalletProgress) -> bool {
    matches!(snapshot.status, WalletProgressStatus::Running)
}

pub fn wallet_progress_percent(snapshot: &WalletProgress) -> Option<u8> {
    let (Some(current), Some(total)) = (snapshot.current, snapshot.total) else {
        return None;
    };
    if total == 0 {
        return None;
    }
    let pct = ((current as f64 / total as f64) * 100.0).round() as i64;
    Some(pct.clamp(0, 100) as u8)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletCoordinatorLiveStatus {
    pub chain_ingest: CoordinatorRegionState,
    pub spend: CoordinatorRegionState,
    pub history_replica: CoordinatorRegionState,
    pub recompose: CoordinatorRegionState,
    pub spend_waiting: u32,
    pub summary: String,
}

impl Default for WalletCoordinatorLiveStatus {
    fn default() -> Self {
        Self {
            chain_ingest: CoordinatorRegionState::Idle,
            spend: CoordinatorRegionState::Idle,
            history_replica: CoordinatorRegionState::Idle,
            recompose: CoordinatorRegionState::Idle,
            spend_waiting: 0,
            summary: "idle".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletStatusInput {
    pub session: WalletSession,
    pub health: SyncHealth,
    pub cloud: CloudBackupHealth,
    pub network_online: bool,
    pub bridge_online: bool,
    pub progress: WalletProgress,
    pub coordinator: WalletCoordinatorLiveStatus,
}

impl Default for WalletStatusInput {
    fn default() -> Self {
        Self {
            session: WalletSession::Ready,
            health: SyncHealth::default(),
            cloud: CloudBackupHealth::default(),
            network_online: true,
            bridge_online: true,
            progress: WalletProgress::default(),
            coordinator: WalletCoordinatorLiveStatus::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletStatusContext {
    pub session: WalletSession,
    pub health: SyncHealth,
    pub cloud: CloudBackupHealth,
    pub network_online: bool,
    pub bridge_online: bool,
    pub progress: WalletProgress,
    pub coordinator: WalletCoordinatorLiveStatus,
    pub refreshing: bool,
}

impl From<WalletStatusInput> for WalletStatusContext {
    fn from(input: WalletStatusInput) -> Self {
        Self {
            session: input.session,
            health: input.health,
            cloud: input.cloud,
            network_online: input.network_online,
            bridge_online: input.bridge_online,
            progress: input.progress,
            coordinator: input.coordinator,
            refreshing: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalletStatusEvent {
    Session { session: WalletSession },
    SyncHealth { health: SyncHealth },
    BackupHealth { cloud: CloudBackupHealth },
    Network { online: bool },
    Bridge { online: bool },
    WalletProgress { progress: WalletProgress },
    Coordinator { coordinator: WalletCoordinatorLiveStatus },
    Refresh,
    RefreshDone,
}

/// Highest priority first; `wallet_status_for` is the single place that ranks them.
pub const WALLET_STATUS_STATES: [&str; 17] = [
    "opening",
    "failed",
    "offline",
    "refreshing",
    "catchingUp",
    "syncFailed",
    "backupFailed",
    "backupDelayed",
    "waitingToSend",
    "syncing",
    "locked",
    "setup",
    "bridgeOff",
    "itemArriving",
    "networkSlow",
    "synced",
    "ready",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalletStatusState {
    Opening,
    Failed,
    Offline,
    Refreshing,
    CatchingUp,
    SyncFailed,
    BackupFailed,
    BackupDelayed,
    WaitingToSend,
    Syncing,
    Locked,
    Setup,
    BridgeOff,
    ItemArriving,
    NetworkSlow,
    Synced,
    Ready,
}

impl WalletStatusState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Failed => "failed",
            Self::Offline => "offline",
            Self::Refreshing => "refreshing",
            Self::CatchingUp => "catchingUp",
            Self::SyncFailed => "syncFailed",
            Self::BackupFailed => "backupFailed",
            Self::BackupDelayed => "backupDelayed",
            Self::WaitingToSend => "waitingToSend",
            Self::Syncing => "syncing",
            Self::Locked => "locked",
            Self::Setup => "setup",
            Self::BridgeOff => "bridgeOff",
            Self::ItemArriving => "itemArriving",
            Self::NetworkSlow => "networkSlow",
            Self::Synced => "synced",
            Self::Ready => "ready",
        }
    }
}

fn chain_busy(c: &WalletStatusContext) -> bool {
    is_wallet_progress_busy(&c.progress)
        || c.coordinator.chain_ingest == CoordinatorRegionState::Active
        || c.coordinator.spend_waiting > 0
        || c.health.phase == SyncHealthPhase::Syncing
}

pub fn wallet_status_for(c: &WalletStatusContext) -> WalletStatusState {
    if c.session == WalletSession::Boot {
        return WalletStatusState::Opening;
    }
    if c.session == WalletSession::Failure {
        return WalletStatusState::Failed;
    }
    if !c.network_online {
        return WalletStatusState::Offline;
    }
    if c.refreshing && !chain_busy(c) {
        return WalletStatusState::Refreshing;
    }
    if is_wallet_progress_busy(&c.progress)
        || c.coordinator.recompose == CoordinatorRegionState::Active
    {
        return WalletStatusState::CatchingUp;
    }
    if c.health.phase == SyncHealthPhase::Error {
        return WalletStatusState::SyncFailed;
    }
    if c.cloud.phase == CloudBackupPhase::Error {
        return WalletStatusState::BackupFailed;
    }
    if c.cloud.phase == CloudBackupPhase::Delayed {
        return WalletStatusState::BackupDelayed;
    }
    if c.coordinator.spend_waiting > 0 {
        return WalletStatusState::WaitingToSend;
    }
    if c.coordinator.chain_ingest == CoordinatorRegionState::Active {
        return WalletStatusState::CatchingUp;
    }
    if c.health.phase == SyncHealthPhase::Syncing {
        return WalletStatusState::Syncing;
    }
    if c.session == WalletSession::Locked {
        return WalletStatusState::Locked;
    }
    if c.session == WalletSession::Onboarding {
        return WalletStatusState::Setup;
    }
    if !c.bridge_online {
        return WalletStatusState::BridgeOff;
    }
    if c.health.pending_tips > 0 {
        return WalletStatusState::ItemArriving;
    }
    if c.health.phase == SyncHealthPhase::Ok {
        if c.health.reason == Some(SyncReason::Timeout) {
            return WalletStatusState::NetworkSlow;
        }
        if c.health.reason == Some(SyncReason::StillImporting) {
            return WalletStatusState::CatchingUp;
        }
        return WalletStatusState::Synced;
    }
    if c.cloud.phase == CloudBackupPhase::Ok {
        WalletStatusState::Synced
    } else {
        WalletStatusState::Ready
    }
}

pub fn refresh_blocked(c: &WalletStatusContext) -> bool {
    c.refreshing || chain_busy(c) || c.coordinator.spend == CoordinatorRegionState::Active
}

pub fn can_refresh(c: &WalletStatusContext) -> bool {
    is_unlocked_session(c.session) && c.network_online && !refresh_blocked(c)
}

pub struct WalletStatusMachine;

impl Statechart for WalletStatusMachine {
    type State = WalletStatusState;
    type Context = WalletStatusContext;
    type Event = WalletStatusEvent;
    type Input = WalletStatusInput;

    const ID: &'static str = "walletStatus";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        let context = WalletStatusContext::from(input);
        let state = wallet_status_for(&context);
        Snapshot::new(state, context)
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

impl HandCashChart for WalletStatusMachine {
    const MANIFEST_ID: &'static str = "walletStatus";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "evaluate",
        "opening",
        "failed",
        "offline",
        "refreshing",
        "catchingUp",
        "syncFailed",
        "backupFailed",
        "backupDelayed",
        "waitingToSend",
        "syncing",
        "locked",
        "setup",
        "bridgeOff",
        "itemArriving",
        "networkSlow",
        "synced",
        "ready",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut context = snapshot.context.clone();
        match event {
            WalletStatusEvent::Session { session } => {
                context.session = session;
            }
            WalletStatusEvent::SyncHealth { health } => {
                context.health = health;
            }
            WalletStatusEvent::BackupHealth { cloud } => {
                context.cloud = cloud;
            }
            WalletStatusEvent::Network { online } => {
                context.network_online = online;
            }
            WalletStatusEvent::Bridge { online } => {
                context.bridge_online = online;
            }
            WalletStatusEvent::WalletProgress { progress } => {
                context.progress = progress;
            }
            WalletStatusEvent::Coordinator { coordinator } => {
                context.coordinator = coordinator;
            }
            WalletStatusEvent::Refresh => {
                if !can_refresh(&context) {
                    return (snapshot.clone(), Vec::new());
                }
                context.refreshing = true;
            }
            WalletStatusEvent::RefreshDone => {
                context.refreshing = false;
            }
        }
        let next_state = wallet_status_for(&context);
        (Snapshot::new(next_state, context), Vec::new())
    }

    fn can(snapshot: &Snapshot<Self::State, Self::Context>, event: &Self::Event) -> bool {
        match event {
            WalletStatusEvent::Refresh => can_refresh(&snapshot.context),
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn ok_health() -> SyncHealth {
        SyncHealth {
            phase: SyncHealthPhase::Ok,
            ..SyncHealth::default()
        }
    }

    fn start_with(f: impl FnOnce(&mut WalletStatusInput)) -> EffectActor<WalletStatusMachine> {
        let mut input = WalletStatusInput {
            session: WalletSession::Ready,
            health: ok_health(),
            cloud: CloudBackupHealth::default(),
            network_online: true,
            bridge_online: true,
            progress: WalletProgress::default(),
            coordinator: WalletCoordinatorLiveStatus::default(),
        };
        f(&mut input);
        EffectActor::new(input)
    }

    fn start() -> EffectActor<WalletStatusMachine> {
        start_with(|_| {})
    }

    #[test]
    fn declares_every_top_level_state_the_pill_can_show() {
        let mut expected = vec!["evaluate"];
        expected.extend_from_slice(&WALLET_STATUS_STATES);
        assert_eq!(WalletStatusMachine::TOP_LEVEL_STATES, expected.as_slice());
    }

    #[test]
    fn opens_on_the_ranked_state_for_its_input() {
        assert_eq!(*start().state(), WalletStatusState::Synced);
        assert_eq!(
            *start_with(|i| i.session = WalletSession::Boot).state(),
            WalletStatusState::Opening
        );
        assert_eq!(
            *start_with(|i| {
                i.session = WalletSession::Locked;
                i.health.phase = SyncHealthPhase::Idle;
            })
            .state(),
            WalletStatusState::Locked
        );
        assert_eq!(
            *start_with(|i| i.health.phase = SyncHealthPhase::Idle).state(),
            WalletStatusState::Ready
        );
    }

    #[test]
    fn keeps_history_restore_visible_even_when_chain_health_already_says_synced() {
        let mut actor = start();
        actor.send(WalletStatusEvent::Coordinator {
            coordinator: WalletCoordinatorLiveStatus {
                recompose: CoordinatorRegionState::Active,
                ..WalletCoordinatorLiveStatus::default()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::CatchingUp);
        actor.send(WalletStatusEvent::Coordinator {
            coordinator: WalletCoordinatorLiveStatus::default(),
        });
        assert_eq!(*actor.state(), WalletStatusState::Synced);
    }

    #[test]
    fn follows_each_store_event() {
        let mut actor = start();
        actor.send(WalletStatusEvent::SyncHealth {
            health: SyncHealth {
                phase: SyncHealthPhase::Syncing,
                ..ok_health()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::Syncing);
        actor.send(WalletStatusEvent::SyncHealth {
            health: SyncHealth {
                phase: SyncHealthPhase::Error,
                ..ok_health()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::SyncFailed);
        actor.send(WalletStatusEvent::SyncHealth {
            health: ok_health(),
        });
        actor.send(WalletStatusEvent::BackupHealth {
            cloud: CloudBackupHealth {
                phase: CloudBackupPhase::Error,
                ..CloudBackupHealth::default()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::BackupFailed);
        actor.send(WalletStatusEvent::BackupHealth {
            cloud: CloudBackupHealth {
                phase: CloudBackupPhase::Delayed,
                ..CloudBackupHealth::default()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::BackupDelayed);
        actor.send(WalletStatusEvent::BackupHealth {
            cloud: CloudBackupHealth::default(),
        });
        actor.send(WalletStatusEvent::Coordinator {
            coordinator: WalletCoordinatorLiveStatus {
                spend_waiting: 1,
                ..WalletCoordinatorLiveStatus::default()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::WaitingToSend);
        actor.send(WalletStatusEvent::Coordinator {
            coordinator: WalletCoordinatorLiveStatus {
                chain_ingest: CoordinatorRegionState::Active,
                ..WalletCoordinatorLiveStatus::default()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::CatchingUp);
        actor.send(WalletStatusEvent::Coordinator {
            coordinator: WalletCoordinatorLiveStatus::default(),
        });
        actor.send(WalletStatusEvent::WalletProgress {
            progress: WalletProgress {
                status: WalletProgressStatus::Running,
                ..WalletProgress::default()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::CatchingUp);
        actor.send(WalletStatusEvent::WalletProgress {
            progress: WalletProgress::default(),
        });
        actor.send(WalletStatusEvent::Bridge { online: false });
        assert_eq!(*actor.state(), WalletStatusState::BridgeOff);
        actor.send(WalletStatusEvent::Bridge { online: true });
        actor.send(WalletStatusEvent::Network { online: false });
        assert_eq!(*actor.state(), WalletStatusState::Offline);
        actor.send(WalletStatusEvent::Network { online: true });
        actor.send(WalletStatusEvent::Session {
            session: WalletSession::Failure,
        });
        assert_eq!(*actor.state(), WalletStatusState::Failed);
        actor.send(WalletStatusEvent::Session {
            session: WalletSession::Onboarding,
        });
        assert_eq!(*actor.state(), WalletStatusState::Setup);
        actor.send(WalletStatusEvent::Session {
            session: WalletSession::Ready,
        });
        assert_eq!(*actor.state(), WalletStatusState::Synced);
    }

    #[test]
    fn reads_the_sync_reason_not_the_message_text() {
        let mut actor = start();
        actor.send(WalletStatusEvent::SyncHealth {
            health: SyncHealth {
                reason: Some(SyncReason::Timeout),
                ..ok_health()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::NetworkSlow);
        actor.send(WalletStatusEvent::SyncHealth {
            health: SyncHealth {
                reason: Some(SyncReason::StillImporting),
                ..ok_health()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::CatchingUp);
        actor.send(WalletStatusEvent::SyncHealth {
            health: SyncHealth {
                message: Some("Refresh took too long — still importing".to_string()),
                ..ok_health()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::Synced);
    }

    #[test]
    fn shows_an_item_arriving_instead_of_synced_while_a_tip_is_unnamed() {
        let actor = start_with(|i| i.health.pending_tips = 2);
        assert_eq!(*actor.state(), WalletStatusState::ItemArriving);
    }

    #[test]
    fn runs_a_manual_refresh_as_its_own_state_until_it_settles() {
        let mut actor = start_with(|i| i.health.phase = SyncHealthPhase::Error);
        assert!(actor.can(&WalletStatusEvent::Refresh));
        actor.send(WalletStatusEvent::Refresh);
        assert_eq!(*actor.state(), WalletStatusState::Refreshing);
        assert!(!actor.can(&WalletStatusEvent::Refresh));

        actor.send(WalletStatusEvent::SyncHealth {
            health: SyncHealth {
                phase: SyncHealthPhase::Syncing,
                ..ok_health()
            },
        });
        assert_eq!(*actor.state(), WalletStatusState::Syncing);
        actor.send(WalletStatusEvent::SyncHealth {
            health: ok_health(),
        });
        assert_eq!(*actor.state(), WalletStatusState::Refreshing);

        actor.send(WalletStatusEvent::RefreshDone);
        assert_eq!(*actor.state(), WalletStatusState::Synced);
    }

    #[test]
    fn refuses_a_refresh_while_locked_offline_syncing_or_spending() {
        assert!(!start_with(|i| i.session = WalletSession::Locked).can(&WalletStatusEvent::Refresh));
        assert!(!start_with(|i| i.network_online = false).can(&WalletStatusEvent::Refresh));
        assert!(
            !start_with(|i| i.health.phase = SyncHealthPhase::Syncing)
                .can(&WalletStatusEvent::Refresh)
        );
        assert!(!start_with(|i| {
            i.coordinator.spend = CoordinatorRegionState::Active;
        })
        .can(&WalletStatusEvent::Refresh));

        let mut actor = start_with(|i| i.session = WalletSession::Locked);
        actor.send(WalletStatusEvent::Refresh);
        assert_eq!(*actor.state(), WalletStatusState::Locked);
    }
}
