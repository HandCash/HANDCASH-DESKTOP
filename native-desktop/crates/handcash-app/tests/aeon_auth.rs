#![cfg(feature = "aeon")]

use aeon_native::{AeonNativeSession, NodeId};
use dioxus::{html::input_data::MouseButton, prelude::VirtualDom};
use handcash_app::{AppServices, HandCashApp};

fn find_class(session: &AeonNativeSession, class: &str) -> NodeId {
    session.tree.nodes.iter().flatten().find(|n| {
        n.attr("class").is_some_and(|c| c.split_whitespace().any(|c| c == class))
    }).unwrap_or_else(|| panic!("missing class {class}")).id
}

fn find_part(session: &AeonNativeSession, part: &str) -> NodeId {
    session.tree.nodes.iter().flatten().find(|n| n.attr("data-aeon-part") == Some(part))
        .unwrap_or_else(|| panic!("missing part {part}")).id
}

fn click(session: &mut AeonNativeSession, id: NodeId, height: f32) {
    for _ in 0..16 {
        let rect = session.layout.get(id).expect("control layout").abs_rect;
        let (x, y) = (rect.x + rect.width / 2., rect.y + rect.height / 2.);
        if rect.y >= 0. && rect.y + rect.height <= height + 1.
            && session.hit_test(x, y).is_some_and(|hit| session.tree.ancestors(hit).contains(&id)) { break; }
        let scroller = session.tree.ancestors(id).into_iter().find(|&ancestor| {
            session.tree.get(ancestor).is_some_and(|n| n.scroll.max_scroll_y() > 0.)
        }).expect("offscreen control needs a scroller");
        let bounds = session.layout.get(scroller).unwrap().abs_rect;
        let scroll_y = (bounds.y.max(0.) + (bounds.y + bounds.height).min(height)) / 2.;
        let dy = if y < scroll_y { 80. } else { -80. };
        assert!(session.dispatch_wheel(bounds.x + bounds.width / 2., scroll_y, 0., dy),
            "offscreen control must be reachable by scrolling");
    }
    let rect = session.layout.get(id).expect("control layout").abs_rect;
    assert!(rect.width > 0. && rect.height > 0., "control must have size: {rect:?}");
    assert!(rect.y >= 0. && rect.y + rect.height <= height + 1.,
        "control must be reachable without clipping: {rect:?}");
    let (x, y) = (rect.x + rect.width / 2., rect.y + rect.height / 2.);
    session.dispatch_pointer_move(x, y);
    let hit = session.hit_test(x, y).expect("control hit");
    assert!(session.tree.ancestors(hit).contains(&id), "control is covered or clipped: target={:?} rect={rect:?} hit={:?}", session.tree.get(id).and_then(|n| n.attr("class")), session.tree.get(hit).and_then(|n| n.attr("class")));

    session.dispatch_pointer_down(x, y, MouseButton::Primary);
    assert!(session.dispatch_pointer_up(x, y, MouseButton::Primary), "click delivered");
}

fn action_in(session: &AeonNativeSession, part: &str) -> NodeId {
    let parent = find_part(session, part);
    session.tree.nodes.iter().flatten().find(|n| {
        n.tag() == Some("button") && session.tree.ancestors(n.id).contains(&parent)
    }).expect("action button").id
}

fn button_named(session: &AeonNativeSession, label: &str) -> NodeId {
    session.tree.nodes.iter().flatten().find(|n| {
        n.tag() == Some("button") && session.tree.nodes.iter().flatten().any(|text| {
            text.text() == Some(label) && session.tree.ancestors(text.id).contains(&n.id)
        })
    }).unwrap_or_else(|| panic!("missing action {label}")).id
}

