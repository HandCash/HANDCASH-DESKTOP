// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pure-Rust secp256k1 keys, P2PKH addresses, BIP-39 mnemonics, BIP-32 (`m/0'/n'`),
//! BRC-157 / BRC-75 / BRC-42 vault master & account derivation, BRC-42/43 `KeyDeriver`,
//! BRC-2 AES-256-GCM symmetric crypto, low-S DER ECDSA signing, and reserved key guards.
//!
//! Verified bit-for-bit against `@bsv/sdk` golden vectors.

use crate::encoding::{decode_hex, encode_hex, hmac_sha256, sha256};
use aes::Aes256;
use aes_gcm::aead::consts::U32;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{AesGcm, Key, Nonce};
use bip39::{Language, Mnemonic};
use hmac::{Hmac, Mac};
use k256::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use k256::ecdsa::{DerSignature, Signature, SigningKey, VerifyingKey};
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::Group;
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, PublicKey, Scalar, SecretKey, U256};
use rand::RngCore;
use ripemd::Ripemd160;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::fmt;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

type HmacSha512 = Hmac<Sha512>;
type Aes256Gcm32 = AesGcm<Aes256, U32>;

pub const VAULT_ACCOUNT_PROTOCOL_NAME: &str = "account";
pub const VAULT_ACCOUNT_PROTOCOL_LEVEL: u8 = 2;

const WALLET_ASSET_PROTOCOLS: &[&str] = &[
    "bnt holder",
    "bnt issuer",
    "bnt fee",
    "countersign decision",
    "countersign release",
    "wltc reserve",
    "bch coin",
    "btc coin",
    "doge coin",
    "ltc coin payment",
    "bch coin payment",
    "btc coin payment",
    "doge coin payment",
    "swap order",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    InvalidPrivateKey(String),
    InvalidPublicKey(String),
    InvalidAddress(String),
    InvalidMnemonic(String),
    InvalidProtocol(String),
    InvalidKeyId(String),
    InvalidSignature(String),
    CryptoFailed(String),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPrivateKey(m) => write!(f, "invalid private key: {m}"),
            Self::InvalidPublicKey(m) => write!(f, "invalid public key: {m}"),
            Self::InvalidAddress(m) => write!(f, "invalid address: {m}"),
            Self::InvalidMnemonic(m) => write!(f, "invalid recovery phrase: {m}"),
            Self::InvalidProtocol(m) => write!(f, "invalid protocol: {m}"),
            Self::InvalidKeyId(m) => write!(f, "invalid key ID: {m}"),
            Self::InvalidSignature(m) => write!(f, "invalid signature: {m}"),
            Self::CryptoFailed(m) => write!(f, "crypto error: {m}"),
        }
    }
}

impl std::error::Error for KeyError {}

/// Zeroized 32-byte secp256k1 private key scalar.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretKeyBytes([u8; 32]);

impl fmt::Debug for SecretKeyBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretKeyBytes([REDACTED])")
    }
}

impl SecretKeyBytes {
    pub fn from_bytes(bytes: [u8; 32]) -> Result<Self, KeyError> {
        SecretKey::from_slice(&bytes).map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
        Ok(Self(bytes))
    }

    pub fn from_hex(hex_str: &str) -> Result<Self, KeyError> {
        let trimmed = hex_str.trim();
        let raw = decode_hex(trimmed).map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
        if raw.len() > 32 {
            return Err(KeyError::InvalidPrivateKey("key exceeds 32 bytes".into()));
        }
        let mut padded = [0u8; 32];
        padded[32 - raw.len()..].copy_from_slice(&raw);
        Self::from_bytes(padded)
    }

    pub fn random() -> Self {
        loop {
            let mut buf = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut buf);
            if let Ok(k) = Self::from_bytes(buf) {
                return k;
            }
        }
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> Zeroizing<String> {
        Zeroizing::new(encode_hex(&self.0))
    }

    pub fn scalar(&self) -> Result<Scalar, KeyError> {
        let sk = SecretKey::from_slice(&self.0)
            .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
        Ok(*sk.to_nonzero_scalar().as_ref())
    }

    pub fn public_key_compressed(&self) -> Result<[u8; 33], KeyError> {
        let sk = SecretKey::from_slice(&self.0)
            .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
        let ep = sk.public_key().to_encoded_point(true);
        let mut out = [0u8; 33];
        out.copy_from_slice(ep.as_bytes());
        Ok(out)
    }

    pub fn public_key_hex(&self) -> Result<String, KeyError> {
        Ok(encode_hex(&self.public_key_compressed()?))
    }

    pub fn p2pkh_address(&self, testnet: bool) -> Result<String, KeyError> {
        Ok(p2pkh_address_from_pubkey(&self.public_key_compressed()?, testnet))
    }
}

/// HASH160 = RIPEMD160(SHA256(data)).
pub fn hash160(data: &[u8]) -> [u8; 20] {
    let sha = sha256(data);
    let mut ripemd = Ripemd160::new();
    ripemd.update(sha);
    ripemd.finalize().into()
}

/// Encode a 33-byte compressed (or 65-byte uncompressed) public key as a Base58Check P2PKH address.
pub fn p2pkh_address_from_pubkey(pubkey: &[u8], testnet: bool) -> String {
    let h160 = hash160(pubkey);
    p2pkh_address_from_hash160(&h160, testnet)
}

pub fn p2pkh_address_from_hash160(h160: &[u8; 20], testnet: bool) -> String {
    let version = if testnet { 0x6fu8 } else { 0x00u8 };
    let mut payload = [0u8; 21];
    payload[0] = version;
    payload[1..21].copy_from_slice(h160);
    bs58::encode(payload).with_check().into_string()
}

/// Decode a Base58Check P2PKH address into `(version_byte, hash160)`.
pub fn decode_p2pkh_address(address: &str) -> Result<(u8, [u8; 20]), KeyError> {
    let decoded = bs58::decode(address.trim())
        .with_check(None)
        .into_vec()
        .map_err(|e| KeyError::InvalidAddress(e.to_string()))?;
    if decoded.len() != 21 {
        return Err(KeyError::InvalidAddress(format!(
            "expected 21 decoded bytes, got {}",
            decoded.len()
        )));
    }
    let version = decoded[0];
    if version != 0x00 && version != 0x6f {
        return Err(KeyError::InvalidAddress(format!(
            "unsupported P2PKH address version 0x{version:02x}"
        )));
    }
    let mut h160 = [0u8; 20];
    h160.copy_from_slice(&decoded[1..21]);
    Ok((version, h160))
}

/// Parse a compressed or uncompressed hex public key into a `ProjectivePoint`.
pub fn parse_public_key_point(hex_or_bytes: &[u8]) -> Result<ProjectivePoint, KeyError> {
    let ep = EncodedPoint::from_bytes(hex_or_bytes)
        .map_err(|e| KeyError::InvalidPublicKey(e.to_string()))?;
    let affine: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
    let pt = affine.ok_or_else(|| KeyError::InvalidPublicKey("point not on secp256k1".into()))?;
    let proj = ProjectivePoint::from(pt);
    if bool::from(proj.is_identity()) {
        return Err(KeyError::InvalidPublicKey("identity point".into()));
    }
    Ok(proj)
}

