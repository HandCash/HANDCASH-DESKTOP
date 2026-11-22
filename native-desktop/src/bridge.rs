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
use crate::wallet_core;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use handcash_engine::WalletEngine;
use handcash_storage::ToolboxDbManager;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

struct ToolboxTxLease {
    trx_id: u64,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

/// Async coordinator for `ToolboxDbManager` on the Tokio engine runtime.
///
/// - Standalone reads run concurrently on each DB's 4-connection WAL `ReaderPool`
///   with zero writer lock contention.
/// - Standalone writes and multi-call `beginTx..commitTx` transactions serialize
///   asynchronously via a per-DB `tokio::sync::Mutex<()>` without ever parking
///   Tokio worker threads.
pub struct ToolboxAsyncRuntime {
    manager: Arc<ToolboxDbManager>,
    writer_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    active_txs: Mutex<HashMap<String, ToolboxTxLease>>,
}

impl ToolboxAsyncRuntime {
    pub fn new(manager: Arc<ToolboxDbManager>) -> Self {
        Self {
            manager,
            writer_locks: Mutex::new(HashMap::new()),
            active_txs: Mutex::new(HashMap::new()),
        }
    }

    fn writer_lock(&self, db_name: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.writer_locks.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            map.entry(db_name.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    pub async fn dispatch(
        &self,
        db_name: &str,
        op: &str,
        params: Value,
    ) -> Result<Value, String> {
        if db_name.trim().is_empty() {
            return Err("toolboxDbOp: missing dbName".into());
        }
        match op {
            "exists" => Ok(Value::Bool(self.manager.exists_on_disk(db_name))),
            "identitySummary" => {
                let mgr = Arc::clone(&self.manager);
                let name = db_name.to_string();
                tokio::task::spawn_blocking(move || {
                    let Some(db) = mgr.open_if_exists(&name)? else {
                        return Ok(json!({ "stored": false, "txCount": Value::Null }));
                    };
                    db.execute_read("identitySummary", &params, None)
                })
                .await
                .map_err(|e| format!("toolboxDbOp join error: {e}"))?
            }
            "open" => {
                let lock = self.writer_lock(db_name);
                let _guard = lock.lock_owned().await;
                let mgr = Arc::clone(&self.manager);
                let name = db_name.to_string();
                tokio::task::spawn_blocking(move || {
                    let db = mgr.get_or_open(&name)?;
                    let settings = if params
                        .get("storageIdentityKey")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| !s.is_empty())
                    {
                        db.execute_write("ensureSettings", &params, None)?
                    } else {
                        db.execute_read("readSettings", &json!({}), None)?
                    };
                    let migrated = db
                        .execute_read("getMeta", &json!({ "key": "migrated_from_idb" }), None)?
                        .as_str()
                        == Some("1");
                    let counts = db.execute_read("tableCounts", &json!({}), None)?;
                    Ok(json!({
                        "settings": settings,
                        "migratedFromIdb": migrated,
                        "counts": counts,
                    }))
                })
                .await
                .map_err(|e| format!("toolboxDbOp join error: {e}"))?
            }
            "close" => {
                let dropped_lease = {
                    let mut map = self.active_txs.lock().unwrap_or_else(|e| e.into_inner());
                    map.remove(db_name)
                };
                if dropped_lease.is_some() {
                    // Lease dropped after closing rolls back any active tx inside `manager.close`.
                    let mgr = Arc::clone(&self.manager);
                    let name = db_name.to_string();
                    let res = tokio::task::spawn_blocking(move || mgr.close(&name))
                        .await
                        .map_err(|e| format!("toolboxDbOp close error: {e}"))?;
                    drop(dropped_lease);
                    return Ok(res);
                }
                let lock = self.writer_lock(db_name);
                let _guard = lock.lock_owned().await;
                let mgr = Arc::clone(&self.manager);
                let name = db_name.to_string();
                tokio::task::spawn_blocking(move || mgr.close(&name))
                    .await
                    .map_err(|e| format!("toolboxDbOp close error: {e}"))
            }
            "dropAllData" => {
                let dropped_lease = {
                    let mut map = self.active_txs.lock().unwrap_or_else(|e| e.into_inner());
                    map.remove(db_name)
                };
                if dropped_lease.is_some() {
                    let mgr = Arc::clone(&self.manager);
                    let name = db_name.to_string();
                    let res = tokio::task::spawn_blocking(move || mgr.drop_all_data(&name))
                        .await
                        .map_err(|e| format!("toolboxDbOp dropAllData error: {e}"))?;
                    drop(dropped_lease);
                    return res;
                }
                let lock = self.writer_lock(db_name);
                let _guard = lock.lock_owned().await;
                let mgr = Arc::clone(&self.manager);
                let name = db_name.to_string();
                tokio::task::spawn_blocking(move || mgr.drop_all_data(&name))
                    .await
                    .map_err(|e| format!("toolboxDbOp dropAllData error: {e}"))?
            }
            "beginTx" => {
                let lock = self.writer_lock(db_name);
                let guard = lock.lock_owned().await;
                let mgr = Arc::clone(&self.manager);
                let name = db_name.to_string();
                let trx_id = tokio::task::spawn_blocking(move || {
                    let db = mgr.get_or_open(&name)?;
                    db.begin_tx()
                })
                .await
                .map_err(|e| format!("toolboxDbOp beginTx join: {e}"))??;
                {
                    let mut map = self.active_txs.lock().unwrap_or_else(|e| e.into_inner());
                    map.insert(
                        db_name.to_string(),
                        ToolboxTxLease {
                            trx_id,
                            _guard: guard,
                        },
                    );
                }
                Ok(json!({ "trxId": trx_id }))
            }
            "commitTx" => {
                let trx_id = params
                    .get("trxId")
                    .and_then(|v| v.as_u64())
                    .ok_or("commitTx: missing trxId")?;
                let lease = {
                    let mut map = self.active_txs.lock().unwrap_or_else(|e| e.into_inner());
                    match map.get(db_name) {
                        Some(l) if l.trx_id == trx_id => map.remove(db_name),
                        _ => None,
                    }
                };
                let mgr = Arc::clone(&self.manager);
                let name = db_name.to_string();
                let res = tokio::task::spawn_blocking(move || {
                    let db = mgr.get_or_open(&name)?;
                    db.commit_tx(trx_id)
                })
                .await
                .map_err(|e| format!("toolboxDbOp commitTx join: {e}"))?;
                drop(lease);
                res?;
                Ok(Value::Bool(true))
            }
            "rollbackTx" => {
                let trx_id = params
                    .get("trxId")
                    .and_then(|v| v.as_u64())
                    .ok_or("rollbackTx: missing trxId")?;
                let lease = {
                    let mut map = self.active_txs.lock().unwrap_or_else(|e| e.into_inner());
                    match map.get(db_name) {
                        Some(l) if l.trx_id == trx_id => map.remove(db_name),
                        _ => None,
                    }
                };
                let mgr = Arc::clone(&self.manager);
                let name = db_name.to_string();
                let res = tokio::task::spawn_blocking(move || {
                    let db = mgr.get_or_open(&name)?;
                    db.rollback_tx(trx_id)
                })
                .await
                .map_err(|e| format!("toolboxDbOp rollbackTx join: {e}"))?;
                drop(lease);
                res?;
                Ok(Value::Bool(true))
            }
            other => {
                let trx_id = params.get("trxId").and_then(|v| v.as_u64());
                let is_read = handcash_storage::toolbox_db::is_read_op(other);
                let mgr = Arc::clone(&self.manager);
                let name = db_name.to_string();
                let op_owned = other.to_string();
                if is_read {
                    tokio::task::spawn_blocking(move || {
                        let db = mgr.get_or_open(&name)?;
                        db.execute_read(&op_owned, &params, trx_id)
                    })
                    .await
                    .map_err(|e| format!("toolboxDbOp read join: {e}"))?
                } else if trx_id.is_some() {
                    tokio::task::spawn_blocking(move || {
                        let db = mgr.get_or_open(&name)?;
                        db.execute_write(&op_owned, &params, trx_id)
                    })
                    .await
                    .map_err(|e| format!("toolboxDbOp tx write join: {e}"))?
                } else {
                    let lock = self.writer_lock(db_name);
                    let _guard = lock.lock_owned().await;
                    tokio::task::spawn_blocking(move || {
                        let db = mgr.get_or_open(&name)?;
                        db.execute_write(&op_owned, &params, None)
                    })
                    .await
                    .map_err(|e| format!("toolboxDbOp write join: {e}"))?
                }
            }
        }
    }
}

pub struct HostState {
    pub updater: Arc<crate::release_update::ReleaseUpdater>,
    pub store: Arc<DurableStore>,
    pub bridge: Arc<Brc100Bridge>,
    pub host_log: Arc<HostLog>,
    pub brc39_archive: Arc<Brc39Archive>,
    pub call_recordings: Arc<CallRecordings>,
    pub clipboard: Arc<ClipboardState>,
    pub engine: Arc<WalletEngine>,
    pub toolbox_db: Arc<ToolboxAsyncRuntime>,
    pub request_guard: Mutex<wallet_core::contract::RequestGuard>,
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
        engine: Arc<WalletEngine>,
        toolbox_db: Arc<ToolboxDbManager>,
        platform: String,
        app_version: String,
        is_packaged: bool,
    ) -> Self {
        Self {
            updater: crate::release_update::ReleaseUpdater::new(
                Arc::clone(&store),
                &app_version,
                &platform,
            ),
            store,
            bridge,
            host_log,
            brc39_archive,
            call_recordings,
            clipboard,
            engine,
            toolbox_db: Arc::new(ToolboxAsyncRuntime::new(toolbox_db)),
            request_guard: Mutex::new(wallet_core::contract::RequestGuard::default()),
            platform,
            app_version,
            is_packaged,
        }
    }
}

/// True for IPC methods that run on the background Tokio engine runtime rather than the UI thread.
pub fn is_async_method(method: &str) -> bool {
    matches!(
        method,
        "checkForUpdates"
            | "downloadUpdate"
            | "installUpdate"
            | "archiveBrc39Snapshot"
            | "toolboxDbOp"
            | "engineStatus"
            | "engineActivateAccount"
            | "engineLock"
            | "engineImportBrc38"
            | "engineReadBalance"
            | "engineReadItemsPage"
            | "engineReadActivityPage"
            | "engineEncryptBrc39"
            | "engineDecryptBrc39"
            | "engineHydrateInputs"
            | "engineVerifyBeef"
            | "engineVerifyBrc150"
            | "engineSyncHeaders"
            | "engineRunProofPoll"
            | "engineRunBrc150Pass"
            | "engineSealDeltaSegment"
    )
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
        "getUpdateStatus" => HostReply::Ok { id, value: state.updater.status() },
        "checkForUpdates" => HostReply::Ok { id, value: state.updater.check(false) },
        "downloadUpdate" | "installUpdate" => HostReply::Ok { id, value: state.updater.download() },
        "setUpdateMode" => match state.updater.mode(params["mode"].as_str().unwrap_or("")) {
            Ok(value) => HostReply::Ok { id, value },
            Err(error) => HostReply::Err { id, error },
        },
        "startUpdateChecks" => { state.updater.start(); HostReply::Ok { id, value: Value::Null } },
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
        "storageSetAsync" => {
            let key = params
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let value = params
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let allow = params
                .get("allow")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let store = Arc::clone(&state.store);
            std::thread::spawn(move || {
                let _ = store.set(&key, &value, allow);
            });
            HostReply::Ok {
                id,
                value: Value::Bool(true),
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
        "walletCoreInfo" => HostReply::Ok {
            id,
            value: wallet_core::core_info(),
        },
        "walletCoreStrictHex" => {
            let Some(input) = params.get("hex").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "missing hex string".into(),
                };
            };
            match wallet_core::encoding::decode_hex(input) {
                Ok(bytes) => HostReply::Ok {
                    id,
                    value: json!({
                        "ok": true,
                        "byteLength": bytes.len(),
                        "canonicalHex": wallet_core::encoding::encode_hex(&bytes),
                        "sha256": wallet_core::encoding::encode_hex(&wallet_core::encoding::sha256(&bytes)),
                    }),
                },
                Err(err) => HostReply::Ok {
                    id,
                    value: json!({ "ok": false, "error": err.to_string() }),
                },
            }
        },
        "walletCoreValidateRequest" => {
            let req: wallet_core::contract::ScopedRequest =
                match serde_json::from_value(params.get("request").cloned().unwrap_or(Value::Null))
                {
                    Ok(v) => v,
                    Err(e) => {
                        return HostReply::Ok {
                            id,
                            value: json!({ "ok": false, "reason": "invalid_schema", "detail": e.to_string() }),
                        };
                    }
                };
            let session: wallet_core::contract::AuthenticatedSession =
                match serde_json::from_value(params.get("session").cloned().unwrap_or(Value::Null))
                {
                    Ok(v) => v,
                    Err(e) => {
                        return HostReply::Ok {
                            id,
                            value: json!({ "ok": false, "reason": "invalid_session", "detail": e.to_string() }),
                        };
                    }
                };
            let grant: wallet_core::contract::PermissionGrant =
                match serde_json::from_value(params.get("grant").cloned().unwrap_or(Value::Null))
                {
                    Ok(v) => v,
                    Err(e) => {
                        return HostReply::Ok {
                            id,
                            value: json!({ "ok": false, "reason": "invalid_grant", "detail": e.to_string() }),
                        };
                    }
                };
            let Some(now_ms) = params.get("nowMs").and_then(|v| v.as_u64()) else {
                return HostReply::Err {
                    id,
                    error: "missing nowMs".into(),
                };
            };
            let mut guard = state
                .request_guard
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match guard.validate(&req, &session, &grant, now_ms) {
                Ok(()) => HostReply::Ok {
                    id,
                    value: json!({ "ok": true }),
                },
                Err(reason) => HostReply::Ok {
                    id,
                    value: json!({ "ok": false, "reason": reason }),
                },
            }
        },
        "toolboxDbOp" => state
            .engine
            .runtime_handle()
            .block_on(dispatch_toolbox_db_async(state, id, params)),
        "engineStatus"
        | "engineActivateAccount"
        | "engineLock"
        | "engineImportBrc38"
        | "engineReadBalance"
        | "engineReadItemsPage"
        | "engineReadActivityPage"
        | "engineEncryptBrc39"
        | "engineDecryptBrc39"
        | "engineHydrateInputs"
        | "engineVerifyBeef"
        | "engineVerifyBrc150"
        | "engineSyncHeaders"
        | "engineRunProofPoll"
        | "engineRunBrc150Pass"
        | "engineSealDeltaSegment" => state
            .engine
            .runtime_handle()
            .block_on(dispatch_engine_async(state, id, method, params)),
        other => HostReply::Err {
            id,
            error: format!("stub: {other} not implemented in thin desktop shell"),
        },
    }
}

