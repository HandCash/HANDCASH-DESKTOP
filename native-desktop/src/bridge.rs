//! Async host methods for `window.handcash` (wry IPC).

use crate::app_browser::GuestBounds;
use crate::brc100_server::Brc100Bridge;
use crate::brc39_archive::Brc39Archive;
use crate::call_recordings::CallRecordings;
use crate::clipboard::ClipboardState;
use crate::device_auth;
use crate::dialogs::{self, ParsedBackup, ParsedImage};
use crate::durable::DurableStore;
use crate::host_log::HostLog;
use crate::omarchy_theme;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct HostState {
    pub store: Arc<DurableStore>,
    pub bridge: Arc<Brc100Bridge>,
    pub host_log: Arc<HostLog>,
    pub brc39_archive: Arc<Brc39Archive>,
    pub call_recordings: Arc<CallRecordings>,
    pub clipboard: Arc<ClipboardState>,
    pub platform: String,
    pub app_version: String,
    pub is_packaged: bool,
}

impl HostState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<DurableStore>,
        bridge: Arc<Brc100Bridge>,
        host_log: Arc<HostLog>,
        brc39_archive: Arc<Brc39Archive>,
        call_recordings: Arc<CallRecordings>,
        clipboard: Arc<ClipboardState>,
        platform: String,
        app_version: String,
        is_packaged: bool,
    ) -> Self {
        Self {
            store,
            bridge,
            host_log,
            brc39_archive,
            call_recordings,
            clipboard,
            platform,
            app_version,
            is_packaged,
        }
    }
}

