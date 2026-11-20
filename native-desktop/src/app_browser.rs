//! In-wallet embedded app-browser guest host (parity with `native-macos/AppBrowserGuest.swift`).
//!
//! Guests are isolated child WebViews laid over the browser panel's content box:
//! - Separate persistent storage directory (`<userData>/app-browser-data`)
//! - No `window.handcash` injected, no IPC channel to the wallet host
//! - Guests talk to the local BRC-100 HTTP bridge like a normal browser
//! - Navigation policy allows only `http:`, `https:`, and `about:`

use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct GuestBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

impl GuestBounds {
    pub fn from_params(params: &Value) -> Self {
        Self {
            x: params.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
            y: params.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
            width: params.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0),
            height: params.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0),
            visible: params
                .get("visible")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        }
    }
}

pub fn is_allowed_guest_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("about:")
}

pub fn is_allowed_initial_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

// ============================================================================
// Linux implementation (GTK Overlay + Fixed + isolated WebKitGTK child views)
// ============================================================================
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use crate::clipboard::cairo_surface_to_rgba;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use gtk::gdk_pixbuf::{Colorspace, InterpType, Pixbuf};
    use gtk::gio;
    use gtk::prelude::*;
    use std::collections::HashMap;
    use std::rc::Rc;
    use webkit2gtk::{
        LoadEvent, NavigationPolicyDecision, NavigationPolicyDecisionExt, PolicyDecisionExt,
        PolicyDecisionType, SnapshotOptions, SnapshotRegion, URIRequestExt, WebContext,
        WebView as WkWebView, WebViewExt, WebsiteDataManager,
    };

    pub struct AppBrowserHost {
        fixed: gtk::Fixed,
        context: WebContext,
        guests: HashMap<String, WkWebView>,
        emit: Rc<dyn Fn(Value)>,
    }

    impl AppBrowserHost {
        pub fn new<F>(fixed: gtk::Fixed, emit: F) -> Self
        where
            F: Fn(Value) + 'static,
        {
            let data_root = crate::paths::user_data_dir().join("app-browser-data");
            let cache_root = crate::paths::user_data_dir().join("app-browser-cache");
            let _ = std::fs::create_dir_all(&data_root);
            let _ = std::fs::create_dir_all(&cache_root);

            let data_mgr = WebsiteDataManager::builder()
                .base_data_directory(data_root.to_string_lossy().as_ref())
                .base_cache_directory(cache_root.to_string_lossy().as_ref())
                .build();
            let context = WebContext::builder()
                .website_data_manager(&data_mgr)
                .build();

            Self {
                fixed,
                context,
                guests: HashMap::new(),
                emit: Rc::new(emit),
            }
        }

        pub fn create(&mut self, id: String, url: String, bounds: GuestBounds) -> Result<(), String> {
            self.destroy(&id);

            let view = WkWebView::builder()
                .web_context(&self.context)
                .build();
            crate::file_chooser::attach_webkit(&view);

            // Enforce http/https/about navigation policy; open target=_blank externally.
            view.connect_decide_policy(|_view, decision, decision_type| {
                if decision_type == PolicyDecisionType::NavigationAction
                    || decision_type == PolicyDecisionType::NewWindowAction
                {
                    if let Some(nav) = decision.downcast_ref::<NavigationPolicyDecision>() {
                        if let Some(action) = nav.navigation_action() {
                            if let Some(req) = action.request() {
                                let target = req.uri().map(|u| u.to_string()).unwrap_or_default();
                                if decision_type == PolicyDecisionType::NewWindowAction {
                                    if is_allowed_initial_url(&target) {
                                        let _ = open::that(&target);
                                    }
                                    decision.ignore();
                                    return true;
                                }
                                if !is_allowed_guest_url(&target) {
                                    decision.ignore();
                                    return true;
                                }
                            }
                        }
                    }
                }
                false
            });

            {
                let emit = Rc::clone(&self.emit);
                let gid = id.clone();
                view.connect_load_changed(move |wv, ev| {
                    let current_url = wv.uri().map(|u| u.to_string()).unwrap_or_default();
                    match ev {
                        LoadEvent::Started => {
                            emit(json!({
                                "id": gid,
                                "type": "loading",
                                "url": current_url,
                            }));
                        }
                        LoadEvent::Finished => {
                            let can_back = wv.can_go_back();
                            let can_fwd = wv.can_go_forward();
                            emit(json!({
                                "id": gid,
                                "type": "loaded",
                                "url": current_url,
                                "canGoBack": can_back,
                                "canGoForward": can_fwd,
                            }));
                            emit(json!({
                                "id": gid,
                                "type": "navigated",
                                "url": current_url,
                                "canGoBack": can_back,
                                "canGoForward": can_fwd,
                            }));
                        }
                        _ => {}
                    }
                });
            }

            {
                let emit = Rc::clone(&self.emit);
                let gid = id.clone();
                view.connect_load_failed(move |_wv, _ev, failing_uri, err| {
                    // Ignore load cancellations (common on redirects / stop()).
                    let msg = err.message().to_string();
                    if msg.to_ascii_lowercase().contains("cancel") {
                        return false;
                    }
                    emit(json!({
                        "id": gid,
                        "type": "failed",
                        "url": failing_uri,
                        "description": msg,
                    }));
                    false
                });
            }

            {
                let emit = Rc::clone(&self.emit);
                let gid = id.clone();
                view.connect_estimated_load_progress_notify(move |wv| {
                    let progress = (wv.estimated_load_progress() * 100.0).round() as i64;
                    emit(json!({
                        "id": gid,
                        "type": "progress",
                        "progress": progress.clamp(0, 100),
                    }));
                });
            }

            self.fixed.put(&view, 0, 0);
            self.apply_bounds(&view, &bounds);
            self.guests.insert(id.clone(), view.clone());

            if is_allowed_initial_url(&url) {
                (self.emit)(json!({
                    "id": id,
                    "type": "loading",
                    "url": url,
                }));
                view.load_uri(&url);
            } else {
                (self.emit)(json!({
                    "id": id,
                    "type": "failed",
                    "url": url,
                    "description": "Invalid app URL",
                }));
            }
            Ok(())
        }

        pub fn set_bounds(&self, id: &str, bounds: GuestBounds) {
            if let Some(view) = self.guests.get(id) {
                self.apply_bounds(view, &bounds);
            }
        }

        pub fn navigate(&self, id: &str, action: &str) {
            let Some(view) = self.guests.get(id) else {
                return;
            };
            match action {
                "back" => view.go_back(),
                "forward" => view.go_forward(),
                "reload" => view.reload(),
                "stop" => view.stop_loading(),
                _ => {}
            }
        }

        pub fn capture<F>(&self, id: &str, target_width: i32, on_done: F)
        where
            F: FnOnce(Option<String>) + 'static,
        {
            let Some(view) = self.guests.get(id) else {
                on_done(None);
                return;
            };
            view.snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                gio::Cancellable::NONE,
                move |res| {
                    let data_url = res.ok().and_then(|surface| {
                        let (w, h, rgba) = cairo_surface_to_rgba(&surface).ok()?;
                        let pb = Pixbuf::from_mut_slice(
                            rgba,
                            Colorspace::Rgb,
                            true,
                            8,
                            w as i32,
                            h as i32,
                            (w * 4) as i32,
                        );
                        let scaled = if target_width > 0 && (w as i32) > target_width {
                            let new_h = ((h as f64) * (target_width as f64) / (w as f64))
                                .round()
                                .max(1.0) as i32;
                            pb.scale_simple(target_width, new_h, InterpType::Bilinear)
                                .unwrap_or(pb)
                        } else {
                            pb
                        };
                        let jpeg = scaled
                            .save_to_bufferv("jpeg", &[("quality", "70")])
                            .ok()?;
                        Some(format!("data:image/jpeg;base64,{}", B64.encode(jpeg)))
                    });
                    on_done(data_url);
                },
            );
        }

        pub fn destroy(&mut self, id: &str) {
            if let Some(view) = self.guests.remove(id) {
                view.stop_loading();
                self.fixed.remove(&view);
            }
        }

        pub fn destroy_all(&mut self) {
            let ids: Vec<String> = self.guests.keys().cloned().collect();
            for id in ids {
                self.destroy(&id);
            }
        }

        fn apply_bounds(&self, view: &WkWebView, bounds: &GuestBounds) {
            if !bounds.visible || bounds.width < 2.0 || bounds.height < 2.0 {
                view.hide();
                return;
            }
            let x = bounds.x.round() as i32;
            let y = bounds.y.round() as i32;
            let w = bounds.width.round().max(2.0) as i32;
            let h = bounds.height.round().max(2.0) as i32;
            self.fixed.move_(view, x, y);
            view.set_size_request(w, h);
            view.show();
        }
    }
}