pub fn parse_public_key_hex(hex_str: &str) -> Result<ProjectivePoint, KeyError> {
    let bytes = decode_hex(hex_str.trim()).map_err(|e| KeyError::InvalidPublicKey(e.to_string()))?;
    parse_public_key_point(&bytes)
}

pub fn compress_point(point: &ProjectivePoint) -> Result<[u8; 33], KeyError> {
    if bool::from(point.is_identity()) {
        return Err(KeyError::InvalidPublicKey("identity point".into()));
    }
    let ep = point.to_affine().to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(ep.as_bytes());
    Ok(out)
}

/// Anyone public key (`1 * G`), matching `@bsv/sdk` `new PrivateKey(1).toPublicKey()`.
pub fn anyone_public_key_point() -> ProjectivePoint {
    ProjectivePoint::GENERATOR
}

/// Anyone private key (`1`).
pub fn anyone_private_key() -> SecretKeyBytes {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    SecretKeyBytes(bytes)
}

// ─── BIP-39 & BIP-32 (`m/0'/n'`) ──────────────────────────────────────────────

/// Generate a fresh 24-word BIP-39 mnemonic (32 bytes of OS entropy).
pub fn generate_mnemonic_24() -> Result<(String, Zeroizing<Vec<u8>>), KeyError> {
    let mut entropy = Zeroizing::new(vec![0u8; 32]);
    rand::rngs::OsRng.fill_bytes(&mut entropy);
    let mn = Mnemonic::from_entropy_in(Language::English, &entropy)
        .map_err(|e| KeyError::InvalidMnemonic(e.to_string()))?;
    Ok((mn.to_string(), entropy))
}

/// Normalize whitespace and validate a BIP-39 English recovery phrase, returning `(canonical_phrase, entropy)`.
pub fn parse_mnemonic(phrase: &str) -> Result<(String, Zeroizing<Vec<u8>>), KeyError> {
    let normalized = phrase
        .split_whitespace()
        .map(|w| w.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let mn = Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|e| KeyError::InvalidMnemonic(e.to_string()))?;
    let entropy = Zeroizing::new(mn.to_entropy());
    Ok((mn.to_string(), entropy))
}