pub enum HostReply {
    Ok { id: String, value: Value },
    Err { id: String, error: String },
    FocusWindow { id: String },
    ReleasePromptFocus { id: String },
    StartWindowDrag { id: String },
    CopyScreenshot { id: String },
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

pub fn dispatch(state: &HostState, id: String, method: &str, params: &Value) -> HostReply {
    match method {
        "getAppInfo" => HostReply::Ok {
            id,
            value: json!({
                "version": state.app_version,
                "name": "HandCash",
                "isPackaged": state.is_packaged,
                "platform": state.platform,
            }),
        },
        "getBridgeStatus" => HostReply::Ok {
            id,
            value: state.bridge.status_snapshot(),
        },
        "restartBridge" => {
            state.bridge.stop();
            state.bridge.start_if_needed();
            HostReply::Ok {
                id,
                value: state.bridge.status_snapshot(),
            }
        }
        "announceBridgeReady" => {
            state.bridge.mark_renderer_ready();
            HostReply::Ok {
                id,
                value: Value::Bool(true),
            }
        }
        "respondHttp" => {
            if let Some(payload) = params.get("response") {
                state.bridge.deliver_http_response(payload);
            }
            HostReply::Ok {
                id,
                value: Value::Bool(true),
            }
        }
        "notePromptOpen" => {
            let open = params.get("open").and_then(|v| v.as_bool()).unwrap_or(false);
            state.bridge.set_prompt_open(open);
            HostReply::Ok {
                id,
                value: Value::Bool(true),
            }
        }
        "respondDevicePeerHttp" => {
            if let Some(payload) = params.get("response") {
                state.bridge.deliver_device_peer_response(payload);
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
        "focusWindow" => HostReply::FocusWindow { id },
        "releasePromptFocus" => HostReply::ReleasePromptFocus { id },
        "startWindowDrag" => HostReply::StartWindowDrag { id },
        "clipboardWrite" => {
            let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            match state.clipboard.write_text(text) {
                Ok(()) => HostReply::Ok {
                    id,
                    value: Value::Bool(true),
                },
                Err(e) => HostReply::Err { id, error: e },
            }
        }
        "clipboardWriteImage" => {
            let mime = params.get("mime").and_then(|v| v.as_str()).unwrap_or("");
            let base64 = params.get("base64").and_then(|v| v.as_str()).unwrap_or("");
            match state.clipboard.write_image_base64(mime, base64) {
                Ok(()) => HostReply::Ok {
                    id,
                    value: Value::Bool(true),
                },
                Err(e) => HostReply::Err { id, error: e },
            }
        }
        "copyScreenshot" => HostReply::CopyScreenshot { id },
        "saveBackupFile" => match dialogs::parse_backup_params(params) {
            Ok(backup) => HostReply::SaveBackupFile { id, backup },
            Err(error) => HostReply::Ok {
                id,
                value: json!({ "ok": false, "error": error }),
            },
        },
        "saveImageFile" => match dialogs::parse_image_params(params) {
            Ok(image) => HostReply::SaveImageFile { id, image },
            Err(error) => HostReply::Ok {
                id,
                value: json!({ "ok": false, "error": error }),
            },
        },
        "getLogInfo" => HostReply::Ok {
            id,
            value: state.host_log.get_log_info(),
        },
        "openLogs" => HostReply::Ok {
            id,
            value: state.host_log.open_logs(),
        },
        "readLogs" => {
            let max_bytes = params.get("maxBytes").and_then(|v| v.as_u64());
            HostReply::Ok {
                id,
                value: state.host_log.read_logs(max_bytes),
            }
        }
        "uploadLogs" => HostReply::Ok {
            id,
            value: HostLog::upload_logs_denied(),
        },
        "getOmarchyTheme" => HostReply::Ok {
            id,
            value: omarchy_theme::read_omarchy_theme(),
        },
        "archiveBrc39Snapshot" => {
            let Some(identity_key) = params.get("identityKey").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "Invalid UTXO archive payload".into(),
                };
            };
            let Some(bytes_b64) = params.get("bytesBase64").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "Invalid UTXO archive payload".into(),
                };
            };
            let exported_at = params.get("exportedAt").and_then(|v| v.as_u64());
            match state
                .brc39_archive
                .write_snapshot(identity_key, bytes_b64, exported_at)
            {
                Ok(value) => HostReply::Ok { id, value },
                Err(error) => HostReply::Err { id, error },
            }
        }
        "listBrc39Archive" => {
            let identity_key = params
                .get("identityKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            HostReply::Ok {
                id,
                value: state.brc39_archive.list_identity_json(identity_key),
            }
        }
        "readBrc39Archive" => {
            let Some(identity_key) = params.get("identityKey").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "Invalid UTXO archive read".into(),
                };
            };
            let Some(snap_id) = params.get("id").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "Invalid UTXO archive read".into(),
                };
            };
            match state.brc39_archive.read_snapshot(identity_key, snap_id) {
                Ok(value) => HostReply::Ok { id, value },
                Err(error) => HostReply::Err { id, error },
            }
        }
        "brc39ArchiveRoot" => HostReply::Ok {
            id,
            value: Value::String(state.brc39_archive.root_path()),
        },
        "appendCallRecording" => {
            let identity_key = params
                .get("identityKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rec_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let Some(seq) = params.get("seq").and_then(|v| v.as_u64()) else {
                return HostReply::Err {
                    id,
                    error: "Invalid call recording part number".into(),
                };
            };
            let sealed = params
                .get("sealedBase64")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match state
                .call_recordings
                .append_part(identity_key, rec_id, seq, sealed)
            {
                Ok(()) => HostReply::Ok {
                    id,
                    value: Value::Bool(true),
                },
                Err(error) => HostReply::Err { id, error },
            }
        }
        "finishCallRecording" => {
            let identity_key = params
                .get("identityKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rec_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let sealed_meta = params
                .get("sealedMetaBase64")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match state
                .call_recordings
                .finish_recording(identity_key, rec_id, sealed_meta)
            {
                Ok(()) => HostReply::Ok {
                    id,
                    value: Value::Bool(true),
                },
                Err(error) => HostReply::Err { id, error },
            }
        }
        "readCallRecording" => {
            let identity_key = params
                .get("identityKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rec_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
            match state.call_recordings.read_recording(identity_key, rec_id) {
                Ok(value) => HostReply::Ok { id, value },
                Err(error) => HostReply::Err { id, error },
            }
        }
        "deleteCallRecording" => {
            let identity_key = params
                .get("identityKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rec_id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
            match state.call_recordings.delete_recording(identity_key, rec_id) {
                Ok(()) => HostReply::Ok {
                    id,
                    value: Value::Bool(true),
                },
                Err(error) => HostReply::Err { id, error },
            }
        }
        "appBrowserGuestCreate" => {
            let Some(guest_id) = params.get("id").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "id and url required".into(),
                };
            };
            let Some(url) = params.get("url").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "id and url required".into(),
                };
            };
            HostReply::AppBrowserCreate {
                id,
                guest_id: guest_id.to_string(),
                url: url.to_string(),
                bounds: GuestBounds::from_params(params),
            }
        }
        "appBrowserGuestSetBounds" => {
            let Some(guest_id) = params.get("id").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "id required".into(),
                };
            };
            HostReply::AppBrowserSetBounds {
                id,
                guest_id: guest_id.to_string(),
                bounds: GuestBounds::from_params(params),
            }
        }
        "appBrowserGuestNavigate" => {
            let Some(guest_id) = params.get("id").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "id and action required".into(),
                };
            };
            let Some(action) = params.get("action").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "id and action required".into(),
                };
            };
            HostReply::AppBrowserNavigate {
                id,
                guest_id: guest_id.to_string(),
                action: action.to_string(),
            }
        }
        "appBrowserGuestCapture" => {
            let Some(guest_id) = params.get("id").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "id required".into(),
                };
            };
            let width = params
                .get("width")
                .and_then(|v| v.as_f64())
                .map(|w| w.round() as i32)
                .unwrap_or(0);
            HostReply::AppBrowserCapture {
                id,
                guest_id: guest_id.to_string(),
                width,
            }
        }
        "appBrowserGuestDestroy" => {
            let guest_id = params
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            HostReply::AppBrowserDestroy { id, guest_id }
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

pub fn reply_ok_script(id: &str, value: &Value) -> String {
    let body = json!({ "id": id, "ok": true, "value": value });
    format!("window.__handcashNativeReply && window.__handcashNativeReply({body})")
}

pub fn reply_err_script(id: &str, error: &str) -> String {
    let body = json!({ "id": id, "ok": false, "error": error });
    format!("window.__handcashNativeReply && window.__handcashNativeReply({body})")
}

pub fn reply_script(reply: &HostReply) -> Option<String> {
    match reply {
        HostReply::Ok { id, value } => Some(reply_ok_script(id, value)),
        HostReply::Err { id, error } => Some(reply_err_script(id, error)),
        _ => None,
    }
}

pub fn push_script(channel: &str, payload: &Value) -> String {
    let body = json!({ "channel": channel, "payload": payload });
    format!("window.__handcashNativePush && window.__handcashNativePush({body})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_state(label: &str) -> (std::path::PathBuf, HostState) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-bridge-{label}-{stamp}"));
        let store = DurableStore::open(dir.join("durable")).unwrap();
        let host_log = HostLog::open(dir.join("logs"));
        let bridge = Brc100Bridge::new(dir.clone(), Arc::clone(&host_log));
        let brc39 = Arc::new(Brc39Archive::open(dir.join("brc39-archive")));
        let recs = Arc::new(CallRecordings::open(dir.join("call-recordings")));
        let clipboard = Arc::new(ClipboardState::default());
        let state = HostState::new(
            store,
            bridge,
            host_log,
            brc39,
            recs,
            clipboard,
            "linux".into(),
            "1.3.718".into(),
            true,
        );
        (dir, state)
    }

    #[test]
    fn dispatches_app_info_bridge_status_logs_archive_and_recordings() {
        let (dir, state) = test_state("parity");

        match dispatch(&state, "1".into(), "getAppInfo", &json!({})) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["version"], json!("1.3.718"));
                assert_eq!(value["isPackaged"], Value::Bool(true));
                assert_eq!(value["platform"], json!("linux"));
            }
            _ => panic!("expected Ok"),
        }

        match dispatch(&state, "2".into(), "getBridgeStatus", &json!({})) {
            HostReply::Ok { value, .. } => {
                assert!(value.get("error").is_some());
                assert_eq!(value["online"], Value::Bool(false));
            }
            _ => panic!("expected Ok"),
        }

        match dispatch(&state, "3".into(), "readLogs", &json!({ "maxBytes": 8192 })) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["ok"], Value::Bool(true));
                assert!(value["text"]
                    .as_str()
                    .unwrap()
                    .contains("handcash-shell log initialized"));
            }
            _ => panic!("expected Ok"),
        }

        match dispatch(&state, "4".into(), "uploadLogs", &json!({ "url": "https://x" })) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["ok"], Value::Bool(false));
            }
            _ => panic!("expected Ok"),
        }

        // BRC-39 archive round trip via IPC dispatch.
        let id_key = "02".to_string() + &"ab".repeat(32);
        let snap_b64 = B64.encode(vec![7u8; 96]);
        let snap_id = match dispatch(
            &state,
            "5".into(),
            "archiveBrc39Snapshot",
            &json!({ "identityKey": id_key, "bytesBase64": snap_b64, "exportedAt": 12345 }),
        ) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["created"], Value::Bool(true));
                value["meta"]["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected Ok"),
        };

        match dispatch(
            &state,
            "6".into(),
            "readBrc39Archive",
            &json!({ "identityKey": id_key, "id": snap_id }),
        ) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["bytesBase64"], json!(snap_b64));
            }
            _ => panic!("expected Ok"),
        }

        // Call recording round trip via IPC dispatch.
        let rec_id = "0123456789abcdef0123456789abcdef";
        assert!(matches!(
            dispatch(
                &state,
                "7".into(),
                "appendCallRecording",
                &json!({ "identityKey": id_key, "id": rec_id, "seq": 0, "sealedBase64": B64.encode(b"part0") })
            ),
            HostReply::Ok { .. }
        ));
        assert!(matches!(
            dispatch(
                &state,
                "8".into(),
                "finishCallRecording",
                &json!({ "identityKey": id_key, "id": rec_id, "sealedMetaBase64": B64.encode(b"meta") })
            ),
            HostReply::Ok { .. }
        ));
        match dispatch(
            &state,
            "9".into(),
            "readCallRecording",
            &json!({ "identityKey": id_key, "id": rec_id }),
        ) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["meta"], json!(B64.encode(b"meta")));
                assert_eq!(value["parts"], json!([B64.encode(b"part0")]));
            }
            _ => panic!("expected Ok"),
        }

        // External URL guard rejects file://.
        assert!(matches!(
            dispatch(
                &state,
                "10".into(),
                "openExternal",
                &json!({ "url": "file:///etc/passwd" })
            ),
            HostReply::Err { .. }
        ));

        let _ = fs::remove_dir_all(dir);
    }
}
