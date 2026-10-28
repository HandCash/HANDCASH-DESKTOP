//! Thin HandCash Desktop host for Windows and Linux: OS WebView + Node sidecar.

#![cfg_attr(
    not(any(target_os = "windows", target_os = "linux")),
    allow(dead_code, unused_imports)
)]

mod bridge;
mod device_auth;
mod durable;
mod seal;
mod sidecar;

use bridge::{dispatch, push_script, reply_script, HostReply, HostState};
use durable::DurableStore;
use serde_json::Value;
use sidecar::BridgeSidecar;
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn main() {
    eprintln!(
        "handcash-shell: this binary targets Windows and Linux. On macOS use native-macos / npm run dev:native."
    );
    std::process::exit(1);
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn main() -> wry::Result<()> {
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::WindowBuilder;
    use wry::http::Request;
    use wry::WebViewBuilder;

    let ui_origin = std::env::var("HANDCASH_UI_ORIGIN")
        .unwrap_or_else(|_| "http://localhost:5173".to_string());
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
    .to_string();

    let store = DurableStore::open_default().expect("durable store");
    let (durable_url, _durable_thread) =
        durable::start_sync_server(Arc::clone(&store), ui_origin.clone())
            .expect("durable sync http");

    let sidecar = BridgeSidecar::new();
    let state = Arc::new(HostState {
        store: Arc::clone(&store),
        sidecar: Arc::clone(&sidecar),
        platform: platform.clone(),
        app_version: std::env::var("HANDCASH_APP_VERSION").unwrap_or_else(|_| "0.0.0-native".into()),
    });

    #[derive(Debug)]
    enum UserEvent {
        SidecarLine(Value),
        Eval(String),
        Focus { id: String },
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    {
        let proxy = proxy.clone();
        sidecar.start_if_needed(move |obj| {
            let _ = proxy.send_event(UserEvent::SidecarLine(obj));
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

    let init_script = build_init_script(&platform, &durable_url);
    let state_ipc = Arc::clone(&state);
    let proxy_ipc = proxy.clone();

    let builder = WebViewBuilder::new()
        .with_url(&ui_origin)
        .with_initialization_script(&init_script)
        .with_ipc_handler(move |req: Request<String>| {
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
            let params = msg.get("params").cloned().unwrap_or(Value::Object(Default::default()));
            if id.is_empty() || method.is_empty() {
                return;
            }
            let reply = dispatch(&state_ipc, id.clone(), &method, &params);
            if matches!(reply, HostReply::FocusWindow) {
                let _ = proxy_ipc.send_event(UserEvent::Focus {
                    id,
                });
                return;
            }
            if method == "restartBridge" {
                let sc = Arc::clone(&state_ipc.sidecar);
                let proxy = proxy_ipc.clone();
                sc.stop();
                sc.start_if_needed(move |obj| {
                    let _ = proxy.send_event(UserEvent::SidecarLine(obj));
                });
            }
            if let Some(script) = reply_script(&reply) {
                let _ = proxy_ipc.send_event(UserEvent::Eval(script));
            }
        });

    #[cfg(any(target_os = "windows"))]
    let webview = builder.build(&window)?;

    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().expect("gtk vbox");
        builder.build_gtk(vbox)?
    };

    let webview = Arc::new(webview);
    let state_loop = Arc::clone(&state);

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Eval(script)) => {
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::Focus { id }) => {
                window.set_focus();
                let script = format!(
                    "window.__handcashNativeReply && window.__handcashNativeReply({{\"id\":{id},\"ok\":true,\"value\":true}})",
                    id = serde_json::to_string(&id).unwrap()
                );
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::SidecarLine(obj)) => {
                let ty = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if ty == "to-renderer" {
                    let channel = obj.get("channel").and_then(|v| v.as_str()).unwrap_or("");
                    let payload = obj.get("payload").cloned().unwrap_or(Value::Null);
                    let script = push_script(channel, &payload);
                    let _ = webview.evaluate_script(&script);
                } else if ty == "ready" || ty == "fatal" {
                    let script = push_script("bridge-status", &state_loop.sidecar.status_snapshot());
                    let _ = webview.evaluate_script(&script);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                state_loop.sidecar.stop();
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

fn build_init_script(platform: &str, durable_url: &str) -> String {
    let page = load_page_script();
    format!(
        "window.__HANDCASH_NATIVE_PLATFORM__={plat};window.__HANDCASH_DURABLE_URL__={dur};{page}",
        plat = serde_json::to_string(platform).unwrap(),
        dur = serde_json::to_string(durable_url).unwrap(),
        page = page,
    )
}

fn load_page_script() -> String {
    if let Ok(path) = std::env::var("HANDCASH_SHELL_PAGE_JS") {
        if let Ok(s) = std::fs::read_to_string(&path) {
            return s;
        }
    }
    // Dev: beside this crate.
    let beside = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("handcash-page.js");
    if let Ok(s) = std::fs::read_to_string(&beside) {
        return s;
    }
    "console.error('[handcash-shell] handcash-page.js missing');".into()
}
