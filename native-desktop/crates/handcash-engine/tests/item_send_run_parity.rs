// Copyright HandCash. Licensed under the Apache License, Version 2.0.
use handcash_engine::collectable_send_run::*;
use serde_json::{json, Value};

#[test]
fn replay_atomic_selection_and_fail_closed_retry_policy() {
    let fixture: Value = serde_json::from_str(include_str!("../../../fixtures/item-send/traces.json")).unwrap();
    for case in fixture["plans"].as_array().unwrap() {
        let input: Vec<String> = serde_json::from_value(case["input"].clone()).unwrap();
        assert_eq!(json!(plan(&input)), case["expected"]);
        assert_eq!(json!(split_leg(&input)), case["split"]);
        assert_eq!(json!(failed_attempt_activity(input.len())), case["activity"]);
    }
    for case in fixture["failures"].as_array().unwrap() {
        assert_eq!(json!(classify_failure(case["input"].as_str().unwrap())), case["expected"]);
    }
}
