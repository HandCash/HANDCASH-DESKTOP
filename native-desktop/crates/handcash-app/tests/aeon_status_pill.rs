#![cfg(feature = "aeon")]

use aeon_native::{AeonNativeSession, NodeId};
use aeon_ui::{AeonTheme, AeonThemeProvider};
use dioxus::{html::input_data::MouseButton, prelude::*};
use handcash_app::css_scope::{PLATFORM, ROOT_CLASSES, SCOPED_SHEETS};
use handcash_app::machines::resolve_wallet_status;
use handcash_app::theme::{build_theme_override_css, ResolvedTheme};
use handcash_app::ui::primitives::TextOverflowCarousel;
use handcash_app::{AppServices, HandCashApp};
use handcash_machines::wallet_status::WalletStatusState;

fn find_class(session: &AeonNativeSession, class: &str) -> NodeId {
    session
        .tree
        .nodes
        .iter()
        .flatten()
        .find(|n| {
            n.attr("class")
                .is_some_and(|c| c.split_whitespace().any(|c| c == class))
        })
        .unwrap_or_else(|| panic!("missing class {class}"))
        .id
}

fn find_text_in(session: &AeonNativeSession, ancestor: NodeId, expected: &str) -> NodeId {
    session
        .tree
        .nodes
        .iter()
        .flatten()
        .find(|n| n.text() == Some(expected) && session.tree.ancestors(n.id).contains(&ancestor))
        .unwrap_or_else(|| panic!("missing text '{expected}' inside {ancestor:?}"))
        .id
}