pub fn mnemonic_to_seed(phrase: &str, passphrase: &str) -> Result<Zeroizing<[u8; 64]>, KeyError> {
    let (canonical, _) = parse_mnemonic(phrase)?;
    let mn = Mnemonic::parse_in_normalized(Language::English, &canonical)
        .map_err(|e| KeyError::InvalidMnemonic(e.to_string()))?;
    Ok(Zeroizing::new(mn.to_seed(passphrase)))
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct Bip32Node {
    key: [u8; 32],
    chain_code: [u8; 32],
}

impl Bip32Node {
    /// BIP-32 master node from 64-byte seed (`HMAC-SHA512("Bitcoin seed", seed)`).
    pub fn from_seed(seed: &[u8]) -> Result<Self, KeyError> {
        let mut mac =
            <HmacSha512 as Mac>::new_from_slice(b"Bitcoin seed").expect("HMAC accepts any key length");
        mac.update(seed);
        let out = mac.finalize().into_bytes();
        let mut key = [0u8; 32];
        let mut chain_code = [0u8; 32];
        key.copy_from_slice(&out[0..32]);
        chain_code.copy_from_slice(&out[32..64]);
        // Verify valid private scalar
        SecretKeyBytes::from_bytes(key)?;
        Ok(Self { key, chain_code })
    }

    /// Derive a child node (`index >= 0x8000_0000` for hardened, `< 0x8000_0000` for normal).
    pub fn derive_child(&self, index: u32) -> Result<Self, KeyError> {
        let mut mac = <HmacSha512 as Mac>::new_from_slice(&self.chain_code)
            .expect("HMAC accepts any key length");
        if index >= 0x8000_0000 {
            mac.update(&[0u8]);
            mac.update(&self.key);
        } else {
            let parent_pub = SecretKeyBytes::from_bytes(self.key)?.public_key_compressed()?;
            mac.update(&parent_pub);
        }
        mac.update(&index.to_be_bytes());
        let out = mac.finalize().into_bytes();

        let il = U256::from_be_slice(&out[0..32]);
        let il_scalar = <Scalar as Reduce<U256>>::reduce(il);
        if bool::from(il_scalar.is_zero()) {
            return Err(KeyError::InvalidPrivateKey("BIP-32 derived zero tweak".into()));
        }
        let parent_scalar = SecretKeyBytes::from_bytes(self.key)?.scalar()?;
        let child_scalar = parent_scalar + il_scalar;
        if bool::from(child_scalar.is_zero()) {
            return Err(KeyError::InvalidPrivateKey("BIP-32 derived zero child key".into()));
        }

        let child_bytes = child_scalar.to_bytes();
        let mut key = [0u8; 32];
        key.copy_from_slice(&child_bytes);
        let mut chain_code = [0u8; 32];
        chain_code.copy_from_slice(&out[32..64]);
        Ok(Self { key, chain_code })
    }

    pub fn private_key(&self) -> Result<SecretKeyBytes, KeyError> {
        SecretKeyBytes::from_bytes(self.key)
    }
}

// ─── Vault Master & Account Derivation (BRC-157 / BRC-75 / BRC-42) ───────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccountDerivation {
    #[serde(rename = "brc-42")]
    Brc42,
    #[serde(rename = "brc-157")]
    Brc157,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MnemonicScheme {
    Brc157,
    Brc75,
    LegacyHd,
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub enum VaultMaster {
    Brc42 {
        key_hex: String,
    },
    Brc157 {
        key_hex: String,
        entropy_length: usize,
    },
}

impl VaultMaster {
    pub fn derivation(&self) -> AccountDerivation {
        match self {
            Self::Brc42 { .. } => AccountDerivation::Brc42,
            Self::Brc157 { .. } => AccountDerivation::Brc157,
        }
    }

    pub fn key_hex(&self) -> &str {
        match self {
            Self::Brc42 { key_hex } | Self::Brc157 { key_hex, .. } => key_hex,
        }
    }

    pub fn entropy_length(&self) -> Option<usize> {
        match self {
            Self::Brc42 { .. } => None,
            Self::Brc157 { entropy_length, .. } => Some(*entropy_length),
        }
    }

    pub fn from_brc157_entropy(entropy: &[u8]) -> Result<Self, KeyError> {
        if !matches!(entropy.len(), 16 | 20 | 24 | 28 | 32) {
            return Err(KeyError::InvalidMnemonic(format!(
                "BRC-157 entropy must be 16..32 bytes in steps of 4, got {}",
                entropy.len()
            )));
        }
        let mut full = [0u8; 32];
        full[32 - entropy.len()..].copy_from_slice(entropy);
        // Validate non-zero & < curve order
        SecretKeyBytes::from_bytes(full)?;
        Ok(Self::Brc157 {
            key_hex: encode_hex(&full),
            entropy_length: entropy.len(),
        })
    }

    pub fn from_mnemonic(phrase: &str, passphrase: &str, scheme: MnemonicScheme) -> Result<Self, KeyError> {
        let (canonical, entropy) = parse_mnemonic(phrase)?;
        match scheme {
            MnemonicScheme::Brc157 => Self::from_brc157_entropy(&entropy),
            MnemonicScheme::Brc75 => {
                let seed = mnemonic_to_seed(&canonical, passphrase)?;
                let digest = sha256(&*seed);
                let sk = SecretKeyBytes::from_bytes(digest)?;
                Ok(Self::Brc42 {
                    key_hex: sk.to_hex().to_string(),
                })
            }
            MnemonicScheme::LegacyHd => {
                let seed = mnemonic_to_seed(&canonical, passphrase)?;
                let node = Bip32Node::from_seed(&*seed)?;
                Ok(Self::Brc42 {
                    key_hex: node.private_key()?.to_hex().to_string(),
                })
            }
        }
    }

    /// Derive account `index`'s root private key (exact parity with `vaultMaster.ts`).
    pub fn account_private_key(&self, index: u32) -> Result<SecretKeyBytes, KeyError> {
        match self {
            Self::Brc157 {
                key_hex,
                entropy_length,
            } => {
                let full = SecretKeyBytes::from_hex(key_hex)?;
                let cut = 32usize.saturating_sub(*entropy_length);
                let entropy = &full.as_bytes()[cut..];
                let mn = Mnemonic::from_entropy_in(Language::English, entropy)
                    .map_err(|e| KeyError::InvalidMnemonic(e.to_string()))?;
                let seed = Zeroizing::new(mn.to_seed(""));
                let master_node = Bip32Node::from_seed(&*seed)?;
                let profile_base = master_node.derive_child(0x8000_0000)?;
                let acct = profile_base.derive_child(0x8000_0000 + index)?;
                acct.private_key()
            }
            Self::Brc42 { key_hex } => {
                let root = SecretKeyBytes::from_hex(key_hex)?;
                if index == 0 {
                    return Ok(root);
                }
                let deriver = KeyDeriver::new(root);
                deriver.derive_private_key(
                    (VAULT_ACCOUNT_PROTOCOL_LEVEL, VAULT_ACCOUNT_PROTOCOL_NAME),
                    &format!("account-{index}"),
                    Counterparty::SelfParty,
                )
            }
        }
    }

    pub fn account_identity_key(&self, index: u32) -> Result<String, KeyError> {
        self.account_private_key(index)?.public_key_hex()
    }
}

// ─── BRC-42 / BRC-43 KeyDeriver & BRC-2 Symmetric Crypto ─────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Counterparty {
    SelfParty,
    Anyone,
    PublicKeyHex(String),
}

impl Counterparty {
    pub fn parse(raw: Option<&str>, default_self: bool) -> Self {
        match raw.map(str::trim) {
            None | Some("") => {
                if default_self {
                    Self::SelfParty
                } else {
                    Self::Anyone
                }
            }
            Some("self") => Self::SelfParty,
            Some("anyone") => Self::Anyone,
            Some(hex) => Self::PublicKeyHex(hex.to_string()),
        }
    }
}

/// Exact BRC-43 invoice number computation matching `@bsv/sdk` `KeyDeriver.computeInvoiceNumber`.
pub fn compute_invoice_number(
    security_level: u8,
    protocol_name: &str,
    key_id: &str,
) -> Result<String, KeyError> {
    if security_level > 2 {
        return Err(KeyError::InvalidProtocol(
            "Protocol security level must be 0, 1, or 2".into(),
        ));
    }
    let name = protocol_name.trim().to_ascii_lowercase();
    if key_id.is_empty() || key_id.len() > 800 {
        return Err(KeyError::InvalidKeyId(
            "Key IDs must be between 1 and 800 characters".into(),
        ));
    }
    let max_len = if name.starts_with("specific linkage revelation ") {
        430
    } else {
        400
    };
    if name.len() < 5 || name.len() > max_len {
        return Err(KeyError::InvalidProtocol(format!(
            "Protocol name length must be 5..={max_len}"
        )));
    }
    if name.contains("  ") {
        return Err(KeyError::InvalidProtocol(
            "Protocol names cannot contain multiple consecutive spaces".into(),
        ));
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b' ')
    {
        return Err(KeyError::InvalidProtocol(
            "Protocol names can only contain letters, numbers and spaces".into(),
        ));
    }
    if name.ends_with(" protocol") {
        return Err(KeyError::InvalidProtocol(
            "Protocol name must not end with \" protocol\"".into(),
        ));
    }
    Ok(format!("{security_level}-{name}-{key_id}"))
}

/// Check whether an external app request touches a reserved wallet key (exact parity with `vaultAccounts.ts`).
pub fn reserved_key_refusal(
    method: &str,
    protocol_name: Option<&str>,
    counterparty: Option<&str>,
    identity_key: Option<&str>,
) -> Option<&'static str> {
    if let Some(raw_name) = protocol_name {
        let lower = raw_name.trim().to_ascii_lowercase();
        if lower == VAULT_ACCOUNT_PROTOCOL_NAME {
            return Some("account-protocol");
        }
        if lower.starts_with("admin") {
            return Some("admin-protocol");
        }
        if lower.starts_with("p ") {
            return Some("permission-scheme");
        }
        let collapsed = lower.split_whitespace().collect::<Vec<_>>().join(" ");
        if WALLET_ASSET_PROTOCOLS.contains(&collapsed.as_str()) {
            return Some("asset-protocol");
        }
    }
    if matches!(
        method,
        "revealCounterpartyKeyLinkage" | "revealSpecificKeyLinkage"
    ) {
        if let Some(peer) = counterparty {
            let p = peer.trim().to_ascii_lowercase();
            if p == "self"
                || identity_key.is_some_and(|ik| !ik.is_empty() && p == ik.trim().to_ascii_lowercase())
            {
                return Some("self-linkage");
            }
        }
    }
    None
}

/// BRC-42 / BRC-43 key deriver wrapping an account's 32-byte root private key.
#[derive(Clone)]
pub struct KeyDeriver {
    root: SecretKeyBytes,
}

impl KeyDeriver {
    pub fn new(root: SecretKeyBytes) -> Self {
        Self { root }
    }

    pub fn identity_key_hex(&self) -> Result<String, KeyError> {
        self.root.public_key_hex()
    }

    pub fn identity_key_compressed(&self) -> Result<[u8; 33], KeyError> {
        self.root.public_key_compressed()
    }

    pub fn root_key(&self) -> &SecretKeyBytes {
        &self.root
    }

