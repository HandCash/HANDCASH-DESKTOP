//! Append-only on-device BRC-39 (UTXO / localState) archive.
//!
//! Parity with `electron/brc39Archive.ts`:
//! - Snapshots live at `<userData>/brc39-archive/{identity}/{exportedAt}-{sha256[..12]}.brc39`.
//! - Existing snapshots are write-once (never overwritten in place).
//! - Identical content is deduplicated by SHA-256 (`created: false`).
//! - Oldest snapshots beyond `MAX_SNAPSHOTS_PER_IDENTITY` (40) are pruned.
//! - Never wiped by `wipeWalletStorage`.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SNAPSHOTS_PER_IDENTITY: usize = 40;
const MIN_SNAPSHOT_BYTES: usize = 64;

#[derive(Clone, Debug)]
pub struct Brc39ArchiveMeta {
    pub id: String,
    pub identity_key: String,
    pub exported_at: u64,
    pub bytes: u64,
    pub sha256: String,
    pub path: String,
}

impl Brc39ArchiveMeta {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "identityKey": self.identity_key,
            "exportedAt": self.exported_at,
            "bytes": self.bytes,
            "sha256": self.sha256,
            "path": self.path,
        })
    }
}

pub struct Brc39Archive {
    root: PathBuf,
}

impl Brc39Archive {
    pub fn open_default() -> Self {
        Self::open(crate::paths::user_data_dir().join("brc39-archive"))
    }

