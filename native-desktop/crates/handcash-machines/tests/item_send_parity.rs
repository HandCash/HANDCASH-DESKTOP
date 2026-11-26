// Copyright HandCash. Licensed under the Apache License, Version 2.0.
use handcash_machines::{EffectActor, HandCashChart, Statechart};
use handcash_machines::collectable_send::*;
use handcash_machines::collectable_send_run::*;
use handcash_machines::item_send::*;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/item-send/traces.json")).unwrap()
}
fn text(v: &Value, key: &str) -> String { v[key].as_str().unwrap().into() }
fn optional(v: &Value, key: &str) -> Option<String> { v[key].as_str().map(str::to_owned) }
fn number(v: &Value, key: &str) -> u32 { v[key].as_u64().unwrap().try_into().unwrap() }
fn path(v: &Value) -> SendPath {
    match v["path"].as_str().unwrap() {
        "p2pkhSend" => SendPath::P2pkhSend,
        "refuse" => SendPath::Refuse { reason: text(v, "reason") },
        other => panic!("unknown path {other}"),
    }
}
fn path_json(p: SendPath) -> Value {
    match p {
        SendPath::P2pkhSend => json!({"path":"p2pkhSend"}),
        SendPath::Refuse { reason } => json!({"path":"refuse","reason":reason}),
    }
}
fn settle(v: &Value) -> ItemSettlePath {
    match v["settle"].as_str().unwrap() {
        "peerDeliver" => ItemSettlePath::PeerDeliver { recipient_identity_key: text(v, "recipientIdentityKey") },
        "selfReceive" => ItemSettlePath::SelfReceive,
        "externalBroadcast" => ItemSettlePath::ExternalBroadcast { reason: ExternalBroadcastReason::NoPeerIdentity },
        other => panic!("unknown settle {other}"),
    }
}
fn settle_json(p: &Option<ItemSettlePath>) -> Value {
    match p {
        Some(ItemSettlePath::PeerDeliver { recipient_identity_key }) => json!({"settle":"peerDeliver","recipientIdentityKey":recipient_identity_key}),
        Some(ItemSettlePath::SelfReceive) => json!({"settle":"selfReceive"}),
        Some(ItemSettlePath::ExternalBroadcast { .. }) => json!({"settle":"externalBroadcast","reason":"no-peer-identity"}),
        None => Value::Null,
    }
}

fn replay<M: HandCashChart<Input = ()>>(
    traces: &Value, event: impl Fn(&Value) -> M::Event,
    snapshot: impl Fn(&EffectActor<M>) -> Value,
) {
    for (index, trace) in traces.as_array().unwrap().iter().enumerate() {
        let mut actor = EffectActor::<M>::default();
        assert_eq!(snapshot(&actor), trace["initial"], "initial trace {index}");
        for step in trace["steps"].as_array().unwrap() {
            actor.send(event(&step["event"]));
            assert_eq!(snapshot(&actor), json!({"state":step["state"],"context":step["context"]}),
                "trace {index} event {}", step["event"]);
        }
    }
}

#[test]
fn replay_parent_routes_and_late_outcomes() {
    replay::<CollectableSendMachine>(&fixture()["collectable"], |v| match v["type"].as_str().unwrap() {
        "START" => CollectableSendEvent::Start { outpoint: text(v,"outpoint"), send_path: path(&v["sendPath"]) },
        "SUCCESS" => CollectableSendEvent::Success { txid: text(v,"txid") },
        "FAIL" => CollectableSendEvent::Fail { error: text(v,"error") },
        "RESET" => CollectableSendEvent::Reset,
        other => panic!("unknown event {other}"),
    }, |a| {
        let c = a.context();
        json!({"state":a.state().as_str(),"context":{"outpoint":c.outpoint,
            "sendPath":c.send_path.clone().map(path_json),"txid":c.txid,"error":c.error}})
    });
}

