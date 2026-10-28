//! Async host methods for window.handcash (wry ipc).

use crate::device_auth;
use crate::durable::DurableStore;
use crate::sidecar::BridgeSidecar;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct HostState {
    pub store: Arc<DurableStore>,
    pub sidecar: Arc<BridgeSidecar>,
    pub platform: String,
    pub app_version: String,
}

pub enum HostReply {
    Ok { id: String, value: Value },
    Err { id: String, error: String },
    FocusWindow,
}

pub fn dispatch(state: &HostState, id: String, method: &str, params: &Value) -> HostReply {
    match method {
        "getAppInfo" => HostReply::Ok {
            id,
            value: json!({
                "version": state.app_version,
                "name": "HandCash",
                "isPackaged": false,
                "platform": state.platform,
            }),
        },
        "getBridgeStatus" => HostReply::Ok {
            id,
            value: state.sidecar.status_snapshot(),
        },
        "restartBridge" => {
            state.sidecar.stop();
            // Caller restarts via start_if_needed after this returns.
            HostReply::Ok {
                id,
                value: state.sidecar.status_snapshot(),
            }
        }
        "announceBridgeReady" => {
            state.sidecar.notify_renderer_ready();
            HostReply::Ok {
                id,
                value: Value::Bool(true),
            }
        }
        "respondHttp" => {
            if let Some(payload) = params.get("response") {
                state
                    .sidecar
                    .send_from_renderer("http-response", payload.clone());
            }
            HostReply::Ok {
                id,
                value: Value::Bool(true),
            }
        }
        "notePromptOpen" => {
            let open = params.get("open").and_then(|v| v.as_bool()).unwrap_or(false);
            state
                .sidecar
                .send_from_renderer("bridge:prompt-open", Value::Bool(open));
            HostReply::Ok {
                id,
                value: Value::Bool(true),
            }
        }
        "respondDevicePeerHttp" => {
            if let Some(payload) = params.get("response") {
                state
                    .sidecar
                    .send_from_renderer("device-peer-http-response", payload.clone());
            }
            HostReply::Ok {
                id,
                value: Value::Bool(true),
            }
        }
        "openExternal" => {
            let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if !(url.starts_with("https://")
                || url.starts_with("http://")
                || url.starts_with("mailto:"))
            {
                return HostReply::Err {
                    id,
                    error: "invalid url".into(),
                };
            }
            match open::that(url) {
                Ok(()) => HostReply::Ok {
                    id,
                    value: Value::Bool(true),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "focusWindow" => HostReply::FocusWindow,
        "releasePromptFocus" => HostReply::Ok {
            id,
            value: Value::Bool(true),
        },
        "clipboardWrite" => {
            let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            match arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_string())) {
                Ok(()) => HostReply::Ok {
                    id,
                    value: Value::Bool(true),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "safeStorageAvailable" => HostReply::Ok {
            id,
            value: Value::Bool(state.store.safe_storage_available()),
        },
        "vaultOpenError" => HostReply::Ok {
            id,
            value: match state.store.vault_open_error() {
                Some(e) => Value::String(e),
                None => Value::Null,
            },
        },
        "wipeWalletStorage" => HostReply::Ok {
            id,
            value: json!({ "removed": state.store.wipe_all() }),
        },
        "getUpdateStatus" | "checkForUpdates" | "downloadUpdate" | "setUpdateMode" => {
            HostReply::Ok {
                id,
                value: stub_update_status(),
            }
        }
        "installUpdate" => HostReply::Err {
            id,
            error: "auto-update not wired in thin shell".into(),
        },
        "deviceAuthStatus" => HostReply::Ok {
            id,
            value: device_auth::status(),
        },
        "deviceAuthEnroll" => {
            let secret = params.get("secret").and_then(|v| v.as_str()).unwrap_or("");
            HostReply::Ok {
                id,
                value: device_auth::enroll(secret),
            }
        }
        "deviceAuthUnlock" => {
            let reason = params.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            HostReply::Ok {
                id,
                value: device_auth::unlock(reason),
            }
        }
        "deviceAuthClear" => HostReply::Ok {
            id,
            value: device_auth::clear(),
        },
        other => HostReply::Err {
            id,
            error: format!("stub: {other} not implemented in thin desktop shell"),
        },
    }
}

/// Matches renderer `UpdateStatus` (idle stub — auto-update not wired yet).
fn stub_update_status() -> Value {
    json!({
        "phase": "idle",
        "mode": "manual",
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "availableVersion": Value::Null,
        "percent": Value::Null,
        "error": Value::Null,
        "canInstall": false,
    })
}

pub fn reply_script(reply: &HostReply) -> Option<String> {
    match reply {
        HostReply::Ok { id, value } => {
            let body = json!({ "id": id, "ok": true, "value": value });
            Some(format!(
                "window.__handcashNativeReply && window.__handcashNativeReply({body})"
            ))
        }
        HostReply::Err { id, error } => {
            let body = json!({ "id": id, "ok": false, "error": error });
            Some(format!(
                "window.__handcashNativeReply && window.__handcashNativeReply({body})"
            ))
        }
        HostReply::FocusWindow => None,
    }
}

pub fn push_script(channel: &str, payload: &Value) -> String {
    let body = json!({ "channel": channel, "payload": payload });
    format!("window.__handcashNativePush && window.__handcashNativePush({body})")
}