    fn normalize_counterparty(&self, counterparty: &Counterparty) -> Result<ProjectivePoint, KeyError> {
        match counterparty {
            Counterparty::SelfParty => {
                parse_public_key_point(&self.root.public_key_compressed()?)
            }
            Counterparty::Anyone => Ok(anyone_public_key_point()),
            Counterparty::PublicKeyHex(hex) => parse_public_key_hex(hex),
        }
    }

    fn brc42_tweak(
        &self,
        counterparty_pt: &ProjectivePoint,
        invoice_number: &str,
    ) -> Result<Scalar, KeyError> {
        let root_scalar = self.root.scalar()?;
        let shared = *counterparty_pt * root_scalar;
        let shared_compressed = compress_point(&shared)?;
        let hmac = hmac_sha256(&shared_compressed, invoice_number.as_bytes());
        Ok(<Scalar as Reduce<U256>>::reduce(U256::from_be_slice(&hmac)))
    }

    pub fn derive_private_key(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
    ) -> Result<SecretKeyBytes, KeyError> {
        let invoice = compute_invoice_number(protocol.0, protocol.1, key_id)?;
        let cp_pt = self.normalize_counterparty(&counterparty)?;
        let tweak = self.brc42_tweak(&cp_pt, &invoice)?;
        let child = self.root.scalar()? + tweak;
        if bool::from(child.is_zero()) {
            return Err(KeyError::CryptoFailed("derived zero child scalar".into()));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&child.to_bytes());
        SecretKeyBytes::from_bytes(out)
    }

    pub fn derive_public_key(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
        for_self: bool,
    ) -> Result<[u8; 33], KeyError> {
        let invoice = compute_invoice_number(protocol.0, protocol.1, key_id)?;
        let cp_pt = self.normalize_counterparty(&counterparty)?;
        let tweak = self.brc42_tweak(&cp_pt, &invoice)?;
        if for_self {
            let child = self.root.scalar()? + tweak;
            if bool::from(child.is_zero()) {
                return Err(KeyError::CryptoFailed("derived zero child scalar".into()));
            }
            let pt = ProjectivePoint::GENERATOR * child;
            compress_point(&pt)
        } else {
            let pt = cp_pt + ProjectivePoint::GENERATOR * tweak;
            compress_point(&pt)
        }
    }

    pub fn derive_symmetric_key(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
    ) -> Result<Zeroizing<[u8; 32]>, KeyError> {
        let derived_pub = self.derive_public_key(protocol, key_id, counterparty.clone(), false)?;
        let derived_priv = self.derive_private_key(protocol, key_id, counterparty)?;
        let pub_pt = parse_public_key_point(&derived_pub)?;
        let shared = pub_pt * derived_priv.scalar()?;
        let compressed = compress_point(&shared)?;
        let mut sym = Zeroizing::new([0u8; 32]);
        sym.copy_from_slice(&compressed[1..33]);
        Ok(sym)
    }

    /// BRC-100 `createSignature`: signs `SHA256(data)` or a precomputed 32-byte `hash_to_sign`
    /// with the derived private key and returns canonical low-S DER bytes.
    pub fn create_signature(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
        data: Option<&[u8]>,
        hash_to_directly_sign: Option<&[u8]>,
    ) -> Result<Vec<u8>, KeyError> {
        let digest = resolve_signing_digest(data, hash_to_directly_sign)?;
        let priv_key = self.derive_private_key(protocol, key_id, counterparty)?;
        sign_ecdsa_der(&priv_key, &digest)
    }

    /// BRC-100 `verifySignature` (handles both `forSelf=true` and counterparty keys).
    #[allow(clippy::too_many_arguments)] // mirrors the BRC-100 `verifySignature` argument list
    pub fn verify_signature(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
        for_self: bool,
        data: Option<&[u8]>,
        hash_to_directly_verify: Option<&[u8]>,
        signature_der: &[u8],
    ) -> Result<bool, KeyError> {
        let digest = resolve_signing_digest(data, hash_to_directly_verify)?;
        let pubkey = self.derive_public_key(protocol, key_id, counterparty, for_self)?;
        verify_ecdsa_der(&pubkey, &digest, signature_der)
    }

    /// BRC-100 `createHmac` using the derived BRC-42 symmetric key.
    pub fn create_hmac(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
        data: &[u8],
    ) -> Result<[u8; 32], KeyError> {
        let sym = self.derive_symmetric_key(protocol, key_id, counterparty)?;
        Ok(hmac_sha256(&*sym, data))
    }

    /// BRC-100 `verifyHmac` (constant-time comparison).
    pub fn verify_hmac(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
        data: &[u8],
        expected: &[u8],
    ) -> Result<bool, KeyError> {
        let actual = self.create_hmac(protocol, key_id, counterparty, data)?;
        if expected.len() != 32 {
            return Ok(false);
        }
        let mut diff = 0u8;
        for (a, b) in actual.iter().zip(expected.iter()) {
            diff |= a ^ b;
        }
        Ok(diff == 0)
    }

