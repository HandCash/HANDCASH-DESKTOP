// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Replay traces recorded from the executable XState charts, not a second oracle.
use handcash_machines::grant_expiry::*;
use handcash_machines::import_write_grant::*;
use handcash_machines::permission_decision::*;
use handcash_machines::EffectActor;
use serde_json::{json, Value};

#[test]
fn replay_ts_permission_traces() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/permissions/traces.json")).unwrap();
    for trace in fixture["decisions"].as_array().unwrap() {
        let mut a = EffectActor::<PermissionDecisionMachine>::default();
        for step in trace.as_array().unwrap() {
            a.send(match step["event"].as_str().unwrap() {
                "APPROVE" => PermissionDecisionEvent::Approve,
                "CANCEL" => PermissionDecisionEvent::Cancel,
                "RESET" => PermissionDecisionEvent::Reset,
                _ => unreachable!(),
            });
            assert_eq!(a.state().as_str(), step["state"]);
        }
    }
    for trace in fixture["grants"].as_array().unwrap() {
        let mut a = EffectActor::<GrantExpiryMachine>::new(GrantExpiryInput {
            expires_at: trace["input"]["expiresAt"].as_i64(),
            now: trace["input"]["now"].as_i64().unwrap(),
        });
        let check = |a: &EffectActor<GrantExpiryMachine>, expected: &Value| {
            assert_eq!(
                json!({ "state": a.state().as_str(),
                "context": { "expiresAt": a.context().expires_at, "now": a.context().now }, "done": a.is_done() }),
                *expected
            );
        };
        check(&a, &trace["initial"]);
        for step in trace["steps"].as_array().unwrap() {
            let e = &step["event"];
            a.send(match e["type"].as_str().unwrap() {
                "TICK" => GrantExpiryEvent::Tick {
                    now: e["now"].as_i64().unwrap(),
                },
                "SET_EXPIRY" => GrantExpiryEvent::SetExpiry {
                    expires_at: e["expiresAt"].as_i64(),
                    now: e["now"].as_i64().unwrap(),
                },
                "REVOKE" => GrantExpiryEvent::Revoke,
                _ => unreachable!(),
            });
            let mut expected = step.clone();
            expected.as_object_mut().unwrap().remove("event");
            check(&a, &expected);
        }
    }
    for trace in fixture["writes"].as_array().unwrap() {
        let mut a =
            EffectActor::<ImportWriteGrantMachine>::new(ImportWriteGrantInput { authorized: true });
        let mut persists = 0;
        for step in trace["steps"].as_array().unwrap() {
            let event = match step["event"].as_str().unwrap() {
                "revoke" => ImportWriteGrantEvent::Revoke,
                "reviewError" => ImportWriteGrantEvent::ReviewError,
                "reviewDone" => ImportWriteGrantEvent::ReviewDone {
                    decision: match step["decision"].as_str().unwrap() {
                        "allow" => ImportReviewDecision::Allow,
                        "deny" => ImportReviewDecision::Deny,
                        "timeout" => ImportReviewDecision::Timeout,
                        _ => unreachable!(),
                    },
                    authorized_now: Some(step["authorizedNow"].as_bool().unwrap()),
                },
                "persistDone" => ImportWriteGrantEvent::PersistDone {
                    receipt: "saved".into(),
                },
                "persistError" => ImportWriteGrantEvent::PersistError,
                _ => unreachable!(),
            };
            persists += a.send(event).len();
            let refusal = a.context().refusal.map(|r| match r {
                ImportWriteRefusal::Denied => "denied",
                ImportWriteRefusal::Timeout => "timeout",
                ImportWriteRefusal::Revoked => "revoked",
                ImportWriteRefusal::Unauthorized => "unauthorized",
                ImportWriteRefusal::Failed => "failed",
            });
            assert_eq!(
                a.state().as_str(),
                step["state"].as_str().unwrap(),
                "{}",
                trace["scenario"]
            );
            assert_eq!(json!(refusal), step["refusal"]);
            assert_eq!(json!(a.context().receipt), step["receipt"]);
            assert_eq!(json!(persists), step["persistCalls"]);
            assert_eq!(json!(a.is_done()), step["done"]);
        }
    }
}
