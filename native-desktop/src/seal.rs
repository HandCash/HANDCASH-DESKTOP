//! Vault seal: AES-256-GCM with a key held in the OS credential store.
//! Prefix matches Mac thin shell (`sealed:native:v1:`) — keys are per-machine.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use keyring::Entry;
use rand::RngCore;
use std::sync::Mutex;

pub const SEALED_PREFIX: &str = "sealed:native:v1:";
const SERVICE: &str = "io.handcash.desktop.thin-shell";
const ACCOUNT: &str = "vault-aes-key-v1";

/// Test-only override so unit tests never touch the real OS keyring.
static TEST_KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);

pub fn is_available() -> bool {
    master_key().is_ok()
}

pub fn is_sealed(value: &str) -> bool {
    value.starts_with(SEALED_PREFIX)
}

pub fn seal(plain: &str) -> Result<String, String> {
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| format!("seal failed: {e}"))?;
    let mut packed = Vec::with_capacity(12 + ct.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ct);
    Ok(format!("{}{}", SEALED_PREFIX, B64.encode(packed)))
}

pub fn unseal(value: &str) -> Result<String, String> {
    if !is_sealed(value) {
        return Ok(value.to_string());
    }
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let raw = B64
        .decode(value[SEALED_PREFIX.len()..].as_bytes())
        .map_err(|e| format!("bad sealed blob: {e}"))?;
    if raw.len() < 13 {
        return Err("sealed blob too short".into());
    }
    let (nonce_bytes, ct) = raw.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let pt = cipher
        .decrypt(nonce, ct)
        .map_err(|_| "Could not decrypt wallet vault from OS keychain.".to_string())?;
    String::from_utf8(pt).map_err(|_| "vault utf8 decode failed".into())
}

fn master_key() -> Result<[u8; 32], String> {
    if let Ok(guard) = TEST_KEY.lock() {
        if let Some(k) = *guard {
            return Ok(k);
        }
    }
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(existing) => {
            let bytes = B64.decode(existing.as_bytes()).map_err(|e| e.to_string())?;
            if bytes.len() != 32 {
                return Err("stored seal key has wrong length".into());
            }
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            Ok(out)
        }
        Err(_) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            entry
                .set_password(&B64.encode(key))
                .map_err(|e| format!("OS credential store unavailable: {e}"))?;
            Ok(key)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_round_trip() {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        *TEST_KEY.lock().unwrap() = Some(key);
        let sealed = seal("hello-vault").expect("seal");
        assert!(is_sealed(&sealed));
        assert_eq!(unseal(&sealed).expect("unseal"), "hello-vault");
        *TEST_KEY.lock().unwrap() = None;
    }
}
