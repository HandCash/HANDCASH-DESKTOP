// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Platform-neutral cryptographic and encoding primitives for HandCash Wallet Engine.
//!
//! Backed strictly by audited, permissively licensed Rust crates (`k256`, `bip39`,
//! `bs58`, `ring`, `ripemd`, `sha2`, `hmac`, `hkdf`, `aes-gcm`, `argon2`, `zeroize`).

pub mod brc140;
pub mod brc39;
pub mod delta_seal;
pub mod encoding;
pub mod keys;
pub mod vault;