fn assert_step(session: &AeonNativeSession, state: &str) {
    assert!(session.tree.nodes.iter().flatten().any(|n| {
        n.attr("data-aeon-scope") == Some("auth") && n.attr("data-aeon-state") == Some(state)
    }), "expected onboarding step {state}, got {:?}", session.tree.nodes.iter().flatten().filter(|n| n.attr("data-aeon-scope") == Some("auth")).filter_map(|n| n.attr("data-aeon-state")).collect::<Vec<_>>());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_create_onboarding_is_reachable() {
    tokio::task::block_in_place(|| {
    for (width, height) in [(984., 652.), (640., 652.)] {
        // Fresh disposable, unfunded wallet. Never touch the installed profile or clipboard.
        let dir = std::env::temp_dir().join(format!(
            "handcash-alpha-complete-auth-{}-{}-{width}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let services = AppServices::open_in(dir.clone(), false).unwrap();
        let dom = VirtualDom::new(HandCashApp);
        dom.provide_root_context(services.clone());
        let mut session = AeonNativeSession::from_virtual_dom(dom, width, height);
        let create = find_part(&session, "create");
        click(&mut session, create, height);
        let submit = find_class(&session, "auth-submit");
        click(&mut session, submit, height);
        assert_step(&session, "keys-backup");
        let words = session.tree.nodes.iter().flatten().filter(|n| {
            n.attr("class") == Some("recovery-phrase-word")
        }).count();
        assert!(matches!(words, 12 | 24), "phrase must be present, never log its contents");
        // Every recovery word needs a usable box, not just an existing DOM node.
        let word_ids: Vec<_> = session.tree.nodes.iter().flatten().filter(|n| {
            n.attr("class") == Some("recovery-phrase-word")
        }).map(|n| n.id).collect();
        for id in word_ids {
            let rect = session.layout.get(id).expect("word layout").abs_rect;
            assert!(rect.width > 0. && rect.height > 0. && rect.x >= 0.
                && rect.x + rect.width <= width + 1., "recovery word must fit");
        }
        let slices = session.tree.nodes.iter().flatten().find(|n| {
            n.attr("role") == Some("tab") && n.attr("aria-selected") == Some("false")
        }).expect("key slice tab").id;
        click(&mut session, slices, height);
        let slice = find_class(&session, "key-slice-trigger");
        // First slice is expanded by default; exercise closing and reopening it.
        click(&mut session, slice, height);
        click(&mut session, slice, height);
        assert!(session.tree.nodes.iter().flatten().any(|n| {
            n.attr("class").is_some_and(|c| c.split_whitespace().any(|c| c == "split-backup-share"))
        }), "key slice must open; expanded={:?}", session.tree.nodes.iter().flatten().filter(|n| n.attr("class") == Some("key-slice-trigger")).map(|n| n.attr("aria-expanded")).collect::<Vec<_>>());
        if width > 800. {
            let saved = button_named(&session, "I saved this slice");
            click(&mut session, saved, height);
            let next = session.tree.nodes.iter().flatten().find(|n| {
                n.attr("class") == Some("key-slice-trigger") && n.attr("aria-expanded") == Some("false")
            }).unwrap().id;
            click(&mut session, next, height);
            let saved = button_named(&session, "I saved this slice");
            click(&mut session, saved, height);
            let confirm = button_named(&session, "I’ve saved it — continue");
            click(&mut session, confirm, height);
            assert!(services.is_keys_backup_confirmed(), "backup confirmation persists");
        } else {
            let later = find_part(&session, "backup-later");
            click(&mut session, later, height);
        }
        assert_step(&session, "accept");
        let accept = action_in(&session, "onboard-accept-actions");
        click(&mut session, accept, height);
        assert_step(&session, "fiat");
        let fiat = action_in(&session, "onboard-fiat-actions");
        click(&mut session, fiat, height);
        assert_step(&session, "protect");
        // Use a real supported password factor, without relying on the host keyring.
        let radio = session.tree.nodes.iter().flatten().find(|n| {
            n.attr("name") == Some("onboard-lock") && n.attr("value") == Some("password")
        }).expect("password option").id;
        let label = session.tree.ancestors(radio).into_iter().find(|&id| {
            session.tree.get(id).is_some_and(|n| n.tag() == Some("label"))
        }).unwrap();
        click(&mut session, label, height);
        let password = session.tree.nodes.iter().flatten().find(|n| {
            n.attr("id") == Some("onboard-lock-password")
        }).expect("password field").id;
        let confirm = session.tree.nodes.iter().flatten().find(|n| {
            n.attr("id") == Some("onboard-lock-password-confirm")
        }).expect("confirmation field").id;
        for id in [password, confirm] {
            session.tree.set_focus(Some(id));
            session.dispatch_key_down(
                dioxus::html::Key::Character("OnboardTest123!".into()),
                dioxus::html::Code::Unidentified,
                Some("OnboardTest123!"), false,
            );
        }
        let finish = action_in(&session, "onboard-protect-actions");
        click(&mut session, finish, height);
        assert!(services.has_memorable_password(), "protection must persist");
        assert!(!session.tree.nodes.iter().flatten().any(|n| {
            n.attr("data-aeon-scope") == Some("onboard-protect")
        }), "must leave onboarding");
        drop(session);
        services.lock();
        services.unlock_with_password("OnboardTest123!").expect("password survives onboarding");
        assert!(services.current_session_summary().is_some());
        // Restore each supported recovery format into a separate unfunded profile.
        // Values stay in memory and are never printed or included in assertions.
        let phrase = services.current_mnemonic().expect("test recovery material");
        let slices = services.load_or_issue_brc140_set().expect("test slices").shares.join("\n");
        let root = services.current_root_key_hex().expect("test recovery key");
        for (tab, field, material) in [(0, "mnemonic", phrase), (1, "shares", slices), (2, "root-key", root.clone())] {
            let recovered = AppServices::open_in(dir.join(format!("restore-{tab}")), false).unwrap();
            let dom = VirtualDom::new(HandCashApp);
            dom.provide_root_context(recovered.clone());
            let mut restored = AeonNativeSession::from_virtual_dom(dom, width, height);
            let signin = find_part(&restored, "sign-in");
            click(&mut restored, signin, height);
            assert!(!restored.tree.nodes.iter().flatten().any(|n| n.attr("aria-busy") == Some("true")),
                "scan-to-sign-in must render QR immediately without a permanent spinner");
            let qr_id = find_class(&restored, "scan-login-qr");
            let qr_rect = restored.layout.get(qr_id).expect("scan-login-qr layout").abs_rect;
            assert!(qr_rect.width >= 180. && qr_rect.height >= 180.,
                "scan-login-qr must have visible QR box: {qr_rect:?}");
            let other = button_named(&restored, "Other ways");
            click(&mut restored, other, height);
            let tab_id = button_named(&restored, ["Phrase", "Shares", "Key"][tab]);
            click(&mut restored, tab_id, height);
            let input = restored.tree.nodes.iter().flatten().find(|n| n.attr("id") == Some(field)).unwrap().id;
            restored.tree.set_focus(Some(input));
            restored.dispatch_key_down(dioxus::html::Key::Character(material.clone()),
                dioxus::html::Code::Unidentified, Some(&material), false);
            let submit = find_class(&restored, "auth-submit");
            click(&mut restored, submit, height);
            assert_step(&restored, "history-recovery");
            assert!(recovered.current_root_key_hex().as_deref() == Some(root.as_str()),
                "recovery must preserve wallet identity");
            let skip = button_named(&restored, "Continue without history");
            click(&mut restored, skip, height);
            assert_step(&restored, "protect");
        }
        // Deliberately retain only disposable test directories for failure inspection.
    }
    });
}

#[tokio::test]
async fn onboarding_layout_and_actions() {
    for width in [984., 640.] {
        for (part, target) in [("sign-in", "device-signin"), ("create", "auth-form")] {
            // Empty isolated services: navigation only, no vault creation or signing.
            let dir = std::env::temp_dir().join(format!(
                "handcash-alpha-auth-test-{}-{width}-{part}", std::process::id()
            ));
            let services = AppServices::open_in(dir, false).unwrap();
            let dom = VirtualDom::new(HandCashApp);
            dom.provide_root_context(services);
            let mut session = AeonNativeSession::from_virtual_dom(dom, width, 652.);
            let id = session.tree.nodes.iter().flatten()
                .find(|n| n.attr("data-aeon-part") == Some(part)).expect("entry action").id;
            let rect = session.layout.get(id).expect("action layout").abs_rect;
            assert!(rect.width > 100. && rect.height > 20., "usable {part}: {rect:?}");
            assert!((rect.x + rect.width / 2. - width / 2.).abs() < 2.,
                "centered {part} at {width}: {rect:?}");
            let label_id = session.tree.nodes.iter().flatten().find(|n| {
                n.attr("data-aeon-part") == Some("label")
                    && session.tree.ancestors(n.id).contains(&id)
            }).expect("button label").id;
            let label_rect = session.layout.get(label_id).expect("label layout").abs_rect;
            assert!(
                ((label_rect.x + label_rect.width / 2.) - (rect.x + rect.width / 2.)).abs() < 2.,
                "centered label inside {part} at {width}: btn={rect:?} label={label_rect:?}"
            );
            let (x, y) = (rect.x + rect.width / 2., rect.y + rect.height / 2.);
            session.dispatch_pointer_move(x, y);
            let hit = session.hit_test(x, y).expect("hovered action hit");
            assert!(session.tree.ancestors(hit).contains(&id), "hover must retain action target");
            session.dispatch_pointer_down(x, y, MouseButton::Primary);
            assert!(session.dispatch_pointer_up(x, y, MouseButton::Primary), "click delivered");
            let states: Vec<_> = session.tree.nodes.iter().flatten()
                .filter_map(|n| n.attr("data-aeon-state")).collect();
            let has_target = session.tree.nodes.iter().flatten().any(|n| {
                n.attr("data-aeon-scope") == Some(target)
                    || n.attr("class").is_some_and(|c| c.split_whitespace().any(|c| c == target))
            });
            assert!(has_target, "{part} must open {target}: {states:?}");
            assert!(!states.contains(&"onboard-entry"), "{part} must leave entry state");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn scan_login_completes_ui_transition_after_phone_handshake() {
    use base64::Engine as _;
    use handcash_app::scan_login::{
        handle_scan_login_request, pairing_confirm_proof, scan_login_proof, sha256_hex,
        ScanLoginPayload, ScanLoginPhase,
    };
    use handcash_primitives::keys::{brc78_encrypt, SecretKeyBytes};

    let dir = std::env::temp_dir().join(format!(
        "handcash-alpha-scan-login-ui-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let services = AppServices::open_in(dir, false).unwrap();
    let dom = VirtualDom::new(HandCashApp);
    dom.provide_root_context(services.clone());
    let mut session = AeonNativeSession::from_virtual_dom(dom, 984., 652.);

    let signin = find_part(&session, "sign-in");
    click(&mut session, signin, 652.);
    let qr_text = match services.scan_login.current_phase() {
        ScanLoginPhase::Scan { qr_text, .. } => qr_text,
        other => panic!("expected Scan phase after clicking Sign in, got {other:?}"),
    };
    let payload: ScanLoginPayload = serde_json::from_str(&qr_text).expect("valid scan payload");

    let approver_key = SecretKeyBytes::random();
    let approver_ik = approver_key.public_key_hex().unwrap().to_ascii_lowercase();
    let hello_proof = scan_login_proof(&payload.secret, "hello", &approver_ik).unwrap();
    let r_hello = handle_scan_login_request(
        &services,
        "POST",
        "/handcash-device/v1/scan-login/hello",
        &serde_json::json!({
            "approverKey": approver_ik,
            "label": "Phone",
            "proof": hello_proof,
        })
        .to_string(),
    );
    assert_eq!(r_hello.status, 200);
    let shown_code = match services.scan_login.current_phase() {
        ScanLoginPhase::ScanComparing { code, .. } => code,
        other => panic!("expected ScanComparing, got {other:?}"),
    };

    let nonce = "00112233445566778899aabbccddeeff";
    let confirm_proof =
        pairing_confirm_proof(&payload.secret, &approver_ik, nonce, &shown_code).unwrap();
    let r_confirm = handle_scan_login_request(
        &services,
        "POST",
        "/handcash-device/v1/scan-login/confirm",
        &serde_json::json!({
            "approverKey": approver_ik,
            "nonce": nonce,
            "proof": confirm_proof,
        })
        .to_string(),
    );
    assert_eq!(r_confirm.status, 200);

    let master_key = SecretKeyBytes::random();
    let transfer_json = serde_json::json!({
        "v": 1,
        "kind": "handcash-brc250-vault",
        "master": { "derivation": "brc-157", "keyHex": master_key.to_hex().as_str(), "entropyLength": 32 },
        "enrollment": null,
        "accounts": null,
        "sentAt": 1_700_000_000_000i64,
    })
    .to_string();
    let ct = brc78_encrypt(transfer_json.as_bytes(), &approver_key, &payload.login_key).unwrap();
    let sealed_b64 = base64::engine::general_purpose::STANDARD.encode(ct);
    let vault_proof = scan_login_proof(&payload.secret, "vault", &sha256_hex(&sealed_b64)).unwrap();
    let r_vault = handle_scan_login_request(
        &services,
        "POST",
        "/handcash-device/v1/scan-login/vault",
        &serde_json::json!({
            "approverKey": approver_ik,
            "sealedVault": sealed_b64,
            "proof": vault_proof,
        })
        .to_string(),
    );
    assert_eq!(r_vault.status, 200, "vault reply: {}", r_vault.body);
    assert!(services.current_session_summary().is_some(), "vault must be installed");

    for _ in 0..20 {
        session.sync();
        if session.tree.nodes.iter().flatten().any(|n| {
            n.attr("data-aeon-scope") == Some("auth") && n.attr("data-aeon-state") == Some("protect")
        }) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    }
    assert_step(&session, "protect");
}
