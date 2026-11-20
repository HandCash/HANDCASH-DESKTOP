//! Pure-Rust HandCash Desktop host for Windows and Linux:
//! OS WebView + built-in BRC-100 HTTP/HTTPS bridge + LAN device-peer + packaged UI server.
//! Zero Electron, zero Node runtime, zero sidecar processes.

#![cfg_attr(
    not(any(target_os = "windows", target_os = "linux")),
    allow(dead_code, unused_imports)
)]

mod app_browser;
mod brc100_server;
mod brc39_archive;
mod bridge;
mod bridge_protocol;
mod call_recordings;
mod clipboard;
mod device_auth;
mod dialogs;
mod durable;
mod durable_cache;
#[cfg(target_os = "linux")]
mod file_chooser;
mod host_log;
mod http_wire;
#[cfg(target_os = "linux")]
mod media;
mod omarchy_theme;
mod paths;
mod seal;
mod spend_ledger;
mod tls_cert;
mod ui_server;

use app_browser::GuestBounds;
use brc100_server::Brc100Bridge;
use brc39_archive::Brc39Archive;
use bridge::{
    dispatch, push_script, reply_err_script, reply_ok_script, reply_script, HostReply, HostState,
};
use call_recordings::CallRecordings;
use clipboard::ClipboardState;
use dialogs::{ParsedBackup, ParsedImage};
use durable::DurableStore;
use host_log::HostLog;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use ui_server::{PackagedUiServer, UI_ORIGIN};

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn main() {
    eprintln!(
        "handcash-shell: this binary targets Windows and Linux. On macOS use native-macos / npm run dev:native."
    );
    std::process::exit(1);
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn main() -> wry::Result<()> {
    use app_browser::AppBrowserHost;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::WindowBuilder;
    use wry::http::Request;
    use wry::WebViewBuilder;

    const PROMPT_FOCUS_RETURN_WINDOW: Duration = Duration::from_secs(10 * 60);

    let host_log = HostLog::open_default();

    // If packaged UI files exist (`HANDCASH_UI_ROOT` or `<exe_dir>/app/index.html`)
    // and the caller did not opt out (`HANDCASH_SKIP_UI_SERVER=1`), serve them on
    // `http://localhost:5173` directly from Rust — no Node uiSidecar required.
    let mut ui_server_handle: Option<PackagedUiServer> = None;
    let skip_ui_server = std::env::var("HANDCASH_SKIP_UI_SERVER").as_deref() == Ok("1");
    if !skip_ui_server {
        if let Some(dist_root) = PackagedUiServer::discover_dist_root() {
            match PackagedUiServer::start(dist_root, Arc::clone(&host_log)) {
                Ok(srv) => ui_server_handle = Some(srv),
                Err(msg) => {
                    host_log.append("error", "ui-server", &msg);
                    eprintln!("[handcash-shell] {msg}");
                    std::process::exit(1);
                }
            }
        }
    }

    let ui_origin =
        std::env::var("HANDCASH_UI_ORIGIN").unwrap_or_else(|_| UI_ORIGIN.to_string());
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
    .to_string();
    let app_version = std::env::var("HANDCASH_APP_VERSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| env!("HANDCASH_PACKAGE_VERSION").to_string());
    let is_packaged = ui_server_handle.is_some() || paths::is_packaged();

    let brc39_archive = Arc::new(Brc39Archive::open_default());
    let (adopted, removed) = brc39_archive.sweep_temps();
    if adopted > 0 || removed > 0 {
        host_log.append(
            "info",
            "brc39-archive",
            &format!("temp sweep adopted={adopted} removed={removed}"),
        );
    }
    let call_recordings = Arc::new(CallRecordings::open_default());
    let clipboard = Arc::new(ClipboardState::default());

    let store = DurableStore::open_default().expect("durable store");
    let (durable_url, durable_token, _durable_thread) =
        durable::start_sync_server(Arc::clone(&store), ui_origin.clone())
            .expect("durable sync http");

    let brc100_bridge = Brc100Bridge::new(paths::user_data_dir(), Arc::clone(&host_log));
    let state = Arc::new(HostState::new(
        Arc::clone(&store),
        Arc::clone(&brc100_bridge),
        Arc::clone(&host_log),
        Arc::clone(&brc39_archive),
        Arc::clone(&call_recordings),
        Arc::clone(&clipboard),
        platform.clone(),
        app_version,
        is_packaged,
    ));

    #[derive(Debug)]
    enum UserEvent {
        Eval(String),
        Push { channel: String, payload: Value },
        Focus { id: String },
        ReleasePromptFocus { id: String },
        StartWindowDrag { id: String },
        CopyScreenshot { id: Option<String> },
        SaveBackupFile { id: String, backup: ParsedBackup },
        SaveImageFile { id: String, image: ParsedImage },
        AppBrowserCreate {
            id: String,
            guest_id: String,
            url: String,
            bounds: GuestBounds,
        },
        AppBrowserSetBounds {
            id: String,
            guest_id: String,
            bounds: GuestBounds,
        },
        AppBrowserNavigate {
            id: String,
            guest_id: String,
            action: String,
        },
        AppBrowserCapture {
            id: String,
            guest_id: String,
            width: i32,
        },
        AppBrowserDestroy {
            id: String,
            guest_id: String,
        },
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    {
        let proxy = proxy.clone();
        brc100_bridge.set_push_handler(move |channel, payload| {
            let _ = proxy.send_event(UserEvent::Push {
                channel: channel.to_string(),
                payload,
            });
        });
        brc100_bridge.start_if_needed();
    }

    {
        let proxy = proxy.clone();
        omarchy_theme::start_watcher(move |snap| {
            let _ = proxy.send_event(UserEvent::Push {
                channel: "omarchy:theme".into(),
                payload: snap,
            });
        });
    }

    // App chrome owns the top rail (.titlebar). OS/GTK CSD would stack a second
    // bar ("HandCash" + min/max/close) on top — drop decorations on Win/Linux.
    let window = WindowBuilder::new()
        .with_title("HandCash")
        .with_decorations(false)
        .with_inner_size(tao::dpi::LogicalSize::new(1180.0, 760.0))
        .with_min_inner_size(tao::dpi::LogicalSize::new(360.0, 420.0))
        .build(&event_loop)
        .unwrap();

    let init_script = build_init_script(&platform, &durable_url, &durable_token);
    let state_ipc = Arc::clone(&state);
    let proxy_ipc = proxy.clone();
    let ui_origin_ipc = ui_origin.trim_end_matches('/').to_string();
    let ui_origin_nav = ui_origin_ipc.clone();

    let builder = WebViewBuilder::new()
        .with_url(&ui_origin)
        .with_initialization_script(&init_script)
        .with_navigation_handler(move |url: String| {
            if url == ui_origin_nav
                || url.starts_with(&format!("{ui_origin_nav}/"))
                || url == "about:blank"
            {
                return true;
            }
            if url.starts_with("https://") || url.starts_with("http://") {
                let _ = open::that(&url);
            }
            false
        })
        .with_ipc_handler(move |req: Request<String>| {
            let uri = req.uri().to_string();
            if uri != ui_origin_ipc && !uri.starts_with(&format!("{ui_origin_ipc}/")) {
                return;
            }
            let Ok(msg) = serde_json::from_str::<Value>(req.body()) else {
                return;
            };
            let id = msg
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let method = msg
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = msg
                .get("params")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            if id.is_empty() || method.is_empty() {
                return;
            }
            let reply = dispatch(&state_ipc, id.clone(), &method, &params);
            match reply {
                HostReply::FocusWindow { id } => {
                    let _ = proxy_ipc.send_event(UserEvent::Focus { id });
                    return;
                }
                HostReply::ReleasePromptFocus { id } => {
                    let _ = proxy_ipc.send_event(UserEvent::ReleasePromptFocus { id });
                    return;
                }
                HostReply::StartWindowDrag { id } => {
                    let _ = proxy_ipc.send_event(UserEvent::StartWindowDrag { id });
                    return;
                }
                HostReply::CopyScreenshot { id } => {
                    let _ = proxy_ipc.send_event(UserEvent::CopyScreenshot { id: Some(id) });
                    return;
                }
                HostReply::SaveBackupFile { id, backup } => {
                    let _ = proxy_ipc.send_event(UserEvent::SaveBackupFile { id, backup });
                    return;
                }
                HostReply::SaveImageFile { id, image } => {
                    let _ = proxy_ipc.send_event(UserEvent::SaveImageFile { id, image });
                    return;
                }
                HostReply::AppBrowserCreate {
                    id,
                    guest_id,
                    url,
                    bounds,
                } => {
                    let _ = proxy_ipc.send_event(UserEvent::AppBrowserCreate {
                        id,
                        guest_id,
                        url,
                        bounds,
                    });
                    return;
                }
                HostReply::AppBrowserSetBounds {
                    id,
                    guest_id,
                    bounds,
                } => {
                    let _ = proxy_ipc.send_event(UserEvent::AppBrowserSetBounds {
                        id,
                        guest_id,
                        bounds,
                    });
                    return;
                }
                HostReply::AppBrowserNavigate {
                    id,
                    guest_id,
                    action,
                } => {
                    let _ = proxy_ipc.send_event(UserEvent::AppBrowserNavigate {
                        id,
                        guest_id,
                        action,
                    });
                    return;
                }
                HostReply::AppBrowserCapture {
                    id,
                    guest_id,
                    width,
                } => {
                    let _ = proxy_ipc.send_event(UserEvent::AppBrowserCapture {
                        id,
                        guest_id,
                        width,
                    });
                    return;
                }
                HostReply::AppBrowserDestroy { id, guest_id } => {
                    let _ = proxy_ipc.send_event(UserEvent::AppBrowserDestroy { id, guest_id });
                    return;
                }
                other => {
                    if let Some(script) = reply_script(&other) {
                        let _ = proxy_ipc.send_event(UserEvent::Eval(script));
                    }
                }
            }
        });

    #[cfg(target_os = "windows")]
    let (webview, mut app_browser) = {
        let webview = builder.build(&window)?;
        let proxy_guest = proxy.clone();
        let host = AppBrowserHost::new(move |event| {
            let _ = proxy_guest.send_event(UserEvent::Push {
                channel: "app-browser-guest".into(),
                payload: event,
            });
        });
        (webview, host)
    };

    #[cfg(target_os = "linux")]
    let (webview, mut app_browser) = {
        use gtk::gdk::ModifierType;
        use gtk::prelude::*;
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;

        let vbox = window.default_vbox().expect("gtk vbox");
        let overlay = gtk::Overlay::new();
        let main_box = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let guest_fixed = gtk::Fixed::new();
        overlay.add(&main_box);
        overlay.add_overlay(&guest_fixed);
        overlay.set_overlay_pass_through(&guest_fixed, true);
        vbox.pack_start(&overlay, true, true, 0);
        overlay.show_all();

        let webview = builder.build_gtk(&main_box)?;
        // wry leaves WebKitGTK file chooser & media unwired.
        file_chooser::attach(&webview);
        media::attach(&webview, &ui_origin);

        // Ctrl+Shift+S → Copy Screenshot (matches Electron / Mac menu shortcut).
        let gtk_win = window.gtk_window();
        let proxy_shot = proxy.clone();
        gtk_win.connect_key_press_event(move |_, ev| {
            let mods = ev.state();
            let ctrl_shift = mods.contains(ModifierType::CONTROL_MASK)
                && mods.contains(ModifierType::SHIFT_MASK);
            if ctrl_shift && matches!(ev.keyval().name().as_deref(), Some("S") | Some("s")) {
                let _ = proxy_shot.send_event(UserEvent::CopyScreenshot { id: None });
                return gtk::glib::Propagation::Stop;
            }
            gtk::glib::Propagation::Proceed
        });

        let proxy_guest = proxy.clone();
        let host = AppBrowserHost::new(guest_fixed, move |event| {
            let _ = proxy_guest.send_event(UserEvent::Push {
                channel: "app-browser-guest".into(),
                payload: event,
            });
        });
        (webview, host)
    };

    let webview = Arc::new(webview);
    let state_loop = Arc::clone(&state);
    let proxy_loop = proxy.clone();
    let mut prompt_stole_focus_at: Option<Instant> = None;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Eval(script)) => {
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::Push { channel, payload }) => {
                let script = push_script(&channel, &payload);
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::Focus { id }) => {
                let was_in_front =
                    window.is_visible() && !window.is_minimized() && window.is_focused();
                if !was_in_front {
                    if prompt_stole_focus_at.is_none() {
                        prompt_stole_focus_at = Some(Instant::now());
                    }
                } else if let Some(at) = prompt_stole_focus_at {
                    if at.elapsed() > Duration::from_secs(2) {
                        prompt_stole_focus_at = None;
                    }
                }
                if window.is_minimized() {
                    window.set_minimized(false);
                }
                window.set_visible(true);
                window.set_focus();
                let script = reply_ok_script(&id, &Value::Bool(true));
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::ReleasePromptFocus { id }) => {
                if let Some(at) = prompt_stole_focus_at.take() {
                    if at.elapsed() <= PROMPT_FOCUS_RETURN_WINDOW {
                        window.request_user_attention(None);
                    }
                }
                let script = reply_ok_script(&id, &Value::Bool(true));
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::StartWindowDrag { id }) => {
                let ok = window.drag_window().is_ok();
                let script = reply_ok_script(&id, &Value::Bool(ok));
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::CopyScreenshot { id }) => {
                #[cfg(target_os = "linux")]
                {
                    let proxy_done = proxy_loop.clone();
                    let cb = Arc::clone(&state_loop.clipboard);
                    let ver = state_loop.app_version.clone();
                    clipboard::capture_webview_screenshot(&webview, cb, ver, move |res| {
                        match res {
                            Ok((at, version)) => {
                                let _ = proxy_done.send_event(UserEvent::Push {
                                    channel: "screenshot:copied".into(),
                                    payload: json!({ "at": at, "version": version }),
                                });
                                if let Some(reply_id) = id {
                                    let _ = proxy_done.send_event(UserEvent::Eval(
                                        reply_ok_script(
                                            &reply_id,
                                            &json!({ "ok": true, "version": version }),
                                        ),
                                    ));
                                }
                            }
                            Err(err) => {
                                if let Some(reply_id) = id {
                                    let _ = proxy_done.send_event(UserEvent::Eval(
                                        reply_ok_script(
                                            &reply_id,
                                            &json!({ "ok": false, "error": err }),
                                        ),
                                    ));
                                }
                            }
                        }
                    });
                }
                #[cfg(target_os = "windows")]
                {
                    if let Some(reply_id) = id {
                        let script = reply_ok_script(
                            &reply_id,
                            &json!({
                                "ok": false,
                                "error": "In-app screenshot capture is not yet wired on Windows; use Win+Shift+S."
                            }),
                        );
                        let _ = webview.evaluate_script(&script);
                    }
                }
            }
            Event::UserEvent(UserEvent::SaveBackupFile { id, backup }) => {
                let proxy_done = proxy_loop.clone();
                let log = Arc::clone(&state_loop.host_log);
                dialogs::show_save_dialog("Save Backup", &backup.filename, None, move |picked| {
                    let result = match picked {
                        None => json!({ "ok": true, "saved": false }),
                        Some(path) => {
                            let res = dialogs::write_backup_verified(&path, &backup.bytes);
                            if res["saved"] == Value::Bool(true) {
                                log.append(
                                    "info",
                                    "backup",
                                    &format!("backup saved ({} bytes)", backup.bytes.len()),
                                );
                            }
                            res
                        }
                    };
                    let _ = proxy_done.send_event(UserEvent::Eval(reply_ok_script(&id, &result)));
                });
            }
            Event::UserEvent(UserEvent::SaveImageFile { id, image }) => {
                let proxy_done = proxy_loop.clone();
                dialogs::show_save_dialog(
                    "Save Image",
                    &image.filename,
                    Some(&image.ext),
                    move |picked| {
                        let result = match picked {
                            None => json!({ "ok": true, "canceled": true }),
                            Some(path) => dialogs::write_image_to_path(&path, &image.bytes),
                        };
                        let _ =
                            proxy_done.send_event(UserEvent::Eval(reply_ok_script(&id, &result)));
                    },
                );
            }
            Event::UserEvent(UserEvent::AppBrowserCreate {
                id,
                guest_id,
                url,
                bounds,
            }) => {
                #[cfg(target_os = "linux")]
                let res = app_browser.create(guest_id, url, bounds);
                #[cfg(target_os = "windows")]
                let res = app_browser.create(&window, guest_id, url, bounds);
                let script = match res {
                    Ok(()) => reply_ok_script(&id, &Value::Bool(true)),
                    Err(_) => {
                        reply_err_script(&id, "This device cannot open apps inside HandCash.")
                    }
                };
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::AppBrowserSetBounds {
                id,
                guest_id,
                bounds,
            }) => {
                app_browser.set_bounds(&guest_id, bounds);
                let script = reply_ok_script(&id, &Value::Bool(true));
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::AppBrowserNavigate {
                id,
                guest_id,
                action,
            }) => {
                app_browser.navigate(&guest_id, &action);
                let script = reply_ok_script(&id, &Value::Bool(true));
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::AppBrowserCapture {
                id,
                guest_id,
                width,
            }) => {
                let proxy_done = proxy_loop.clone();
                app_browser.capture(&guest_id, width, move |data_url| {
                    let body = json!({ "dataUrl": data_url });
                    let _ = proxy_done.send_event(UserEvent::Eval(reply_ok_script(&id, &body)));
                });
            }
            Event::UserEvent(UserEvent::AppBrowserDestroy { id, guest_id }) => {
                app_browser.destroy(&guest_id);
                let script = reply_ok_script(&id, &Value::Bool(true));
                let _ = webview.evaluate_script(&script);
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                app_browser.destroy_all();
                state_loop.bridge.stop();
                if let Some(mut ui) = ui_server_handle.take() {
                    ui.stop();
                }
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

fn build_init_script(platform: &str, durable_url: &str, durable_token: &str) -> String {
    let page = load_page_script();
    format!(
        "window.__HANDCASH_NATIVE_PLATFORM__={plat};window.__HANDCASH_DURABLE_URL__={dur};window.__HANDCASH_DURABLE_TOKEN__={tok};{page}",
        plat = serde_json::to_string(platform).unwrap(),
        dur = serde_json::to_string(durable_url).unwrap(),
        tok = serde_json::to_string(durable_token).unwrap(),
        page = page,
    )
}

fn load_page_script() -> String {
    if let Ok(path) = std::env::var("HANDCASH_SHELL_PAGE_JS") {
        if let Ok(s) = std::fs::read_to_string(&path) {
            return s;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside_exe = dir.join("handcash-page.js");
            if let Ok(s) = std::fs::read_to_string(&beside_exe) {
                return s;
            }
        }
    }
    // Dev: beside this crate.
    let beside = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("handcash-page.js");
    if let Ok(s) = std::fs::read_to_string(&beside) {
        return s;
    }
    "console.error('[handcash-shell] handcash-page.js missing');".into()
}
