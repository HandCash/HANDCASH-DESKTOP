//! On-device sealed call recordings store.
//!
//! Parity with `electron/callRecordings.ts`:
//! - Files live at `<userData>/call-recordings/{identity}/{id}/000000.part` and `meta.sealed`.
//! - Every part and meta file is already sealed by the renderer before arriving here.
//! - Parts are write-once; playback stops before any missing sequence gap.

use crate::brc39_archive::write_file_exclusive;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const RECORDING_PART_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const RECORDING_PARTS_MAX: u64 = 100_000;
const META_NAME: &str = "meta.sealed";

pub struct CallRecordings {
    root: PathBuf,
}

impl CallRecordings {
    pub fn open_default() -> Self {
        Self::open(crate::paths::user_data_dir().join("call-recordings"))
    }

    pub fn open(root: PathBuf) -> Self {
        Self { root }
    }

    fn recording_dir(&self, identity_key: &str, id: &str) -> Result<PathBuf, String> {
        if !is_valid_identity_key(identity_key) {
            return Err("Invalid identity key for call recordings".into());
        }
        if !is_valid_recording_id(id) {
            return Err("Invalid call recording id".into());
        }
        Ok(self.root.join(identity_key.to_ascii_lowercase()).join(id))
    }

    pub fn append_part(
        &self,
        identity_key: &str,
        id: &str,
        seq: u64,
        sealed_base64: &str,
    ) -> Result<(), String> {
        if seq >= RECORDING_PARTS_MAX {
            return Err("Invalid call recording part number".into());
        }
        let bytes = decode_sealed(sealed_base64)?;
        let dir = self.recording_dir(identity_key, id)?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        let path = dir.join(format!("{seq:06}.part"));
        write_file_exclusive(&path, &bytes).map_err(|e| e.to_string())
    }

    pub fn finish_recording(
        &self,
        identity_key: &str,
        id: &str,
        sealed_meta_base64: &str,
    ) -> Result<(), String> {
        let bytes = decode_sealed(sealed_meta_base64)?;
        let dir = self.recording_dir(identity_key, id)?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        write_file_exclusive(&dir.join(META_NAME), &bytes).map_err(|e| e.to_string())
    }

    pub fn read_recording(&self, identity_key: &str, id: &str) -> Result<Value, String> {
        let dir = self.recording_dir(identity_key, id)?;
        let meta = fs::read(dir.join(META_NAME))
            .ok()
            .map(|b| Value::String(B64.encode(b)))
            .unwrap_or(Value::Null);
        let mut parts_b64 = Vec::new();
        for (_, path) in contiguous_parts(&dir) {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            parts_b64.push(Value::String(B64.encode(bytes)));
        }
        Ok(json!({
            "meta": meta,
            "parts": parts_b64,
        }))
    }

    pub fn delete_recording(&self, identity_key: &str, id: &str) -> Result<(), String> {
        let dir = self.recording_dir(identity_key, id)?;
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn is_valid_identity_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 66
        && bytes[0] == b'0'
        && (bytes[1] == b'2' || bytes[1] == b'3')
        && bytes[2..].iter().all(|b| b.is_ascii_hexdigit())
}

fn is_valid_recording_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 32
        && bytes
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

fn decode_sealed(b64: &str) -> Result<Vec<u8>, String> {
    let bytes = B64
        .decode(b64.as_bytes())
        .map_err(|_| "Invalid call recording part".to_string())?;
    if bytes.is_empty() || bytes.len() > RECORDING_PART_MAX_BYTES {
        return Err("Invalid call recording part".into());
    }
    Ok(bytes)
}

fn contiguous_parts(dir: &Path) -> Vec<(u64, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut parts = Vec::new();
    for ent in entries.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.strip_suffix(".part") {
            if stem.len() == 6 && stem.bytes().all(|b| b.is_ascii_digit()) {
                if let Ok(seq) = stem.parse::<u64>() {
                    parts.push((seq, ent.path()));
                }
            }
        }
    }
    parts.sort_by_key(|(seq, _)| *seq);
    // Stop before the first missing sequence number (gap means lost part).
    let mut out = Vec::with_capacity(parts.len());
    for (idx, (seq, path)) in parts.into_iter().enumerate() {
        if seq != idx as u64 {
            break;
        }
        out.push((seq, path));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn recording_append_finish_read_gap_and_delete() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-call-rec-{stamp}"));
        let store = CallRecordings::open(dir.clone());
        let id_key = "02".to_string() + &"ab".repeat(32);
        let rec_id = "0123456789abcdef0123456789abcdef";

        store
            .append_part(&id_key, rec_id, 0, &B64.encode(b"chunk0"))
            .unwrap();
        store
            .append_part(&id_key, rec_id, 1, &B64.encode(b"chunk1"))
            .unwrap();
        // Write-once refuses overwrite of seq 0.
        assert!(store
            .append_part(&id_key, rec_id, 0, &B64.encode(b"overwrite"))
            .is_err());
        // Gap at seq 2 → seq 3 should not be returned past the gap.
        store
            .append_part(&id_key, rec_id, 3, &B64.encode(b"chunk3"))
            .unwrap();
        store
            .finish_recording(&id_key, rec_id, &B64.encode(b"sealed-meta"))
            .unwrap();

        let read = store.read_recording(&id_key, rec_id).unwrap();
        assert_eq!(read["meta"], json!(B64.encode(b"sealed-meta")));
        let parts = read["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], json!(B64.encode(b"chunk0")));
        assert_eq!(parts[1], json!(B64.encode(b"chunk1")));

        store.delete_recording(&id_key, rec_id).unwrap();
        let after = store.read_recording(&id_key, rec_id).unwrap();
        assert_eq!(after["meta"], Value::Null);
        assert!(after["parts"].as_array().unwrap().is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_invalid_keys_and_ids() {
        let store = CallRecordings::open(std::env::temp_dir().join("hc-call-rec-invalid"));
        let good_key = "03".to_string() + &"cd".repeat(32);
        let good_id = "abcdef0123456789abcdef0123456789";
        assert!(store
            .append_part("not-a-key", good_id, 0, &B64.encode(b"x"))
            .is_err());
        assert!(store
            .append_part(&good_key, "../escape", 0, &B64.encode(b"x"))
            .is_err());
        assert!(store
            .append_part(&good_key, good_id, RECORDING_PARTS_MAX, &B64.encode(b"x"))
            .is_err());
        assert!(store.append_part(&good_key, good_id, 0, "").is_err());
    }
}
