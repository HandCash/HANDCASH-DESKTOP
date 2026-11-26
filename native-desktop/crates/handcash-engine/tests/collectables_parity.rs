// Copyright HandCash. Licensed under the Apache License, Version 2.0.
use handcash_engine::collectables::*;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Deserialize)]
struct Case {
    items: Vec<Item>,
    assets: Vec<CompactAsset>,
    grouped: Value,
    searches: Vec<Value>,
    suggestions: Vec<Value>,
    selections: Vec<Value>,
}

fn strings(v: &Value) -> Vec<String> {
    serde_json::from_value(v.clone()).unwrap()
}
fn set(v: &Value) -> BTreeSet<String> {
    strings(v).into_iter().collect()
}
fn sorted(v: BTreeSet<String>) -> Value {
    serde_json::to_value(v).unwrap()
}

#[test]
fn replay_ts_collectables_read_model() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../../fixtures/collectables/read-model.json"
    ))
    .unwrap();
    for c in cases {
        assert_eq!(
            serde_json::to_value(group(&c.items, &c.assets)).unwrap(),
            c.grouped
        );
        for search in c.searches {
            let actual: Vec<_> = c
                .items
                .iter()
                .filter(|i| matches(i, search["query"].as_str().unwrap()))
                .map(|i| &i.outpoint)
                .collect();
            assert_eq!(serde_json::to_value(actual).unwrap(), search["outpoints"]);
        }
        for s in c.suggestions {
            assert_eq!(
                serde_json::to_value(suggestions(
                    s["draft"].as_str().unwrap(),
                    &strings(&s["terms"]),
                    &c.items,
                    6
                ))
                .unwrap(),
                s["result"]
            );
        }
        for s in c.selections {
            let selected = set(&s["selected"]);
            let available = selectable(&c.items, &set(&s["busy"]));
            assert_eq!(sorted(reconcile(&selected, &c.items)), s["reconciled"]);
            assert_eq!(
                serde_json::to_value(available.iter().map(|i| &i.outpoint).collect::<Vec<_>>())
                    .unwrap(),
                s["selectable"]
            );
            assert_eq!(selection_state(&selected, &available), s["state"]);
            assert_eq!(sorted(toggle(&selected, &available, true)), s["on"]);
            assert_eq!(sorted(toggle(&selected, &available, false)), s["off"]);
        }
    }
}

#[test]
fn replay_ts_issuer_views() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../fixtures/collectables/issuer-views.json"
    ))
    .unwrap();
    for c in cases {
        let item: Item = serde_json::from_value(c["item"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(issuer_view(&item).unwrap()).unwrap(),
            c["expected"]
        );
    }
}

#[test]
fn unsigned_claim_cannot_borrow_a_verified_profile() {
    let key = format!("02{}", "11".repeat(32));
    let mut item = Item {
        issuer: key.clone(),
        attribution: Some(Attribution::Verified {
            identity_key: key.clone(),
            profile_id: "profile".into(),
            bap_id: None,
            label: "Trusted name".into(),
            image_url: Some("data:image/png;base64,AA==".into()),
            listed: true,
        }),
        ..Item::default()
    };
    let claim = issuer_view(&item).unwrap();
    assert_eq!(claim.rank, 5);
    assert!(claim.profile_id.is_none());
    assert!(claim.image_url.is_none());
    assert_eq!(claim.key, format!("issuer:claim:{key}"));
    item.issuer_attested = true;
    assert_eq!(issuer_view(&item).unwrap().rank, 0);
    item.bap_id = "unrelated".into();
    assert_eq!(issuer_view(&item).unwrap().rank, 3);
}
