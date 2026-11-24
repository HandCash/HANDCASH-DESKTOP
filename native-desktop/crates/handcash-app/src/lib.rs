// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 100% Pure-Rust HandCash Desktop wallet built on Aeon UI + Dioxus Native.

pub mod brc100_native;
pub mod css_scope;
pub mod health;
pub mod icons;
pub mod machines;
pub mod parity;
pub mod state;
pub mod theme;
pub mod ui;

pub use state::{AppServices, SessionSummary, WalletSnapshot, APP_VERSION};
pub use ui::HandCashApp;

#[cfg(test)]
mod tests {
    use super::*;
    use dioxus::prelude::*;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("hc-native-app-{tag}-{nanos}"))
    }

    fn render_with_services(services: Arc<AppServices>) -> String {
        let mut dom = VirtualDom::new(HandCashApp);
        dom.provide_root_context(services);
        dom.rebuild_in_place();
        dioxus_ssr::render(&dom)
    }

    #[test]
    fn renders_onboarding_and_unlocked_dashboard_with_aeon_ui() {
        let dir = temp_dir("ssr");
        let svc = AppServices::open_in(dir.clone(), false).unwrap();

        let html_onboarding = render_with_services(Arc::clone(&svc));
        assert!(html_onboarding.contains("class=\"app-shell\""));
        assert!(html_onboarding.contains("data-aeon-scope=\"auth-shell\""));
        assert!(html_onboarding.contains("Create new wallet"));
        assert!(html_onboarding.contains("Sign in"));

        let (summary, phrase) = svc.create_vault("alice", "supersecret123", "main").unwrap();
        assert_eq!(summary.handle, "alice");
        assert!(phrase.is_some());

        let html_unlocked = render_with_services(Arc::clone(&svc));
        assert!(html_unlocked.contains("data-aeon-scope=\"dashboard\""));
        assert!(html_unlocked.contains("data-aeon-scope=\"wallet-hero\""));
        assert!(html_unlocked.contains("data-aeon-scope=\"fiat-currency\""));
        assert!(html_unlocked.contains("data-aeon-scope=\"wallet-account-menu\""));
        assert!(html_unlocked.contains("data-aeon-scope=\"wallet-nav\""));
        assert!(html_unlocked.contains("data-aeon-scope=\"dashboard-side\""));
        assert!(html_unlocked.contains("data-aeon-scope=\"what-is-bsv\""));
        assert!(html_unlocked.contains("Filters"));
        // TS `walletIdentityChip`: no claimed handle → short identity key, not the vault name.
        let ik = summary.identity_key.trim();
        let short_ik = format!("{}…{}", &ik[..8], &ik[ik.len() - 6..]);
        assert!(html_unlocked.contains(&short_ik));
        assert!(html_unlocked.contains("Copy pay address"));
        assert!(html_unlocked.contains("Your activity"));

        // Multi-account creation & switching
        let initial_accounts = svc.list_vault_accounts();
        assert_eq!(initial_accounts.len(), 1);
        let (created_row, switched_summary) = svc.create_vault_account().unwrap();
        assert_eq!(created_row.index, 1);
        assert_eq!(switched_summary.account_index, 1);
        assert_ne!(switched_summary.identity_key, summary.identity_key);
        assert_eq!(svc.list_vault_accounts().len(), 2);

        let back = svc.switch_vault_account(0).unwrap();
        assert_eq!(back.account_index, 0);
        assert_eq!(back.identity_key, summary.identity_key);

        // Fiat currency & FX formatting + collection view persistence
        svc.save_fiat_currency(machines::FiatCode::Eur);
        assert_eq!(svc.load_fiat_currency(), machines::FiatCode::Eur);
        let fx = state::FxRates::from_json_str(
            r#"{"perBsv":{"usd":50.0,"eur":45.0,"jpy":7500.0},"usdPerBsv":50.0,"fetchedAt":1700000000000}"#,
        )
        .unwrap();
        assert_eq!(
            fx.format_sats(100_000_000, machines::FiatCode::Usd)
                .as_deref(),
            Some("$50.00")
        );
        assert_eq!(
            fx.format_sats(100_000_000, machines::FiatCode::Eur)
                .as_deref(),
            Some("€45.00")
        );
        assert_eq!(
            fx.format_sats(100_000_000, machines::FiatCode::Jpy)
                .as_deref(),
            Some("¥7,500")
        );
        svc.save_collection_view(machines::CollectionView::List);
        assert_eq!(svc.load_collection_view(), machines::CollectionView::List);

        // Authenticity order: only complete BRC-150 proofs display as verified
        assert_eq!(ui::collectables::authenticity_display("brc150").1, "brc150");
        assert_eq!(
            ui::collectables::authenticity_display("indexer").1,
            "unproven"
        );
        assert_eq!(
            ui::collectables::authenticity_display("unproven").1,
            "unproven"
        );

        // Friends CRUD persisted to account-scoped durable store
        let pk = "02".to_string() + &"c".repeat(64);
        let added = svc.add_friend(&pk, Some("Bob")).unwrap();
        assert_eq!(added.label, "Bob");
        assert_eq!(svc.list_friends().len(), 1);
        let renamed = svc.update_friend_label(&added.id, "Robert").unwrap();
        assert_eq!(renamed.label, "Robert");
        svc.remove_friend(&added.id).unwrap();
        assert!(svc.list_friends().is_empty());

        svc.lock();
        let html_locked = render_with_services(Arc::clone(&svc));
        assert!(html_locked.contains("Welcome back"));
        assert!(html_locked.contains("HandCash password"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn classify_recipient_and_payment_filters_work() {
        use crate::machines::{
            classify_recipient, PaymentFilters, PaymentKindFilter, PaymentStatusFilter,
            PaymentTimeFilter, RecipientKind,
        };
        use handcash_storage::ActivityRow;

        assert!(matches!(
            classify_recipient("$alice"),
            Some(RecipientKind::Handle(h)) if h == "alice"
        ));
        let pk = "02".to_string() + &"a".repeat(64);
        assert!(matches!(
            classify_recipient(&pk),
            Some(RecipientKind::IdentityKey(_))
        ));
        assert!(matches!(
            classify_recipient(&format!("peerpay:{pk}")),
            Some(RecipientKind::PeerPay { .. })
        ));
        assert!(classify_recipient("not-a-valid-recipient").is_none());

        let now = state::now_ms();
        let row = ActivityRow {
            activity_id: "tx-1".into(),
            txid: Some("b".repeat(64)),
            kind: "payment".into(),
            direction: "out".into(),
            satoshis: -500,
            status: "completed".into(),
            title: "Sent BSV".into(),
            counterparty: Some("$bob".into()),
            app_origin: Some("wallet".into()),
            sort_ts_ms: now - 10_000,
        };
        let mut f = PaymentFilters::default();
        assert!(f.matches(&row, now));
        f.kind = PaymentKindFilter::Spent;
        f.status = PaymentStatusFilter::Success;
        f.time = PaymentTimeFilter::H24;
        assert!(f.matches(&row, now));
        assert_eq!(f.active_count(), 3);
        f.kind = PaymentKindFilter::Earned;
        assert!(!f.matches(&row, now));
    }

    #[test]
    fn brc100_direct_handler_enforces_lock_and_reserved_keys_and_signs() {
        let dir = temp_dir("brc100");
        let svc = AppServices::open_in(dir.clone(), false).unwrap();
        let headers = HashMap::new();

        // Locked state
        let locked =
            brc100_native::handle_brc100_request(&svc, "POST", "/isAuthenticated", &headers, "{}");
        assert_eq!(locked.status, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&locked.body).unwrap()["authenticated"],
            false
        );

        let denied =
            brc100_native::handle_brc100_request(&svc, "POST", "/getNetwork", &headers, "{}");
        assert_eq!(denied.status, 401);

        // Unlock via create
        let (summary, _) = svc
            .create_vault("bob_test", "password1234", "main")
            .unwrap();

        let authed =
            brc100_native::handle_brc100_request(&svc, "POST", "/isAuthenticated", &headers, "{}");
        assert_eq!(
            serde_json::from_str::<Value>(&authed.body).unwrap()["authenticated"],
            true
        );

        let id_key = brc100_native::handle_brc100_request(
            &svc,
            "POST",
            "/getPublicKey",
            &headers,
            &json!({ "identityKey": true }).to_string(),
        );
        assert_eq!(id_key.status, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&id_key.body).unwrap()["publicKey"],
            summary.identity_key
        );

        // Reserved key protocol must be refused (403)
        let reserved = brc100_native::handle_brc100_request(
            &svc,
            "POST",
            "/getPublicKey",
            &headers,
            &json!({ "protocolID": [2, "account"], "keyID": "account-1" }).to_string(),
        );
        assert_eq!(reserved.status, 403);

        // Sign + verify round-trip
        let sign_res = brc100_native::handle_brc100_request(
            &svc,
            "POST",
            "/createSignature",
            &headers,
            &json!({
                "protocolID": [1, "handcash demo"],
                "keyID": "k1",
                "counterparty": "self",
                "data": [1, 2, 3, 4],
            })
            .to_string(),
        );
        assert_eq!(sign_res.status, 200);
        let sig = serde_json::from_str::<Value>(&sign_res.body).unwrap()["signature"].clone();

        let verify_res = brc100_native::handle_brc100_request(
            &svc,
            "POST",
            "/verifySignature",
            &headers,
            &json!({
                "protocolID": [1, "handcash demo"],
                "keyID": "k1",
                "counterparty": "self",
                "forSelf": true,
                "data": [1, 2, 3, 4],
                "signature": sig,
            })
            .to_string(),
        );
        assert_eq!(verify_res.status, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&verify_res.body).unwrap()["valid"],
            true
        );

        svc.lock();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