// ============================================================================
// Windows implementation (wry child WebView2 instances)
// ============================================================================
#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::{PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder};

    pub struct AppBrowserHost {
        context: WebContext,
        guests: HashMap<String, WebView>,
        emit: Arc<dyn Fn(Value) + Send + Sync>,
    }

    impl AppBrowserHost {
        pub fn new<F>(emit: F) -> Self
        where
            F: Fn(Value) + Send + Sync + 'static,
        {
            let data_root = crate::paths::user_data_dir().join("app-browser-data");
            let _ = std::fs::create_dir_all(&data_root);
            Self {
                context: WebContext::new(Some(data_root)),
                guests: HashMap::new(),
                emit: Arc::new(emit),
            }
        }

        pub fn create(
            &mut self,
            window: &tao::window::Window,
            id: String,
            url: String,
            bounds: GuestBounds,
        ) -> Result<(), String> {
            self.destroy(&id);
            if !is_allowed_initial_url(&url) {
                (self.emit)(json!({
                    "id": id,
                    "type": "failed",
                    "url": url,
                    "description": "Invalid app URL",
                }));
                return Ok(());
            }

            let emit_load = Arc::clone(&self.emit);
            let gid_load = id.clone();
            let rect = to_rect(&bounds);
            let visible = bounds.visible && bounds.width >= 2.0 && bounds.height >= 2.0;

            let view = WebViewBuilder::new_with_web_context(&mut self.context)
                .with_url(&url)
                .with_bounds(rect)
                .with_visible(visible)
                .with_navigation_handler(|target| is_allowed_guest_url(&target))
                .with_on_page_load_handler(move |event, loaded_url| match event {
                    PageLoadEvent::Started => {
                        emit_load(json!({
                            "id": gid_load,
                            "type": "loading",
                            "url": loaded_url,
                        }));
                    }
                    PageLoadEvent::Finished => {
                        emit_load(json!({
                            "id": gid_load,
                            "type": "loaded",
                            "url": loaded_url,
                            "canGoBack": true,
                            "canGoForward": false,
                        }));
                        emit_load(json!({
                            "id": gid_load,
                            "type": "navigated",
                            "url": loaded_url,
                            "canGoBack": true,
                            "canGoForward": false,
                        }));
                    }
                })
                .build_as_child(window)
                .map_err(|e| e.to_string())?;

            self.guests.insert(id, view);
            Ok(())
        }

        pub fn set_bounds(&self, id: &str, bounds: GuestBounds) {
            if let Some(view) = self.guests.get(id) {
                let visible = bounds.visible && bounds.width >= 2.0 && bounds.height >= 2.0;
                let _ = view.set_visible(visible);
                if visible {
                    let _ = view.set_bounds(to_rect(&bounds));
                }
            }
        }

        pub fn navigate(&self, id: &str, action: &str) {
            let Some(view) = self.guests.get(id) else {
                return;
            };
            let script = match action {
                "back" => "window.history.back()",
                "forward" => "window.history.forward()",
                "reload" => "window.location.reload()",
                "stop" => "window.stop()",
                _ => return,
            };
            let _ = view.evaluate_script(script);
        }

        pub fn capture<F>(&self, _id: &str, _target_width: i32, on_done: F)
        where
            F: FnOnce(Option<String>) + 'static,
        {
            on_done(None);
        }

        pub fn destroy(&mut self, id: &str) {
            self.guests.remove(id);
        }

        pub fn destroy_all(&mut self) {
            self.guests.clear();
        }
    }

    fn to_rect(bounds: &GuestBounds) -> Rect {
        Rect {
            position: LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)).into(),
            size: LogicalSize::new(bounds.width.max(2.0), bounds.height.max(2.0)).into(),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub use platform::AppBrowserHost;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_url_policy_allows_only_web_and_about() {
        assert!(is_allowed_initial_url("https://market.handcash.io/app"));
        assert!(is_allowed_initial_url("http://localhost:3000"));
        assert!(!is_allowed_initial_url("file:///etc/passwd"));
        assert!(!is_allowed_initial_url("javascript:alert(1)"));
        assert!(!is_allowed_initial_url("mailto:test@example.com"));
        assert!(is_allowed_guest_url("about:blank"));
        assert!(!is_allowed_guest_url("file:///tmp/x"));
    }
}