    pub fn open(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root_path(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn safe_identity_dir(&self, identity_key: &str) -> Result<PathBuf, String> {
        let safe: String = identity_key
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .take(64)
            .collect::<String>()
            .to_ascii_lowercase();
        if safe.len() < 8 {
            return Err("Invalid identity key for UTXO archive".into());
        }
        Ok(self.root.join(safe))
    }

    /// Write a write-once snapshot if identical bytes are not already archived.
    pub fn write_snapshot(
        &self,
        identity_key: &str,
        bytes_base64: &str,
        exported_at: Option<u64>,
    ) -> Result<Value, String> {
        let identity_key = identity_key.trim();
        let bytes = B64
            .decode(bytes_base64.as_bytes())
            .map_err(|_| "Invalid base64 in UTXO archive payload".to_string())?;
        if bytes.len() < MIN_SNAPSHOT_BYTES {
            return Err("BRC-39 snapshot too small to archive".into());
        }

        let exported_at = match exported_at {
            Some(ts) if ts > 0 => ts,
            _ => now_ms(),
        };
        let digest = sha256_hex(&bytes);
        let dir = self.safe_identity_dir(identity_key)?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));

        // Idempotent: identical content already on disk.
        for entry in self.list_identity(identity_key) {
            if let Ok(on_disk) = fs::read(&entry.path) {
                if sha256_hex(&on_disk) == digest {
                    let mut meta = entry;
                    meta.sha256 = digest;
                    return Ok(json!({
                        "created": false,
                        "meta": meta.to_json(),
                    }));
                }
            }
        }

        let name = snapshot_filename(exported_at, &digest);
        let file_path = dir.join(&name);

        match write_file_exclusive(&file_path, &bytes) {
            Ok(()) => {
                self.prune_oldest(identity_key);
                let mut meta = parse_snapshot_name(identity_key, &dir, &name)
                    .ok_or_else(|| "Failed to record UTXO archive metadata".to_string())?;
                meta.sha256 = digest;
                Ok(json!({
                    "created": true,
                    "meta": meta.to_json(),
                }))
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Ok(on_disk) = fs::read(&file_path) {
                    if sha256_hex(&on_disk) == digest {
                        if let Some(mut meta) = parse_snapshot_name(identity_key, &dir, &name) {
                            meta.sha256 = digest;
                            return Ok(json!({
                                "created": false,
                                "meta": meta.to_json(),
                            }));
                        }
                    }
                }
                // Same timestamp collision with different content — write under a unique name.
                let alt = snapshot_filename(exported_at.saturating_add(1), &digest);
                let alt_path = dir.join(&alt);
                write_file_exclusive(&alt_path, &bytes).map_err(|err| err.to_string())?;
                self.prune_oldest(identity_key);
                let mut meta = parse_snapshot_name(identity_key, &dir, &alt)
                    .ok_or_else(|| "Failed to record UTXO archive metadata".to_string())?;
                meta.sha256 = digest;
                Ok(json!({
                    "created": true,
                    "meta": meta.to_json(),
                }))
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn list_identity(&self, identity_key: &str) -> Vec<Brc39ArchiveMeta> {
        let trimmed = identity_key.trim();
        let Ok(dir) = self.safe_identity_dir(trimmed) else {
            return vec![];
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            return vec![];
        };
        let mut out = Vec::new();
        for ent in entries.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if let Some(meta) = parse_snapshot_name(trimmed, &dir, &name) {
                out.push(meta);
            }
        }
        // Newest first.
        out.sort_by(|a, b| b.exported_at.cmp(&a.exported_at).then_with(|| a.id.cmp(&b.id)));
        out
    }

    pub fn list_identity_json(&self, identity_key: &str) -> Value {
        let list: Vec<Value> = self
            .list_identity(identity_key)
            .into_iter()
            .map(|m| m.to_json())
            .collect();
        Value::Array(list)
    }

    pub fn read_snapshot(&self, identity_key: &str, id: &str) -> Result<Value, String> {
        let identity_key = identity_key.trim();
        if !is_valid_snapshot_name(id) {
            return Err("Invalid UTXO archive id".into());
        }
        let dir = self.safe_identity_dir(identity_key)?;
        let file_path = dir.join(id);
        if !file_path.is_file() {
            return Err("UTXO archive snapshot not found".into());
        }
        let bytes = fs::read(&file_path).map_err(|e| e.to_string())?;
        let mut meta = parse_snapshot_name(identity_key, &dir, id)
            .ok_or_else(|| "Corrupt UTXO archive metadata".to_string())?;
        let digest = sha256_hex(&bytes);
        if !digest.starts_with(&meta.sha256) {
            return Err("UTXO archive snapshot is incomplete or damaged".into());
        }
        meta.sha256 = digest;
        Ok(json!({
            "meta": meta.to_json(),
            "bytesBase64": B64.encode(&bytes),
        }))
    }

    /// Recover complete temp files from interrupted writes and remove leftovers.
    pub fn sweep_temps(&self) -> (usize, usize) {
        let mut adopted = 0;
        let mut removed = 0;
        let Ok(dirs) = fs::read_dir(&self.root) else {
            return (0, 0);
        };
        for dir_ent in dirs.flatten() {
            let dir = dir_ent.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(&dir) else {
                continue;
            };
            for file_ent in files.flatten() {
                let name = file_ent.file_name().to_string_lossy().into_owned();
                let Some(target_name) = strip_temp_suffix(&name) else {
                    continue;
                };
                let temp_path = file_ent.path();
                let target_path = dir.join(target_name);
                if let Some((_, hash_prefix)) = parse_snapshot_parts(target_name) {
                    if !target_path.exists() {
                        if let Ok(bytes) = fs::read(&temp_path) {
                            if sha256_hex(&bytes).starts_with(&hash_prefix)
                                && fs::hard_link(&temp_path, &target_path).is_ok()
                            {
                                adopted += 1;
                            }
                        }
                    }
                }
                if fs::remove_file(&temp_path).is_ok() {
                    removed += 1;
                }
            }
        }
        (adopted, removed)
    }

    fn prune_oldest(&self, identity_key: &str) {
        let entries = self.list_identity(identity_key);
        if entries.len() <= MAX_SNAPSHOTS_PER_IDENTITY {
            return;
        }
        for entry in entries.into_iter().skip(MAX_SNAPSHOTS_PER_IDENTITY) {
            let _ = fs::remove_file(&entry.path);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

fn snapshot_filename(exported_at: u64, sha256: &str) -> String {
    format!("{exported_at}-{}.brc39", &sha256[..12])
}

fn parse_snapshot_parts(name: &str) -> Option<(u64, String)> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return None;
    }
    let stem = name.strip_suffix(".brc39")?;
    let (ts_str, hash_str) = stem.split_once('-')?;
    if ts_str.is_empty() || !ts_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if hash_str.len() != 12 || !hash_str.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let exported_at: u64 = ts_str.parse().ok()?;
    if exported_at == 0 {
        return None;
    }
    Some((exported_at, hash_str.to_ascii_lowercase()))
}

fn is_valid_snapshot_name(name: &str) -> bool {
    parse_snapshot_parts(name).is_some()
}

fn parse_snapshot_name(identity_key: &str, dir: &Path, name: &str) -> Option<Brc39ArchiveMeta> {
    let (exported_at, hash_prefix) = parse_snapshot_parts(name)?;
    let file_path = dir.join(name);
    let bytes = fs::metadata(&file_path).ok()?.len();
    Some(Brc39ArchiveMeta {
        id: name.to_string(),
        identity_key: identity_key.to_string(),
        exported_at,
        bytes,
        sha256: hash_prefix,
        path: file_path.to_string_lossy().into_owned(),
    })
}

fn strip_temp_suffix(name: &str) -> Option<&str> {
    // Matches `target.tmp-<pid>-<nonce>` or `target.tmp`.
    if let Some(idx) = name.find(".tmp") {
        let target = &name[..idx];
        if !target.is_empty() {
            return Some(target);
        }
    }
    None
}

/// Write bytes to a temp file in the same directory, sync it, then exclusively
/// publish via `hard_link` so an interrupted write never leaves a partial snapshot
/// and an existing snapshot is never overwritten.
pub fn write_file_exclusive(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent dir"))?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad filename"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!("{file_name}.tmp-{}-{nonce}", std::process::id()));

    let write_result = (|| -> std::io::Result<()> {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        #[cfg(unix)]
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    let link_res = fs::hard_link(&tmp, target);
    let _ = fs::remove_file(&tmp);
    link_res?;
    #[cfg(unix)]
    if let Ok(dir_file) = File::open(parent) {
        let _ = dir_file.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_archive(label: &str) -> (PathBuf, Brc39Archive) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-brc39-{label}-{stamp}"));
        let archive = Brc39Archive::open(dir.clone());
        (dir, archive)
    }

    #[test]
    fn write_dedup_list_read_and_integrity_check() {
        let (dir, archive) = temp_archive("roundtrip");
        let id_key = "02abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let payload = vec![0x42u8; 128];
        let b64 = B64.encode(&payload);

        let first = archive
            .write_snapshot(id_key, &b64, Some(1_700_000_000_000))
            .expect("first write");
        assert_eq!(first["created"], Value::Bool(true));
        let snap_id = first["meta"]["id"].as_str().unwrap().to_string();

        // Identical content deduplicates.
        let second = archive
            .write_snapshot(id_key, &b64, Some(1_700_000_000_999))
            .expect("dedup write");
        assert_eq!(second["created"], Value::Bool(false));
        assert_eq!(second["meta"]["id"], json!(snap_id));

        // List returns newest first.
        let listed = archive.list_identity(id_key);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, snap_id);

        // Read returns exact bytes.
        let read = archive.read_snapshot(id_key, &snap_id).expect("read");
        assert_eq!(read["bytesBase64"], json!(b64));

        // Path traversal is refused.
        assert!(archive.read_snapshot(id_key, "../secret.brc39").is_err());

        // Damaged file fails integrity check.
        let snap_path = PathBuf::from(listed[0].path.clone());
        fs::write(&snap_path, vec![0x99u8; 128]).unwrap();
        assert!(archive.read_snapshot(id_key, &snap_id).is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_small_snapshot_and_prunes_oldest() {
        let (dir, archive) = temp_archive("prune");
        let id_key = "031111111111111111111111111111111111111111111111111111111111111111";
        assert!(archive
            .write_snapshot(id_key, &B64.encode([1u8; 16]), Some(100))
            .is_err());

        for i in 0..45u64 {
            let mut bytes = vec![0u8; 80];
            bytes[0..8].copy_from_slice(&i.to_le_bytes());
            archive
                .write_snapshot(id_key, &B64.encode(&bytes), Some(10_000 + i))
                .expect("write");
        }
        let listed = archive.list_identity(id_key);
        assert_eq!(listed.len(), MAX_SNAPSHOTS_PER_IDENTITY);
        assert_eq!(listed[0].exported_at, 10_044);
        assert_eq!(listed.last().unwrap().exported_at, 10_005);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sweep_adopts_complete_temp_and_removes_incomplete() {
        let (dir, archive) = temp_archive("sweep");
        let id_key = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let id_dir = archive.safe_identity_dir(id_key).unwrap();
        fs::create_dir_all(&id_dir).unwrap();

        let good_bytes = vec![0x55u8; 96];
        let good_sha = sha256_hex(&good_bytes);
        let good_name = snapshot_filename(20_000, &good_sha);
        fs::write(id_dir.join(format!("{good_name}.tmp-123")), &good_bytes).unwrap();

        let bad_name = snapshot_filename(20_001, "000000000000");
        fs::write(id_dir.join(format!("{bad_name}.tmp-456")), b"partial").unwrap();

        let (adopted, removed) = archive.sweep_temps();
        assert_eq!(adopted, 1);
        assert_eq!(removed, 2);
        assert_eq!(archive.list_identity(id_key).len(), 1);
        assert_eq!(archive.list_identity(id_key)[0].id, good_name);

        let _ = fs::remove_dir_all(dir);
    }
}
