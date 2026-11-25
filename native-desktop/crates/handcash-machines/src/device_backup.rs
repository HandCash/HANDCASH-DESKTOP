// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/deviceBackupMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DeviceBackupScanOrigin {
    #[default]
    List,
    Import,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceSubState {
    Choosing,
    SealPrompt,
    Sealing,
    Sealed,
    ImportPrompt,
    Importing,
}

impl DeviceSubState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Choosing => "choosing",
            Self::SealPrompt => "sealPrompt",
            Self::Sealing => "sealing",
            Self::Sealed => "sealed",
            Self::ImportPrompt => "importPrompt",
            Self::Importing => "importing",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoverySubState {
    Locked,
    Unsealing,
    Opened,
}

impl RecoverySubState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Locked => "locked",
            Self::Unsealing => "unsealing",
            Self::Opened => "opened",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceBackupState {
    Devices,
    Scanning,
    Device(DeviceSubState),
    Recovery(RecoverySubState),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceBackupContext {
    pub peer_device_id: Option<String>,
    pub show_my_code: bool,
    pub error: Option<String>,
    pub scan_origin: DeviceBackupScanOrigin,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeviceBackupEvent {
    Scan,
    ScanCancel,
    Scanned { peer_device_id: Option<String> },
    ToggleMyCode,
    OpenDevice { peer_device_id: String },
    ProtectLocal,
    ProtectPeer,
    Seal,
    SealOk,
    Import,
    ImportOk,
    OpenRecovery { peer_device_id: String },
    Unseal,
    UnsealOk,
    Fail { error: String },
    Back,
}

pub struct DeviceBackupMachine;

impl Statechart for DeviceBackupMachine {
    type State = DeviceBackupState;
    type Context = DeviceBackupContext;
    type Event = DeviceBackupEvent;
    type Input = ();

    const ID: &'static str = "deviceBackup";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(DeviceBackupState::Devices, DeviceBackupContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            DeviceBackupState::Devices => StateValue::leaf("devices"),
            DeviceBackupState::Scanning => StateValue::leaf("scanning"),
            DeviceBackupState::Device(sub) => {
                StateValue::compound("device", StateValue::leaf(sub.as_str()))
            }
            DeviceBackupState::Recovery(sub) => {
                StateValue::compound("recovery", StateValue::leaf(sub.as_str()))
            }
        }
    }
}

fn enter_devices(ctx: &mut DeviceBackupContext) -> DeviceBackupState {
    ctx.peer_device_id = None;
    ctx.error = None;
    ctx.scan_origin = DeviceBackupScanOrigin::List;
    DeviceBackupState::Devices
}

impl HandCashChart for DeviceBackupMachine {
    const MANIFEST_ID: &'static str = "deviceBackup";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["devices", "scanning", "device", "recovery"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let from_import_scan = ctx.scan_origin == DeviceBackupScanOrigin::Import
            && ctx.peer_device_id.as_deref().is_some_and(|s| !s.is_empty());