#[test]
fn replay_split_halt_reset_and_ignored_events() {
    replay::<CollectableSendRunMachine>(&fixture()["runs"], |v| match v["type"].as_str().unwrap() {
        "START" => CollectableSendRunEvent::Start { legs: number(v,"legs") },
        "LEG_SENT" => CollectableSendRunEvent::LegSent { items: number(v,"items") },
        "LEG_REJECTED" => CollectableSendRunEvent::LegRejected { items: number(v,"items"), reason: text(v,"reason") },
        "RUN_FAULT" => CollectableSendRunEvent::RunFault { remaining_items: number(v,"remainingItems"), reason: text(v,"reason") },
        "RESET" => CollectableSendRunEvent::Reset,
        other => panic!("unknown event {other}"),
    }, |a| {
        let c = a.context();
        json!({"state":a.state().as_str(),"context":{"planned":c.planned,"queued":c.queued,
            "sentLegs":c.sent_legs,"sentItems":c.sent_items,"failedItems":c.failed_items,
            "stopped":c.stopped.map(|_| "fault"),"error":c.error}})
    });
}

#[test]
fn replay_signed_lifecycle_without_executing_side_effects() {
    replay::<ItemSendMachine>(&fixture()["items"], |v| match v["type"].as_str().unwrap() {
        "START" => ItemSendEvent::Start { outpoint: text(v,"outpoint"), settle_path: settle(&v["settlePath"]) },
        "RETRY_BROADCAST" => ItemSendEvent::RetryBroadcast { outpoint: text(v,"outpoint"), txid: text(v,"txid") },
        "BUILT" => ItemSendEvent::Built,
        "CREATED" => ItemSendEvent::Created { txid: optional(v,"txid") },
        "SIGNED" => ItemSendEvent::Signed { txid: text(v,"txid") },
        "BROADCASTED" => ItemSendEvent::Broadcasted,
        "SKIPPED" => ItemSendEvent::Skipped,
        "FAIL" => ItemSendEvent::Fail { error: text(v,"error") },
        "RESET" => ItemSendEvent::Reset,
        other => panic!("unknown event {other}"),
    }, |a| {
        let c = a.context();
        json!({"state":a.state().as_str(),"context":{"outpoint":c.outpoint,
            "settlePath":settle_json(&c.settle_path),"txid":c.txid,"error":c.error}})
    });
    for trace in fixture()["policies"].as_array().unwrap() {
        for p in trace.as_array().unwrap() {
            let state = match p["state"].as_str().unwrap() {
                "peerDeliver" => ItemSendState::PeerDeliver,
                "selfReceive" => ItemSendState::SelfReceive,
                "externalBroadcast" => ItemSendState::ExternalBroadcast,
                "confirmBroadcast" => ItemSendState::ConfirmBroadcast,
                _ => ItemSendState::Idle,
            };
            let mut snapshot = ItemSendMachine::initial(());
            snapshot.value = state;
            assert_eq!(json!(may_sender_broadcast(&snapshot)), p["mayBroadcast"]);
            assert_eq!(json!(is_silent_sender_broadcast(&snapshot)), p["silent"]);
            assert_eq!(json!(must_deliver_to_peer(&snapshot)), p["mustDeliver"]);
        }
    }
}

#[test]
fn replay_compose_path_and_advisory_readiness_precedence() {
    let f = fixture();
    for case in f["paths"].as_array().unwrap() {
        let i = &case["input"];
        assert_eq!(path_json(held_collectable_send_path(i["lockingScript"].as_str(),
            i["covenantLocked"].as_bool().unwrap(), i["proven"].as_bool().unwrap())), case["expected"]);
    }
    for case in f["choices"].as_array().unwrap() {
        let i = &case["input"];
        let kind = match i["tipKind"]["kind"].as_str().unwrap() {
            "p2pkh" => TipKind::P2pkh { locking_script: text(&i["tipKind"],"lockingScript") },
            "covenantLocked" => TipKind::CovenantLocked { locking_script: text(&i["tipKind"],"lockingScript") },
            _ => TipKind::Unknown,
        };
        let refusal = match i["sendReady"]["reason"].as_str() {
            Some("verifying") => Some(SendReadyRefusal::Verifying),
            Some("unproven") => Some(SendReadyRefusal::Unproven),
            _ => None,
        };
        let tier = if i["provenTier"] == "brc150" { ProvenTier::Brc150 } else { ProvenTier::Unproven };
        assert_eq!(path_json(choose_send_path(&kind, Some(tier), refusal)), case["expected"]);
    }
}