#[component]
fn StatusPillHarness(state: WalletStatusState) -> Element {
    let view = resolve_wallet_status(state);
    let theme_css = build_theme_override_css(&ResolvedTheme::dark_handcash());
    let scoped: &str = &SCOPED_SHEETS;
    rsx! {
        AeonThemeProvider {
            theme: AeonTheme::Handcash,
            mode: aeon_ui::AeonMode::Dark,
            style { "{scoped}" }
            style { "{theme_css}" }
            div {
                class: ROOT_CLASSES,
                "data-hc": "",
                "data-aeon-mode": "dark",
                "data-aeon-platform": PLATFORM,
                div { class: "app-shell", "data-aeon-scope": "app", "data-aeon-state": "ready",
                    header { class: "titlebar aeon-titlebar",
                        div { class: "titlebar-end",
                            button {
                                r#type: "button",
                                class: "status-pill status-pill-btn",
                                "data-aeon-state": view.state_attr,
                                "data-tone": view.tone.as_str(),
                                span { class: "status-dot", "data-tone": view.tone.as_str() }
                                span { class: "status-pill-sizer", aria_hidden: true, "Synced" }
                                TextOverflowCarousel {
                                    label: view.label.to_string(),
                                    class: "status-pill-label".to_string(),
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn synced_and_syncing_labels_are_visible_with_fixed_pill_width() {
    for width in [984., 640.] {
        let synced = AeonNativeSession::from_virtual_dom(
            VirtualDom::new_with_props(
                StatusPillHarness,
                StatusPillHarnessProps {
                    state: WalletStatusState::Synced,
                },
            ),
            width,
            652.,
        );
        let synced_pill = synced.layout.get(find_class(&synced, "status-pill")).unwrap().abs_rect;
        let synced_label_id = find_class(&synced, "status-pill-label");
        let synced_label = synced.layout.get(synced_label_id).unwrap().abs_rect;
        let synced_text = synced
            .layout
            .get(find_text_in(&synced, synced_label_id, "Synced"))
            .unwrap()
            .abs_rect;

        assert!(
            synced_label.width >= 45.0 && synced_label.height >= 10.0,
            "Synced label collapsed at {width}: pill={synced_pill:?} label={synced_label:?}"
        );
        assert!(
            synced_text.width >= 45.0 && synced_text.width <= synced_label.width + 2.0,
            "Synced text must fit inside pill slot at {width}: label={synced_label:?} text={synced_text:?}"
        );

        let syncing = AeonNativeSession::from_virtual_dom(
            VirtualDom::new_with_props(
                StatusPillHarness,
                StatusPillHarnessProps {
                    state: WalletStatusState::Refreshing,
                },
            ),
            width,
            652.,
        );
        let syncing_pill = syncing.layout.get(find_class(&syncing, "status-pill")).unwrap().abs_rect;
        let syncing_label_id = find_class(&syncing, "status-pill-label");
        let syncing_label = syncing.layout.get(syncing_label_id).unwrap().abs_rect;
        let syncing_text = syncing
            .layout
            .get(find_text_in(&syncing, syncing_label_id, "Syncing"))
            .unwrap()
            .abs_rect;

        assert!(
            syncing_label.width >= 45.0 && syncing_label.height >= 10.0,
            "Syncing label collapsed at {width}: pill={syncing_pill:?} label={syncing_label:?}"
        );
        assert!(
            syncing_text.width >= 45.0 && syncing_text.height >= 10.0,
            "Syncing text collapsed at {width}: text={syncing_text:?}"
        );
        assert!(
            (syncing_pill.width - synced_pill.width).abs() < 1.0,
            "Syncing must keep the fixed Synced pill width at {width}: synced={synced_pill:?} syncing={syncing_pill:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn clicking_status_pill_in_handcash_app_renders_visible_syncing_label() {
    tokio::task::block_in_place(|| {
        let dir = std::env::temp_dir().join(format!(
            "handcash-alpha-status-pill-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let services = AppServices::open_in(dir.clone(), false).unwrap();
        services
            .create_vault("status-test", "StatusTest123!", "main")
            .unwrap();
        let dom = VirtualDom::new(HandCashApp);
        dom.provide_root_context(services);
        let mut session = AeonNativeSession::from_virtual_dom(dom, 984., 652.);

        let pill = find_class(&session, "status-pill");
        let pill_before = session.layout.get(pill).expect("pill layout").abs_rect;
        let label_before = session
            .layout
            .get(find_class(&session, "status-pill-label"))
            .expect("label layout")
            .abs_rect;
        assert!(
            label_before.width >= 45.0 && label_before.height >= 10.0,
            "initial status-pill label must be visible: pill={pill_before:?} label={label_before:?}"
        );

        let (x, y) = (
            pill_before.x + pill_before.width / 2.,
            pill_before.y + pill_before.height / 2.,
        );
        session.dispatch_pointer_move(x, y);
        session.dispatch_pointer_down(x, y, MouseButton::Primary);
        assert!(
            session.dispatch_pointer_up(x, y, MouseButton::Primary),
            "status pill click delivered"
        );

        let pill_after_id = find_class(&session, "status-pill");
        let state_after = session
            .tree
            .get(pill_after_id)
            .and_then(|n| n.attr("data-aeon-state"));
        let label_after_id = find_class(&session, "status-pill-label");
        let label_after = session.layout.get(label_after_id).unwrap().abs_rect;
        let pill_after = session.layout.get(pill_after_id).unwrap().abs_rect;
        let syncing_text = find_text_in(&session, label_after_id, "Syncing");
        let syncing_text_rect = session.layout.get(syncing_text).unwrap().abs_rect;

        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(state_after, Some("refreshing"));
        assert!(
            label_after.width >= 45.0 && label_after.height >= 10.0,
            "Syncing label must be visible: pill={pill_after:?} label={label_after:?}"
        );
        assert!(
            syncing_text_rect.width >= 45.0 && syncing_text_rect.height >= 10.0,
            "Syncing text must have size: {syncing_text_rect:?}"
        );
        assert!(
            (pill_after.width - pill_before.width).abs() < 1.0,
            "pill width must stay fixed when entering Syncing: before={pill_before:?} after={pill_after:?}"
        );
    });
}