        let next = match (snapshot.value, event) {
            (DeviceBackupState::Devices, DeviceBackupEvent::Scan) => {
                ctx.scan_origin = DeviceBackupScanOrigin::List;
                ctx.error = None;
                DeviceBackupState::Scanning
            }
            (DeviceBackupState::Devices, DeviceBackupEvent::ToggleMyCode) => {
                ctx.show_my_code = !ctx.show_my_code;
                DeviceBackupState::Devices
            }
            (DeviceBackupState::Devices, DeviceBackupEvent::OpenDevice { peer_device_id }) => {
                ctx.peer_device_id = Some(peer_device_id);
                ctx.error = None;
                DeviceBackupState::Device(DeviceSubState::Choosing)
            }
            (DeviceBackupState::Devices, DeviceBackupEvent::OpenRecovery { peer_device_id }) => {
                ctx.peer_device_id = Some(peer_device_id);
                ctx.error = None;
                DeviceBackupState::Recovery(RecoverySubState::Locked)
            }
            (DeviceBackupState::Devices, DeviceBackupEvent::Fail { error }) => {
                ctx.error = Some(error);
                DeviceBackupState::Devices
            }
            (DeviceBackupState::Scanning, DeviceBackupEvent::Scanned { peer_device_id }) => {
                if let Some(id) = peer_device_id.filter(|s| !s.is_empty()) {
                    ctx.peer_device_id = Some(id);
                    ctx.error = None;
                    ctx.scan_origin = DeviceBackupScanOrigin::List;
                    DeviceBackupState::Device(DeviceSubState::Choosing)
                } else {
                    enter_devices(&mut ctx)
                }
            }
            (DeviceBackupState::Scanning, DeviceBackupEvent::ScanCancel) => {
                if from_import_scan {
                    DeviceBackupState::Device(DeviceSubState::ImportPrompt)
                } else {
                    enter_devices(&mut ctx)
                }
            }
            (DeviceBackupState::Scanning, DeviceBackupEvent::Fail { error }) => {
                if from_import_scan {
                    ctx.error = Some(error);
                    DeviceBackupState::Device(DeviceSubState::ImportPrompt)
                } else {
                    ctx.error = Some(error);
                    enter_devices(&mut ctx)
                }
            }
            (DeviceBackupState::Device(DeviceSubState::Choosing), DeviceBackupEvent::ProtectLocal) => {
                DeviceBackupState::Device(DeviceSubState::SealPrompt)
            }
            (DeviceBackupState::Device(DeviceSubState::Choosing), DeviceBackupEvent::ProtectPeer) => {
                DeviceBackupState::Device(DeviceSubState::ImportPrompt)
            }
            (DeviceBackupState::Device(DeviceSubState::SealPrompt), DeviceBackupEvent::Seal) => {
                DeviceBackupState::Device(DeviceSubState::Sealing)
            }
            (DeviceBackupState::Device(DeviceSubState::SealPrompt), DeviceBackupEvent::Back) => {
                ctx.error = None;
                DeviceBackupState::Device(DeviceSubState::Choosing)
            }
            (DeviceBackupState::Device(DeviceSubState::Sealing), DeviceBackupEvent::SealOk) => {
                DeviceBackupState::Device(DeviceSubState::Sealed)
            }
            (
                DeviceBackupState::Device(DeviceSubState::Sealing),
                DeviceBackupEvent::Fail { error },
            ) => {
                ctx.error = Some(error);
                DeviceBackupState::Device(DeviceSubState::SealPrompt)
            }
            (
                DeviceBackupState::Device(DeviceSubState::ImportPrompt),
                DeviceBackupEvent::Import,
            ) => DeviceBackupState::Device(DeviceSubState::Importing),
            (
                DeviceBackupState::Device(DeviceSubState::ImportPrompt),
                DeviceBackupEvent::Scan,
            ) => {
                ctx.scan_origin = DeviceBackupScanOrigin::Import;
                ctx.error = None;
                DeviceBackupState::Scanning
            }
            (
                DeviceBackupState::Device(DeviceSubState::ImportPrompt),
                DeviceBackupEvent::Back,
            ) => {
                ctx.error = None;
                DeviceBackupState::Device(DeviceSubState::Choosing)
            }
            (
                DeviceBackupState::Device(DeviceSubState::Importing),
                DeviceBackupEvent::ImportOk,
            ) => {
                ctx.error = None;
                DeviceBackupState::Device(DeviceSubState::Choosing)
            }
            (
                DeviceBackupState::Device(DeviceSubState::Importing),
                DeviceBackupEvent::Fail { error },
            ) => {
                ctx.error = Some(error);
                DeviceBackupState::Device(DeviceSubState::ImportPrompt)
            }
            (DeviceBackupState::Device(_), DeviceBackupEvent::Back) => enter_devices(&mut ctx),
            (DeviceBackupState::Recovery(RecoverySubState::Locked), DeviceBackupEvent::Unseal) => {
                DeviceBackupState::Recovery(RecoverySubState::Unsealing)
            }
            (
                DeviceBackupState::Recovery(RecoverySubState::Unsealing),
                DeviceBackupEvent::UnsealOk,
            ) => DeviceBackupState::Recovery(RecoverySubState::Opened),
            (
                DeviceBackupState::Recovery(RecoverySubState::Unsealing),
                DeviceBackupEvent::Fail { error },
            ) => {
                ctx.error = Some(error);
                DeviceBackupState::Recovery(RecoverySubState::Locked)
            }
            (DeviceBackupState::Recovery(_), DeviceBackupEvent::Back) => enter_devices(&mut ctx),
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn starts_on_the_device_list_with_this_devices_code_hidden() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        assert_eq!(*a.state(), DeviceBackupState::Devices);
        assert!(!a.context().show_my_code);
        a.send(DeviceBackupEvent::ToggleMyCode);
        assert!(a.context().show_my_code);
    }