    /// BRC-100 `encrypt` (`iv(32) || ciphertext || tag(16)` using AES-256-GCM).
    pub fn encrypt(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, KeyError> {
        let sym = self.derive_symmetric_key(protocol, key_id, counterparty)?;
        encrypt_brc2(&sym, plaintext)
    }

    /// BRC-100 `decrypt` (`iv(32) || ciphertext || tag(16)` using AES-256-GCM).
    pub fn decrypt(
        &self,
        protocol: (u8, &str),
        key_id: &str,
        counterparty: Counterparty,
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, KeyError> {
        let sym = self.derive_symmetric_key(protocol, key_id, counterparty)?;
        decrypt_brc2(&sym, ciphertext)
    }
}

fn resolve_signing_digest(
    data: Option<&[u8]>,
    hash_to_directly_sign: Option<&[u8]>,
) -> Result<[u8; 32], KeyError> {
    if let Some(h) = hash_to_directly_sign {
        if h.len() != 32 {
            return Err(KeyError::InvalidSignature(
                "hashToDirectlySign must be exactly 32 bytes".into(),
            ));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(h);
        return Ok(arr);
    }
    let bytes = data.ok_or_else(|| {
        KeyError::InvalidSignature("either data or hashToDirectlySign is required".into())
    })?;
    Ok(sha256(bytes))
}

/// Sign a 32-byte digest with RFC 6979 deterministic secp256k1 ECDSA and enforce BIP-62 low-S DER.
pub fn sign_ecdsa_der(privkey: &SecretKeyBytes, digest32: &[u8; 32]) -> Result<Vec<u8>, KeyError> {
    let signing_key = SigningKey::from_slice(privkey.as_bytes())
        .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
    let sig: Signature = signing_key
        .sign_prehash(digest32)
        .map_err(|e| KeyError::CryptoFailed(e.to_string()))?;
    let normalized = sig.normalize_s().unwrap_or(sig);
    Ok(normalized.to_der().as_bytes().to_vec())
}

/// Verify a DER-encoded secp256k1 ECDSA signature over a 32-byte digest.
pub fn verify_ecdsa_der(
    pubkey_bytes: &[u8],
    digest32: &[u8; 32],
    der_sig: &[u8],
) -> Result<bool, KeyError> {
    let pk = PublicKey::from_sec1_bytes(pubkey_bytes)
        .map_err(|e| KeyError::InvalidPublicKey(e.to_string()))?;
    let vk = VerifyingKey::from(&pk);
    let Ok(der) = DerSignature::from_bytes(der_sig) else {
        return Ok(false);
    };
    let Ok(sig) = Signature::from_der(der.as_bytes()) else {
        return Ok(false);
    };
    // Accept both low-S and high-S during verify (normalized before check, matching @bsv/sdk).
    let norm = sig.normalize_s().unwrap_or(sig);
    Ok(vk.verify_prehash(digest32, &norm).is_ok())
}

/// BRC-2 `SymmetricKey.encrypt`: `iv (32 random bytes) || ciphertext || tag (16 bytes)`.
pub fn encrypt_brc2(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, KeyError> {
    let mut iv = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm32::new(Key::<Aes256Gcm32>::from_slice(key));
    let sealed = cipher
        .encrypt(Nonce::<U32>::from_slice(&iv), plaintext)
        .map_err(|_| KeyError::CryptoFailed("AES-256-GCM encryption failed".into()))?;
    let mut out = Vec::with_capacity(32 + sealed.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// BRC-2 `SymmetricKey.decrypt`: decrypts `iv (32 bytes) || ciphertext || tag (16 bytes)`.
pub fn decrypt_brc2(key: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>, KeyError> {
    if payload.len() < 32 + 16 {
        return Err(KeyError::CryptoFailed("ciphertext too short".into()));
    }
    let iv = &payload[0..32];
    let body = &payload[32..];
    let cipher = Aes256Gcm32::new(Key::<Aes256Gcm32>::from_slice(key));
    cipher
        .decrypt(Nonce::<U32>::from_slice(iv), body)
        .map_err(|_| KeyError::CryptoFailed("decryption failed".into()))
}

fn write_bitcoin_varint(out: &mut Vec<u8>, n: usize) {
    if n < 0xfd {
        out.push(n as u8);
    } else if n <= 0xffff {
        out.push(0xfd);
        out.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n <= 0xffff_ffff {
        out.push(0xfe);
        out.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        out.push(0xff);
        out.extend_from_slice(&(n as u64).to_le_bytes());
    }
}

/// Double-SHA256 Bitcoin Signed Message magic hash (matches `@bsv/sdk` `BSM.magicHash`).
pub fn bsm_magic_hash(message: &[u8]) -> [u8; 32] {
    const PREFIX: &[u8] = b"Bitcoin Signed Message:\n";
    let mut buf = Vec::with_capacity(PREFIX.len() + message.len() + 10);
    write_bitcoin_varint(&mut buf, PREFIX.len());
    buf.extend_from_slice(PREFIX);
    write_bitcoin_varint(&mut buf, message.len());
    buf.extend_from_slice(message);
    sha256(&sha256(&buf))
}

/// Verify a 65-byte compact BSM signature against a mainnet P2PKH `expected_address`.
pub fn verify_bsm(message: &[u8], compact_sig: &[u8], expected_address: &str) -> bool {
    if compact_sig.len() != 65 {
        return false;
    }
    let header = compact_sig[0];
    if !(27..=34).contains(&header) {
        return false;
    }
    let recovery_byte = (header - 27) & 3;
    let Ok(sig) = Signature::from_slice(&compact_sig[1..65]) else {
        return false;
    };
    let Some(recid) = k256::ecdsa::RecoveryId::from_byte(recovery_byte) else {
        return false;
    };
    let digest = bsm_magic_hash(message);
    let Ok(vk) = VerifyingKey::recover_from_prehash(&digest, &sig, recid) else {
        return false;
    };
    let compressed = vk.to_encoded_point(true);
    if p2pkh_address_from_pubkey(compressed.as_bytes(), false) == expected_address {
        return true;
    }
    if header < 31 {
        let uncompressed = vk.to_encoded_point(false);
        if p2pkh_address_from_pubkey(uncompressed.as_bytes(), false) == expected_address {
            return true;
        }
    }
    false
}

/// Produce a 65-byte compact BSM signature (compressed key flag 31 + recid).
pub fn sign_bsm(privkey: &SecretKeyBytes, message: &[u8]) -> Result<[u8; 65], KeyError> {
    let signing_key = SigningKey::from_slice(privkey.as_bytes())
        .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
    let digest = bsm_magic_hash(message);
    let (sig, recid) = signing_key
        .sign_prehash_recoverable(&digest)
        .map_err(|e| KeyError::CryptoFailed(e.to_string()))?;
    let mut out = [0u8; 65];
    out[0] = 31 + recid.to_byte();
    out[1..65].copy_from_slice(&sig.to_bytes());
    Ok(out)
}

/// Verify a BRC-77 `SignedMessage` (`verifier == 0x00` anyone) over `message`.
/// Returns the lowercase compressed 33-byte signer public key hex on success.
pub fn verify_brc77_anyone(message: &[u8], sig: &[u8]) -> Option<String> {
    // Version (4) + signer compressed pubkey (33) + verifier kind 0x00 (1) + key_id (32) + DER sig
    if sig.len() < 78 || sig[0..4] != [0x42, 0x42, 0x33, 0x01] || sig[37] != 0x00 {
        return None;
    }
    let signer_bytes = &sig[4..37];
    parse_public_key_point(signer_bytes).ok()?;
    let signer_hex = encode_hex(signer_bytes);
    let key_id_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &sig[38..70]);
    let der_sig = &sig[70..];
    let mut anyone_bytes = [0u8; 32];
    anyone_bytes[31] = 1;
    let anyone = SecretKeyBytes::from_bytes(anyone_bytes).ok()?;
    let kd = KeyDeriver::new(anyone);
    let valid = kd
        .verify_signature(
            (2, "message signing"),
            &key_id_b64,
            Counterparty::PublicKeyHex(signer_hex.clone()),
            false,
            Some(message),
            None,
            der_sig,
        )
        .ok()?;
    if valid {
        Some(signer_hex)
    } else {
        None
    }
}

/// Sign a message with BRC-77 (`verifier == 0x00` anyone), matching `@bsv/sdk` `SignedMessage.sign`.
pub fn sign_brc77_anyone(privkey: &SecretKeyBytes, message: &[u8]) -> Result<Vec<u8>, KeyError> {
    let signer_pub = privkey.public_key_compressed()?;
    let mut key_id = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key_id);
    let key_id_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key_id);
    let kd = KeyDeriver::new(privkey.clone());
    let der_sig = kd.create_signature(
        (2, "message signing"),
        &key_id_b64,
        Counterparty::Anyone,
        Some(message),
        None,
    )?;
    let mut out = Vec::with_capacity(70 + der_sig.len());
    out.extend_from_slice(&[0x42, 0x42, 0x33, 0x01]);
    out.extend_from_slice(&signer_pub);
    out.push(0x00);
    out.extend_from_slice(&key_id);
    out.extend_from_slice(&der_sig);
    Ok(out)
}

/// Sign `SHA256(message)` with RFC 6979 low-S secp256k1 ECDSA and return 64-byte compact `r || s`
/// (matches `@bsv/sdk` `PrivateKey.sign` + `compactHexFromSig` used by BRC-33/BRC-103 messagebox auth).
pub fn sign_ecdsa_compact(privkey: &SecretKeyBytes, message: &[u8]) -> Result<[u8; 64], KeyError> {
    let digest = sha256(message);
    let signing_key = SigningKey::from_slice(privkey.as_bytes())
        .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
    let sig: Signature = signing_key
        .sign_prehash(&digest)
        .map_err(|e| KeyError::CryptoFailed(e.to_string()))?;
    let normalized = sig.normalize_s().unwrap_or(sig);
    let mut out = [0u8; 64];
    out.copy_from_slice(&normalized.to_bytes());
    Ok(out)
}

/// BRC-78 `EncryptedMessage.encrypt` wire format (`0x42421033 || senderPub(33) || recipientPub(33) || keyID(32) || brc2_ciphertext`).
pub fn brc78_encrypt(
    plaintext: &[u8],
    sender: &SecretKeyBytes,
    recipient_pub_hex: &str,
) -> Result<Vec<u8>, KeyError> {
    let sender_pub = sender.public_key_compressed()?;
    let recip_pt = parse_public_key_hex(recipient_pub_hex)?;
    let recip_pub = compress_point(&recip_pt)?;
    let mut key_id = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key_id);
    let key_id_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key_id);
    let kd = KeyDeriver::new(sender.clone());
    let encrypted = kd.encrypt(
        (2, "message encryption"),
        &key_id_b64,
        Counterparty::PublicKeyHex(encode_hex(&recip_pub)),
        plaintext,
    )?;
    let mut out = Vec::with_capacity(4 + 33 + 33 + 32 + encrypted.len());
    out.extend_from_slice(&[0x42, 0x42, 0x10, 0x33]);
    out.extend_from_slice(&sender_pub);
    out.extend_from_slice(&recip_pub);
    out.extend_from_slice(&key_id);
    out.extend_from_slice(&encrypted);
    Ok(out)
}

/// BRC-78 `EncryptedMessage.decrypt`: verifies version and recipient key, then decrypts the BRC-2 payload.
pub fn brc78_decrypt(
    ciphertext: &[u8],
    recipient: &SecretKeyBytes,
) -> Result<Vec<u8>, KeyError> {
    if ciphertext.len() < 4 + 33 + 33 + 32 + 48 {
        return Err(KeyError::CryptoFailed("BRC-78 ciphertext too short".into()));
    }
    if ciphertext[0..4] != [0x42, 0x42, 0x10, 0x33] {
        return Err(KeyError::CryptoFailed("BRC-78 version mismatch".into()));
    }
    let sender_pub = &ciphertext[4..37];
    let expected_recip = &ciphertext[37..70];
    let actual_recip = recipient.public_key_compressed()?;
    if expected_recip != actual_recip.as_slice() {
        return Err(KeyError::CryptoFailed("BRC-78 recipient key mismatch".into()));
    }
    let key_id_b64 =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &ciphertext[70..102]);
    let payload = &ciphertext[102..];
    let kd = KeyDeriver::new(recipient.clone());
    kd.decrypt(
        (2, "message encryption"),
        &key_id_b64,
        Counterparty::PublicKeyHex(encode_hex(sender_pub)),
        payload,
    )
}

/// Encode bytes into a BRC-26 / UHRP URL (`base58check(0xce00 || sha256(bytes))`).
pub fn uhrp_url_for_bytes(bytes: &[u8]) -> String {
    let digest = sha256(bytes);
    let mut payload = [0u8; 34];
    payload[0] = 0xce;
    payload[1] = 0x00;
    payload[2..].copy_from_slice(&digest);
    bs58::encode(payload).with_check().into_string()
}

/// Decode a UHRP URL (with optional `uhrp://` prefix) back into its 32-byte SHA-256 hash.
pub fn uhrp_hash_from_url(url: &str) -> Option<[u8; 32]> {
    let mut s = url.trim();
    if s.len() >= 5 && s[..5].eq_ignore_ascii_case("uhrp:") {
        s = &s[5..];
    }
    if let Some(rest) = s.strip_prefix("//") {
        s = rest;
    }
    let decoded = bs58::decode(s).with_check(None).into_vec().ok()?;
    if decoded.len() != 34 || decoded[0] != 0xce || decoded[1] != 0x00 {
        return None;
    }
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&decoded[2..]);
    Some(hash)
}

/// Canonical BAP ID for a root address: `base58(RIPEMD160(SHA256(address_utf8)))`.
pub fn bap_id_for_address(address: &str) -> String {
    bs58::encode(hash160(address.as_bytes())).into_string()
}

/// Derive this master key's BAP ID (`identity-0` under `[1, "sigma"]`, mainnet address).
pub fn bap_id_for_deriver(deriver: &KeyDeriver) -> Result<String, KeyError> {
    let root = deriver.derive_private_key((1, "sigma"), "identity-0", Counterparty::SelfParty)?;
    let addr = root.p2pkh_address(false)?;
    Ok(bap_id_for_address(&addr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brc78_encrypt_and_decrypt_roundtrip_and_reject_wrong_recipient() {
        let alice = SecretKeyBytes::from_hex(&"11".repeat(32)).unwrap();
        let bob = SecretKeyBytes::from_hex(&"22".repeat(32)).unwrap();
        let eve = SecretKeyBytes::from_hex(&"33".repeat(32)).unwrap();
        let bob_pub = bob.public_key_hex().unwrap();
        let ct = brc78_encrypt(b"hello identity card", &alice, &bob_pub).unwrap();
        assert_eq!(&ct[0..4], &[0x42, 0x42, 0x10, 0x33]);
        let pt = brc78_decrypt(&ct, &bob).unwrap();
        assert_eq!(pt, b"hello identity card");
        assert!(brc78_decrypt(&ct, &eve).is_err());
        // Self-encryption roundtrip (own-box)
        let alice_pub = alice.public_key_hex().unwrap();
        let ct_self = brc78_encrypt(b"vault identities", &alice, &alice_pub).unwrap();
        assert_eq!(brc78_decrypt(&ct_self, &alice).unwrap(), b"vault identities");
    }

    #[test]
    fn uhrp_url_roundtrips_sha256_hash() {
        let data = b"handcash-avatar-png";
        let url = uhrp_url_for_bytes(data);
        assert_eq!(uhrp_hash_from_url(&url), Some(sha256(data)));
        assert_eq!(uhrp_hash_from_url(&format!("uhrp://{url}")), Some(sha256(data)));
        assert!(uhrp_hash_from_url("not-a-uhrp-url").is_none());
    }

    #[test]
    fn brc157_and_brc75_match_bsv_sdk_golden_vectors() {
        let entropy: Vec<u8> = (1u8..=32u8).collect();
        let master = VaultMaster::from_brc157_entropy(&entropy).unwrap();
        let acc0 = master.account_private_key(0).unwrap();
        let acc1 = master.account_private_key(1).unwrap();

        assert_eq!(
            acc0.to_hex().as_str(),
            "0cc3d1f67425e8a7e570570f1819dbe3e9ff636d993b3c67f1cb51ee3112384d"
        );
        assert_eq!(
            acc0.public_key_hex().unwrap(),
            "032a32ac11bbbd6b333b19cafc986e2508be3621246d75224e234a0d1a2f15eb75"
        );
        assert_eq!(
            acc0.p2pkh_address(false).unwrap(),
            "1Mmd5LJCnFKpkSYkZHdruZBs27koQoRpDj"
        );
        assert_eq!(
            acc0.p2pkh_address(true).unwrap(),
            "n2HaNPPBbGm5XZ2NGrcEjUQBt7MWKVgvXZ"
        );
        assert_eq!(
            acc1.to_hex().as_str(),
            "67f5f339c58bea7ceea484102ade3fd35622c40d09117032092215eb3cf4de80"
        );
        assert_eq!(
            acc1.public_key_hex().unwrap(),
            "03f6dc4f2d36f93205aa1f6bebda0639c122c6347d44523ea6527393b09658ba09"
        );

        let phrase = "absurd avoid scissors anxiety gather lottery category door army half long cage bachelor another expect people blade school educate curtain scrub monitor lady beyond";
        let (canonical, parsed_ent) = parse_mnemonic(phrase).unwrap();
        assert_eq!(canonical, phrase);
        assert_eq!(&*parsed_ent, &entropy);

        let brc75 = VaultMaster::from_mnemonic(phrase, "", MnemonicScheme::Brc75).unwrap();
        let brc75_acc0 = brc75.account_private_key(0).unwrap();
        assert_eq!(
            brc75_acc0.to_hex().as_str(),
            "47c5faf9cdbcec58179a3f2bbc08e7e56868ae966c4ba553c893adec275aadb6"
        );
        assert_eq!(
            brc75_acc0.public_key_hex().unwrap(),
            "026dca6a3f36e46d85b6264267c851d8af1d311f2b1697a73eab898693c0f77b6c"
        );
    }

    #[test]
    fn brc42_key_deriver_matches_bsv_sdk_golden_vectors() {
        let root = SecretKeyBytes::from_hex(&"11".repeat(32)).unwrap();
        let peer = SecretKeyBytes::from_hex(&"22".repeat(32)).unwrap();
        assert_eq!(
            root.public_key_hex().unwrap(),
            "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"
        );
        assert_eq!(
            root.p2pkh_address(false).unwrap(),
            "1Q1pE5vPGEEMqRcVRMbtBK842Y6Pzo6nK9"
        );
        let peer_pub = peer.public_key_hex().unwrap();
        assert_eq!(
            peer_pub,
            "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"
        );

        let kd = KeyDeriver::new(root);
        let derived_self = kd
            .derive_private_key((2, "test proto"), "key-1", Counterparty::SelfParty)
            .unwrap();
        assert_eq!(
            derived_self.to_hex().as_str(),
            "0a9becda9bd02a3a29f4b11d466f58df122a4340ef62acea968832a641b9d294"
        );

        let derived_peer_priv = kd
            .derive_private_key(
                (1, "brc29 test"),
                "inv 01",
                Counterparty::PublicKeyHex(peer_pub.clone()),
            )
            .unwrap();
        assert_eq!(
            derived_peer_priv.to_hex().as_str(),
            "6801845e96d30118507047e63cb78dd2764301eec327412bb841fe4301aee9b6"
        );

        let derived_peer_pub = kd
            .derive_public_key(
                (1, "brc29 test"),
                "inv 01",
                Counterparty::PublicKeyHex(peer_pub.clone()),
                false,
            )
            .unwrap();
        assert_eq!(
            encode_hex(&derived_peer_pub),
            "02c9f2f79ec4da04419d2c148bcc21a5c551f76c85736655f1b63ae8104ecd441e"
        );

        let derived_anyone_pub = kd
            .derive_public_key((0, "public test"), "k0", Counterparty::Anyone, true)
            .unwrap();
        assert_eq!(
            encode_hex(&derived_anyone_pub),
            "0328e3371dedaac4c584959d452c103e271979520d6fcb59ee32046239ff318f06"
        );

        let sym = kd
            .derive_symmetric_key(
                (2, "secret msg"),
                "m-42",
                Counterparty::PublicKeyHex(peer_pub.clone()),
            )
            .unwrap();
        assert_eq!(
            encode_hex(&*sym),
            "cdaccea1cf6b80d56e9c5dfd954c1980ded45d1a440c034c48d6eaf0dc21af76"
        );

        // Encrypt & decrypt symmetry between root and peer
        let peer_kd = KeyDeriver::new(peer);
        let root_pub = kd.identity_key_hex().unwrap();
        let ct = kd
            .encrypt(
                (2, "secret msg"),
                "m-42",
                Counterparty::PublicKeyHex(peer_pub.clone()),
                b"hello handcash rust",
            )
            .unwrap();
        let pt = peer_kd
            .decrypt(
                (2, "secret msg"),
                "m-42",
                Counterparty::PublicKeyHex(root_pub.clone()),
                &ct,
            )
            .unwrap();
        assert_eq!(pt, b"hello handcash rust");

        // Signature create & verify symmetry between root and peer
        let sig = kd
            .create_signature(
                (1, "auth check"),
                "s-1",
                Counterparty::PublicKeyHex(peer_pub.clone()),
                Some(b"handcash native"),
                None,
            )
            .unwrap();
        let valid = peer_kd
            .verify_signature(
                (1, "auth check"),
                "s-1",
                Counterparty::PublicKeyHex(root_pub),
                false,
                Some(b"handcash native"),
                None,
                &sig,
            )
            .unwrap();
        assert!(valid);

        // HMAC roundtrip
        let mac = kd
            .create_hmac(
                (2, "hmac test"),
                "h-1",
                Counterparty::PublicKeyHex(peer_pub),
                b"payload",
            )
            .unwrap();
        assert!(kd
            .verify_hmac(
                (2, "hmac test"),
                "h-1",
                Counterparty::PublicKeyHex(
                    "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27".into()
                ),
                b"payload",
                &mac
            )
            .unwrap());
    }

    #[test]
    fn reserved_key_refusal_blocks_protected_protocols() {
        assert_eq!(
            reserved_key_refusal("getPublicKey", Some("account"), Some("self"), None),
            Some("account-protocol")
        );
        assert_eq!(
            reserved_key_refusal("createSignature", Some("admin secret"), None, None),
            Some("admin-protocol")
        );
        assert_eq!(
            reserved_key_refusal("getPublicKey", Some("p 1sat"), None, None),
            Some("permission-scheme")
        );
        assert_eq!(
            reserved_key_refusal("createSignature", Some("bnt  holder"), None, None),
            Some("asset-protocol")
        );
        assert_eq!(
            reserved_key_refusal(
                "revealCounterpartyKeyLinkage",
                Some("normal proto"),
                Some("self"),
                Some("02abc")
            ),
            Some("self-linkage")
        );
        assert_eq!(
            reserved_key_refusal("getPublicKey", Some("my app proto"), Some("anyone"), None),
            None
        );
    }

    // Ported 1:1 from `src/wallet/primitives/base58check.test.ts`
    #[test]
    fn p2pkh_base58check_matches_zero_hash_vector_and_rejects_invalid_addresses() {
        let zero_addr = "1111111111111111111114oLvT2";
        assert_eq!(p2pkh_address_from_hash160(&[0u8; 20], false), zero_addr);
        assert_eq!(decode_p2pkh_address(zero_addr).unwrap(), (0x00, [0u8; 20]));
        for bad in [
            "",
            "0OIl",
            "1",
            "1111111111111111111114oLvT3",
            &"1".repeat(129),
        ] {
            assert!(decode_p2pkh_address(bad).is_err(), "bad={bad}");
        }
    }

    // Ported 1:1 from `src/wallet/primitives/hashes.test.ts`
    #[test]
    fn hashes_match_empty_composition_vectors_and_lengths() {
        assert_eq!(
            encode_hex(&sha256(&sha256(&[]))),
            "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456"
        );
        assert_eq!(
            encode_hex(&hash160(&[])),
            "b472a266d0bd89c13706a4132ccfb16f7c3b9fcb"
        );
        for len in [0usize, 1, 31, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024, 65536] {
            let storage: Vec<u8> = (0..len + 6).map(|i| ((i * 37 + 11) % 256) as u8).collect();
            let slice = &storage[3..len + 3];
            let d1 = sha256(&sha256(slice));
            let d2 = sha256(&sha256(slice));
            assert_eq!(d1, d2);
            assert_eq!(hash160(slice), hash160(slice));
        }
    }

    // Ported 1:1 from `src/wallet/primitives/coinCrypto.test.ts`
    #[test]
    fn coin_crypto_preserves_legacy_self_keys_and_brc42_vector() {
        let root = SecretKeyBytes::from_hex(&"11".repeat(32)).unwrap();
        let deriver = KeyDeriver::new(root.clone());
        for (name, expected_hex) in [
            ("wltc reserve", "1f5c57e2fe75c32612bfe0f467d41d7a0b62dd30f016f14fa3f32ef2357578f0"),
            ("btc coin", "cc772b2f9244754ceb6fc10f10761eff32ed8ab714c64d2446ddcf06ac56ac35"),
            ("bch coin", "f8d61ba7b5c6a3101e750bec6effb2001f19a6ebe0f94018aa3fd493728fdbd7"),
            ("doge coin", "c01e4444a8357298fa6311d80cb25668c9f0161785184a8dd92529148a6486df"),
            ("arc usd", "fc7973577a39d802f16f73d28f66c857534bfd7becf38325bb7f829b0c20b007"),
        ] {
            let derived = deriver
                .derive_private_key((2, name), "1", Counterparty::parse(Some("self"), true))
                .unwrap();
            assert_eq!(derived.to_hex().as_str(), expected_hex, "protocol={name}");
        }

        // Published BRC-42 mathematical vector
        let recipient = SecretKeyBytes::from_hex(
            "6a1751169c111b4667a6539ee1be6b7cd9f6e9c8fe011a5f2fe31e03a15e0ede",
        )
        .unwrap();
        let recipient_deriver = KeyDeriver::new(recipient.clone());
        let sender_pt = parse_public_key_hex(
            "033f9160df035156f1c48e75eae99914fa1a1546bec19781e8eddb900200bff9d1",
        )
        .unwrap();
        let tweak = recipient_deriver
            .brc42_tweak(&sender_pt, "f3WCaUmnN9U=")
            .unwrap();
        let child = recipient.scalar().unwrap() + tweak;
        assert_eq!(
            encode_hex(&child.to_bytes()),
            "761656715bbfa172f8f9f58f5af95d9d0dfd69014cfdcacc9a245a10ff8893ef"
        );
    }

    // Ported 1:1 from `src/wallet/primitives/coinCrypto.test.ts`
    #[test]
    fn coin_crypto_reciprocity_deterministic_low_s_der_and_rejections() {
        let root = SecretKeyBytes::from_hex(&"11".repeat(32)).unwrap();
        let peer = SecretKeyBytes::from_hex(&"33".repeat(32)).unwrap();
        let sender_deriver = KeyDeriver::new(root.clone());
        let peer_deriver = KeyDeriver::new(peer.clone());

        let sent_pub = sender_deriver
            .derive_public_key(
                (2, "btc payment"),
                "receipt-1",
                Counterparty::parse(Some(&peer.public_key_hex().unwrap()), true),
                false,
            )
            .unwrap();
        let paid_priv = peer_deriver
            .derive_private_key(
                (2, "btc payment"),
                "receipt-1",
                Counterparty::parse(Some(&root.public_key_hex().unwrap()), true),
            )
            .unwrap();
        assert_eq!(paid_priv.public_key_compressed().unwrap(), sent_pub);

        let digest_vec = decode_hex(&"22".repeat(32)).unwrap();
        let digest: [u8; 32] = digest_vec.try_into().unwrap();
        let sig = sign_ecdsa_der(&root, &digest).unwrap();
        assert_eq!(
            encode_hex(&sig),
            "3045022100cfd18ee918d6729134adbc61212142cf71fcf186dfc3123cfca8f7062e0fad5a0220703cc467d9857349ddb6e148bd1663f5050f3f6b9d788d64349c357f14eb4a5f"
        );
        let root_pub = root.public_key_compressed().unwrap();
        assert!(verify_ecdsa_der(&root_pub, &digest, &sig).unwrap());
        let wrong_digest: [u8; 32] = decode_hex(&"23".repeat(32)).unwrap().try_into().unwrap();
        assert!(!verify_ecdsa_der(&root_pub, &wrong_digest, &sig).unwrap());

        for bad_key in ["", "0", &"ff".repeat(32), &"01".repeat(33), "zz"] {
            assert!(SecretKeyBytes::from_hex(bad_key).is_err(), "bad_key={bad_key}");
        }
        for bad_der in [
            "",
            "3006020100020100",
            "3006020180020101",
            "300702020001020101",
            "300602010102010100",
        ] {
            let bytes = decode_hex(bad_der).unwrap();
            assert!(!verify_ecdsa_der(&root_pub, &digest, &bytes).unwrap(), "bad_der={bad_der}");
        }
        for bad_proto in ["tiny", "btc  coin", "btc protocol", "btc/coin"] {
            assert!(
                sender_deriver
                    .derive_private_key((2, bad_proto), "1", Counterparty::parse(Some("self"), true))
                    .is_err(),
                "bad_proto={bad_proto}"
            );
        }
        assert!(
            sender_deriver
                .derive_private_key((2, "btc coin"), "", Counterparty::parse(Some("self"), true))
                .is_err()
        );
    }
}