/// Async dispatch entry for the Tokio engine runtime (never touches the GTK/wry UI thread).
pub async fn dispatch_async(
    state: Arc<HostState>,
    id: String,
    method: String,
    params: Value,
) -> HostReply {
    match method.as_str() {
        "toolboxDbOp" => dispatch_toolbox_db_async(&state, id, &params).await,
        "engineStatus"
        | "engineActivateAccount"
        | "engineLock"
        | "engineImportBrc38"
        | "engineReadBalance"
        | "engineReadItemsPage"
        | "engineReadActivityPage"
        | "engineEncryptBrc39"
        | "engineDecryptBrc39"
        | "engineHydrateInputs"
        | "engineVerifyBeef"
        | "engineVerifyBrc150"
        | "engineSyncHeaders"
        | "engineRunProofPoll"
        | "engineRunBrc150Pass"
        | "engineSealDeltaSegment" => dispatch_engine_async(&state, id, &method, &params).await,
        _ => tokio::task::spawn_blocking(move || dispatch(&state, id, &method, &params))
            .await
            .unwrap_or_else(|e| HostReply::Err {
                id: String::new(),
                error: format!("async host task failed: {e}"),
            }),
    }
}

async fn dispatch_toolbox_db_async(
    state: &HostState,
    id: String,
    params: &Value,
) -> HostReply {
    let db_name = params.get("dbName").and_then(|v| v.as_str()).unwrap_or("");
    let op = params.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let op_params = params
        .get("params")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match state.toolbox_db.dispatch(db_name, op, op_params).await {
        Ok(value) => HostReply::Ok { id, value },
        Err(error) => HostReply::Err { id, error },
    }
}

