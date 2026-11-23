// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pure-Rust vault encryption, decryption, creation, and restoration.
//!
//! 100% on-disk compatible with `src/wallet/vault.ts` (`handcash.brc100.vault.v1`):
//! - v1/v2: PBKDF2-HMAC-SHA256 (210,000 iterations) -> AES-256-GCM (12-byte IV) directly over secret
//! - v3: random 32-byte DEK encrypts secret via AES-256-GCM; `wraps.password` wraps DEK with PBKDF2-HMAC-SHA256 (210,000 iterations)
//! - Secret payload: raw 64-hex string (v1) or JSON `{ rootKeyHex, mnemonic, derivation?, entropyLength? }`

use crate::keys::{
    generate_mnemonic_24, parse_mnemonic, AccountDerivation, KeyError, MnemonicScheme, VaultMaster,
};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::RngCore;
use ring::pbkdf2;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::num::NonZeroU32;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub const VAULT_STORAGE_KEY: &str = "handcash.brc100.vault.v1";
pub const VAULT_BACKUP_STORAGE_KEY: &str = "handcash.brc100.vault.backup.v1";
pub const PBKDF2_ITERATIONS: u32 = 210_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    WrongPassword,
    CorruptVault(String),
    InvalidHandle(String),
    InvalidPassword(String),
    Key(KeyError),
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongPassword => write!(f, "Incorrect password"),
            Self::CorruptVault(m) => write!(f, "Corrupt wallet vault: {m}"),
            Self::InvalidHandle(m) => write!(f, "{m}"),
            Self::InvalidPassword(m) => write!(f, "{m}"),
            Self::Key(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<KeyError> for VaultError {
    fn from(e: KeyError) -> Self {
        Self::Key(e)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PasswordWrap {
    pub salt: String,
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceWrap {
    pub enrolled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultWraps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<PasswordWrap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceWrap>,
}

/// Exact JSON layout of `handcash.brc100.vault.v1`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecord {
    pub version: u8,
    pub chain: String,
    pub handle: String,
    pub identity_key: String,
    pub address: String,
    pub ciphertext: String,
    pub iv: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_mnemonic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivation: Option<AccountDerivation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wraps: Option<VaultWraps>,
}

impl VaultRecord {
    pub fn is_testnet(&self) -> bool {
        self.chain == "test"
    }

    pub fn has_password_factor(&self) -> bool {
        if self.version == 3 {
            self.wraps
                .as_ref()
                .and_then(|w| w.password.as_ref())
                .is_some()
        } else {
            true
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultSecretJson {
    root_key_hex: String,
    mnemonic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    derivation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entropy_length: Option<usize>,
}

/// Decrypted vault material, automatically zeroized on drop.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct UnlockedVault {
    pub master: VaultMaster,
    pub mnemonic: Option<String>,
    #[zeroize(skip)]
    pub record: VaultRecord,
}

pub fn normalize_handle(input: &str) -> Result<String, VaultError> {
    let cleaned: String = input
        .trim()
        .trim_start_matches('$')
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
        .collect();
    if cleaned.len() < 3 {
        return Err(VaultError::InvalidHandle(
            "Handle must be at least 3 characters".into(),
        ));
    }
    Ok(cleaned)
}

pub fn validate_password(password: &str) -> Result<(), VaultError> {
    if password.len() < 8 {
        return Err(VaultError::InvalidPassword(
            "Password must be at least 8 characters".into(),
        ));
    }
    Ok(())
}

/// New create / restore / change-password policy minimum length.
/// Mirrors `src/wallet/passwordPolicy.ts` (`PASSWORD_MIN_LENGTH`).
pub const PASSWORD_MIN_LENGTH: usize = 10;

/// Mirrors `src/wallet/passwordPolicy.ts` (`validatePassword`): returns the
/// user-facing error, or `None` when the password meets the new policy.
pub fn password_policy_error(password: &str) -> Option<String> {
    if password.chars().count() < PASSWORD_MIN_LENGTH {
        return Some(format!(
            "Password must be at least {PASSWORD_MIN_LENGTH} characters"
        ));
    }
    if !password.chars().any(|c| c.is_ascii_alphabetic()) {
        return Some("Password must include a letter".into());
    }
    if !password.chars().any(|c| c.is_ascii_digit()) {
        return Some("Password must include a number".into());
    }
    None
}

/// Mirrors `src/wallet/deviceLockPrefs.ts` (`generateWrapSecret`): 24 random
/// bytes, base64 with `+/=` replaced by `x`, prefixed `Hc1` (meets the policy).
pub fn generate_wrap_secret() -> Zeroizing<String> {
    let mut bytes = Zeroizing::new([0u8; 24]);
    rand::rngs::OsRng.fill_bytes(&mut *bytes);
    let body: String = BASE64
        .encode(*bytes)
        .chars()
        .map(|c| if matches!(c, '+' | '/' | '=') { 'x' } else { c })
        .collect();
    Zeroizing::new(format!("Hc1{body}"))
}

fn derive_pbkdf2_key(password: &str, salt: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PBKDF2_ITERATIONS).unwrap(),
        salt,
        password.as_bytes(),
        &mut *key,
    );
    key
}

fn aes_gcm_encrypt(key_bytes: &[u8; 32], plaintext: &[u8]) -> Result<(String, String), VaultError> {
    let mut iv = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext)
        .map_err(|_| VaultError::CorruptVault("AES-GCM encrypt failed".into()))?;
    Ok((BASE64.encode(ct), BASE64.encode(iv)))
}

fn aes_gcm_decrypt(
    key_bytes: &[u8; 32],
    ciphertext_b64: &str,
    iv_b64: &str,
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let ct = BASE64
        .decode(ciphertext_b64.trim())
        .map_err(|_| VaultError::CorruptVault("invalid ciphertext base64".into()))?;
    let iv = BASE64
        .decode(iv_b64.trim())
        .map_err(|_| VaultError::CorruptVault("invalid iv base64".into()))?;
    if iv.len() != 12 {
        return Err(VaultError::CorruptVault("invalid AES-GCM IV length".into()));
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let pt = cipher
        .decrypt(Nonce::from_slice(&iv), ct.as_slice())
        .map_err(|_| VaultError::WrongPassword)?;
    Ok(Zeroizing::new(pt))
}

fn serialize_secret(master: &VaultMaster, mnemonic: Option<&str>) -> Zeroizing<String> {
    match master {
        VaultMaster::Brc157 {
            key_hex,
            entropy_length,
        } => {
            let payload = VaultSecretJson {
                root_key_hex: key_hex.clone(),
                mnemonic: mnemonic.map(ToString::to_string),
                derivation: Some("brc-157".into()),
                entropy_length: Some(*entropy_length),
            };
            Zeroizing::new(serde_json::to_string(&payload).expect("serialize vault secret"))
        }
        VaultMaster::Brc42 { key_hex } => {
            if let Some(m) = mnemonic {
                let payload = VaultSecretJson {
                    root_key_hex: key_hex.clone(),
                    mnemonic: Some(m.to_string()),
                    derivation: None,
                    entropy_length: None,
                };
                Zeroizing::new(serde_json::to_string(&payload).expect("serialize vault secret"))
            } else {
                Zeroizing::new(key_hex.clone())
            }
        }
    }
}

fn parse_secret(plain: &str) -> Result<(VaultMaster, Option<String>), VaultError> {
    let trimmed = plain.trim();
    if trimmed.starts_with('{') {
        let parsed: VaultSecretJson = serde_json::from_str(trimmed)
            .map_err(|e| VaultError::CorruptVault(e.to_string()))?;
        let master = match parsed.derivation.as_deref() {
            None | Some("brc-42") => VaultMaster::Brc42 {
                key_hex: crate::keys::SecretKeyBytes::from_hex(&parsed.root_key_hex)?
                    .to_hex()
                    .to_string(),
            },
            Some("brc-157") => {
                let ent_len = parsed
                    .entropy_length
                    .ok_or_else(|| VaultError::CorruptVault("missing entropyLength".into()))?;
                let full = crate::keys::SecretKeyBytes::from_hex(&parsed.root_key_hex)?;
                let cut = 32usize
                    .checked_sub(ent_len)
                    .ok_or_else(|| VaultError::CorruptVault("invalid entropyLength".into()))?;
                if full.as_bytes()[..cut].iter().any(|&b| b != 0) {
                    return Err(VaultError::CorruptVault(
                        "entropy does not fit recorded length".into(),
                    ));
                }
                VaultMaster::from_brc157_entropy(&full.as_bytes()[cut..])?
            }
            Some(other) => {
                return Err(VaultError::CorruptVault(format!(
                    "unsupported derivation '{other}'"
                )));
            }
        };
        Ok((master, parsed.mnemonic))
    } else {
        let key = crate::keys::SecretKeyBytes::from_hex(trimmed)?;
        Ok((
            VaultMaster::Brc42 {
                key_hex: key.to_hex().to_string(),
            },
            None,
        ))
    }
}

/// Unlock an existing v1, v2, or v3 HandCash vault using the user's password.
pub fn unlock_vault_with_password(
    record: &VaultRecord,
    password: &str,
) -> Result<UnlockedVault, VaultError> {
    let plain_bytes = if record.version == 3 {
        let pw_wrap = record
            .wraps
            .as_ref()
            .and_then(|w| w.password.as_ref())
            .ok_or_else(|| VaultError::CorruptVault("v3 vault has no password wrap".into()))?;
        let salt = BASE64
            .decode(pw_wrap.salt.trim())
            .map_err(|_| VaultError::CorruptVault("invalid password salt".into()))?;
        let kek = derive_pbkdf2_key(password, &salt);
        let dek_vec = aes_gcm_decrypt(&kek, &pw_wrap.ciphertext, &pw_wrap.iv)?;
        if dek_vec.len() != 32 {
            return Err(VaultError::CorruptVault("unwrapped DEK is not 32 bytes".into()));
        }
        let mut dek = Zeroizing::new([0u8; 32]);
        dek.copy_from_slice(&dek_vec);
        aes_gcm_decrypt(&dek, &record.ciphertext, &record.iv)?
    } else {
        let salt_b64 = record
            .salt
            .as_deref()
            .ok_or_else(|| VaultError::CorruptVault("legacy vault missing salt".into()))?;
        let salt = BASE64
            .decode(salt_b64.trim())
            .map_err(|_| VaultError::CorruptVault("invalid legacy salt".into()))?;
        let key = derive_pbkdf2_key(password, &salt);
        aes_gcm_decrypt(&key, &record.ciphertext, &record.iv)?
    };

    let plain_str = Zeroizing::new(
        String::from_utf8(plain_bytes.to_vec())
            .map_err(|_| VaultError::CorruptVault("decrypted vault secret is not UTF-8".into()))?,
    );
    let (master, mnemonic) = parse_secret(&plain_str)?;
    Ok(UnlockedVault {
        master,
        mnemonic,
        record: record.clone(),
    })
}

/// Encrypt a vault master + optional mnemonic as a standard v3 DEK-wrapped `VaultRecord`.
pub fn encrypt_vault_v3(
    master: &VaultMaster,
    mnemonic: Option<&str>,
    handle: &str,
    chain: &str,
    password: &str,
) -> Result<VaultRecord, VaultError> {
    validate_password(password)?;
    let normalized_handle = normalize_handle(handle)?;
    let testnet = chain == "test";
    let acc0 = master.account_private_key(0)?;
    let identity_key = acc0.public_key_hex()?;
    let address = acc0.p2pkh_address(testnet)?;

    let secret = serialize_secret(master, mnemonic);
    let mut dek = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(&mut *dek);
    let (ciphertext, iv) = aes_gcm_encrypt(&dek, secret.as_bytes())?;

    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let kek = derive_pbkdf2_key(password, &salt);
    let (wrap_ct, wrap_iv) = aes_gcm_encrypt(&kek, &*dek)?;

    Ok(VaultRecord {
        version: 3,
        chain: if testnet { "test" } else { "main" }.into(),
        handle: normalized_handle,
        identity_key,
        address,
        ciphertext,
        iv,
        salt: None,
        has_mnemonic: Some(mnemonic.is_some()),
        derivation: match master.derivation() {
            AccountDerivation::Brc157 => Some(AccountDerivation::Brc157),
            AccountDerivation::Brc42 => None,
        },
        wraps: Some(VaultWraps {
            password: Some(PasswordWrap {
                salt: BASE64.encode(salt),
                iv: wrap_iv,
                ciphertext: wrap_ct,
            }),
            device: None,
        }),
    })
}

/// Create a brand-new 24-word BRC-157 vault.
pub fn create_new_vault(
    handle: &str,
    password: &str,
    chain: &str,
) -> Result<UnlockedVault, VaultError> {
    let (phrase, entropy) = generate_mnemonic_24()?;
    let master = VaultMaster::from_brc157_entropy(&entropy)?;
    let record = encrypt_vault_v3(&master, Some(&phrase), handle, chain, password)?;
    Ok(UnlockedVault {
        master,
        mnemonic: Some(phrase),
        record,
    })
}

/// Restore a vault from a 12- or 24-word BIP-39 recovery phrase.
pub fn restore_vault_from_mnemonic(
    handle: &str,
    mnemonic: &str,
    passphrase: &str,
    password: &str,
    chain: &str,
    scheme: MnemonicScheme,
) -> Result<UnlockedVault, VaultError> {
    let (canonical, _) = parse_mnemonic(mnemonic)?;
    let master = VaultMaster::from_mnemonic(&canonical, passphrase, scheme)?;
    let record = encrypt_vault_v3(&master, Some(&canonical), handle, chain, password)?;
    Ok(UnlockedVault {
        master,
        mnemonic: Some(canonical),
        record,
    })
}

/// Restore a vault from a 64-hex emergency root key (BRC-42 master).
pub fn restore_vault_from_root_key(
    handle: &str,
    root_key_hex: &str,
    password: &str,
    chain: &str,
) -> Result<UnlockedVault, VaultError> {
    let trimmed = root_key_hex.trim();
    let clean = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")).unwrap_or(trimmed);
    if clean.len() != 64 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(VaultError::InvalidPassword("Emergency key must be 64 hex characters".into()));
    }
    let key = crate::keys::SecretKeyBytes::from_hex(clean)?;
    let master = VaultMaster::Brc42 {
        key_hex: key.to_hex().to_string(),
    };
    let record = encrypt_vault_v3(&master, None, handle, chain, password)?;
    Ok(UnlockedVault {
        master,
        mnemonic: None,
        record,
    })
}

/// Re-encrypt an existing vault under a new password without changing keys or identity.
pub fn change_vault_password(
    record: &VaultRecord,
    current_password: &str,
    new_password: &str,
) -> Result<VaultRecord, VaultError> {
    let unlocked = unlock_vault_with_password(record, current_password)?;
    encrypt_vault_v3(
        &unlocked.master,
        unlocked.mnemonic.as_deref(),
        &record.handle,
        &record.chain,
        new_password,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_webcrypto_pbkdf2_aes256gcm_golden_vector() {
        // Exact vector produced by Node/WebCrypto PBKDF2-HMAC-SHA256 (210,000 iters) + AES-256-GCM.
        let salt = BASE64.decode("ABEiM0RVZneImaq7zN3u/w==").unwrap();
        let key = derive_pbkdf2_key("correct horse battery staple", &salt);
        let pt = aes_gcm_decrypt(
            &key,
            "KLveNm4LEn77CEf3ltVqlTR3CNQVQ5FQG07zCcMg",
            "AQIDBAUGBwgJCgsM",
        )
        .unwrap();
        assert_eq!(&*pt, b"vault-dek-test");
    }

    #[test]
    fn create_unlock_and_change_password_roundtrip() {
        let created = create_new_vault("$Alice_1", "super-secret-pass", "main").unwrap();
        assert_eq!(created.record.version, 3);
        assert_eq!(created.record.handle, "alice_1");
        assert_eq!(created.record.derivation, Some(AccountDerivation::Brc157));
        assert!(created.mnemonic.as_ref().unwrap().split_whitespace().count() == 24);

        let unlocked = unlock_vault_with_password(&created.record, "super-secret-pass").unwrap();
        assert_eq!(unlocked.record.identity_key, created.record.identity_key);
        assert_eq!(unlocked.mnemonic, created.mnemonic);
        assert_eq!(
            unlocked.master.account_identity_key(0).unwrap(),
            created.record.identity_key
        );

        assert!(matches!(
            unlock_vault_with_password(&created.record, "wrong-password"),
            Err(VaultError::WrongPassword)
        ));

        let rotated =
            change_vault_password(&created.record, "super-secret-pass", "new-strong-pass")
                .unwrap();
        assert_eq!(rotated.identity_key, created.record.identity_key);
        let reopened = unlock_vault_with_password(&rotated, "new-strong-pass").unwrap();
        assert_eq!(reopened.mnemonic, created.mnemonic);
    }

    #[test]
    fn restores_brc157_and_brc75_mnemonics_deterministically() {
        let phrase = "absurd avoid scissors anxiety gather lottery category door army half long cage bachelor another expect people blade school educate curtain scrub monitor lady beyond";
        let v157 = restore_vault_from_mnemonic(
            "bob",
            phrase,
            "",
            "password123",
            "main",
            MnemonicScheme::Brc157,
        )
        .unwrap();
        assert_eq!(
            v157.record.identity_key,
            "032a32ac11bbbd6b333b19cafc986e2508be3621246d75224e234a0d1a2f15eb75"
        );
        assert_eq!(v157.record.address, "1Mmd5LJCnFKpkSYkZHdruZBs27koQoRpDj");

        let v75 = restore_vault_from_mnemonic(
            "bob",
            phrase,
            "",
            "password123",
            "main",
            MnemonicScheme::Brc75,
        )
        .unwrap();
        assert_eq!(
            v75.record.identity_key,
            "026dca6a3f36e46d85b6264267c851d8af1d311f2b1697a73eab898693c0f77b6c"
        );
    }

    #[test]
    fn password_policy_and_wrap_secret_and_root_key_restore() {
        assert_eq!(password_policy_error("short1a").as_deref(), Some("Password must be at least 10 characters"));
        assert_eq!(password_policy_error("1234567890").as_deref(), Some("Password must include a letter"));
        assert_eq!(password_policy_error("abcdefghij").as_deref(), Some("Password must include a number"));
        assert_eq!(password_policy_error("ValidPass123"), None);

        let wrap = generate_wrap_secret();
        assert!(wrap.starts_with("Hc1"));
        assert_eq!(password_policy_error(&wrap), None);

        let restored = restore_vault_from_root_key(
            "wallet",
            "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
            &wrap,
            "main",
        )
        .unwrap();
        assert_eq!(restored.mnemonic, None);
        assert_eq!(restored.record.has_mnemonic, Some(false));
    }
}