    #[test]
    fn routes_a_scanned_recovery_copy_straight_to_that_device() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::Scan);
        assert_eq!(*a.state(), DeviceBackupState::Scanning);
        a.send(DeviceBackupEvent::Scanned {
            peer_device_id: Some("peer-1".to_string()),
        });
        assert_eq!(*a.state(), DeviceBackupState::Device(DeviceSubState::Choosing));
        assert_eq!(a.context().peer_device_id.as_deref(), Some("peer-1"));
    }

    #[test]
    fn returns_to_the_list_when_a_scan_yields_no_device() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::Scan);
        a.send(DeviceBackupEvent::Scanned {
            peer_device_id: None,
        });
        assert_eq!(*a.state(), DeviceBackupState::Devices);
    }

    #[test]
    fn seals_one_direction_and_shows_the_copy_to_hand_over() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::OpenDevice {
            peer_device_id: "peer-1".to_string(),
        });
        a.send(DeviceBackupEvent::ProtectLocal);
        assert_eq!(*a.state(), DeviceBackupState::Device(DeviceSubState::SealPrompt));
        a.send(DeviceBackupEvent::Seal);
        a.send(DeviceBackupEvent::SealOk);
        assert_eq!(*a.state(), DeviceBackupState::Device(DeviceSubState::Sealed));
    }

    #[test]
    fn keeps_a_failed_seal_on_its_own_prompt_with_the_reason() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::OpenDevice {
            peer_device_id: "peer-1".to_string(),
        });
        a.send(DeviceBackupEvent::ProtectLocal);
        a.send(DeviceBackupEvent::Seal);
        a.send(DeviceBackupEvent::Fail {
            error: "Incorrect password".to_string(),
        });
        assert_eq!(*a.state(), DeviceBackupState::Device(DeviceSubState::SealPrompt));
        assert_eq!(a.context().error.as_deref(), Some("Incorrect password"));
    }

    #[test]
    fn cannot_reach_the_import_prompt_from_the_seal_prompt_without_going_back() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::OpenDevice {
            peer_device_id: "peer-1".to_string(),
        });
        a.send(DeviceBackupEvent::ProtectLocal);
        a.send(DeviceBackupEvent::ProtectPeer);
        assert_eq!(*a.state(), DeviceBackupState::Device(DeviceSubState::SealPrompt));
        a.send(DeviceBackupEvent::Back);
        a.send(DeviceBackupEvent::ProtectPeer);
        assert_eq!(*a.state(), DeviceBackupState::Device(DeviceSubState::ImportPrompt));
    }

    #[test]
    fn clears_the_selected_device_when_returning_to_the_list() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::OpenDevice {
            peer_device_id: "peer-1".to_string(),
        });
        a.send(DeviceBackupEvent::Back);
        assert_eq!(*a.state(), DeviceBackupState::Devices);
        assert!(a.context().peer_device_id.is_none());
    }

    #[test]
    fn opens_a_stored_copy_only_through_the_unseal_step() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::OpenRecovery {
            peer_device_id: "peer-1".to_string(),
        });
        assert_eq!(*a.state(), DeviceBackupState::Recovery(RecoverySubState::Locked));
        a.send(DeviceBackupEvent::UnsealOk);
        assert_eq!(*a.state(), DeviceBackupState::Recovery(RecoverySubState::Locked));
        a.send(DeviceBackupEvent::Unseal);
        a.send(DeviceBackupEvent::UnsealOk);
        assert_eq!(*a.state(), DeviceBackupState::Recovery(RecoverySubState::Opened));
    }

    #[test]
    fn returns_a_cancelled_import_scan_to_the_store_theirs_step() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::OpenDevice {
            peer_device_id: "peer-1".to_string(),
        });
        a.send(DeviceBackupEvent::ProtectPeer);
        a.send(DeviceBackupEvent::Scan);
        assert_eq!(*a.state(), DeviceBackupState::Scanning);
        assert_eq!(a.context().scan_origin, DeviceBackupScanOrigin::Import);
        a.send(DeviceBackupEvent::ScanCancel);
        assert_eq!(*a.state(), DeviceBackupState::Device(DeviceSubState::ImportPrompt));
        assert_eq!(a.context().peer_device_id.as_deref(), Some("peer-1"));
    }

    #[test]
    fn returns_a_cancelled_list_scan_to_the_device_list() {
        let mut a = EffectActor::<DeviceBackupMachine>::default();
        a.send(DeviceBackupEvent::Scan);
        a.send(DeviceBackupEvent::ScanCancel);
        assert_eq!(*a.state(), DeviceBackupState::Devices);
    }
}