async fn dispatch_engine_async(
    state: &HostState,
    id: String,
    method: &str,
    params: &Value,
) -> HostReply {
    match method {
        "engineStatus" => HostReply::Ok {
            id,
            value: state.engine.status(),
        },
        "engineActivateAccount" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match state.engine.activate_account(account_id) {
                Ok(res) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(res).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineLock" => {
            state.engine.lock();
            HostReply::Ok {
                id,
                value: Value::Bool(true),
            }
        }
        "engineImportBrc38" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let json_str = params
                .get("json")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            match state
                .engine
                .import_brc38(account_id, generation, json_str)
                .await
            {
                Ok(stats) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(stats).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineReadBalance" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            match state.engine.read_balance(account_id, generation).await {
                Ok(bal) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(bal).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineReadItemsPage" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let basket = params
                .get("basket")
                .and_then(|v| v.as_str())
                .unwrap_or("1sat")
                .to_string();
            let limit = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50) as usize;
            let cursor = params
                .get("cursor")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    if arr.len() == 2 {
                        Some((arr[0].as_i64()?, arr[1].as_str()?.to_string()))
                    } else {
                        None
                    }
                });
            match state
                .engine
                .read_items_page(account_id, generation, basket, cursor, limit)
                .await
            {
                Ok(page) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(page).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineReadActivityPage" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let limit = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50) as usize;
            let cursor = params
                .get("cursor")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    if arr.len() == 2 {
                        Some((arr[0].as_i64()?, arr[1].as_str()?.to_string()))
                    } else {
                        None
                    }
                });
            match state
                .engine
                .read_activity_page(account_id, generation, cursor, limit)
                .await
            {
                Ok(page) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(page).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineEncryptBrc39" => {
            let Some(json_str) = params.get("json").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "missing json".into(),
                };
            };
            let Some(password) = params.get("password").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "missing password".into(),
                };
            };
            match state
                .engine
                .encrypt_brc39_async(json_str.to_string(), password.to_string())
                .await
            {
                Ok(bytes) => HostReply::Ok {
                    id,
                    value: json!({
                        "bytesBase64": BASE64.encode(&bytes),
                        "byteLength": bytes.len(),
                    }),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineDecryptBrc39" => {
            let Some(b64) = params.get("bytesBase64").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "missing bytesBase64".into(),
                };
            };
            let Some(password) = params.get("password").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "missing password".into(),
                };
            };
            let bytes = match BASE64.decode(b64) {
                Ok(b) => b,
                Err(e) => {
                    return HostReply::Err {
                        id,
                        error: format!("invalid base64: {e}"),
                    };
                }
            };
            match state
                .engine
                .decrypt_brc39_async(bytes, password.to_string())
                .await
            {
                Ok(json_str) => HostReply::Ok {
                    id,
                    value: json!({ "json": json_str }),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineHydrateInputs" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let allow_raw = params
                .get("allowRaw")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let txids: Vec<String> = params
                .get("txids")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            match state
                .engine
                .hydrate_input_txids(account_id, generation, txids, allow_raw)
                .await
            {
                Ok(res) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(res).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineVerifyBeef" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let Some(b64) = params.get("beefBase64").and_then(|v| v.as_str()) else {
                return HostReply::Err {
                    id,
                    error: "missing beefBase64".into(),
                };
            };
            let bytes = match BASE64.decode(b64) {
                Ok(b) => b,
                Err(e) => {
                    return HostReply::Err {
                        id,
                        error: format!("invalid base64: {e}"),
                    };
                }
            };
            let subject_txid = params
                .get("subjectTxid")
                .and_then(|v| v.as_str())
                .map(String::from);
            match state
                .engine
                .verify_beef_spv(account_id, generation, bytes, subject_txid)
                .await
            {
                Ok(res) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(res).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineVerifyBrc150" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let tip_outpoint = params
                .get("tipOutpoint")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let expected_origin = params
                .get("expectedOrigin")
                .and_then(|v| v.as_str())
                .map(String::from);
            let seed_beef_bytes = params
                .get("beefBase64")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .and_then(|b64| BASE64.decode(b64).ok());
            match state
                .engine
                .verify_brc150(
                    account_id,
                    generation,
                    tip_outpoint,
                    expected_origin,
                    seed_beef_bytes,
                )
                .await
            {
                Ok(verdict) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(verdict).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineSyncHeaders" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            match state.engine.sync_headers(account_id, generation).await {
                Ok(tip) => HostReply::Ok {
                    id,
                    value: json!({ "tipHeight": tip }),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineRunProofPoll" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            match state.engine.run_proof_poll(account_id, generation).await {
                Ok(summary) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(summary).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineRunBrc150Pass" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let max_items = params
                .get("maxItems")
                .and_then(|v| v.as_u64())
                .unwrap_or(2) as usize;
            match state
                .engine
                .run_brc150_pass(account_id, generation, max_items)
                .await
            {
                Ok(proven) => HostReply::Ok {
                    id,
                    value: json!({ "provenCount": proven }),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        "engineSealDeltaSegment" => {
            let account_id = params
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let generation = params
                .get("generation")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            match state.engine.seal_delta_segment(account_id, generation).await {
                Ok(seg) => HostReply::Ok {
                    id,
                    value: serde_json::to_value(seg).unwrap_or(Value::Null),
                },
                Err(e) => HostReply::Err {
                    id,
                    error: e.to_string(),
                },
            }
        }
        other => HostReply::Err {
            id,
            error: format!("unknown engine method: {other}"),
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

    #[test]
    fn update_ipc_validates_modes_and_never_fetches_when_disabled() {
        let (dir, state) = test_state("update");
        assert!(matches!(dispatch(&state, "1".into(), "setUpdateMode", &json!({"mode":"invalid"})), HostReply::Err { .. }));
        assert!(matches!(dispatch(&state, "2".into(), "setUpdateMode", &json!({"mode":"none"})), HostReply::Ok { .. }));
        match dispatch(&state, "3".into(), "checkForUpdates", &Value::Null) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["mode"], "none");
                assert_eq!(value["error"], "Updates are off.");
            }
            _ => panic!("missing native update response"),
        }
        drop(state);
        fs::remove_dir_all(dir).unwrap();
    }

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
        let engine = WalletEngine::open(dir.clone(), false).unwrap();
        let toolbox_db = Arc::new(ToolboxDbManager::new(dir.clone()));
        let state = HostState::new(
            store,
            bridge,
            host_log,
            brc39,
            recs,
            clipboard,
            engine,
            toolbox_db,
            "linux".into(),
            "1.3.718".into(),
            true,
        );
        (dir, state)
    }

    #[test]
    fn dispatches_engine_sqlite_wal_activate_import_and_paged_reads() {
        let (dir, state) = test_state("engine-wal");

        let act = match dispatch(
            &state,
            "e1".into(),
            "engineActivateAccount",
            &json!({ "accountId": "acct-wal-1" }),
        ) {
            HostReply::Ok { value, .. } => value,
            _ => panic!("expected Ok"),
        };
        assert_eq!(act["accountId"], json!("acct-wal-1"));
        assert_eq!(act["generation"], json!(1));

        let brc38 = json!({
            "brc": 38,
            "schema": "brc-38",
            "tables": {
                "outputBaskets": [
                    { "basketId": 1, "name": "default" },
                    { "basketId": 2, "name": "1sat" }
                ],
                "transactions": [
                    { "transactionId": 1, "txid": "aa".repeat(32), "status": "completed", "isOutgoing": false, "satoshis": 12345, "description": "Seed" }
                ],
                "outputs": [
                    { "outputId": 1, "transactionId": 1, "vout": 0, "satoshis": 12345, "basketId": 1, "spendable": true, "change": true },
                    { "outputId": 2, "transactionId": 1, "vout": 1, "satoshis": 1, "basketId": 2, "spendable": true, "change": false }
                ]
            }
        });
        let imported = match dispatch(
            &state,
            "e2".into(),
            "engineImportBrc38",
            &json!({ "accountId": "acct-wal-1", "generation": 1, "json": brc38.to_string() }),
        ) {
            HostReply::Ok { value, .. } => value,
            HostReply::Err { error, .. } => panic!("import failed: {error}"),
            _ => panic!("unexpected reply"),
        };
        assert_eq!(imported["utxos"], json!(2));
        assert_eq!(imported["items"], json!(1));

        let bal = match dispatch(
            &state,
            "e3".into(),
            "engineReadBalance",
            &json!({ "accountId": "acct-wal-1", "generation": 1 }),
        ) {
            HostReply::Ok { value, .. } => value,
            _ => panic!("expected balance Ok"),
        };
        assert_eq!(bal["spendableSats"], json!(12345));
        assert_eq!(bal["itemCount"], json!(1));

        let page = match dispatch(
            &state,
            "e4".into(),
            "engineReadItemsPage",
            &json!({ "accountId": "acct-wal-1", "generation": 1, "basket": "1sat", "limit": 25 }),
        ) {
            HostReply::Ok { value, .. } => value,
            _ => panic!("expected items page Ok"),
        };
        assert_eq!(page["total"], json!(1));

        drop(state);
        fs::remove_dir_all(dir).unwrap();
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

    #[test]
    fn wallet_core_ipc_dispatches_info_hex_and_scoped_request_guard() {
        let (dir, state) = test_state("wallet-core");
        match dispatch(&state, "1".into(), "walletCoreInfo", &json!({})) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["contractVersion"], json!(1));
                assert_eq!(value["license"], json!("Apache-2.0"));
                assert_eq!(value["maxPageSlice"], json!(100));
            }
            _ => panic!("expected Ok"),
        }
        match dispatch(&state, "2".into(), "walletCoreStrictHex", &json!({ "hex": "00Ab" })) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["ok"], Value::Bool(true));
                assert_eq!(value["byteLength"], json!(2));
                assert_eq!(value["canonicalHex"], json!("00ab"));
            }
            _ => panic!("expected Ok"),
        }
        match dispatch(&state, "3".into(), "walletCoreStrictHex", &json!({ "hex": " 00" })) {
            HostReply::Ok { value, .. } => assert_eq!(value["ok"], Value::Bool(false)),
            _ => panic!("expected Ok"),
        }
        let valid_payload = json!({
            "nowMs": 1000,
            "session": {
                "origin": "https://app.example",
                "sessionId": "s1",
                "activeAccountId": "a1",
                "activeGeneration": 3
            },
            "grant": {
                "origin": "https://app.example",
                "accountId": "a1",
                "chainNetwork": "bsv:mainnet",
                "allowedCapabilities": ["readBalanceView"],
                "maxAmountUnits": null,
                "expiresAtMs": 5000,
                "revoked": false
            },
            "request": {
                "v": 1,
                "requestId": "req-1",
                "origin": "https://app.example",
                "sessionId": "s1",
                "accountId": "a1",
                "generation": 3,
                "chainNetwork": "bsv:mainnet",
                "capability": "readBalanceView",
                "amountUnits": null,
                "expiresAtMs": 4000
            }
        });
        match dispatch(&state, "4".into(), "walletCoreValidateRequest", &valid_payload) {
            HostReply::Ok { value, .. } => assert_eq!(value["ok"], Value::Bool(true)),
            _ => panic!("expected Ok"),
        }
        match dispatch(&state, "5".into(), "walletCoreValidateRequest", &valid_payload) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["ok"], Value::Bool(false));
                assert_eq!(value["reason"], json!("replay_detected"));
            }
            _ => panic!("expected Ok"),
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn toolbox_db_ipc_handles_transactions_reads_and_identity_probe() {
        let (dir, state) = test_state("toolbox-ipc");

        // Probing a non-existent DB does NOT create a file on disk.
        match dispatch(
            &state,
            "t0".into(),
            "toolboxDbOp",
            &json!({ "dbName": "never-opened", "op": "identitySummary", "params": { "identityKey": "02aa" } }),
        ) {
            HostReply::Ok { value, .. } => assert_eq!(value["stored"], Value::Bool(false)),
            other => panic!("unexpected: {:?}", reply_script(&other)),
        }
        match dispatch(
            &state,
            "t0b".into(),
            "toolboxDbOp",
            &json!({ "dbName": "never-opened", "op": "exists", "params": {} }),
        ) {
            HostReply::Ok { value, .. } => assert_eq!(value, Value::Bool(false)),
            _ => panic!("expected Ok"),
        }

        // Open, beginTx, insertUser, commitTx, read back via identitySummary.
        match dispatch(
            &state,
            "t1".into(),
            "toolboxDbOp",
            &json!({
                "dbName": "acct-1",
                "op": "open",
                "params": { "storageName": "acct-1", "storageIdentityKey": "02stor", "chain": "main", "maxOutputScript": 1024 }
            }),
        ) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["settings"]["dbtype"], json!("SQLite"));
                assert_eq!(value["migratedFromIdb"], Value::Bool(false));
            }
            other => panic!("open failed: {:?}", reply_script(&other)),
        }

        let trx_id = match dispatch(
            &state,
            "t2".into(),
            "toolboxDbOp",
            &json!({ "dbName": "acct-1", "op": "beginTx", "params": {} }),
        ) {
            HostReply::Ok { value, .. } => value["trxId"].as_u64().unwrap(),
            other => panic!("beginTx failed: {:?}", reply_script(&other)),
        };

        assert!(matches!(
            dispatch(
                &state,
                "t3".into(),
                "toolboxDbOp",
                &json!({
                    "dbName": "acct-1",
                    "op": "insertUser",
                    "params": { "trxId": trx_id, "row": { "identityKey": "02user", "activeStorage": "02stor" } }
                })
            ),
            HostReply::Ok { .. }
        ));
        assert!(matches!(
            dispatch(
                &state,
                "t4".into(),
                "toolboxDbOp",
                &json!({ "dbName": "acct-1", "op": "commitTx", "params": { "trxId": trx_id } })
            ),
            HostReply::Ok { .. }
        ));
        match dispatch(
            &state,
            "t5".into(),
            "toolboxDbOp",
            &json!({ "dbName": "acct-1", "op": "identitySummary", "params": { "identityKey": "02user" } }),
        ) {
            HostReply::Ok { value, .. } => {
                assert_eq!(value["stored"], Value::Bool(true));
                assert_eq!(value["txCount"], json!(0));
            }
            _ => panic!("expected Ok"),
        }

        drop(state);
        let _ = fs::remove_dir_all(dir);
    }
}
