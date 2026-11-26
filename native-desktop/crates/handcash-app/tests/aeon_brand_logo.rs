#![cfg(feature = "aeon")]

use aeon_native::{AeonNativeSession, ImageQuality, NodeId};
use aeon_ui::{AeonMode, AeonTheme, AeonThemeProvider};
use dioxus::prelude::*;
use handcash_app::css_scope::{PLATFORM, ROOT_CLASSES, SCOPED_SHEETS};
use handcash_app::theme::{build_theme_override_css, ResolvedTheme};
use handcash_app::ui::BrandLogo;
use handcash_app::{AppServices, HandCashApp};

fn visible_brand_marks(session: &AeonNativeSession) -> Vec<NodeId> {
    session
        .tree
        .nodes
        .iter()
        .flatten()
        .filter(|n| {
            n.attr("class")
                .is_some_and(|c| c.split_whitespace().any(|cls| cls == "brand-logo-mark"))
                && session.layout.get(n.id).is_some()
        })
        .map(|n| n.id)
        .collect()
}

fn assert_mark_box_and_mips(
    session: &mut AeonNativeSession,
    mark_id: NodeId,
    expected_size: u32,
    scale_expectations: &[(f32, (u32, u32))],
) {
    let node = session.tree.get(mark_id).unwrap();
    let computed = session.layout.get(mark_id).unwrap();
    let rect = computed.abs_rect;
    let image = node
        .image
        .as_ref()
        .expect("brand mark must carry aeon-image pixels");
    assert_eq!((image.pixels.width(), image.pixels.height()), (144, 144));
    assert_eq!(image.quality, ImageQuality::Medium);
    assert!(
        computed.style.background.is_some(),
        "dark mode brand mark must have a background plate: {:?}",
        computed.style.background
    );
    assert!(
        computed.style.border_radius > 0.0,
        "brand mark must keep rounded corners: {}",
        computed.style.border_radius
    );
    assert_eq!(
        (rect.width.round() as u32, rect.height.round() as u32),
        (expected_size, expected_size),
        "expected {expected_size}x{expected_size} brand mark box, got {rect:?}"
    );

    for &(scale, expected_mip) in scale_expectations {
        session.set_scale_factor(scale);
        let patch_count = session.paint_scene().encoding().resources.patches.len();
        assert!(
            patch_count >= 1,
            "scale {scale}: expected image patch in scene, got {patch_count}"
        );
        let painted = session.painted_images();
        assert!(
            painted.contains(&(mark_id, expected_mip.0, expected_mip.1)),
            "scale {scale}: expected {expected_size}px mark ({mark_id:?}) mip {expected_mip:?} in {painted:?}"
        );
    }
}

#[component]
fn TitlebarBrandHarness() -> Element {
    let theme_css = build_theme_override_css(&ResolvedTheme::dark_handcash());
    let scoped: &str = &SCOPED_SHEETS;
    rsx! {
        AeonThemeProvider {
            theme: AeonTheme::Handcash,
            mode: AeonMode::Dark,
            style { "{scoped}" }
            style { "{theme_css}" }
            div {
                class: ROOT_CLASSES,
                "data-hc": "",
                "data-aeon-mode": "dark",
                "data-aeon-platform": PLATFORM,
                div { class: "app-shell", "data-aeon-scope": "app", "data-aeon-state": "ready",
                    header { class: "titlebar aeon-titlebar",
                        BrandLogo { size: 28, show_wordmark: true }
                    }
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_entry_brand_logo_renders_with_48px_box_and_scale_mips() {
    tokio::task::block_in_place(|| {
        let dir = std::env::temp_dir().join(format!(
            "handcash-alpha-brand-logo-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let services = AppServices::open_in(dir.clone(), false).unwrap();
        let dom = VirtualDom::new(HandCashApp);
        dom.provide_root_context(services);
        let mut session = AeonNativeSession::from_virtual_dom(dom, 1120.0, 760.0);

        let marks = visible_brand_marks(&session);
        assert_eq!(
            marks.len(),
            1,
            "expected single visible auth-entry brand mark during onboarding (titlebar hidden), got {marks:?}"
        );
        assert_mark_box_and_mips(
            &mut session,
            marks[0],
            48,
            &[
                (1.0, (72, 72)),
                (1.25, (72, 72)),
                (1.5, (72, 72)),
                (2.0, (144, 144)),
            ],
        );

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn titlebar_brand_logo_renders_with_28px_box_and_scale_mips() {
    let mut session =
        AeonNativeSession::from_virtual_dom(VirtualDom::new(TitlebarBrandHarness), 1120.0, 760.0);
    let marks = visible_brand_marks(&session);
    assert_eq!(
        marks.len(),
        1,
        "expected single visible 28px titlebar brand mark, got {marks:?}"
    );
    assert_mark_box_and_mips(
        &mut session,
        marks[0],
        28,
        &[
            (1.0, (36, 36)),
            (1.25, (36, 36)),
            (1.5, (72, 72)),
            (2.0, (72, 72)),
        ],
    );
}
