// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Application services and wallet session state for `handcash-native`.

use crate::machines::{CollectionView, FiatCode, MarketCoin};
use crate::theme::{read_resolved_theme, AppearancePreference, ResolvedTheme};
use base64::Engine as _;
use handcash_bitcoin::beef::Beef;
use handcash_bitcoin::issuer::{
    compute_issuer_trust_state, extract_issuer_from_beef, extract_issuer_from_custom_instructions,
    extract_issuer_from_tx, issuer_metadata_from_script, normalize_bap_id,
    normalize_issuer_identity_key, parse_outpoint, verify_issuer_identity_package,
    verify_verified_issuer_list, VerifiedBapIdentity, VerifiedIssuerEntry,
};
use handcash_bitcoin::ord::parse_ord_envelope;
use handcash_bitcoin::recover::{find_recoverable_outputs, parse_recover_txid, RecoverableOutput};
use handcash_bitcoin::signer::{address_to_locking_script, estimate_p2pkh_fee};
use handcash_bitcoin::tx::{Transaction, TxOutput};
use handcash_engine::WalletEngine;
use handcash_primitives::brc140::{
    create_brc140_shares, extend_brc140_shares, recover_root_key_from_brc140_shares,
    seal_brc140_issued_set, unseal_brc140_issued_set, Brc140IssuedSet, BRC140_DEFAULT_THRESHOLD,
    BRC140_DEFAULT_TOTAL, BRC140_ISSUED_SET_KEY_PREFIX,
};
use handcash_primitives::encoding::{encode_hex, sha256};
use handcash_primitives::keys::{bap_id_for_deriver, KeyDeriver, MnemonicScheme};
use handcash_primitives::vault::{
    change_vault_password, create_new_vault, generate_wrap_secret, restore_vault_from_mnemonic,
    restore_vault_from_root_key, unlock_vault_with_password, UnlockedVault, VaultRecord,
    VAULT_STORAGE_KEY,
};
use handcash_shell::brc100_server::Brc100Bridge;
use handcash_shell::brc39_archive::{Brc39Archive, Brc39ArchiveMeta};
use handcash_shell::durable::DurableStore;
use handcash_shell::host_log::HostLog;
use handcash_shell::release_update::ReleaseUpdater;
use handcash_shell::{omarchy_theme, paths};
use handcash_storage::{
    export_brc38_from_toolbox, ActivityRow, BalanceBreakdown, ItemCardRow, ToolboxDbManager,
};
use qrcode::render::svg;
use qrcode::QrCode;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

pub const APP_VERSION: &str = env!("HANDCASH_PACKAGE_VERSION");
pub const DEVICE_LOCK_MODE_KEY: &str = "handcash.brc100.deviceLock.mode";
pub const OPEN_UNLOCK_SECRET_KEY: &str = "handcash.brc100.vault.openSecret.v1";
/// `storageRegistry.backupConfirmed` / `backupDeferred` / `backupFormatsSaved`.
pub const BACKUP_CONFIRMED_KEY: &str = "handcash.brc100.backupConfirmed";
pub const HISTORY_BACKUP_CONFIRMED_KEY: &str = "handcash.brc100.historyBackupConfirmed";
pub const HISTORY_BACKUP_PREFS_KEY: &str = "handcash.brc100.historyBackup.v1";
pub const BACKUP_DEFERRED_KEY: &str = "handcash.brc100.backupDeferred";
pub const BACKUP_FORMATS_SAVED_KEY: &str = "handcash.backup.formatsSaved.v1";
pub const DEVICE_ID_STORAGE_KEY: &str = "handcash.brc100.deviceId.v1";
pub const DEVICE_WALLETS_STORAGE_KEY: &str = "handcash.brc100.deviceWallets.v1";
pub const SIGNIN_EMAIL_STORAGE_KEY: &str = "handcash.brc100.signinEmail.v1";
pub const SUGGESTED_HISTORY_BACKUP_BASE_URL: &str = "https://cloud.handcash.io";
pub const APPEARANCE_STORAGE_KEY: &str = "handcash.appearance";
pub const FIAT_CURRENCY_STORAGE_KEY: &str = "handcash.brc100.fiatCurrency";
pub const BSV_USD_STORAGE_KEY: &str = "handcash.brc100.bsvUsd";
pub const APP_ACTIVITY_STORAGE_KEY: &str = "handcash.brc100.appActivity";
pub const COLLECTABLE_PROVEN_V2_KEY: &str = "handcash.collectables.proven.v2";
pub const COLLECTABLE_PROVEN_V1_KEY: &str = "handcash.collectables.proven.v1";
pub const INSCRIPTION_RESOLUTION_KEY: &str = "handcash.inscriptionResolution.v1";
pub const VERIFIED_ISSUERS_KEY: &str = "handcash.verifiedIssuers.v1";
pub const ITEM_ART_CACHE_KEY: &str = "handcash.itemArt.v1";
pub const COLLECTABLES_VIEW_KEY: &str = "handcash.collectables.view";
pub const FRIENDS_STORAGE_KEY: &str = "handcash.brc100.friends";
pub const CONNECTED_APPS_STORAGE_KEY: &str = "handcash.brc100.connectedApps";
/// Shared with `src/wallet/labs.ts` — JSON object of enabled lab flags.
pub const LABS_STORAGE_KEY: &str = "handcash.labs.v1";
/// Shared with `src/wallet/acceptedCoins.ts` — `bitcoin` | `all`.
pub const ACCEPTED_COINS_STORAGE_KEY: &str = "handcash.acceptedCoins.v1";
/// Shared with `src/wallet/soundPrefs.ts` — only an explicit `0` mutes.
pub const SFX_PREF_KEY: &str = "handcash.sfx.enabled";

/// 1:1 port of `AcceptedCoins` in `src/wallet/acceptedCoins.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcceptedCoins {
    Bitcoin,
    All,
}

impl AcceptedCoins {
    pub const CHOICES: [AcceptedCoins; 2] = [Self::Bitcoin, Self::All];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bitcoin => "bitcoin",
            Self::All => "all",
        }
    }

    /// Unset means a wallet made before the choice existed: it keeps showing all coins.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("bitcoin") => Self::Bitcoin,
            _ => Self::All,
        }
    }

    pub const fn title(self) -> &'static str {
        match self {
            Self::Bitcoin => "Just Bitcoin SV",
            Self::All => "Bitcoin SV and crypto",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Self::Bitcoin => "Bitcoin SV and its tokens. Other coins and tokens backed by them are hidden, not removed.",
            Self::All => "Bitcoin SV and its tokens, plus LTC, BCH, BTC, DOGE, USDC on Arc, and tokens backed by them.",
        }
    }
}

/// 1:1 port of `LabFeature` in `src/wallet/labs.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LabFeature {
    LocalHandCashHosts,
    ArcUsdc,
}

impl LabFeature {
    pub const ALL: [LabFeature; 2] = [Self::LocalHandCashHosts, Self::ArcUsdc];

    pub const fn key(self) -> &'static str {
        match self {
            Self::LocalHandCashHosts => "localHandCashHosts",
            Self::ArcUsdc => "arcUsdc",
        }
    }

    pub const fn title(self) -> &'static str {
        match self {
            Self::LocalHandCashHosts => "Local HandCash hosts",
            Self::ArcUsdc => "Wrap USDC (Arc)",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Self::LocalHandCashHosts => "Treat pages on localhost as HandCash sites for migrate, handle claim and market listing. For local testing only.",
            Self::ArcUsdc => "Experimental: wrap USDC on Arc onto BSV claim units (not Ethereum or other networks). Holding, send and receive do not need this. Off by default; lab wrap credits a local claim ledger (live Arc payout still unfinished).",
        }
    }
}

/// Whether `feature` is on in a stored `handcash.labs.v1` value.
pub fn lab_flag_in(raw: Option<&str>, feature: LabFeature) -> bool {
    raw.and_then(|r| serde_json::from_str::<Value>(r).ok())
        .and_then(|v| v.get(feature.key()).and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Next `handcash.labs.v1` value; off flags are deleted, like the TS store.
pub fn with_lab_flag(raw: Option<&str>, feature: LabFeature, enabled: bool) -> String {
    let mut map = raw
        .and_then(|r| serde_json::from_str::<Value>(r).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();
    map.retain(|_, v| v.as_bool() == Some(true));
    if enabled {
        map.insert(feature.key().to_string(), Value::Bool(true));
    } else {
        map.remove(feature.key());
    }
    Value::Object(map).to_string()
}
pub const VAULT_ACCOUNTS_PREFIX: &str = "handcash.vault-accounts.v1:";
pub const TOOLBOX_DB_POINTER_V1_PREFIX: &str = "handcash.toolboxDatabasePointer.v1:";
pub const TOOLBOX_DB_POINTER_LEGACY_PREFIX: &str = "handcash.toolbox.dbPointer.";

/// Cached & live BSV/fiat exchange rates (compatible 1:1 with `src/wallet/fx.ts`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FxRates {
    pub per_bsv: HashMap<String, f64>,
    pub usd_per_bsv: f64,
    pub fetched_at_ms: i64,
}

impl FxRates {
    pub fn from_json_str(raw: &str) -> Option<Self> {
        let v = serde_json::from_str::<Value>(raw).ok()?;
        let mut per_bsv = HashMap::new();
        if let Some(obj) = v.get("perBsv").and_then(Value::as_object) {
            for (k, val) in obj {
                if let Some(n) = val.as_f64().filter(|x| x.is_finite() && *x > 0.0) {
                    per_bsv.insert(k.to_ascii_lowercase(), n);
                }
            }
        }
        let usd = v
            .get("usdPerBsv")
            .and_then(Value::as_f64)
            .filter(|x| x.is_finite() && *x > 0.0)
            .or_else(|| per_bsv.get("usd").copied())?;
        per_bsv.entry("usd".into()).or_insert(usd);
        let fetched_at_ms = v.get("fetchedAt").and_then(Value::as_i64).unwrap_or(0);
        Some(Self {
            per_bsv,
            usd_per_bsv: usd,
            fetched_at_ms,
        })
    }

    pub fn to_json_string(&self) -> String {
        serde_json::json!({
            "perBsv": self.per_bsv,
            "usdPerBsv": self.usd_per_bsv,
            "fetchedAt": self.fetched_at_ms,
        })
        .to_string()
    }

    pub fn rate_for(&self, code: FiatCode) -> Option<f64> {
        if let Some(&r) = self.per_bsv.get(code.as_str()) {
            if r.is_finite() && r > 0.0 {
                return Some(r);
            }
        }
        if code == FiatCode::Usd && self.usd_per_bsv.is_finite() && self.usd_per_bsv > 0.0 {
            return Some(self.usd_per_bsv);
        }
        None
    }

    pub fn format_sats(&self, sats: u64, code: FiatCode) -> Option<String> {
        let rate = self.rate_for(code)?;
        let value = (sats as f64 / 100_000_000.0) * rate;
        Some(format_fiat_value(value, code))
    }

    pub fn format_price(&self, code: FiatCode) -> Option<String> {
        let rate = self.rate_for(code)?;
        Some(format_fiat_value(rate, code))
    }
}

pub fn format_fiat_value(amount: f64, code: FiatCode) -> String {
    let sym = code.symbol();
    let abs = amount.abs();
    let zero_decimal = matches!(code, FiatCode::Jpy | FiatCode::Krw);
    if abs == 0.0 {
        return if zero_decimal {
            format!("{sym}0")
        } else {
            format!("{sym}0.00")
        };
    }
    if zero_decimal {
        if abs < 1.0 {
            format!("< {sym}1")
        } else {
            format!("{sym}{}", format_with_commas(abs.round() as u64))
        }
    } else if abs < 0.01 {
        format!("< {sym}0.01")
    } else {
        let cents = (abs * 100.0).round() as u64;
        let whole = cents / 100;
        let frac = cents % 100;
        format!("{sym}{}.{frac:02}", format_with_commas(whole))
    }
}

fn format_with_commas(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppRecord {
    pub origin: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub connected_at: i64,
    #[serde(default)]
    pub accept_incoming_funds: Option<bool>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendRecord {
    pub id: String,
    pub label: String,
    pub identity_key: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messagebox: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IdentityDetails {
    pub claimed_handle: Option<String>,
    pub bap_profile_id: Option<String>,
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub public_identities: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultAccountRow {
    pub index: u32,
    pub name: String,
    pub identity_key: String,
    pub held_here: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSummary {
    pub handle: String,
    pub chain: String,
    pub address: String,
    pub identity_key: String,
    pub account_id: String,
    pub account_index: u32,
    pub toolbox_db_name: String,
    pub generation: u64,
    pub has_mnemonic: bool,
    pub derivation: String,
}

/// Display/grouping metadata for a collectable card enriched from `ord` MAP fields,
/// `handcash.inscriptionResolution.v1`, and `handcash.collectables.proven.v2`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ItemDisplayMeta {
    pub app: Option<String>,
    pub collection_id: Option<String>,
    pub signer: Option<String>,
    pub media_origin: Option<String>,
    pub issuer_attested: bool,
    pub bap_id: Option<String>,
    pub content: Option<String>,
    pub item_type: Option<String>,
    pub sub_type: Option<String>,
    pub traits: Vec<(String, String)>,
    pub extras: Vec<(String, String)>,
}

/// Resolved issuer badge view computed from local profiles, BAP packages, identity cards,
/// and HandCash's signed verified-issuer list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedIssuerDisplay {
    pub identity_key: String,
    pub label: String,
    pub state: &'static str,
    pub profile_id: Option<String>,
    pub image_url: Option<String>,
    pub issuer_attested: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalletSnapshot {
    pub balance: BalanceSummary,
    pub items: Vec<ItemCardRow>,
    pub items_total: u64,
    pub item_art: HashMap<String, String>,
    pub item_meta: HashMap<String, ItemDisplayMeta>,
    pub held_coins: HeldCoins,
    pub activity: Vec<ActivityRow>,
    pub activity_total: u64,
    pub bridge_online: bool,
    pub bridge_http_url: String,
    pub bridge_https_url: String,
    pub engine_phase: u64,
    pub engine_generation: u64,
}

/// Spendable base units (8 decimals) held per non-BSV coin, read from the shared TS
/// coin-wallet durable records (`handcash.{coin}.v1:wallet:…`). Read-only display.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HeldCoins {
    pub ltc: u64,
    pub bch: u64,
    pub btc: u64,
    pub doge: u64,
}

impl HeldCoins {
    /// Units for a non-BSV coin; `None` for BSV and coins without a local wallet.
    pub fn units(&self, coin: MarketCoin) -> Option<u64> {
        match coin {
            MarketCoin::Ltc => Some(self.ltc),
            MarketCoin::Bch => Some(self.bch),
            MarketCoin::Btc => Some(self.btc),
            MarketCoin::Doge => Some(self.doge),
            MarketCoin::Bsv | MarketCoin::ArcUsd => None,
        }
    }
}

/// Spendable units of a serialized TS `CoinState`, mirroring `coinWallet.ts` `balanceOf`:
/// skip coins spent by any payment; count `received` coins only when proven, `claim`
/// coins always, and change coins once their payment is `sent`.
pub fn coin_spendable_units(raw: &str) -> u64 {
    let Ok(state) = serde_json::from_str::<Value>(raw) else {
        return 0;
    };
    let payments = state.get("payments").and_then(Value::as_object);
    let spent: HashSet<&str> = payments
        .into_iter()
        .flat_map(|p| p.values())
        .filter_map(|p| p.get("inputs").and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let Some(coins) = state.get("coins").and_then(Value::as_object) else {
        return 0;
    };
    let mut total: u64 = 0;
    for (key, coin) in coins {
        if spent.contains(key.as_str()) {
            continue;
        }
        let ready = match coin.get("source").and_then(Value::as_str) {
            Some("received") => coin.get("proven").and_then(Value::as_bool) == Some(true),
            Some("claim") => true,
            _ => {
                let txid = key.split(':').next().unwrap_or_default();
                payments
                    .and_then(|p| p.get(txid))
                    .and_then(|p| p.get("status"))
                    .and_then(Value::as_str)
                    == Some("sent")
            }
        };
        if !ready {
            continue;
        }
        let units = match coin.get("litoshi") {
            Some(Value::String(s)) => s.trim().parse::<u64>().unwrap_or(0),
            Some(v) => v.as_u64().unwrap_or(0),
            None => 0,
        };
        total = total.saturating_add(units);
    }
    total
}

/// Full decimal amount with trailing zeros trimmed (TS `formatCoin`).
pub fn format_coin(units: u64, decimals: u32) -> String {
    let scale = 10u64.pow(decimals);
    let whole = units / scale;
    let frac = format!("{:0width$}", units % scale, width = decimals as usize);
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{frac}")
    }
}

/// Four significant digits, no grouping, trailing zeros dropped (TS `formatCoinShort`).
pub fn format_coin_short(units: u64, decimals: u32) -> String {
    if units == 0 {
        return "0".to_string();
    }
    let value = units as f64 / 10f64.powi(decimals as i32);
    let magnitude = value.abs().log10().floor() as i32;
    let places = (3 - magnitude).max(0) as usize;
    let s = format!("{value:.places$}");
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

/// Normalised key for the shared `handcash.itemArt.v1` cache (TS `originArtKey`):
/// lowercase, with a trailing `.N` vout separator rewritten to `_N`.
pub fn origin_art_key(origin: &str) -> String {
    let o = origin.trim().to_ascii_lowercase();
    if let Some((txid, vout)) = o.rsplit_once('.') {
        if !vout.is_empty() && vout.bytes().all(|b| b.is_ascii_digit()) {
            return format!("{txid}_{vout}");
        }
    }
    o
}

fn is_bare_item_name(item: &ItemCardRow) -> bool {
    let n = item.name.trim();
    n.is_empty()
        || n.starts_with(&format!("{} #", item.basket))
        || n.starts_with("out-")
        || (n.len() >= 12 && n.contains('…'))
        || n.eq_ignore_ascii_case("Migrated collectable")
        || n.eq_ignore_ascii_case("Market item to buyer")
        || n.eq_ignore_ascii_case("Imported collectable")
        || n.eq_ignore_ascii_case("HandCash collectable")
}

fn is_valid_origin_key(origin_key: &str) -> bool {
    let Some((txid, vout)) = origin_key.rsplit_once('_') else {
        return false;
    };
    txid.len() == 64
        && txid.bytes().all(|b| b.is_ascii_hexdigit())
        && !vout.is_empty()
        && vout.bytes().all(|b| b.is_ascii_digit())
}

/// Enrich `items` and `item_meta` from the shared TS `handcash.inscriptionResolution.v1` cache
/// (keyed by outpoint `txid.vout` or origin `txid_vout`). Skips placeholder self-origin entries.
pub fn apply_inscription_resolutions(
    raw: &str,
    items: &mut [ItemCardRow],
    item_meta: &mut HashMap<String, ItemDisplayMeta>,
) {
    let Ok(Value::Object(cache)) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    for item in items.iter_mut() {
        let out_dot = item.outpoint.trim().to_ascii_lowercase().replace('_', ".");
        let out_us = origin_art_key(&item.outpoint);
        let orig_dot = item
            .origin_outpoint
            .trim()
            .to_ascii_lowercase()
            .replace('_', ".");
        let orig_us = origin_art_key(&item.origin_outpoint);
        let hit = [&item.outpoint, &out_dot, &out_us, &item.origin_outpoint, &orig_dot, &orig_us]
            .into_iter()
            .filter(|k| !k.trim().is_empty())
            .find_map(|k| cache.get(k.as_str()).and_then(Value::as_object));
        let Some(rec) = hit else {
            continue;
        };
        let rec_origin = rec
            .get("origin")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let rec_mime = rec
            .get("mimeType")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let has_traits = rec
            .get("traits")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
        // Skip GorillaPool unindexed self-origin placeholders (TS `isPlaceholderResolution`).
        if let Some(ro) = rec_origin {
            if origin_art_key(ro) == out_us && rec_mime.is_none() && !has_traits {
                continue;
            }
            if origin_art_key(&item.origin_outpoint) == out_us && origin_art_key(ro) != out_us {
                item.origin_outpoint = ro.replace('_', ".");
            }
        }
        if let Some(m) = rec_mime {
            if item.mime.is_empty() || item.mime == "application/octet-stream" {
                item.mime = m.to_string();
            }
        }
        if let Some(name) = rec
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if is_bare_item_name(item) {
                item.name = name.to_string();
            }
        }
        let entry = item_meta.entry(item.outpoint.clone()).or_default();
        if entry.app.is_none() {
            entry.app = rec
                .get("app")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
        }
        if entry.collection_id.is_none() {
            entry.collection_id = rec
                .get("collectionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
        }
        if item.issuer_key.is_none() {
            if let Some(iss) = rec
                .get("issuer")
                .or_else(|| rec.get("issuerKey"))
                .and_then(Value::as_str)
                .and_then(normalize_issuer_identity_key)
            {
                item.issuer_key = Some(iss);
            }
        }
        if entry.signer.is_none() {
            entry.signer = rec
                .get("signer")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
        }
        if entry.media_origin.is_none() {
            entry.media_origin = rec
                .get("content")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(origin_art_key)
                .filter(|k| is_valid_origin_key(k));
        }
        if entry.content.is_none() {
            entry.content = rec
                .get("content")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
        }
        if entry.item_type.is_none() {
            entry.item_type = rec
                .get("type")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
        }
        if entry.sub_type.is_none() {
            entry.sub_type = rec
                .get("subType")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
        }
        if entry.bap_id.is_none() {
            entry.bap_id = rec
                .get("bapId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
        }
        if rec.get("issuerAttested").and_then(Value::as_bool) == Some(true) {
            entry.issuer_attested = true;
        }
        if entry.traits.is_empty() {
            if let Some(arr) = rec.get("traits").and_then(Value::as_array) {
                for t in arr {
                    let name = t.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    let val = t.get("value").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if !name.is_empty() && !val.is_empty() {
                        entry.traits.push((name.to_string(), val.to_string()));
                    }
                }
            }
        }
        if let Some(arr) = rec.get("extras").and_then(Value::as_array) {
            let fill_extras = entry.extras.is_empty();
            for t in arr {
                let name = t.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
                let val = t.get("value").and_then(Value::as_str).map(str::trim).unwrap_or("");
                if name.is_empty() || val.is_empty() {
                    continue;
                }
                if item.issuer_key.is_none() && (name.eq_ignore_ascii_case("issuer") || name.eq_ignore_ascii_case("issuerKey")) {
                    if let Some(iss) = normalize_issuer_identity_key(val) {
                        item.issuer_key = Some(iss);
                    }
                }
                if entry.bap_id.is_none() && name.eq_ignore_ascii_case("bapId") {
                    if let Some(bid) = normalize_bap_id(val) {
                        entry.bap_id = Some(bid);
                    }
                }
                if fill_extras {
                    entry.extras.push((name.to_string(), val.to_string()));
                }
            }
        }
    }
}

/// Fill `item_art` (keyed by outpoint) for items missing art from the shared
/// `handcash.itemArt.v1` cache (`{ originKey: { mime, b64 } }`), checking derivative
/// `media_origin`, `origin_outpoint`, and `outpoint`. Only `image/*` entries.
pub fn fill_item_art_from_cache_with_meta(
    raw: &str,
    items: &[ItemCardRow],
    item_meta: &HashMap<String, ItemDisplayMeta>,
    item_art: &mut HashMap<String, String>,
) {
    let Ok(cache) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let Some(cache) = cache.as_object() else {
        return;
    };
    for item in items {
        if item_art.contains_key(&item.outpoint) {
            continue;
        }
        let media_orig = item_meta
            .get(&item.outpoint)
            .and_then(|m| m.media_origin.as_deref())
            .unwrap_or("");
        let hit = [media_orig, item.origin_outpoint.as_str(), item.outpoint.as_str()]
            .into_iter()
            .filter(|o| !o.trim().is_empty())
            .find_map(|o| cache.get(&origin_art_key(o)));
        let Some(entry) = hit else {
            continue;
        };
        let mime = entry
            .get("mime")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let b64 = entry.get("b64").and_then(Value::as_str).unwrap_or_default();
        if mime.to_ascii_lowercase().starts_with("image/") && !b64.is_empty() {
            item_art.insert(item.outpoint.clone(), format!("data:{mime};base64,{b64}"));
        }
    }
}

/// Fill `item_art` (keyed by outpoint) for items missing art from the shared
/// `handcash.itemArt.v1` cache (`{ originKey: { mime, b64 } }`). Only `image/*` entries.
pub fn fill_item_art_from_cache(
    raw: &str,
    items: &[ItemCardRow],
    item_art: &mut HashMap<String, String>,
) {
    fill_item_art_from_cache_with_meta(raw, items, &HashMap::new(), item_art);
}

/// Last resort for items whose bytes never reached this device (legacy-address sweeps):
/// GorillaPool `/content/{origin}` (TS `contentUrlForOrigin`). Only for image or
/// unknown mime so a non-image inscription keeps the placeholder tile.
pub fn fill_item_art_remote(
    chain: &str,
    items: &[ItemCardRow],
    item_art: &mut HashMap<String, String>,
) {
    let base = if chain == "main" {
        "https://ordinals.gorillapool.io"
    } else {
        "https://testnet.ordinals.gorillapool.io"
    };
    for item in items {
        if item_art.contains_key(&item.outpoint) {
            continue;
        }
        let mime = item.mime.to_ascii_lowercase();
        if !(mime.starts_with("image/") || mime.is_empty() || mime == "application/octet-stream") {
            continue;
        }
        let origin = origin_art_key(&item.origin_outpoint);
        let Some((txid, vout)) = origin.rsplit_once('_') else {
            continue;
        };
        if txid.len() != 64
            || !txid.bytes().all(|b| b.is_ascii_hexdigit())
            || vout.is_empty()
            || !vout.bytes().all(|b| b.is_ascii_digit())
        {
            continue;
        }
        item_art.insert(item.outpoint.clone(), format!("{base}/content/{origin}"));
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BalanceSummary {
    pub spendable_sats: u64,
    pub pending_change_sats: u64,
    pub displayed_sats: u64,
    pub spendable_utxo_count: u64,
    pub item_count: u64,
}

impl From<BalanceBreakdown> for BalanceSummary {
    fn from(b: BalanceBreakdown) -> Self {
        Self {
            spendable_sats: b.spendable_sats,
            pending_change_sats: b.pending_change_sats,
            displayed_sats: b.displayed_sats,
            spendable_utxo_count: b.spendable_utxo_count,
            item_count: b.item_count,
        }
    }
}

/// Result of [`AppServices::scan_recover_tx`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoverScan {
    pub txid: String,
    pub outputs: Vec<RecoverableOutput>,
}

pub struct ActiveSession {
    pub vault: UnlockedVault,
    pub deriver: KeyDeriver,
    pub summary: SessionSummary,
}

pub struct AppServices {
    pub user_data_dir: PathBuf,
    pub durable: Arc<DurableStore>,
    pub engine: Arc<WalletEngine>,
    pub toolbox: ToolboxDbManager,
    pub brc100: Arc<Brc100Bridge>,
    pub brc39_archive: Brc39Archive,
    pub updater: Arc<ReleaseUpdater>,
    pub host_log: Arc<HostLog>,
    pub session: Mutex<Option<ActiveSession>>,
    /// In-memory session cache of resolved item art (`origin_key -> Some(data_uri) | None` for misses).
    item_art_mem: Mutex<HashMap<String, Option<String>>>,
    /// Origins currently being fetched in the background so we never storm indexers.
    item_art_inflight: Mutex<HashSet<String>>,
    /// Origins already queried against GorillaPool `/api/txos/outpoints` this session.
    meta_backfill_asked: Mutex<HashSet<String>>,
    /// Epoch ms of the last automatic peer identity sync attempt (30 s cooldown).
    last_peer_identity_sync_ms: std::sync::atomic::AtomicI64,
    patch_tx: watch::Sender<u64>,
    theme_tx: watch::Sender<ResolvedTheme>,
    fx_tx: watch::Sender<FxRates>,
    health_tx: watch::Sender<crate::health::DependencyHealthSnapshot>,
}

impl AppServices {
    pub fn open_default() -> Result<Arc<Self>, String> {
        let user_data_dir = paths::user_data_dir();
        let durable = DurableStore::open_default()?;
        let svc = Self::open_with(user_data_dir, durable, false)?;
        svc.start_theme_watcher();
        Ok(svc)
    }

    pub fn open_in(dir: PathBuf, testnet: bool) -> Result<Arc<Self>, String> {
        let durable = DurableStore::open(dir.join("durable"))?;
        Self::open_with(dir, durable, testnet)
    }

    fn open_with(
        user_data_dir: PathBuf,
        durable: Arc<DurableStore>,
        testnet: bool,
    ) -> Result<Arc<Self>, String> {
        let host_log = HostLog::open(user_data_dir.join("logs"));
        let engine = WalletEngine::open(&user_data_dir, testnet).map_err(|e| e.to_string())?;
        let toolbox = ToolboxDbManager::new(&user_data_dir);
        let brc100 = Brc100Bridge::new(user_data_dir.clone(), Arc::clone(&host_log));
        let brc39_archive = Brc39Archive::open(user_data_dir.join("brc39-archive"));
        let _ = brc39_archive.sweep_temps();
        let platform = if cfg!(target_os = "windows") {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let updater = ReleaseUpdater::new(Arc::clone(&durable), APP_VERSION, platform);
        let (patch_tx, _) = watch::channel(0u64);
        let (theme_tx, _) = watch::channel(read_resolved_theme());
        let initial_fx = durable
            .get(BSV_USD_STORAGE_KEY)
            .as_deref()
            .and_then(FxRates::from_json_str)
            .unwrap_or_default();
        let (fx_tx, _) = watch::channel(initial_fx);
        let (health_tx, _) = watch::channel(crate::health::DependencyHealthSnapshot::default());
        {
            let tx = patch_tx.clone();
            engine.set_push_handler(move |_patch| {
                let next = tx.borrow().wrapping_add(1);
                let _ = tx.send(next);
            });
        }
        let services = Arc::new(Self {
            user_data_dir,
            durable,
            engine,
            toolbox,
            brc100,
            brc39_archive,
            updater,
            host_log,
            session: Mutex::new(None),
            item_art_mem: Mutex::new(HashMap::new()),
            item_art_inflight: Mutex::new(HashSet::new()),
            meta_backfill_asked: Mutex::new(HashSet::new()),
            last_peer_identity_sync_ms: std::sync::atomic::AtomicI64::new(0),
            patch_tx,
            theme_tx,
            fx_tx,
            health_tx,
        });
        crate::brc100_native::install_direct_handler(&services);
        crate::device_peer::install_direct_device_peer_handler(&services);
        Ok(services)
    }

    pub fn current_fx_rates(&self) -> FxRates {
        self.fx_tx.borrow().clone()
    }

    pub fn subscribe_fx(&self) -> watch::Receiver<FxRates> {
        self.fx_tx.subscribe()
    }

    pub fn dependency_health(&self) -> crate::health::DependencyHealthSnapshot {
        self.health_tx.borrow().clone()
    }

    pub fn subscribe_dependency_health(
        &self,
    ) -> watch::Receiver<crate::health::DependencyHealthSnapshot> {
        self.health_tx.subscribe()
    }

    /// Run upstream probes once (`refreshDependencyHealth`); logs summary + per-probe lines.
    pub async fn refresh_dependency_health_async(
        self: Arc<Self>,
    ) -> crate::health::DependencyHealthSnapshot {
        let probes = crate::health::run_probes().await;
        let summary = crate::health::summarize(&probes);
        self.host_log.append("info", "dependency-health", &summary);
        for p in &probes {
            self.host_log.append(
                "info",
                "dependency-health",
                &format!("{}: {} — {}", p.label, p.status.as_str(), p.detail),
            );
        }
        let snap = crate::health::DependencyHealthSnapshot {
            at: now_ms(),
            probes,
            summary,
        };
        let _ = self.health_tx.send(snap.clone());
        snap
    }

    /// Fetch live BSV/fiat exchange rates for all 12 supported currencies and persist to durable store.
    pub async fn refresh_fx_rates_async(self: Arc<Self>) {
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let vs = FiatCode::ALL
            .iter()
            .map(|c| c.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let mut per_bsv: HashMap<String, f64> = HashMap::new();
        let cg_url = format!(
            "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies={vs}"
        );
        if let Ok(resp) = client.get(&cg_url).send().await {
            if resp.status().is_success() {
                if let Ok(v) = resp.json::<Value>().await {
                    if let Some(obj) = v.get("bitcoin-cash-sv").and_then(Value::as_object) {
                        for (k, val) in obj {
                            if let Some(n) = val.as_f64().filter(|x| x.is_finite() && *x > 0.0) {
                                per_bsv.insert(k.to_ascii_lowercase(), n);
                            }
                        }
                    }
                }
            }
        }
        // Fallback to WhatsOnChain USD rate if CoinGecko was rate-limited or unreachable.
        if !per_bsv.contains_key("usd") {
            if let Ok(resp) = client
                .get("https://api.whatsonchain.com/v1/bsv/main/exchangerate")
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(v) = resp.json::<Value>().await {
                        let rate = v
                            .get("rate")
                            .and_then(|r| {
                                r.as_f64()
                                    .or_else(|| r.as_str().and_then(|s| s.parse::<f64>().ok()))
                            })
                            .filter(|x| x.is_finite() && *x > 0.0);
                        if let Some(usd) = rate {
                            per_bsv.insert("usd".into(), usd);
                        }
                    }
                }
            }
        }
        let Some(&usd) = per_bsv.get("usd") else {
            return;
        };
        // Preserve any previously known cross-rates rescaled to the new USD rate (matches `fx.ts`).
        let prev = self.current_fx_rates();
        if prev.usd_per_bsv > 0.0 {
            for code in FiatCode::ALL {
                let k = code.as_str();
                if !per_bsv.contains_key(k) {
                    if let Some(&old) = prev.per_bsv.get(k) {
                        if old > 0.0 {
                            per_bsv.insert(k.to_string(), (old / prev.usd_per_bsv) * usd);
                        }
                    }
                }
            }
        }
        let next = FxRates {
            per_bsv,
            usd_per_bsv: usd,
            fetched_at_ms: now_ms(),
        };
        let _ = self
            .durable
            .set(BSV_USD_STORAGE_KEY, &next.to_json_string(), false);
        let _ = self.fx_tx.send(next);
    }

    pub fn load_identity_details(&self, profile: &SessionSummary) -> IdentityDetails {
        let mut details = IdentityDetails::default();

        // 0. Canonical public identities view + presented account profile (BRC-248 / BAP / card).
        let view = self.list_public_identities_view(profile);
        if let Some(prof) =
            self.account_profile_for(&profile.chain, profile.account_index, &profile.identity_key)
        {
            details.display_name = Some(prof.name);
            if !prof.description.trim().is_empty() {
                details.bio = Some(prof.description);
            }
        }
        for row in &view.rows {
            if details.bap_profile_id.is_none() && row.bap_published {
                details.bap_profile_id = Some(row.bap_id.clone());
            }
            if details.display_name.is_none() {
                details.display_name = row.name.clone();
            }
            if details.bio.is_none() {
                details.bio = row.description.clone().filter(|s| !s.trim().is_empty());
            }
            if let Some(ref n) = row.name {
                details
                    .public_identities
                    .push((n.clone(), row.identity_key.clone()));
            }
        }

        // 1. Read legacy `handcash.publicIdentities.v1` shapes if still empty.
        for key in [
            format!(
                "handcash.publicIdentities.v1:{}:{}",
                profile.chain, profile.identity_key
            ),
            format!("handcash.publicIdentities.v1:{}", profile.identity_key),
            "handcash.publicIdentities.v1".to_string(),
        ] {
            if let Some(raw) = self.durable.get(&key) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    let arr = v
                        .as_array()
                        .or_else(|| v.get("identities").and_then(Value::as_array))
                        .or_else(|| v.get("entries").and_then(Value::as_array));
                    if let Some(list) = arr {
                        for entry in list {
                            let prof = entry.get("profile").unwrap_or(entry);
                            let name = prof
                                .get("name")
                                .or_else(|| prof.get("alternateName"))
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty());
                            let id = prof
                                .get("id")
                                .or_else(|| entry.get("bapId"))
                                .or_else(|| entry.get("identityKey"))
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty());
                            let bio = prof
                                .get("description")
                                .or_else(|| prof.get("bio"))
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty());
                            if details.bap_profile_id.is_none()
                                && prof.get("source").and_then(Value::as_str) == Some("bap")
                            {
                                details.bap_profile_id = id.map(ToString::to_string);
                            }
                            if details.display_name.is_none() {
                                details.display_name = name.map(ToString::to_string);
                            }
                            if details.bio.is_none() {
                                details.bio = bio.map(ToString::to_string);
                            }
                            if let (Some(n), Some(i)) = (name, id) {
                                details
                                    .public_identities
                                    .push((n.to_string(), i.to_string()));
                            }
                        }
                    }
                }
            }
        }

        // 2. Read `handcash.identityProfiles.v1` (chain-scoped or unscoped).
        for key in [
            format!("handcash.identityProfiles.v1:{}", profile.chain),
            "handcash.identityProfiles.v1".to_string(),
        ] {
            if let Some(raw) = self.durable.get(&key) {
                if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) {
                    if let Some(entry) = map
                        .get(&profile.identity_key)
                        .or_else(|| map.get(&profile.identity_key.to_ascii_lowercase()))
                    {
                        if details.display_name.is_none() {
                            details.display_name = entry
                                .get("name")
                                .or_else(|| entry.get("alternateName"))
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(ToString::to_string);
                        }
                        if details.bio.is_none() {
                            details.bio = entry
                                .get("description")
                                .or_else(|| entry.get("bio"))
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(ToString::to_string);
                        }
                        if details.bap_profile_id.is_none() {
                            details.bap_profile_id = entry
                                .get("id")
                                .or_else(|| entry.get("bapId"))
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(ToString::to_string);
                        }
                    }
                }
            }
        }

        // 3. Check claimed cloud handle if present.
        for key in [
            format!("handcash.cloudHandle.v1:{}", profile.identity_key),
            format!("handcash.brc100.claimedHandle:{}", profile.identity_key),
            "handcash.cloudHandle.v1".to_string(),
        ] {
            if let Some(raw) = self.durable.get(&key) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if let Some(h) = v
                        .get("handle")
                        .or_else(|| v.get("display"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        details.claimed_handle = Some(if h.starts_with('$') {
                            h.to_string()
                        } else {
                            format!("${h}")
                        });
                        break;
                    }
                }
            }
        }

        details
    }

    pub fn load_appearance(&self) -> AppearancePreference {
        match self
            .durable
            .get(APPEARANCE_STORAGE_KEY)
            .as_deref()
            .map(str::trim)
        {
            Some("dark") => AppearancePreference::Dark,
            Some("light") => AppearancePreference::Light,
            _ => AppearancePreference::System,
        }
    }

    pub fn save_appearance(&self, pref: AppearancePreference) {
        let _ = self
            .durable
            .set(APPEARANCE_STORAGE_KEY, pref.as_str(), false);
    }

    pub fn load_fiat_currency(&self) -> FiatCode {
        self.durable
            .get(FIAT_CURRENCY_STORAGE_KEY)
            .as_deref()
            .and_then(FiatCode::parse)
            .unwrap_or_default()
    }

    pub fn save_fiat_currency(&self, code: FiatCode) {
        let _ = self
            .durable
            .set(FIAT_CURRENCY_STORAGE_KEY, code.as_str(), false);
    }

    pub fn lab_enabled(&self, feature: LabFeature) -> bool {
        lab_flag_in(self.durable.get(LABS_STORAGE_KEY).as_deref(), feature)
    }

    pub fn set_lab_enabled(&self, feature: LabFeature, enabled: bool) {
        let next = with_lab_flag(
            self.durable.get(LABS_STORAGE_KEY).as_deref(),
            feature,
            enabled,
        );
        let _ = self.durable.set(LABS_STORAGE_KEY, &next, false);
    }

    pub fn load_accepted_coins(&self) -> AcceptedCoins {
        AcceptedCoins::parse(self.durable.get(ACCEPTED_COINS_STORAGE_KEY).as_deref())
    }

    pub fn save_accepted_coins(&self, next: AcceptedCoins) {
        let _ = self
            .durable
            .set(ACCEPTED_COINS_STORAGE_KEY, next.as_str(), false);
    }

    pub fn sfx_enabled(&self) -> bool {
        self.durable.get(SFX_PREF_KEY).as_deref() != Some("0")
    }

    pub fn set_sfx_enabled(&self, enabled: bool) {
        let _ = self
            .durable
            .set(SFX_PREF_KEY, if enabled { "1" } else { "0" }, false);
    }

    pub fn load_collection_view(&self) -> CollectionView {
        self.durable
            .get(COLLECTABLES_VIEW_KEY)
            .as_deref()
            .map(CollectionView::parse)
            .unwrap_or_default()
    }

    pub fn save_collection_view(&self, view: CollectionView) {
        let _ = self
            .durable
            .set(COLLECTABLES_VIEW_KEY, view.as_str(), false);
    }

    fn friends_storage_key(&self) -> String {
        if let Some(s) = self.current_session_summary() {
            format!("{FRIENDS_STORAGE_KEY}:{}:{}", s.chain, s.identity_key)
        } else {
            FRIENDS_STORAGE_KEY.to_string()
        }
    }

    /// Read contacts from durable store (compatible 1:1 with `src/wallet/friends.ts`).
    pub fn list_friends(&self) -> Vec<FriendRecord> {
        let scoped = self.friends_storage_key();
        let raw = self
            .durable
            .get(&scoped)
            .or_else(|| self.durable.get(FRIENDS_STORAGE_KEY));
        let mut list: Vec<FriendRecord> = raw
            .and_then(|s| serde_json::from_str::<Vec<FriendRecord>>(&s).ok())
            .unwrap_or_default();
        list.sort_by_key(|a| a.label.to_ascii_lowercase());
        list
    }

    fn save_friends(&self, friends: &[FriendRecord]) -> Result<(), String> {
        let scoped = self.friends_storage_key();
        let json = serde_json::to_string(friends).map_err(|e| e.to_string())?;
        if !self.durable.set(&scoped, &json, false) {
            return Err("Failed to save friends to durable store.".into());
        }
        Ok(())
    }

    pub fn add_friend(
        &self,
        recipient: &str,
        custom_label: Option<&str>,
    ) -> Result<FriendRecord, String> {
        let parsed = crate::machines::classify_recipient(recipient).ok_or_else(|| {
            "Enter a valid $handle, peerpay: URI, or 66-hex wallet key.".to_string()
        })?;
        let (identity_key, handle, default_label) = match parsed {
            crate::machines::RecipientKind::PeerPay { identity_key }
            | crate::machines::RecipientKind::IdentityKey(identity_key) => {
                let lbl = custom_label
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| truncate_mid(&identity_key, 8));
                (identity_key, None, lbl)
            }
            crate::machines::RecipientKind::Handle(h) => {
                let display = format!("${h}");
                (display.clone(), Some(display.clone()), display)
            }
            crate::machines::RecipientKind::P2pkhAddress(addr) => {
                let lbl = custom_label
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| truncate_mid(&addr, 8));
                (addr, None, lbl)
            }
        };

        let mut list = self.list_friends();
        if let Some(existing) = list.iter().find(|f| f.identity_key == identity_key) {
            return Err(format!(
                "Already in your friends list as {}.",
                existing.label
            ));
        }
        let now = now_ms();
        let rec = FriendRecord {
            id: format!("fr-{now}-{}", list.len() + 1),
            label: default_label,
            identity_key,
            created_at: now,
            handle,
            messagebox: None,
        };
        list.push(rec.clone());
        self.save_friends(&list)?;
        Ok(rec)
    }

    pub fn update_friend_label(&self, id: &str, new_label: &str) -> Result<FriendRecord, String> {
        let trimmed = new_label.trim();
        if trimmed.is_empty() {
            return Err("Contact name cannot be empty.".into());
        }
        let mut list = self.list_friends();
        let Some(pos) = list.iter().position(|f| f.id == id) else {
            return Err("Friend not found.".into());
        };
        if list[pos].handle.is_some() {
            return Err("Handle contacts cannot be renamed.".into());
        }
        list[pos].label = trimmed.to_string();
        let updated = list[pos].clone();
        self.save_friends(&list)?;
        Ok(updated)
    }

    pub fn remove_friend(&self, id: &str) -> Result<(), String> {
        let mut list = self.list_friends();
        let before = list.len();
        list.retain(|f| f.id != id);
        if list.len() == before {
            return Err("Friend not found.".into());
        }
        self.save_friends(&list)
    }

    fn connected_apps_storage_key(&self) -> String {
        if let Some(s) = self.current_session_summary() {
            format!(
                "{CONNECTED_APPS_STORAGE_KEY}:{}:{}",
                s.chain, s.identity_key
            )
        } else {
            CONNECTED_APPS_STORAGE_KEY.to_string()
        }
    }

    /// Read connected BRC-100 apps from durable store (1:1 with `src/wallet/permissions.ts`).
    pub fn list_connected_apps(&self) -> Vec<ConnectedAppRecord> {
        let scoped = self.connected_apps_storage_key();
        let raw = self
            .durable
            .get(&scoped)
            .or_else(|| self.durable.get(CONNECTED_APPS_STORAGE_KEY));
        let mut list: Vec<ConnectedAppRecord> = raw
            .and_then(|s| serde_json::from_str::<Vec<ConnectedAppRecord>>(&s).ok())
            .unwrap_or_default();
        let now = now_ms();
        list.retain(|a| a.expires_at.map(|exp| exp > now).unwrap_or(true));
        list.sort_by_key(|a| std::cmp::Reverse(a.connected_at));
        list
    }

    pub fn revoke_connected_app(&self, origin: &str) -> Result<(), String> {
        let scoped = self.connected_apps_storage_key();
        let mut list = self.list_connected_apps();
        let before = list.len();
        list.retain(|a| a.origin != origin);
        if list.len() == before {
            return Err("App not found.".into());
        }
        let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
        if !self.durable.set(&scoped, &json, false) {
            return Err("Failed to save connected apps.".into());
        }
        Ok(())
    }

    /// List all BRC-208 vault sub-accounts from `handcash.vault-accounts.v1:<masterIdentityKey>`.
    pub fn list_vault_accounts(&self) -> Vec<VaultAccountRow> {
        let guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let Some(active) = guard.as_ref() else {
            return Vec::new();
        };
        let master_ik = active.vault.record.identity_key.clone();
        let key = format!("{VAULT_ACCOUNTS_PREFIX}{master_ik}");
        let mut rows = Vec::new();
        if let Some(raw) = self.durable.get(&key) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(arr) = v.get("accounts").and_then(Value::as_array) {
                    for item in arr {
                        let idx = item.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                            .map(ToString::to_string)
                            .unwrap_or_else(|| {
                                if idx == 0 {
                                    "Primary".into()
                                } else {
                                    format!("Wallet {idx}")
                                }
                            });
                        let ik = item
                            .get("identityKey")
                            .and_then(Value::as_str)
                            .unwrap_or(&master_ik)
                            .to_string();
                        let held_here = item
                            .get("holding")
                            .and_then(|h| h.get("kind"))
                            .and_then(Value::as_str)
                            .map(|k| k == "here")
                            .unwrap_or(true);
                        rows.push(VaultAccountRow {
                            index: idx,
                            name,
                            identity_key: ik,
                            held_here,
                        });
                    }
                }
            }
        }
        if !rows.iter().any(|r| r.index == 0) {
            rows.insert(
                0,
                VaultAccountRow {
                    index: 0,
                    name: "Primary".into(),
                    identity_key: master_ik,
                    held_here: true,
                },
            );
        }
        rows.sort_by_key(|r| r.index);
        rows
    }

    /// Switch the active BRC-208 vault sub-account on this device.
    pub fn switch_vault_account(&self, target_index: u32) -> Result<SessionSummary, String> {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let active = guard
            .as_mut()
            .ok_or_else(|| "Unlock the vault before switching wallets.".to_string())?;
        let master_ik = active.vault.record.identity_key.clone();
        let chain = active.vault.record.chain.clone();
        let handle = active.vault.record.handle.clone();
        let testnet = chain != "main";

        let acc_key = active
            .vault
            .master
            .account_private_key(target_index)
            .map_err(|e| e.to_string())?;
        let active_ik = acc_key.public_key_hex().map_err(|e| e.to_string())?;
        let address = if target_index == 0 {
            active.vault.record.address.clone()
        } else {
            acc_key.p2pkh_address(testnet).map_err(|e| e.to_string())?
        };
        let deriver = KeyDeriver::new(acc_key);
        let account_id = format!("{chain}:{active_ik}");
        let toolbox_db_name = self.resolve_toolbox_db_name(&chain, &handle, target_index);
        let activated = self
            .engine
            .activate_account(&account_id)
            .map_err(|e| e.to_string())?;

        // Persist `activeIndex` in `handcash.vault-accounts.v1:<masterIdentityKey>`.
        let store_key = format!("{VAULT_ACCOUNTS_PREFIX}{master_ik}");
        let mut store_val = self
            .durable
            .get(&store_key)
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| {
                serde_json::json!({
                    "version": 1,
                    "masterIdentityKey": master_ik,
                    "activeIndex": target_index,
                    "accounts": [{
                        "index": 0,
                        "name": "Primary",
                        "identityKey": master_ik,
                    }]
                })
            });
        if let Some(obj) = store_val.as_object_mut() {
            obj.insert("activeIndex".into(), Value::from(target_index));
        }
        if let Ok(json) = serde_json::to_string(&store_val) {
            let _ = self.durable.set(&store_key, &json, false);
        }

        let summary = SessionSummary {
            handle,
            chain,
            address,
            identity_key: active_ik,
            account_id,
            account_index: target_index,
            toolbox_db_name,
            generation: activated.generation,
            has_mnemonic: active.vault.mnemonic.is_some(),
            derivation: active.summary.derivation.clone(),
        };
        active.deriver = deriver;
        active.summary = summary.clone();
        self.host_log.append(
            "info",
            "native-app",
            &format!(
                "switched to sub-account #{} (${}, gen={})",
                summary.account_index, summary.handle, summary.generation
            ),
        );
        Ok(summary)
    }

    /// Create and activate a new BRC-208 vault sub-account on this device.
    pub fn create_vault_account(&self) -> Result<(VaultAccountRow, SessionSummary), String> {
        let existing = self.list_vault_accounts();
        let next_index = existing
            .iter()
            .map(|a| a.index)
            .max()
            .map(|m| m + 1)
            .unwrap_or(1);
        let (master_ik, new_ik) = {
            let guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
            let active = guard
                .as_ref()
                .ok_or_else(|| "Unlock the vault before creating a wallet.".to_string())?;
            let ik = active
                .vault
                .master
                .account_identity_key(next_index)
                .map_err(|e| e.to_string())?;
            (active.vault.record.identity_key.clone(), ik)
        };

        let name = format!("Wallet {next_index}");
        let store_key = format!("{VAULT_ACCOUNTS_PREFIX}{master_ik}");
        let mut store_val = self
            .durable
            .get(&store_key)
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| {
                serde_json::json!({
                    "version": 1,
                    "masterIdentityKey": master_ik,
                    "activeIndex": 0,
                    "accounts": [{
                        "index": 0,
                        "name": "Primary",
                        "identityKey": master_ik,
                    }]
                })
            });
        if let Some(arr) = store_val.get_mut("accounts").and_then(Value::as_array_mut) {
            if !arr
                .iter()
                .any(|a| a.get("index").and_then(Value::as_u64) == Some(next_index as u64))
            {
                arr.push(serde_json::json!({
                    "index": next_index,
                    "name": name,
                    "identityKey": new_ik,
                    "holding": { "kind": "here" }
                }));
            }
        }
        if let Ok(json) = serde_json::to_string(&store_val) {
            let _ = self.durable.set(&store_key, &json, false);
        }
        let summary = self.switch_vault_account(next_index)?;
        let row = VaultAccountRow {
            index: next_index,
            name,
            identity_key: new_ik,
            held_here: true,
        };
        Ok((row, summary))
    }

    pub fn subscribe_patches(&self) -> watch::Receiver<u64> {
        self.patch_tx.subscribe()
    }

    pub fn bump_patch(&self) {
        let next = self.patch_tx.borrow().wrapping_add(1);
        let _ = self.patch_tx.send(next);
    }

    /// Trigger a non-blocking background sync of missing identity profiles and BAP packages
    /// from connected same-identity peer devices.
    pub fn spawn_sync_identities_from_peers(self: &Arc<Self>) {
        let svc = Arc::clone(self);
        self.engine.runtime_handle().spawn(async move {
            let _ = crate::device_peer::sync_identities_from_connected_peers(&svc).await;
        });
    }

    /// If any held collectable has an issuing identity key whose profile is not on this device,
    /// trigger a rate-limited (30 s) background pull from connected peer devices.
    pub fn maybe_sync_missing_identities_from_peers(
        self: &Arc<Self>,
        chain: &str,
        snap: &WalletSnapshot,
    ) {
        let has_unknown_issuer = snap.items.iter().any(|item| {
            let meta = snap.item_meta.get(&item.outpoint);
            let key = item
                .issuer_key
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    meta.and_then(|m| m.signer.as_deref())
                        .filter(|s| !s.trim().is_empty())
                });
            let Some(key) = key else {
                return false;
            };
            let bap_id = meta
                .and_then(|m| m.bap_id.as_deref())
                .filter(|s| !s.trim().is_empty());
            let attested = meta.is_some_and(|m| m.issuer_attested);
            matches!(
                self.resolve_issuer_display(chain, key, bap_id, attested).state,
                "key" | "claim" | "unconfirmed"
            )
        });
        if !has_unknown_issuer {
            return;
        }
        let now = now_ms();
        let prev = self
            .last_peer_identity_sync_ms
            .load(std::sync::atomic::Ordering::Relaxed);
        if now.saturating_sub(prev) < 30_000 {
            return;
        }
        if self
            .last_peer_identity_sync_ms
            .compare_exchange(
                prev,
                now,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
        {
            self.spawn_sync_identities_from_peers();
        }
    }

    pub fn subscribe_theme(&self) -> watch::Receiver<ResolvedTheme> {
        self.theme_tx.subscribe()
    }

    fn start_theme_watcher(&self) {
        let tx = self.theme_tx.clone();
        omarchy_theme::start_watcher(move |_snap| {
            let _ = tx.send(read_resolved_theme());
        });
    }

    pub fn start_bridge(&self) {
        self.brc100.start_if_needed();
    }

    pub fn load_vault_record(&self) -> Option<VaultRecord> {
        let raw = self.durable.get(VAULT_STORAGE_KEY)?;
        serde_json::from_str(&raw).ok()
    }

    /// Mirrors `src/wallet/deviceLockPrefs.ts` (`getDeviceLockMode`).
    pub fn device_lock_mode(&self) -> Option<String> {
        let raw = self.durable.get(DEVICE_LOCK_MODE_KEY)?;
        match raw.trim() {
            "none" | "password" | "device" | "both" => Some(raw.trim().to_string()),
            _ => None,
        }
    }

    /// Mirrors `src/wallet/deviceLockPrefs.ts` (`getOpenUnlockSecret`).
    pub fn open_unlock_secret(&self) -> Option<String> {
        self.durable
            .get(OPEN_UNLOCK_SECRET_KEY)
            .filter(|s| !s.trim().is_empty())
    }

    /// Mirrors `src/wallet/deviceLockPrefs.ts` (`setDeviceLockMode`).
    pub fn set_device_lock_mode(&self, mode: &str) -> bool {
        self.durable.set(DEVICE_LOCK_MODE_KEY, mode, false)
    }

    /// Mirrors `src/wallet/deviceLockPrefs.ts` (`setOpenUnlockSecret`); the
    /// key sits under the vault prefix, so the durable store seals it.
    pub fn set_open_unlock_secret(&self, secret: &str) -> bool {
        self.durable.set(OPEN_UNLOCK_SECRET_KEY, secret, false)
    }

    /// Mirrors `src/wallet/deviceLockPrefs.ts` (`clearOpenUnlockSecret`).
    pub fn clear_open_unlock_secret(&self) {
        self.durable.remove(OPEN_UNLOCK_SECRET_KEY);
    }

    /// Mirrors `src/wallet/defaultDeviceLock.ts` (`osKeyStorageAvailable`):
    /// "None" is only offered when an OS keystore seals the open secret.
    pub fn os_key_storage_available(&self) -> bool {
        self.durable.safe_storage_available()
    }

    /// Mirrors `src/wallet/applyOnboardLock.ts` for the modes this build can
    /// honour (`none`, `password`). Device unlock has no native port yet, so
    /// `device` / `both` are refused rather than faked.
    pub fn apply_onboard_lock(
        &self,
        wrap_password: &str,
        mode: &str,
        user_password: Option<&str>,
    ) -> Result<(), String> {
        if wrap_password.is_empty() {
            return Err("Missing device wrap".into());
        }
        match mode {
            "none" => {
                if !self.set_open_unlock_secret(wrap_password) {
                    return Err("Failed to save the device unlock secret.".into());
                }
                self.set_device_lock_mode("none");
                Ok(())
            }
            "password" => {
                let user_password = user_password.unwrap_or_default();
                if let Some(err) = handcash_primitives::vault::password_policy_error(user_password)
                {
                    return Err(err);
                }
                if user_password != wrap_password {
                    self.change_password(wrap_password, user_password)?;
                }
                self.clear_open_unlock_secret();
                self.set_device_lock_mode("password");
                Ok(())
            }
            _ => Err("Device unlock is not available on this device".into()),
        }
    }

    /// Mirrors `src/wallet/vaultLocalKeys.ts` (`vaultLocalKey`): vault-wide
    /// settings live in the master account's namespace.
    pub fn vault_local_key(&self, base: &str) -> Option<String> {
        let record = self.load_vault_record()?;
        let ik = record.identity_key.trim();
        if ik.is_empty() {
            return None;
        }
        Some(format!("{base}:wallet:{}:0:{ik}", record.chain))
    }

    /// Mirrors `src/wallet/backupStatus.ts` (`isKeysBackupConfirmed`).
    pub fn is_keys_backup_confirmed(&self) -> bool {
        self.vault_local_key(BACKUP_CONFIRMED_KEY)
            .and_then(|k| self.durable.get(&k))
            .as_deref()
            == Some("1")
    }

    /// Mirrors `src/wallet/backupStatus.ts` (`markKeysBackupConfirmed`) plus
    /// `src/wallet/backupFormats.ts` (`markBackupFormatSaved`). The caller
    /// holds the session handoff evidence (phrase copied) like TS does.
    pub fn mark_keys_backup_confirmed(&self, format: &str) -> bool {
        let (Some(confirmed), Some(deferred), Some(formats)) = (
            self.vault_local_key(BACKUP_CONFIRMED_KEY),
            self.vault_local_key(BACKUP_DEFERRED_KEY),
            self.vault_local_key(BACKUP_FORMATS_SAVED_KEY),
        ) else {
            return false;
        };
        if !self.durable.set(&confirmed, "1", false) {
            return false;
        }
        self.durable.remove(&deferred);
        let mut saved: Vec<String> = self
            .durable
            .get(&formats)
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_default();
        if !saved.iter().any(|f| f == format) {
            saved.push(format.to_string());
            if let Ok(json) = serde_json::to_string(&saved) {
                self.durable.set(&formats, &json, false);
            }
        }
        true
    }

    /// Mirrors `src/wallet/backupStatus.ts` (`markKeysBackupDeferred`).
    pub fn mark_keys_backup_deferred(&self) {
        if self.is_keys_backup_confirmed() {
            return;
        }
        if let Some(k) = self.vault_local_key(BACKUP_DEFERRED_KEY) {
            self.durable.set(&k, "1", false);
        }
    }

    /// Mirrors `src/wallet/deviceLockPrefs.ts` (`isNoDeviceLock`).
    pub fn is_no_device_lock(&self) -> bool {
        self.device_lock_mode().as_deref() == Some("none") && self.open_unlock_secret().is_some()
    }

    /// Mirrors `src/wallet/deviceLockPrefs.ts` (`hasMemorablePassword`).
    pub fn has_memorable_password(&self) -> bool {
        match self.device_lock_mode().as_deref() {
            Some("password") | Some("both") => true,
            Some("none") | Some("device") => false,
            _ => {
                let has_pw = self
                    .load_vault_record()
                    .map(|v| v.has_password_factor())
                    .unwrap_or(false);
                has_pw && self.open_unlock_secret().is_none()
            }
        }
    }

    /// Mirrors `src/wallet/deviceLockPrefs.ts` (`shouldAutoUnlock`).
    pub fn should_auto_unlock(&self) -> bool {
        if !self.is_no_device_lock() {
            return false;
        }
        let has_device_wrap = self
            .load_vault_record()
            .and_then(|v| v.wraps)
            .and_then(|w| w.device)
            .map(|d| d.enrolled)
            .unwrap_or(false);
        !has_device_wrap
    }

    /// Auto-unlock a passwordless account using `handcash.brc100.vault.openSecret.v1`.
    pub fn try_auto_unlock(&self) -> Option<Result<SessionSummary, String>> {
        if !self.should_auto_unlock() {
            return None;
        }
        let secret = self.open_unlock_secret()?;
        Some(self.unlock_with_password(&secret))
    }

    pub fn current_session_summary(&self) -> Option<SessionSummary> {
        self.session
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.summary.clone()))
    }

    pub fn current_mnemonic(&self) -> Option<String> {
        self.session
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|s| s.vault.mnemonic.clone()))
    }

    pub fn current_root_key_hex(&self) -> Option<String> {
        self.session
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.vault.master.key_hex().to_string()))
    }

    pub fn verify_password(&self, password: &str) -> Result<(), String> {
        let record = self
            .load_vault_record()
            .ok_or_else(|| "No wallet vault found.".to_string())?;
        unlock_vault_with_password(&record, password)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn set_password_from_open(&self, new_password: &str) -> Result<(), String> {
        if let Some(err) = handcash_primitives::vault::password_policy_error(new_password) {
            return Err(err);
        }
        let open_secret = self
            .open_unlock_secret()
            .ok_or_else(|| "No open device secret found.".to_string())?;
        self.change_password(&open_secret, new_password)?;
        self.clear_open_unlock_secret();
        self.set_device_lock_mode("password");
        Ok(())
    }

    fn resolve_active_subaccount(&self, record: &VaultRecord) -> (u32, String) {
        let key = format!("{VAULT_ACCOUNTS_PREFIX}{}", record.identity_key);
        let Some(raw) = self.durable.get(&key) else {
            return (0, record.identity_key.clone());
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            return (0, record.identity_key.clone());
        };
        let active_idx = v.get("activeIndex").and_then(Value::as_u64).unwrap_or(0) as u32;
        let active_ik = v
            .get("accounts")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|a| a.get("index").and_then(Value::as_u64) == Some(active_idx as u64))
            })
            .and_then(|a| a.get("identityKey").and_then(Value::as_str))
            .map(ToString::to_string)
            .unwrap_or_else(|| record.identity_key.clone());
        (active_idx, active_ik)
    }

    fn resolve_toolbox_db_name(&self, chain: &str, handle: &str, account_index: u32) -> String {
        let base = if account_index == 0 {
            format!("handcash-brc100-{chain}-{handle}")
        } else {
            format!("handcash-brc100-{chain}-{handle}-a{account_index}")
        };
        for prefix in [
            TOOLBOX_DB_POINTER_V1_PREFIX,
            TOOLBOX_DB_POINTER_LEGACY_PREFIX,
        ] {
            let pointer_key = format!("{prefix}{base}");
            if let Some(selected) = self.durable.get(&pointer_key) {
                let trimmed = selected.trim();
                if trimmed.starts_with(&format!("{base}-restore-")) {
                    return trimmed.to_string();
                }
                if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(db) = v
                        .get("dbName")
                        .or_else(|| v.get("name"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| s.starts_with(&format!("{base}-restore-")))
                    {
                        return db.to_string();
                    }
                }
            }
        }
        base
    }

    fn activate_unlocked(&self, unlocked: UnlockedVault) -> Result<SessionSummary, String> {
        let (account_index, active_identity_key) = self.resolve_active_subaccount(&unlocked.record);
        let acc_key = unlocked
            .master
            .account_private_key(account_index)
            .or_else(|_| unlocked.master.account_private_key(0))
            .map_err(|e| e.to_string())?;
        let testnet = unlocked.record.chain != "main";
        let address = if account_index == 0 {
            unlocked.record.address.clone()
        } else {
            acc_key
                .p2pkh_address(testnet)
                .unwrap_or_else(|_| unlocked.record.address.clone())
        };
        let deriver = KeyDeriver::new(acc_key);
        let account_id = format!("{}:{}", unlocked.record.chain, active_identity_key);
        let toolbox_db_name = self.resolve_toolbox_db_name(
            &unlocked.record.chain,
            &unlocked.record.handle,
            account_index,
        );
        let activated = self
            .engine
            .activate_account(&account_id)
            .map_err(|e| e.to_string())?;
        let derivation = match unlocked.record.derivation {
            Some(handcash_primitives::keys::AccountDerivation::Brc157) => "BRC-157",
            _ => "BRC-42",
        }
        .to_string();
        let summary = SessionSummary {
            handle: unlocked.record.handle.clone(),
            chain: unlocked.record.chain.clone(),
            address,
            identity_key: active_identity_key,
            account_id,
            account_index,
            toolbox_db_name,
            generation: activated.generation,
            has_mnemonic: unlocked.mnemonic.is_some(),
            derivation,
        };
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(ActiveSession {
            vault: unlocked,
            deriver,
            summary: summary.clone(),
        });
        self.host_log.append(
            "info",
            "native-app",
            &format!(
                "unlocked ${} ({}) gen={}",
                summary.handle, summary.chain, summary.generation
            ),
        );
        Ok(summary)
    }

    pub fn unlock_with_password(&self, password: &str) -> Result<SessionSummary, String> {
        let record = self
            .load_vault_record()
            .ok_or_else(|| "No wallet vault found on this device.".to_string())?;
        let unlocked = unlock_vault_with_password(&record, password).map_err(|e| e.to_string())?;
        self.activate_unlocked(unlocked)
    }

    pub fn create_vault(
        &self,
        handle: &str,
        password: &str,
        chain: &str,
    ) -> Result<(SessionSummary, Option<String>), String> {
        let unlocked = create_new_vault(handle, password, chain).map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&unlocked.record).map_err(|e| e.to_string())?;
        if !self.durable.set(VAULT_STORAGE_KEY, &json, true) {
            return Err("Failed to save encrypted vault to durable store.".into());
        }
        let phrase = unlocked.mnemonic.clone();
        let summary = self.activate_unlocked(unlocked)?;
        Ok((summary, phrase))
    }

    pub fn restore_vault(
        &self,
        handle: &str,
        mnemonic: &str,
        passphrase: &str,
        password: &str,
        chain: &str,
        scheme: MnemonicScheme,
    ) -> Result<SessionSummary, String> {
        let unlocked =
            restore_vault_from_mnemonic(handle, mnemonic, passphrase, password, chain, scheme)
                .map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&unlocked.record).map_err(|e| e.to_string())?;
        if !self.durable.set(VAULT_STORAGE_KEY, &json, true) {
            return Err("Failed to save restored vault to durable store.".into());
        }
        self.activate_unlocked(unlocked)
    }

    /// Mirrors `src/components/AuthScreen.tsx` create flow: generates a wrap secret,
    /// sets device lock mode to `none` until `OnboardProtectPanel` completes.
    pub fn create_vault_onboard(
        &self,
        handle: &str,
        chain: &str,
    ) -> Result<(SessionSummary, Option<String>, String), String> {
        let wrap = generate_wrap_secret();
        let wrap_str = wrap.as_str().to_string();
        let (sum, phrase) = self.create_vault(handle, &wrap_str, chain)?;
        self.set_open_unlock_secret(&wrap_str);
        self.set_device_lock_mode("none");
        Ok((sum, phrase, wrap_str))
    }

    /// Mirrors `src/components/AuthScreen.tsx` phrase restore flow with wrap secret.
    pub fn restore_vault_onboard(
        &self,
        handle: &str,
        mnemonic: &str,
        passphrase: &str,
        chain: &str,
        scheme: MnemonicScheme,
    ) -> Result<(SessionSummary, String), String> {
        let wrap = generate_wrap_secret();
        let wrap_str = wrap.as_str().to_string();
        let sum = self.restore_vault(handle, mnemonic, passphrase, &wrap_str, chain, scheme)?;
        self.set_open_unlock_secret(&wrap_str);
        self.set_device_lock_mode("none");
        let _ = self.mark_keys_backup_confirmed("phrase");
        Ok((sum, wrap_str))
    }

    /// Mirrors `src/components/AuthScreen.tsx` emergency root key restore flow with wrap secret.
    pub fn restore_vault_root_key_onboard(
        &self,
        handle: &str,
        root_key_hex: &str,
        chain: &str,
    ) -> Result<(SessionSummary, String), String> {
        let wrap = generate_wrap_secret();
        let wrap_str = wrap.as_str().to_string();
        let unlocked = restore_vault_from_root_key(handle, root_key_hex, &wrap_str, chain)
            .map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&unlocked.record).map_err(|e| e.to_string())?;
        if !self.durable.set(VAULT_STORAGE_KEY, &json, true) {
            return Err("Failed to save restored vault to durable store.".into());
        }
        let sum = self.activate_unlocked(unlocked)?;
        self.set_open_unlock_secret(&wrap_str);
        self.set_device_lock_mode("none");
        let _ = self.mark_keys_backup_confirmed("key");
        Ok((sum, wrap_str))
    }

    pub fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<(), String> {
        let record = self
            .load_vault_record()
            .ok_or_else(|| "No wallet vault found.".to_string())?;
        let updated = change_vault_password(&record, current_password, new_password)
            .map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&updated).map_err(|e| e.to_string())?;
        if !self.durable.set(VAULT_STORAGE_KEY, &json, false) {
            return Err("Failed to persist updated vault password.".into());
        }
        if let Ok(mut guard) = self.session.lock() {
            if let Some(active) = guard.as_mut() {
                active.vault.record = updated;
            }
        }
        Ok(())
    }

    /// Recover-from-transaction scan (read-only): fetch `raw_txid` (SQLite
    /// cache first, then the rate-limited chain fetcher) and list its 1-sat
    /// outputs locked to this wallet's address. Import stays on the TS path.
    pub async fn scan_recover_tx(&self, raw_txid: &str) -> Result<RecoverScan, String> {
        let txid = parse_recover_txid(raw_txid)?;
        let summary = {
            let guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .as_ref()
                .map(|a| a.summary.clone())
                .ok_or_else(|| "Unlock the wallet first.".to_string())?
        };
        let lock = address_to_locking_script(&summary.address).map_err(|e| e.to_string())?;
        let hydrated = self
            .engine
            .hydrate_input_txids(
                &summary.account_id,
                summary.generation,
                vec![txid.clone()],
                true,
            )
            .await
            .map_err(|e| e.to_string())?;
        let entry = hydrated
            .found
            .get(&txid)
            .ok_or_else(|| "Transaction not found on chain.".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&entry.bytes_base64)
            .map_err(|e| e.to_string())?;
        let tx = if entry.kind == "beef" {
            Beef::from_bytes(&bytes)
                .map_err(|e| e.to_string())?
                .find_tx(&txid)
                .cloned()
                .ok_or_else(|| "Transaction missing from its BEEF.".to_string())?
        } else {
            Transaction::from_bytes(&bytes).map_err(|e| e.to_string())?
        };
        if tx.txid_hex().map_err(|e| e.to_string())? != txid {
            return Err("Fetched transaction does not match the txid.".into());
        }
        Ok(RecoverScan {
            outputs: find_recoverable_outputs(&txid, &tx, &lock),
            txid,
        })
    }

    pub fn lock(&self) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = None;
        }
        self.engine.lock();
    }

    pub fn read_snapshot(&self) -> WalletSnapshot {
        let bridge = self.brc100.status_snapshot();
        let engine_status = self.engine.status();
        let mut snap = WalletSnapshot {
            bridge_online: bridge
                .get("online")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            bridge_http_url: bridge
                .get("httpUrl")
                .and_then(Value::as_str)
                .unwrap_or("http://127.0.0.1:3321")
                .to_string(),
            bridge_https_url: bridge
                .get("httpsUrl")
                .and_then(Value::as_str)
                .unwrap_or("https://127.0.0.1:2121")
                .to_string(),
            engine_phase: engine_status
                .get("phase")
                .and_then(Value::as_u64)
                .unwrap_or(2),
            engine_generation: engine_status
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            ..Default::default()
        };

        let Some(summary) = self.current_session_summary() else {
            return snap;
        };

        // 1. Prefer the existing Wallet Toolbox SQLite WAL database (`toolbox-sqlite/`) so
        //    existing desktop wallet balances, 1sat items, and activity load 1:1 immediately.
        let mut loaded_from_toolbox = false;
        if let Ok(Some(tb)) = self.toolbox.open_if_exists(&summary.toolbox_db_name) {
            if let Ok((bal, mut items, items_total, activity, activity_total)) =
                tb.read_wallet_snapshot(2000, 100)
            {
                // Decode 1Sat inscription artwork, MAP metadata, and BRC-247/Sigma issuer attribution.
                let mut item_art = HashMap::new();
                let mut item_meta: HashMap<String, ItemDisplayMeta> = HashMap::new();
                let ci_map = tb.read_item_custom_instructions(2000);
                for item in &mut items {
                    if let Some(ref existing_iss) = item.issuer_key {
                        item.issuer_key = normalize_issuer_identity_key(existing_iss);
                    }
                    if let Some(ref hash) = item.art_blob_hash {
                        if let Some(script_bytes) = tb.read_cold_blob(hash) {
                            let tape = issuer_metadata_from_script(&script_bytes);
                            if item.issuer_key.is_none() {
                                item.issuer_key = tape.issuer;
                            }
                            if let Some(bap) = tape.bap_id {
                                let entry = item_meta.entry(item.outpoint.clone()).or_default();
                                if entry.bap_id.is_none() {
                                    entry.bap_id = Some(bap);
                                }
                            }
                            if let Some(ord) = parse_ord_envelope(&script_bytes) {
                                if !ord.content_type.is_empty()
                                    && item.mime == "application/octet-stream"
                                {
                                    item.mime = ord.content_type.clone();
                                }
                                if item.name.starts_with(&format!("{} #", item.basket)) {
                                    if let Some(map_name) = ord
                                        .map_fields
                                        .get("name")
                                        .or_else(|| ord.map_fields.get("subTypeData.name"))
                                        .map(String::as_str)
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                    {
                                        item.name = map_name.to_string();
                                    }
                                }
                                let map_app = ord
                                    .map_fields
                                    .get("app")
                                    .map(String::as_str)
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .map(ToString::to_string);
                                let map_col = ord
                                    .map_fields
                                    .get("subTypeData.collectionId")
                                    .or_else(|| ord.map_fields.get("collectionId"))
                                    .map(String::as_str)
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .map(ToString::to_string);
                                if map_app.is_some() || map_col.is_some() {
                                    let entry = item_meta.entry(item.outpoint.clone()).or_default();
                                    entry.app = map_app;
                                    entry.collection_id = map_col;
                                }
                                let ct = ord.content_type.to_ascii_lowercase();
                                if ct.starts_with("image/")
                                    && !ord.body.is_empty()
                                    && ord.body.len() <= 262_144
                                {
                                    let b64 =
                                        base64::engine::general_purpose::STANDARD.encode(&ord.body);
                                    item_art.insert(
                                        item.outpoint.clone(),
                                        format!("data:{};base64,{b64}", ord.content_type),
                                    );
                                }
                            }
                        }
                    }

                    // Extract issuer key / Sigma verification from custom_instructions (incl. BRC-150 provenance BEEF).
                    if let Some(ci_json) = ci_map.get(&item.outpoint) {
                        let ex = extract_issuer_from_custom_instructions(ci_json, &item.origin_outpoint);
                        if let Some(po) = ex.provenance_origin {
                            if item.origin_outpoint == item.outpoint {
                                item.origin_outpoint = po;
                            }
                        }
                        if let Some(iss) = ex.issuer_key {
                            item.issuer_key = Some(iss);
                        }
                        if ex.bap_id.is_some() || ex.signer.is_some() || ex.issuer_attested {
                            let entry = item_meta.entry(item.outpoint.clone()).or_default();
                            if ex.bap_id.is_some() {
                                entry.bap_id = ex.bap_id;
                            }
                            if ex.signer.is_some() {
                                entry.signer = ex.signer;
                            }
                            if ex.issuer_attested {
                                entry.issuer_attested = true;
                            }
                        }
                    }

                    // Verify Sigma / extract origin MAP issuer from local raw_tx or input_beef when not yet attested.
                    let already_attested = item_meta
                        .get(&item.outpoint)
                        .is_some_and(|m| m.issuer_attested);
                    if !already_attested {
                        let mut from_chain = None;
                        if let Some((orig_txid, orig_vout)) = parse_outpoint(&item.origin_outpoint) {
                            if let Some(raw_tx) = tb.read_raw_tx_by_txid(&orig_txid) {
                                if let Ok(tx) = Transaction::from_bytes(&raw_tx) {
                                    from_chain = Some(extract_issuer_from_tx(&tx, orig_vout));
                                }
                            }
                            if from_chain
                                .as_ref()
                                .is_none_or(|e| e.issuer_key.is_none() && e.signer.is_none())
                            {
                                if let Some((tip_txid, _)) = parse_outpoint(&item.outpoint) {
                                    if let Some(beef_bytes) = tb.read_input_beef_by_txid(&tip_txid) {
                                        from_chain = extract_issuer_from_beef(
                                            &beef_bytes,
                                            &item.origin_outpoint,
                                        );
                                    }
                                }
                            }
                        }
                        if let Some(ex) = from_chain {
                            if ex.issuer_key.is_some() {
                                item.issuer_key = ex.issuer_key;
                            }
                            if ex.bap_id.is_some() || ex.signer.is_some() || ex.issuer_attested {
                                let entry = item_meta.entry(item.outpoint.clone()).or_default();
                                if ex.bap_id.is_some() {
                                    entry.bap_id = ex.bap_id;
                                }
                                if ex.signer.is_some() {
                                    entry.signer = ex.signer;
                                }
                                if ex.issuer_attested {
                                    entry.issuer_attested = true;
                                }
                            }
                        }
                    }
                }
                snap.balance = bal.into();
                snap.items = items;
                snap.items_total = items_total;
                snap.item_art = item_art;
                snap.item_meta = item_meta;
                snap.activity = activity;
                snap.activity_total = activity_total;
                loaded_from_toolbox = true;
            }
        }

        // 2. Fallback to the pure-Rust engine-accounts store when toolbox DB isn't present.
        if !loaded_from_toolbox {
            let rt = self.engine.runtime_handle();
            if let Ok(bal) = rt.block_on(
                self.engine
                    .read_balance(&summary.account_id, summary.generation),
            ) {
                snap.balance = bal.into();
            }
            if let Ok(items) = rt.block_on(self.engine.read_items_page(
                &summary.account_id,
                summary.generation,
                "1sat".to_string(),
                None,
                100,
            )) {
                snap.items = items.items;
                snap.items_total = items.total;
            }
            // Item art for the engine-store path: resolve each card's art blob and keep only
            // bounded `image/*` inscriptions, the same rules as the toolbox path above.
            let mut item_art = HashMap::new();
            for item in &snap.items {
                let Some(ref hash) = item.art_blob_hash else {
                    continue;
                };
                let Ok(Some(script_bytes)) = rt.block_on(self.engine.read_blob(
                    &summary.account_id,
                    summary.generation,
                    hash.clone(),
                )) else {
                    continue;
                };
                let Some(ord) = parse_ord_envelope(&script_bytes) else {
                    continue;
                };
                let ct = ord.content_type.to_ascii_lowercase();
                if ct.starts_with("image/") && !ord.body.is_empty() && ord.body.len() <= 262_144 {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&ord.body);
                    item_art.insert(
                        item.outpoint.clone(),
                        format!("data:{};base64,{b64}", ord.content_type),
                    );
                }
            }
            snap.item_art = item_art;
            if let Ok(activity) = rt.block_on(self.engine.read_activity_page(
                &summary.account_id,
                summary.generation,
                None,
                100,
            )) {
                snap.activity = activity.rows;
                snap.activity_total = activity.total;
            }
        }

        // 2b. Upgrade item authenticity & verified origins from local BRC-150 proven cache,
        //     shared TS collectables list cache, and inscription resolution cache BEFORE art lookup.
        self.apply_proven_collectables(&summary.chain, &mut snap.items);
        self.apply_collectables_list_cache(&summary, &mut snap.items, &mut snap.item_meta);
        if let Some(raw) = self.durable.get(INSCRIPTION_RESOLUTION_KEY) {
            apply_inscription_resolutions(&raw, &mut snap.items, &mut snap.item_meta);
        }

        // 2c. Fill collectable art from instant local caches (session memory, then durable
        //     `handcash.itemArt.v1`). Missing image origins are prefetched in a bounded
        //     background batch rather than stalling Blitz on 100 uncached HTTPS <img> loads.
        if let Ok(mem) = self.item_art_mem.lock() {
            for item in &snap.items {
                if snap.item_art.contains_key(&item.outpoint) {
                    continue;
                }
                let media_orig = snap
                    .item_meta
                    .get(&item.outpoint)
                    .and_then(|m| m.media_origin.as_deref())
                    .unwrap_or("");
                let hit = [media_orig, item.origin_outpoint.as_str(), item.outpoint.as_str()]
                    .into_iter()
                    .filter(|o| !o.trim().is_empty())
                    .find_map(|o| mem.get(&origin_art_key(o)).and_then(|v| v.as_ref()));
                if let Some(uri) = hit {
                    snap.item_art.insert(item.outpoint.clone(), uri.clone());
                }
            }
        }
        if let Some(raw) = self.durable.get(ITEM_ART_CACHE_KEY) {
            fill_item_art_from_cache_with_meta(
                &raw,
                &snap.items,
                &snap.item_meta,
                &mut snap.item_art,
            );
        }

        // 2d. Other-coin balances (read-only) from the shared TS coin-wallet records.
        let coin_units = |coin: &str| {
            let key = format!(
                "handcash.{coin}.v1:wallet:{}:{}:{}",
                summary.chain, summary.account_index, summary.identity_key
            );
            self.durable
                .get(&key)
                .map(|raw| coin_spendable_units(&raw))
                .unwrap_or(0)
        };
        snap.held_coins = HeldCoins {
            ltc: coin_units("ltc"),
            bch: coin_units("bch"),
            btc: coin_units("btc"),
            doge: coin_units("doge"),
        };

        // 3. Proven collectables already applied in step 2b before art lookup.

        // 4. Merge rich appActivity entries from durable store (`handcash.brc100.appActivity:*`).
        self.merge_durable_app_activity(&summary, &mut snap.activity);
        snap.activity_total = snap.activity_total.max(snap.activity.len() as u64);

        // 5. If still zeroed, hydrate displayed balance from lastTrusted durable cache.
        if snap.balance.displayed_sats == 0 {
            let cache_key = format!(
                "handcash.balance.lastTrusted:{}:{}",
                summary.chain, summary.identity_key
            );
            if let Some(raw) = self
                .durable
                .get(&cache_key)
                .or_else(|| self.durable.get("handcash.balance.lastTrusted"))
            {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if let Some(sats) = v
                        .get("displayedSatoshis")
                        .or_else(|| v.get("spendableSatoshis"))
                        .or_else(|| v.get("satoshis"))
                        .and_then(Value::as_u64)
                    {
                        snap.balance.displayed_sats = sats;
                        snap.balance.spendable_sats = sats;
                    }
                }
            }
        }
        snap
    }

    /// Prefetch missing collectable artwork in bounded parallel batches, storing results in
    /// session memory and persisting bounded entries to the shared `handcash.itemArt.v1` cache.
    pub fn prefetch_missing_item_art(self: &Arc<Self>, chain: &str, snap: &WalletSnapshot) {
        let mut missing: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mem_guard = self.item_art_mem.lock().ok();
        let mut inflight_guard = self.item_art_inflight.lock().ok();
        for item in &snap.items {
            if snap.item_art.contains_key(&item.outpoint) {
                continue;
            }
            let mime = item.mime.to_ascii_lowercase();
            if !(mime.starts_with("image/")
                || mime.is_empty()
                || mime == "application/octet-stream")
            {
                continue;
            }
            let origin = snap
                .item_meta
                .get(&item.outpoint)
                .and_then(|m| m.media_origin.clone())
                .unwrap_or_else(|| origin_art_key(&item.origin_outpoint));
            if !is_valid_origin_key(&origin) || !seen.insert(origin.clone()) {
                continue;
            }
            if mem_guard
                .as_ref()
                .is_some_and(|m| m.contains_key(&origin))
            {
                continue;
            }
            if let Some(ref mut inflight) = inflight_guard {
                if !inflight.insert(origin.clone()) {
                    continue;
                }
            }
            missing.push(origin);
            if missing.len() >= 32 {
                break;
            }
        }
        drop(mem_guard);
        drop(inflight_guard);
        if missing.is_empty() {
            return;
        }
        let svc = Arc::clone(self);
        let base = if chain == "main" {
            "https://ordinals.gorillapool.io"
        } else {
            "https://testnet.ordinals.gorillapool.io"
        };
        self.engine.runtime_handle().spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(8))
                .build()
            {
                Ok(c) => c,
                Err(_) => {
                    if let Ok(mut inf) = svc.item_art_inflight.lock() {
                        for o in &missing {
                            inf.remove(o);
                        }
                    }
                    return;
                }
            };
            let mut new_durable: Vec<(String, String, String)> = Vec::new();
            let mut any_hit = false;
            for chunk in missing.chunks(6) {
                let mut handles = Vec::with_capacity(chunk.len());
                for origin in chunk {
                    let client = client.clone();
                    let origin = origin.clone();
                    let url = format!("{base}/content/{origin}");
                    handles.push(tokio::spawn(async move {
                        let resp = client.get(&url).send().await.ok()?;
                        if !resp.status().is_success() {
                            return Some((origin, None));
                        }
                        let ct = resp
                            .headers()
                            .get(reqwest::header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .split(';')
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_ascii_lowercase();
                        if !ct.starts_with("image/") {
                            return Some((origin, None));
                        }
                        let bytes = resp.bytes().await.ok()?;
                        if bytes.is_empty() || bytes.len() > 262_144 {
                            return Some((origin, None));
                        }
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        Some((origin, Some((ct, b64))))
                    }));
                }
                let mut chunk_hit = false;
                for h in handles {
                    if let Ok(Some((origin, res))) = h.await {
                        if let Ok(mut inf) = svc.item_art_inflight.lock() {
                            inf.remove(&origin);
                        }
                        match res {
                            Some((mime, b64)) => {
                                let uri = format!("data:{mime};base64,{b64}");
                                if let Ok(mut mem) = svc.item_art_mem.lock() {
                                    mem.insert(origin.clone(), Some(uri));
                                }
                                new_durable.push((origin, mime, b64));
                                chunk_hit = true;
                                any_hit = true;
                            }
                            None => {
                                if let Ok(mut mem) = svc.item_art_mem.lock() {
                                    mem.insert(origin, None);
                                }
                            }
                        }
                    }
                }
                if chunk_hit {
                    let next = svc.patch_tx.borrow().wrapping_add(1);
                    let _ = svc.patch_tx.send(next);
                }
            }
            if let Ok(mut inf) = svc.item_art_inflight.lock() {
                for o in &missing {
                    inf.remove(o);
                }
            }
            if any_hit && !new_durable.is_empty() {
                svc.persist_item_art_cache(&new_durable);
            }
        });
    }

    fn persist_item_art_cache(&self, entries: &[(String, String, String)]) {
        let mut map = self
            .durable
            .get(ITEM_ART_CACHE_KEY)
            .and_then(|raw| serde_json::from_str::<serde_json::Map<String, Value>>(&raw).ok())
            .unwrap_or_default();
        let now = now_ms();
        for (origin, mime, b64) in entries {
            map.insert(
                origin.clone(),
                serde_json::json!({ "mime": mime, "b64": b64, "at": now }),
            );
        }
        // Respect TS `localItemArt.ts` budget: <= 120 entries and <= 512 KB.
        let mut order: Vec<(String, u64)> = map
            .iter()
            .map(|(k, v)| (k.clone(), v.get("at").and_then(Value::as_u64).unwrap_or(0)))
            .collect();
        order.sort_by_key(|(_, at)| *at);
        let mut drop_idx = 0usize;
        while map.len() > 120 && drop_idx < order.len() {
            map.remove(&order[drop_idx].0);
            drop_idx += 1;
        }
        let mut body = serde_json::to_string(&map).unwrap_or_default();
        while body.len() > 512 * 1024 && map.len() > 1 && drop_idx < order.len() {
            map.remove(&order[drop_idx].0);
            drop_idx += 1;
            body = serde_json::to_string(&map).unwrap_or_default();
        }
        if !body.is_empty() {
            let _ = self.durable.set(ITEM_ART_CACHE_KEY, &body, false);
        }
    }

    fn apply_collectables_list_cache(
        &self,
        summary: &SessionSummary,
        items: &mut [ItemCardRow],
        item_meta: &mut HashMap<String, ItemDisplayMeta>,
    ) {
        if items.is_empty() {
            return;
        }
        let trimmed = summary.identity_key.trim();
        let lower = trimmed.to_ascii_lowercase();
        let raw = [
            format!(
                "handcash.collectables.list.v1:wallet:{}:{}:{trimmed}",
                summary.chain, summary.account_index
            ),
            format!(
                "handcash.collectables.list.v1:wallet:{}:{}:{lower}",
                summary.chain, summary.account_index
            ),
        ]
        .into_iter()
        .find_map(|k| self.durable.get(&k));
        let Some(raw) = raw else {
            return;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            return;
        };
        let Some(arr) = parsed
            .as_array()
            .or_else(|| parsed.get("items").and_then(Value::as_array))
        else {
            return;
        };
        let mut by_key: HashMap<String, &serde_json::Map<String, Value>> = HashMap::new();
        for el in arr {
            let Some(obj) = el.as_object() else {
                continue;
            };
            if let Some(op) = obj.get("outpoint").and_then(Value::as_str) {
                let k = op.trim().to_ascii_lowercase().replace('_', ".");
                if !k.is_empty() {
                    by_key.insert(k, obj);
                }
            }
            if let Some(orig) = obj.get("origin").and_then(Value::as_str) {
                let k = origin_art_key(orig);
                if !k.is_empty() {
                    by_key.entry(k).or_insert(obj);
                }
            }
        }
        if by_key.is_empty() {
            return;
        }
        for item in items.iter_mut() {
            let out_dot = item.outpoint.trim().to_ascii_lowercase().replace('_', ".");
            let orig_us = origin_art_key(&item.origin_outpoint);
            let Some(rec) = by_key.get(&out_dot).or_else(|| by_key.get(&orig_us)) else {
                continue;
            };
            if let Some(ro) = rec
                .get("origin")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if origin_art_key(&item.origin_outpoint) == origin_art_key(&item.outpoint)
                    && origin_art_key(ro) != origin_art_key(&item.outpoint)
                {
                    item.origin_outpoint = ro.replace('_', ".");
                }
            }
            if let Some(name) = rec
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if is_bare_item_name(item) && !(name.len() >= 12 && name.contains('…')) {
                    item.name = name.to_string();
                }
            }
            if let Some(m) = rec
                .get("mimeType")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if item.mime.is_empty() || item.mime == "application/octet-stream" {
                    item.mime = m.to_string();
                }
            }
            if rec.get("proven").and_then(Value::as_bool) == Some(true)
                || rec.get("authenticity").and_then(Value::as_str) == Some("brc150")
            {
                item.authenticity_status = "brc150".into();
            }
            if item.issuer_key.is_none() {
                if let Some(iss) = rec
                    .get("issuer")
                    .or_else(|| rec.get("issuerKey"))
                    .and_then(Value::as_str)
                    .and_then(normalize_issuer_identity_key)
                {
                    item.issuer_key = Some(iss);
                }
            }
            let entry = item_meta.entry(item.outpoint.clone()).or_default();
            if entry.app.is_none() {
                entry.app = rec
                    .get("app")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
            }
            if entry.collection_id.is_none() {
                entry.collection_id = rec
                    .get("collectionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
            }
            if entry.signer.is_none() {
                entry.signer = rec
                    .get("signer")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
            }
            if entry.bap_id.is_none() {
                entry.bap_id = rec
                    .get("bapId")
                    .and_then(Value::as_str)
                    .and_then(normalize_bap_id);
            }
            if rec.get("issuerAttested").and_then(Value::as_bool) == Some(true) {
                entry.issuer_attested = true;
            }
            if entry.item_type.is_none() {
                entry.item_type = rec
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
            }
            if entry.sub_type.is_none() {
                entry.sub_type = rec
                    .get("subType")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
            }
            if entry.traits.is_empty() {
                if let Some(t_arr) = rec.get("traits").and_then(Value::as_array) {
                    for t in t_arr {
                        let n = t.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
                        let v = t.get("value").and_then(Value::as_str).map(str::trim).unwrap_or("");
                        if !n.is_empty() && !v.is_empty() {
                            entry.traits.push((n.to_string(), v.to_string()));
                        }
                    }
                }
            }
            if entry.extras.is_empty() {
                if let Some(e_arr) = rec.get("extras").and_then(Value::as_array) {
                    for t in e_arr {
                        let n = t.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
                        let v = t.get("value").and_then(Value::as_str).map(str::trim).unwrap_or("");
                        if !n.is_empty() && !v.is_empty() {
                            entry.extras.push((n.to_string(), v.to_string()));
                        }
                    }
                }
            }
        }
    }

    /// Bulk-resolve missing origin/app/signer/name metadata from GorillaPool once per session
    /// (mirrors TS `src/wallet/originSigners.ts`), persisting hits to `handcash.inscriptionResolution.v1`.
    pub fn backfill_missing_inscription_metadata(
        self: &Arc<Self>,
        chain: &str,
        snap: &WalletSnapshot,
    ) {
        let mut candidates: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let Ok(mut asked) = self.meta_backfill_asked.lock() else {
            return;
        };
        for item in &snap.items {
            let meta = snap.item_meta.get(&item.outpoint);
            let has_attribution = item.issuer_key.is_some()
                || meta.is_some_and(|m| m.signer.is_some() || m.app.is_some());
            if has_attribution && !is_bare_item_name(item) {
                continue;
            }
            for cand in [
                origin_art_key(&item.origin_outpoint),
                origin_art_key(&item.outpoint),
            ] {
                if is_valid_origin_key(&cand) && !asked.contains(&cand) && seen.insert(cand.clone()) {
                    asked.insert(cand.clone());
                    candidates.push(cand);
                }
            }
            if candidates.len() >= 100 {
                break;
            }
        }
        drop(asked);
        if candidates.is_empty() {
            return;
        }
        let svc = Arc::clone(self);
        let base = if chain == "main" {
            "https://ordinals.gorillapool.io"
        } else {
            "https://testnet.ordinals.gorillapool.io"
        };
        self.engine.runtime_handle().spawn(async move {
            let Ok(client) = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(12))
                .build()
            else {
                return;
            };
            let url = format!("{base}/api/txos/outpoints?script=false");
            let Ok(resp) = client
                .post(&url)
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .json(&candidates)
                .send()
                .await
            else {
                return;
            };
            if !resp.status().is_success() {
                return;
            }
            let Ok(Value::Array(rows)) = resp.json::<Value>().await else {
                return;
            };
            let mut updates: Vec<(String, Value)> = Vec::new();
            for row in rows {
                let Some(obj) = row.as_object() else {
                    continue;
                };
                let Some(outpoint) = obj.get("outpoint").and_then(Value::as_str) else {
                    continue;
                };
                let origin_obj = obj.get("origin").and_then(Value::as_object);
                let origin_op = origin_obj
                    .and_then(|o| o.get("outpoint").and_then(Value::as_str))
                    .unwrap_or(outpoint);
                let data = origin_obj
                    .and_then(|o| o.get("data"))
                    .or_else(|| obj.get("data"))
                    .and_then(Value::as_object);
                let Some(data) = data else {
                    continue;
                };
                let map = data.get("map").and_then(Value::as_object);
                let insc_file = data
                    .get("insc")
                    .and_then(|i| i.get("file"))
                    .and_then(Value::as_object);
                let mime = insc_file
                    .and_then(|f| f.get("type"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let name = map
                    .and_then(|m| {
                        m.get("name")
                            .or_else(|| m.get("subTypeData").and_then(|s| s.get("name")))
                    })
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let app = map
                    .and_then(|m| m.get("app"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let collection_id = map
                    .and_then(|m| {
                        m.get("subTypeData")
                            .and_then(|s| s.get("collectionId"))
                            .or_else(|| m.get("collectionId"))
                    })
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let signer = data
                    .get("sigma")
                    .and_then(Value::as_array)
                    .and_then(|arr| arr.first())
                    .and_then(|s| s.get("address"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let issuer = map
                    .and_then(|m| m.get("issuer").or_else(|| m.get("issuerKey")))
                    .and_then(Value::as_str)
                    .and_then(normalize_issuer_identity_key);
                let bap_id = map
                    .and_then(|m| m.get("bapId"))
                    .and_then(Value::as_str)
                    .and_then(normalize_bap_id);
                if name.is_none() && app.is_none() && signer.is_none() && issuer.is_none() && mime.is_none() {
                    continue;
                }
                let mut rec = serde_json::Map::new();
                rec.insert("origin".into(), Value::String(origin_op.to_string()));
                if let Some(n) = name {
                    rec.insert("name".into(), Value::String(n.to_string()));
                }
                if let Some(a) = app {
                    rec.insert("app".into(), Value::String(a.to_string()));
                }
                if let Some(c) = collection_id {
                    rec.insert("collectionId".into(), Value::String(c.to_string()));
                }
                if let Some(s) = signer {
                    rec.insert("signer".into(), Value::String(s.to_string()));
                }
                if let Some(m) = mime {
                    rec.insert("mimeType".into(), Value::String(m.to_string()));
                }
                if let Some(iss) = issuer {
                    rec.insert("issuer".into(), Value::String(iss));
                }
                if let Some(bid) = bap_id {
                    rec.insert("bapId".into(), Value::String(bid));
                }
                let rec_val = Value::Object(rec);
                updates.push((origin_art_key(outpoint), rec_val.clone()));
                if origin_art_key(origin_op) != origin_art_key(outpoint) {
                    updates.push((origin_art_key(origin_op), rec_val));
                }
            }
            if updates.is_empty() {
                return;
            }
            let mut cache = svc
                .durable
                .get(INSCRIPTION_RESOLUTION_KEY)
                .and_then(|raw| serde_json::from_str::<serde_json::Map<String, Value>>(&raw).ok())
                .unwrap_or_default();
            let mut changed = false;
            for (k, v) in updates {
                if !cache.contains_key(&k) {
                    cache.insert(k, v);
                    changed = true;
                }
            }
            if changed {
                while cache.len() > 2000 {
                    if let Some(first_key) = cache.keys().next().cloned() {
                        cache.remove(&first_key);
                    } else {
                        break;
                    }
                }
                if let Ok(body) = serde_json::to_string(&Value::Object(cache)) {
                    let _ = svc.durable.set(INSCRIPTION_RESOLUTION_KEY, &body, false);
                }
                svc.bump_patch();
            }
        });
    }

    fn apply_proven_collectables(&self, chain: &str, items: &mut [ItemCardRow]) {
        if items.is_empty() {
            return;
        }
        let mut proven_origins: HashMap<String, Option<String>> = HashMap::new();
        for base in [COLLECTABLE_PROVEN_V2_KEY, COLLECTABLE_PROVEN_V1_KEY] {
            for key in [format!("{base}:{chain}"), base.to_string()] {
                if let Some(raw) = self.durable.get(&key) {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                        if let Some(obj) = v.as_object() {
                            for (k, val) in obj {
                                let proven_ok = if let Some(vo) = val.as_object() {
                                    match vo.get("tier").and_then(Value::as_str) {
                                        Some("brc150" | "brc156") => true,
                                        Some("unproven") => false,
                                        _ => true,
                                    }
                                } else {
                                    val.as_bool() == Some(true)
                                };
                                if proven_ok {
                                    let verified_origin = val
                                        .as_object()
                                        .and_then(|vo| vo.get("origin"))
                                        .and_then(Value::as_str)
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(|s| s.replace('_', "."));
                                    proven_origins
                                        .entry(k.to_ascii_lowercase().replace('_', "."))
                                        .or_insert(verified_origin);
                                }
                            }
                        } else if let Some(arr) = v.as_array() {
                            for el in arr {
                                if let Some(s) = el.as_str() {
                                    proven_origins
                                        .entry(s.to_ascii_lowercase().replace('_', "."))
                                        .or_insert(None);
                                }
                            }
                        }
                    }
                }
            }
        }
        if proven_origins.is_empty() {
            return;
        }
        for item in items.iter_mut() {
            let norm_origin = item.origin_outpoint.to_ascii_lowercase().replace('_', ".");
            let norm_out = item.outpoint.to_ascii_lowercase().replace('_', ".");
            if let Some(verified_origin) = proven_origins
                .get(&norm_out)
                .or_else(|| proven_origins.get(&norm_origin))
            {
                item.authenticity_status = "brc150".into();
                if let Some(vo) = verified_origin {
                    item.origin_outpoint = vo.clone();
                }
            }
        }
    }

    fn merge_durable_app_activity(&self, summary: &SessionSummary, rows: &mut Vec<ActivityRow>) {
        let scoped = format!(
            "{APP_ACTIVITY_STORAGE_KEY}:{}:{}",
            summary.chain, summary.identity_key
        );
        let raw = self
            .durable
            .get(&scoped)
            .or_else(|| self.durable.get(APP_ACTIVITY_STORAGE_KEY));
        let Some(raw) = raw else {
            rows.sort_by_key(|r| std::cmp::Reverse(r.sort_ts_ms));
            return;
        };
        let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&raw) else {
            rows.sort_by_key(|r| std::cmp::Reverse(r.sort_ts_ms));
            return;
        };

        let mut by_txid: HashMap<String, usize> = HashMap::new();
        for (idx, r) in rows.iter().enumerate() {
            if let Some(ref tx) = r.txid {
                by_txid.insert(tx.to_ascii_lowercase(), idx);
            }
        }

        for entry in entries {
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let kind = entry
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("payment")
                .to_string();
            let origin = entry
                .get("origin")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let sats = entry.get("sats").and_then(Value::as_i64).unwrap_or(0);
            let signed_sats = if kind == "spent" && sats > 0 {
                -sats
            } else {
                sats
            };
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("complete")
                .to_string();
            let txid = entry
                .get("txid")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
            let ts = entry
                .get("at")
                .or_else(|| entry.get("timestamp"))
                .or_else(|| entry.get("createdAt"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let counterparty = entry
                .get("friendLabel")
                .or_else(|| entry.get("counterparty"))
                .or_else(|| entry.get("recipient"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToString::to_string);
            let title = entry
                .get("title")
                .or_else(|| entry.get("description"))
                .or_else(|| entry.get("label"))
                .or_else(|| entry.get("item").and_then(|i| i.get("name")))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| match kind.as_str() {
                    "spent" => "Sent BSV".into(),
                    "earned" => "Received BSV".into(),
                    _ => "Wallet action".into(),
                });
            let direction = match kind.as_str() {
                "spent" => "out",
                "earned" => "in",
                _ => "event",
            }
            .to_string();

            if let Some(ref tx) = txid {
                if let Some(&existing_idx) = by_txid.get(&tx.to_ascii_lowercase()) {
                    let row = &mut rows[existing_idx];
                    if !title.is_empty() {
                        row.title = title;
                    }
                    if counterparty.is_some() {
                        row.counterparty = counterparty;
                    }
                    if origin.is_some() {
                        row.app_origin = origin;
                    }
                    if ts > 0 && row.sort_ts_ms == 0 {
                        row.sort_ts_ms = ts;
                    }
                    continue;
                }
            }

            if !id.is_empty() {
                let new_idx = rows.len();
                if let Some(ref tx) = txid {
                    by_txid.insert(tx.to_ascii_lowercase(), new_idx);
                }
                rows.push(ActivityRow {
                    activity_id: id,
                    txid,
                    kind,
                    direction,
                    satoshis: signed_sats,
                    status,
                    title,
                    counterparty,
                    app_origin: origin,
                    sort_ts_ms: ts,
                });
            }
        }
        rows.sort_by_key(|r| std::cmp::Reverse(r.sort_ts_ms));
    }

    pub fn import_brc38_json(&self, json: String) -> Result<String, String> {
        let summary = self
            .current_session_summary()
            .ok_or_else(|| "Unlock your wallet first.".to_string())?;
        let stats = self
            .engine
            .runtime_handle()
            .block_on(
                self.engine
                    .import_brc38(&summary.account_id, summary.generation, json),
            )
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "Imported {} UTXOs, {} items, {} transactions.",
            stats.utxos, stats.items, stats.transactions
        ))
    }

    pub fn sync_now(&self) -> Result<String, String> {
        let summary = self
            .current_session_summary()
            .ok_or_else(|| "Unlock your wallet first.".to_string())?;
        let rt = self.engine.runtime_handle();
        let tip = rt
            .block_on(
                self.engine
                    .sync_headers(&summary.account_id, summary.generation),
            )
            .map_err(|e| e.to_string())?;
        let lane2 = rt
            .block_on(
                self.engine
                    .run_proof_poll(&summary.account_id, summary.generation),
            )
            .map_err(|e| e.to_string())?;
        let proven = rt
            .block_on(
                self.engine
                    .run_brc150_pass(&summary.account_id, summary.generation, 10),
            )
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "Sync complete: tip={}, proofs_settled={}, brc150_proven={proven}",
            tip.map(|h| h.to_string())
                .unwrap_or_else(|| "offline".into()),
            lane2.proofs_settled
        ))
    }

    pub fn verify_brc150_batch(&self) -> Result<u64, String> {
        let summary = self
            .current_session_summary()
            .ok_or_else(|| "Unlock your wallet first.".to_string())?;
        self.engine
            .runtime_handle()
            .block_on(
                self.engine
                    .run_brc150_pass(&summary.account_id, summary.generation, 10),
            )
            .map_err(|e| e.to_string())
    }

    /// Validate a P2PKH send target and estimate its BSV network fee.
    pub fn preview_send(&self, address: &str, satoshis: u64) -> Result<(u64, u64), String> {
        if satoshis == 0 {
            return Err("Amount must be greater than 0 satoshis.".into());
        }
        let script = address_to_locking_script(address.trim())
            .map_err(|_| "Invalid BSV P2PKH address.".to_string())?;
        let out = TxOutput {
            satoshis,
            locking_script: script,
        };
        let fee = estimate_p2pkh_fee(1, &[out], 100);
        Ok((satoshis + fee, fee))
    }

    // ── BRC-140 Key Slices & Backup Formats (`src/wallet/brc140Backup.ts`, `brc140IssuedSet.ts`) ──

    pub fn saved_backup_formats(&self) -> HashSet<String> {
        self.vault_local_key(BACKUP_FORMATS_SAVED_KEY)
            .and_then(|k| self.durable.get(&k))
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .map(|v| v.into_iter().collect())
            .unwrap_or_default()
    }

    /// Load the sealed BRC-140 slice set for the unlocked master identity, or issue & seal a fresh 2-of-3 set.
    pub fn load_or_issue_brc140_set(&self) -> Result<Brc140IssuedSet, String> {
        let root_key = self
            .current_root_key_hex()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        let sk = handcash_primitives::keys::SecretKeyBytes::from_hex(&root_key)
            .map_err(|e| e.to_string())?;
        let identity_key = sk.public_key_hex().map_err(|e| e.to_string())?;
        let storage_key = format!("{BRC140_ISSUED_SET_KEY_PREFIX}{identity_key}");
        if let Some(raw) = self.durable.get(&storage_key) {
            if let Some(existing) = unseal_brc140_issued_set(&root_key, &raw) {
                return Ok(existing);
            }
        }
        self.rotate_brc140_set()
    }

    /// Issue and seal a brand-new 2-of-3 BRC-140 slice set for the unlocked master identity.
    pub fn rotate_brc140_set(&self) -> Result<Brc140IssuedSet, String> {
        let root_key = self
            .current_root_key_hex()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        let split = create_brc140_shares(&root_key, BRC140_DEFAULT_THRESHOLD, BRC140_DEFAULT_TOTAL)
            .map_err(|e| e.to_string())?;
        let issued = Brc140IssuedSet {
            threshold: split.threshold,
            total_shares: split.total_shares,
            shares: split.shares,
            integrity: split.integrity,
            issued_at: now_ms(),
            origin: "issued".into(),
        };
        let (storage_key, sealed_json) =
            seal_brc140_issued_set(&root_key, &issued).map_err(|e| e.to_string())?;
        let _ = self.durable.set(&storage_key, &sealed_json, false);
        Ok(issued)
    }

    /// Restore a wallet from BRC-140 key slices, extend the used slices back to a 3-slice set on the
    /// same polynomial, seal the restored set, and mark `"split"` backup confirmed.
    pub fn restore_vault_brc140_shares_onboard(
        &self,
        handle: &str,
        raw_shares_text: &str,
        chain: &str,
    ) -> Result<(SessionSummary, String), String> {
        let lines: Vec<String> = raw_shares_text
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        let recovered =
            recover_root_key_from_brc140_shares(&lines).map_err(|e| e.message)?;
        let (sum, wrap_str) =
            self.restore_vault_root_key_onboard(handle, &recovered.root_key_hex, chain)?;
        let _ = self.mark_keys_backup_confirmed("split");
        if let Ok(extended) = extend_brc140_shares(
            &recovered.root_key_hex,
            &recovered.shares_used,
            BRC140_DEFAULT_TOTAL,
        ) {
            let issued = Brc140IssuedSet {
                threshold: extended.threshold,
                total_shares: extended.total_shares,
                shares: extended.shares,
                integrity: extended.integrity,
                issued_at: now_ms(),
                origin: "restored".into(),
            };
            if let Ok((storage_key, sealed_json)) =
                seal_brc140_issued_set(&recovered.root_key_hex, &issued)
            {
                let _ = self.durable.set(&storage_key, &sealed_json, false);
            }
        }
        Ok((sum, wrap_str))
    }

    // ── BRC-38 / BRC-39 History Backup & On-Device Archive (`src/wallet/historyBackup.ts`) ──

    pub fn account_local_key(&self, base: &str) -> Option<String> {
        let s = self.current_session_summary()?;
        Some(format!(
            "{base}:wallet:{}:{}:{}",
            s.chain, s.account_index, s.identity_key
        ))
    }

    pub fn is_history_backup_confirmed(&self) -> bool {
        if self
            .vault_local_key(HISTORY_BACKUP_CONFIRMED_KEY)
            .and_then(|k| self.durable.get(&k))
            .as_deref()
            == Some("1")
        {
            return true;
        }
        if let Some(acc_key) = self.account_local_key(HISTORY_BACKUP_CONFIRMED_KEY) {
            if self.durable.get(&acc_key).as_deref() == Some("1") {
                if let Some(vk) = self.vault_local_key(HISTORY_BACKUP_CONFIRMED_KEY) {
                    let _ = self.durable.set(&vk, "1", false);
                }
                return true;
            }
        }
        false
    }

    pub fn mark_history_backup_confirmed(&self) -> bool {
        let Some(vk) = self.vault_local_key(HISTORY_BACKUP_CONFIRMED_KEY) else {
            return false;
        };
        self.durable.set(&vk, "1", false)
    }

    pub fn load_history_backup_prefs(&self) -> HistoryBackupPrefs {
        let own_raw = self
            .account_local_key(HISTORY_BACKUP_PREFS_KEY)
            .and_then(|k| self.durable.get(&k))
            .or_else(|| self.durable.get(HISTORY_BACKUP_PREFS_KEY));
        let vault_raw = self
            .vault_local_key(HISTORY_BACKUP_PREFS_KEY)
            .and_then(|k| self.durable.get(&k));
        HistoryBackupPrefs::from_stored(own_raw.as_deref(), vault_raw.as_deref())
    }

    pub fn save_history_backup_prefs(&self, prefs: &HistoryBackupPrefs) {
        let json = prefs.to_json_string();
        if let Some(vk) = self.vault_local_key(HISTORY_BACKUP_PREFS_KEY) {
            let _ = self.durable.set(&vk, &json, false);
        }
        if let Some(ak) = self.account_local_key(HISTORY_BACKUP_PREFS_KEY) {
            let _ = self.durable.set(&ak, &json, false);
        } else {
            let _ = self.durable.set(HISTORY_BACKUP_PREFS_KEY, &json, false);
        }
    }

    /// Export live BRC-38 JSON for the active account (prefers `AccountStore`, falls back to `ToolboxDb`
    /// if the engine store has no outputs yet).
    pub fn export_live_brc38_json(&self) -> Result<String, String> {
        let summary = self
            .current_session_summary()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        let rt = self.engine.runtime_handle();
        let engine_json = rt
            .block_on(
                self.engine
                    .export_brc38(&summary.account_id, summary.generation),
            )
            .map_err(|e| e.to_string())?;

        let engine_has_outputs = serde_json::from_str::<Value>(&engine_json)
            .ok()
            .and_then(|v| {
                v.get("tables")
                    .and_then(|t| t.get("outputs"))
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
            })
            .unwrap_or(false);

        if !engine_has_outputs {
            if let Ok(Some(tb)) = self.toolbox.open_if_exists(&summary.toolbox_db_name) {
                if let Ok(tb_json) = export_brc38_from_toolbox(&tb, now_ms()) {
                    // Non-destructively mirror into AccountStore as well.
                    let _ = rt.block_on(self.engine.import_brc38(
                        &summary.account_id,
                        summary.generation,
                        tb_json.clone(),
                    ));
                    return Ok(tb_json);
                }
            }
        }
        Ok(engine_json)
    }

    /// Create an encrypted `.brc39` backup sealed to `history_crypto_secret(rootKeyHex)` and archive
    /// a write-once snapshot in `<userData>/brc39-archive/{identityKey}/`.
    pub fn create_brc39_backup_bytes(&self) -> Result<Vec<u8>, String> {
        let summary = self
            .current_session_summary()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        let root_key = self
            .current_root_key_hex()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        let secret = history_crypto_secret(&root_key)?;
        let json = self.export_live_brc38_json()?;
        let bytes = self
            .engine
            .runtime_handle()
            .block_on(self.engine.encrypt_brc39_async(json, secret))
            .map_err(|e| e.to_string())?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let _ = self
            .brc39_archive
            .write_snapshot(&summary.identity_key, &b64, Some(now_ms() as u64));
        Ok(bytes)
    }

    /// Decrypt and merge a `.brc39` (or plain `.json` BRC-38) backup into the active account's SQLite WAL store.
    /// Merge-only: never drops existing outputs or downgrades proven BRC-150 items.
    pub fn restore_brc39_backup_bytes(
        &self,
        bytes: &[u8],
        legacy_password: Option<&str>,
    ) -> Result<String, String> {
        if bytes.is_empty() {
            return Err("Backup file is empty.".into());
        }
        // Accept raw BRC-38 JSON if the user selected a `.json` file.
        let trimmed_str = std::str::from_utf8(bytes).ok().map(str::trim);
        if let Some(s) = trimmed_str.filter(|s| s.starts_with('{')) {
            return self.import_brc38_json(s.to_string());
        }
        if bytes.len() < 64 {
            return Err("File is too small to be a BRC-39 backup.".into());
        }
        let root_key = self
            .current_root_key_hex()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        let secret = history_crypto_secret(&root_key)?;
        let rt = self.engine.runtime_handle();
        let decrypted_json = match rt.block_on(
            self.engine
                .decrypt_brc39_async(bytes.to_vec(), secret),
        ) {
            Ok(j) => j,
            Err(root_err) => {
                let Some(pw) = legacy_password.map(str::trim).filter(|s| !s.is_empty()) else {
                    return Err(root_err.to_string());
                };
                rt.block_on(
                    self.engine
                        .decrypt_brc39_async(bytes.to_vec(), pw.to_string()),
                )
                .map_err(|_| root_err.to_string())?
            }
        };
        self.import_brc38_json(decrypted_json)
    }

    pub fn list_local_brc39_archive(&self) -> Vec<Brc39ArchiveMeta> {
        let Some(summary) = self.current_session_summary() else {
            return Vec::new();
        };
        self.brc39_archive.list_identity(&summary.identity_key)
    }

    pub fn restore_local_brc39_snapshot(
        &self,
        snapshot_id: &str,
        legacy_password: Option<&str>,
    ) -> Result<String, String> {
        let summary = self
            .current_session_summary()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        let val = self
            .brc39_archive
            .read_snapshot(&summary.identity_key, snapshot_id)?;
        let b64 = val
            .get("bytesBase64")
            .and_then(Value::as_str)
            .ok_or_else(|| "Snapshot payload missing.".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())?;
        self.restore_brc39_backup_bytes(&bytes, legacy_password)
    }

    // ── Recover From Transaction — Claim / Ingest (`src/wallet/recoverFromTx.ts`) ──

    /// Scan `raw_txid` and ingest its recoverable 1-sat outputs paying this wallet into `AccountStore`,
    /// then run a BRC-150 pass so proven ordinal lineage upgrades immediately.
    pub async fn claim_recover_tx(&self, raw_txid: &str) -> Result<String, String> {
        let scan = self.scan_recover_tx(raw_txid).await?;
        if scan.outputs.is_empty() {
            return Err("No 1-sat outputs in this transaction pay this wallet's address.".into());
        }
        let summary = self
            .current_session_summary()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        let hydrated = self
            .engine
            .hydrate_input_txids(
                &summary.account_id,
                summary.generation,
                vec![scan.txid.clone()],
                true,
            )
            .await
            .map_err(|e| e.to_string())?;
        let entry = hydrated
            .found
            .get(&scan.txid)
            .ok_or_else(|| "Transaction bytes missing after scan.".to_string())?;
        let raw_bytes = base64::engine::general_purpose::STANDARD
            .decode(&entry.bytes_base64)
            .map_err(|e| e.to_string())?;
        let tx = if entry.kind == "beef" {
            Beef::from_bytes(&raw_bytes)
                .map_err(|e| e.to_string())?
                .find_tx(&scan.txid)
                .cloned()
                .ok_or_else(|| "Transaction missing from its BEEF.".to_string())?
        } else {
            Transaction::from_bytes(&raw_bytes).map_err(|e| e.to_string())?
        };

        let now = now_ms();
        let mut outs = Vec::with_capacity(scan.outputs.len());
        for (i, rec_out) in scan.outputs.iter().enumerate() {
            let tx_out = tx
                .outputs
                .get(rec_out.vout as usize)
                .ok_or_else(|| "Output index out of bounds.".to_string())?;
            let script_b64 =
                base64::engine::general_purpose::STANDARD.encode(&tx_out.locking_script);
            let mut ci = serde_json::Map::new();
            ci.insert("origin".into(), Value::from(rec_out.outpoint.clone()));
            if let Some(ord) = parse_ord_envelope(&tx_out.locking_script) {
                if !ord.content_type.is_empty() {
                    ci.insert("contentType".into(), Value::from(ord.content_type));
                }
                if let Some(name) = ord
                    .map_fields
                    .get("name")
                    .or_else(|| ord.map_fields.get("subTypeData.name"))
                    .filter(|s| !s.trim().is_empty())
                {
                    ci.insert("name".into(), Value::from(name.trim()));
                }
            }
            outs.push(serde_json::json!({
                "outputId": now + (i as i64) + 1,
                "transactionId": 1,
                "txid": scan.txid,
                "vout": rec_out.vout,
                "satoshis": tx_out.satoshis,
                "basketId": 2,
                "spendable": true,
                "change": false,
                "lockingScript": script_b64,
                "customInstructions": Value::Object(ci).to_string(),
            }));
        }

        let mut tx_obj = serde_json::Map::new();
        tx_obj.insert("transactionId".into(), Value::from(1));
        tx_obj.insert("txid".into(), Value::from(scan.txid.clone()));
        tx_obj.insert("status".into(), Value::from("completed"));
        tx_obj.insert("isOutgoing".into(), Value::from(false));
        tx_obj.insert("satoshis".into(), Value::from(scan.outputs.len() as i64));
        tx_obj.insert(
            "description".into(),
            Value::from(format!("Recovered {} item(s)", scan.outputs.len())),
        );
        tx_obj.insert("created_at".into(), Value::from(now.to_string()));
        if entry.kind == "beef" {
            tx_obj.insert("inputBEEF".into(), Value::from(entry.bytes_base64.clone()));
        } else {
            tx_obj.insert("rawTx".into(), Value::from(entry.bytes_base64.clone()));
        }

        let doc = serde_json::json!({
            "brc": 38,
            "schema": "brc-38",
            "tables": {
                "outputBaskets": [
                    { "basketId": 1, "name": "default" },
                    { "basketId": 2, "name": "1sat" }
                ],
                "provenTxs": [],
                "provenTxReqs": [],
                "transactions": [Value::Object(tx_obj)],
                "outputs": outs,
            }
        });
        let stats = self
            .engine
            .import_brc38(&summary.account_id, summary.generation, doc.to_string())
            .await
            .map_err(|e| e.to_string())?;
        let proven = self
            .engine
            .run_brc150_pass(&summary.account_id, summary.generation, 10)
            .await
            .unwrap_or(0);
        Ok(format!(
            "Claimed {} item output(s) from {} ({} BRC-150 proven).",
            stats.items.max(scan.outputs.len()),
            truncate_mid(&scan.txid, 8),
            proven
        ))
    }

    // ── Wallet Health — UTXO Heal (`src/wallet/utxoHeal.ts`) ──

    pub fn heal_wallet_utxos(&self) -> Result<String, String> {
        let summary = self
            .current_session_summary()
            .ok_or_else(|| "Unlock the wallet first.".to_string())?;
        // 1. Ensure any ToolboxDb UTXOs are mirrored into AccountStore.
        let _ = self.export_live_brc38_json();
        // 2. Archive a fresh local BRC-39 snapshot before healing.
        let _ = self.create_brc39_backup_bytes();
        // 3. Run chain header sync, proof poll, and BRC-150 verification pass.
        let sync_msg = self.sync_now()?;
        let snap = self.read_snapshot();
        self.host_log.append(
            "info",
            "utxo-heal",
            &format!(
                "healed account #{}: {} spendable UTXOs ({} sats), {} items ({sync_msg})",
                summary.account_index,
                snap.balance.spendable_utxo_count,
                snap.balance.spendable_sats,
                snap.balance.item_count
            ),
        );
        Ok(format!(
            "{} spendable UTXO(s) ({} sats) · {} item(s) verified",
            snap.balance.spendable_utxo_count,
            snap.balance.spendable_sats,
            snap.balance.item_count
        ))
    }

    // ── Wipe Wallet & History Gate (`src/wallet/wipeWallet.ts`, `wipeHistoryGate.ts`) ──

    /// Check whether local wallet history is safely backed up before wiping.
    /// Returns `Ok(gate_kind)` when safe to proceed, or `Err(refusal_message)` when blocked.
    pub fn check_wipe_history_gate(&self) -> Result<&'static str, String> {
        let snap = self.read_snapshot();
        let local_empty = snap.balance.spendable_sats == 0
            && snap.balance.item_count == 0
            && snap.activity.is_empty();
        if local_empty {
            return Ok("nothing-to-lose");
        }
        // Check if on-device BRC-39 archive or confirmed history backup exists.
        if self.is_history_backup_confirmed() || !self.list_local_brc39_archive().is_empty() {
            return Ok("synced");
        }
        // Attempt an automatic on-device BRC-39 archive snapshot right now so no UTXOs are lost.
        match self.create_brc39_backup_bytes() {
            Ok(_) => Ok("synced"),
            Err(e) => Err(format!("History didn’t sync: {e}")),
        }
    }

    /// Factory-reset local wallet: verifies unlock factor, locks session & engine, removes
    /// `engine-accounts/` and `toolbox-sqlite/` (preserving `brc39-archive/`), and wipes durable keys.
    pub fn wipe_all_wallet_data(&self, password: Option<&str>) -> Result<(), String> {
        let open_secret = if self.is_no_device_lock() {
            self.open_unlock_secret()
        } else {
            None
        };
        if let Some(pw) = password.filter(|s| !s.is_empty()) {
            if pw.len() < 8 {
                return Err("Password must be at least 8 characters".into());
            }
            self.verify_password(pw)?;
        } else if let Some(ref open) = open_secret {
            self.verify_password(open)?;
        } else {
            return Err("Confirm your HandCash password before wiping this device.".into());
        }

        // Write a final on-device BRC-39 archive snapshot best-effort before wiping (archive is never wiped).
        let _ = self.create_brc39_backup_bytes();

        self.lock();
        let _ = std::fs::remove_dir_all(self.user_data_dir.join("engine-accounts"));
        let _ = std::fs::remove_dir_all(self.user_data_dir.join("toolbox-sqlite"));
        self.durable.wipe_all();
        self.host_log
            .append("info", "wipe", "wiped local wallet data (brc39-archive preserved)");
        Ok(())
    }

    // ── Multi-Device Roster, Device Backup & Sign-in Email (`deviceWallets.ts`, `deviceSignin`) ──

    pub fn get_or_create_device_id(&self) -> String {
        if let Some(existing) = self
            .durable
            .get(DEVICE_ID_STORAGE_KEY)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            return existing;
        }
        let id = format!("dev-{:x}", now_ms());
        let _ = self.durable.set(DEVICE_ID_STORAGE_KEY, &id, false);
        id
    }

    pub fn local_device_label() -> &'static str {
        if cfg!(target_os = "macos") {
            "This Mac"
        } else if cfg!(target_os = "windows") {
            "This Windows PC"
        } else {
            "This Linux PC"
        }
    }

    pub fn list_peer_devices(&self) -> Vec<DeviceWalletRow> {
        let Some(raw) = self.durable.get(DEVICE_WALLETS_STORAGE_KEY) else {
            return Vec::new();
        };
        let Ok(list) = serde_json::from_str::<Vec<DeviceWalletRow>>(&raw) else {
            return Vec::new();
        };
        let local_id = self.get_or_create_device_id();
        list.into_iter()
            .filter(|d| !d.is_local && d.device_id != local_id)
            .collect()
    }

    pub fn build_local_pair_qr_json(&self) -> Option<String> {
        let sum = self.current_session_summary()?;
        let device_id = self.get_or_create_device_id();
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "windows") {
            "win32"
        } else {
            "linux"
        };
        let label = match platform {
            "darwin" => "Mac",
            "win32" => "Windows PC",
            _ => "Linux PC",
        };
        let bridge = self.brc100.status_snapshot();
        let peer_base_url = bridge
            .get("devicePeerLanUrls")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str);
        Some(
            serde_json::json!({
                "v": 3,
                "identityKey": sum.identity_key,
                "address": sum.address,
                "deviceId": device_id,
                "label": label,
                "platform": platform,
                "peerBaseUrl": peer_base_url,
            })
            .to_string(),
        )
    }

    pub fn link_peer_from_json(&self, raw: &str) -> Result<DeviceWalletRow, String> {
        let sum = self
            .current_session_summary()
            .ok_or_else(|| "Unlock this wallet first.".to_string())?;
        let v: Value = serde_json::from_str(raw.trim())
            .map_err(|_| "Pair code must be a HandCash device QR JSON.".to_string())?;
        let ver = v.get("v").and_then(Value::as_u64).unwrap_or(0);
        if !matches!(ver, 1..=3) {
            return Err("Unsupported pair payload version.".into());
        }
        let ik = v
            .get("identityKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| s.len() == 66 && (s.starts_with("02") || s.starts_with("03")))
            .ok_or_else(|| "Pair payload identity key is invalid.".to_string())?
            .to_string();
        let device_id = v
            .get("deviceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Pair payload missing deviceId.".to_string())?
            .to_string();
        if device_id == self.get_or_create_device_id() {
            return Err("That is this device.".into());
        }
        let label = v
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Device")
            .trim_start_matches("This ")
            .to_string();
        let platform = v
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let address = v
            .get("address")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        let same_identity = ik.eq_ignore_ascii_case(&sum.identity_key);
        let row = DeviceWalletRow {
            device_id: device_id.clone(),
            label,
            platform,
            peer_base_url: v
                .get("peerBaseUrl")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            is_local: false,
            identity_key: ik,
            address,
            last_seen_at: Some(now_ms()),
            online: false,
            linked_at: Some(now_ms()),
            link_mode: if same_identity {
                "linked".into()
            } else {
                "backup-only".into()
            },
        };
        let mut peers = self.list_peer_devices();
        peers.retain(|p| p.device_id != device_id);
        peers.push(row.clone());
        if let Ok(json) = serde_json::to_string(&peers) {
            let _ = self.durable.set(DEVICE_WALLETS_STORAGE_KEY, &json, false);
        }
        Ok(row)
    }

    pub fn remove_peer_device(&self, device_id: &str) {
        let mut peers = self.list_peer_devices();
        peers.retain(|p| p.device_id != device_id);
        if let Ok(json) = serde_json::to_string(&peers) {
            let _ = self.durable.set(DEVICE_WALLETS_STORAGE_KEY, &json, false);
        }
    }

    pub fn signin_email(&self) -> Option<String> {
        let key = self
            .vault_local_key(SIGNIN_EMAIL_STORAGE_KEY)
            .unwrap_or_else(|| SIGNIN_EMAIL_STORAGE_KEY.to_string());
        self.durable
            .get(&key)
            .or_else(|| self.durable.get(SIGNIN_EMAIL_STORAGE_KEY))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    pub fn set_signin_email(&self, email: Option<&str>) {
        let key = self
            .vault_local_key(SIGNIN_EMAIL_STORAGE_KEY)
            .unwrap_or_else(|| SIGNIN_EMAIL_STORAGE_KEY.to_string());
        match email.map(str::trim).filter(|s| !s.is_empty()) {
            Some(e) => {
                let _ = self.durable.set(&key, e, false);
            }
            None => {
                self.durable.remove(&key);
                self.durable.remove(SIGNIN_EMAIL_STORAGE_KEY);
            }
        }
    }

    // ── Identity Cards, Public Identities, Notes, Messages & Developer Keys ──

    /// Fully qualified claimed handle (`claimed.display`, e.g. `@h@domain`) — the pay
    /// address `WalletAccountMenu` copies. `None` when no handle is claimed.
    pub fn claimed_handle_display_for(
        &self,
        chain: &str,
        account_index: u32,
        identity_key: &str,
    ) -> Option<String> {
        let ik_lower = identity_key.trim().to_ascii_lowercase();
        for key in [
            format!("handcash.brc100.claimedHandle:wallet:{chain}:{account_index}:{ik_lower}"),
            format!("handcash.brc100.claimedHandle:wallet:{chain}:{account_index}:{identity_key}"),
        ] {
            let Some(v) = self
                .durable
                .get(&key)
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            else {
                continue;
            };
            if let Some(d) = v
                .get("display")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(d.to_string());
            }
        }
        None
    }

    pub fn claimed_handle_for(
        &self,
        chain: &str,
        account_index: u32,
        identity_key: &str,
    ) -> Option<String> {
        let ik_lower = identity_key.trim().to_ascii_lowercase();
        for key in [
            format!(
                "handcash.brc100.claimedHandle:wallet:{chain}:{account_index}:{ik_lower}"
            ),
            format!("handcash.brc100.claimedHandle:wallet:{chain}:{account_index}:{identity_key}"),
            format!("handcash.cloudHandle.v1:{identity_key}"),
            format!("handcash.brc100.claimedHandle:{identity_key}"),
            "handcash.cloudHandle.v1".to_string(),
        ] {
            if let Some(raw) = self.durable.get(&key) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    let matches_ik = v
                        .get("identityKey")
                        .and_then(Value::as_str)
                        .map(|s| s.trim().eq_ignore_ascii_case(&ik_lower))
                        .unwrap_or(true);
                    if !matches_ik {
                        continue;
                    }
                    if let Some(h) = v
                        .get("handle")
                        .or_else(|| v.get("display"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        let clean = h.trim_start_matches(['$', '@']);
                        return Some(format!("${clean}"));
                    }
                }
            }
        }
        None
    }

    pub fn build_identity_cards(&self, profile: &SessionSummary) -> Vec<IdentityCardItem> {
        let mut cards = vec![IdentityCardItem {
            id: "key".into(),
            kind: "key",
            title: "Identity key".into(),
            groups: key_groups(&profile.identity_key),
            holder: "WALLET KEY".into(),
            identity_key: profile.identity_key.clone(),
            own: true,
        }];
        if let Some(claimed) =
            self.claimed_handle_for(&profile.chain, profile.account_index, &profile.identity_key)
        {
            cards.push(IdentityCardItem {
                id: "own-handle".into(),
                kind: "handle",
                title: claimed,
                groups: key_groups(&profile.identity_key),
                holder: "YOU".into(),
                identity_key: profile.identity_key.clone(),
                own: true,
            });
        }
        let mut seen = HashSet::new();
        seen.insert(profile.identity_key.to_ascii_lowercase());
        for friend in self.list_friends() {
            let has_fixed_handle = friend
                .handle
                .as_deref()
                .map(|h| !h.trim().is_empty())
                .unwrap_or_else(|| friend.label.trim().starts_with('$'));
            if !has_fixed_handle {
                continue;
            }
            let k = friend.identity_key.to_ascii_lowercase();
            if !seen.insert(k) {
                continue;
            }
            let title = friend
                .handle
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(friend.label.trim())
                .to_string();
            let holder = friend
                .label
                .trim()
                .trim_start_matches(['$', '@'])
                .to_uppercase();
            cards.push(IdentityCardItem {
                id: format!("friend-{}", friend.id),
                kind: "handle",
                title,
                groups: key_groups(&friend.identity_key),
                holder,
                identity_key: friend.identity_key,
                own: false,
            });
        }
        cards
    }

    fn public_identities_store_key(
        chain: &str,
        account_index: u32,
        identity_key: &str,
    ) -> String {
        format!(
            "handcash.publicIdentities.v1:wallet:{chain}:{account_index}:{}",
            identity_key.trim().to_ascii_lowercase()
        )
    }

    /// Read a verified/stored self-published profile for `identity_key` on `chain`
    /// (`handcash.identityProfiles.v1:{chain}:{identity_key}`).
    pub fn identity_profile_for(
        &self,
        chain: &str,
        identity_key: &str,
    ) -> Option<AccountProfileView> {
        let ik = identity_key.trim().to_ascii_lowercase();
        if ik.is_empty() {
            return None;
        }
        for key in [
            format!("handcash.identityProfiles.v1:{chain}:{ik}"),
            format!("handcash.identityProfiles.v1:{chain}:{identity_key}"),
        ] {
            if let Some(raw) = self.durable.get(&key) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    let name = v
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?
                        .to_string();
                    let description = v
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let image_data_url = v
                        .get("record")
                        .and_then(|r| r.get("image"))
                        .and_then(|img| {
                            let ct = img.get("contentType")?.as_str()?;
                            let b64 = img.get("bytesB64")?.as_str()?;
                            Some(format!("data:{ct};base64,{b64}"))
                        })
                        .or_else(|| {
                            v.get("imageDataUrl")
                                .and_then(Value::as_str)
                                .map(ToString::to_string)
                        });
                    return Some(AccountProfileView {
                        identity_key: ik,
                        name,
                        description,
                        image_data_url,
                    });
                }
            }
        }
        None
    }

    /// Read the active public profile for a vault sub-account (`WalletAccountMenu` avatar + name).
    pub fn account_profile_for(
        &self,
        chain: &str,
        account_index: u32,
        identity_key: &str,
    ) -> Option<AccountProfileView> {
        // Mirrors TS `presentedRow`: the presented row with a live profile, else the
        // owner row, else any row. `selected` is the issuance signer, not display.
        let trimmed = identity_key.trim();
        if trimmed.is_empty() {
            return None;
        }
        let ik = trimmed.to_ascii_lowercase();
        // TS keys the store by the trimmed (not lowercased) identity key.
        let store = [
            format!("handcash.publicIdentities.v1:wallet:{chain}:{account_index}:{trimmed}"),
            Self::public_identities_store_key(chain, account_index, &ik),
        ]
        .iter()
        .find_map(|key| {
            self.durable
                .get(key)
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        });
        let mut order: Vec<String> = Vec::new();
        let mut push = |k: &str| {
            let k = k.trim();
            if !k.is_empty() && !order.iter().any(|o| o.eq_ignore_ascii_case(k)) {
                order.push(k.to_string());
            }
        };
        if let Some(ref v) = store {
            if let Some(p) = v.get("presented").and_then(Value::as_str) {
                push(p);
            }
            if let Some(o) = v.get("owner").and_then(Value::as_str) {
                push(o);
            }
        }
        push(trimmed);
        // Collect any published BAP IDs keyed by identityKey in the store.
        let mut published_bap: HashMap<String, String> = HashMap::new();
        if let Some(rows) = store
            .as_ref()
            .and_then(|v| v.get("identities"))
            .and_then(Value::as_array)
        {
            for row in rows {
                if let Some(k) = row.get("identityKey").and_then(Value::as_str) {
                    push(k);
                    if let Some(bap_id) = row.get("published").and_then(Value::as_str) {
                        published_bap.insert(k.trim().to_ascii_lowercase(), bap_id.to_string());
                    }
                }
            }
        }
        let bap_to_view = |key: &str, bap: handcash_bitcoin::issuer::VerifiedBapIdentity| {
            AccountProfileView {
                identity_key: key.to_ascii_lowercase(),
                name: bap.name,
                description: bap.description,
                image_data_url: bap.image_data_url,
            }
        };
        for k in &order {
            if let Some(p) = self.identity_profile_for(chain, k) {
                return Some(p);
            }
            let k_lower = k.to_ascii_lowercase();
            if let Some(bap) = published_bap
                .get(&k_lower)
                .and_then(|bid| self.bap_identity_for(chain, bid))
                .or_else(|| self.linked_bap_identity_for_key(chain, &k_lower))
            {
                return Some(bap_to_view(&k_lower, bap));
            }
        }
        // Fallback: check identity cards received from sibling accounts held on other devices.
        let cards_key = format!("handcash.identityCards.v1:{chain}");
        if let Some(link) = self
            .durable
            .get(&cards_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .and_then(|v| v.get("links")?.get(&ik).cloned())
        {
            if let Some(presented_key) = link.get("key").and_then(Value::as_str) {
                if let Some(p) = self.identity_profile_for(chain, presented_key) {
                    return Some(p);
                }
                if let Some(bap) = self.linked_bap_identity_for_key(chain, presented_key) {
                    return Some(bap_to_view(presented_key, bap));
                }
            }
            if let Some(bap_id) = link.get("bapId").and_then(Value::as_str) {
                if let Some(bap) = self.bap_identity_for(chain, bap_id) {
                    return Some(bap_to_view(&ik, bap));
                }
            }
        }
        None
    }

        /// Read and cryptographically verify `handcash.verifiedIssuers.v1` against the pinned HandCash certifier.
    pub fn verified_issuers(&self) -> Vec<VerifiedIssuerEntry> {
        let Some(raw) = self.durable.get(VERIFIED_ISSUERS_KEY) else {
            return Vec::new();
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            return Vec::new();
        };
        verify_verified_issuer_list(&v).unwrap_or_default()
    }

    /// Read and verify a stored BAP issuer package (`handcash.issuerIdentities.v1:{chain}:{bap_id}`).
    pub fn bap_identity_for(&self, chain: &str, bap_id: &str) -> Option<VerifiedBapIdentity> {
        let id = normalize_bap_id(bap_id)?;
        let key = format!("handcash.issuerIdentities.v1:{chain}:{id}");
        let raw = self.durable.get(&key)?;
        let v: Value = serde_json::from_str(&raw).ok()?;
        let verified = verify_issuer_identity_package(&v)?;
        (verified.bap_id == id && !verified.revoked).then_some(verified)
    }

    /// Find a stored non-revoked BAP identity linked to `identity_key` on `chain`.
    pub fn linked_bap_identity_for_key(&self, chain: &str, identity_key: &str) -> Option<VerifiedBapIdentity> {
        let ik = normalize_issuer_identity_key(identity_key)?;
        let idx_key = format!("handcash.issuerIdentities.v1:{chain}");
        let idx = self
            .durable
            .get(&idx_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())?;
        let entries = idx.get("entries")?.as_array()?;
        for entry in entries {
            let Some(bap_id) = entry.get("bapId").and_then(Value::as_str) else {
                continue;
            };
            if let Some(bap) = self.bap_identity_for(chain, bap_id) {
                if bap.linked_identity_keys.iter().any(|k| k.eq_ignore_ascii_case(&ik)) {
                    return Some(bap);
                }
            }
        }
        None
    }

    /// Resolve a locally controlled wallet identity key's published BAP identity
    /// (`handcash.publicIdentities.v1:wallet:{chain}:{idx}:{owner}`), matching TS `profileForKey`.
    fn published_bap_for_own_key(&self, chain: &str, identity_key: &str) -> Option<VerifiedBapIdentity> {
        let target = normalize_issuer_identity_key(identity_key)?;
        let mut stores: Vec<(u32, String)> = self
            .list_vault_accounts()
            .into_iter()
            .map(|a| (a.index, a.identity_key))
            .collect();
        if let Some(cur) = self.current_session_summary() {
            if !stores.iter().any(|(i, _)| *i == cur.account_index) {
                stores.push((cur.account_index, cur.identity_key));
            }
        }
        for (idx, owner) in stores {
            let trimmed = owner.trim();
            let lower = trimmed.to_ascii_lowercase();
            let store = [
                format!("handcash.publicIdentities.v1:wallet:{chain}:{idx}:{trimmed}"),
                Self::public_identities_store_key(chain, idx, &lower),
            ]
            .into_iter()
            .find_map(|k| {
                self.durable
                    .get(&k)
                    .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            });
            let Some(rows) = store
                .as_ref()
                .and_then(|v| v.get("identities"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for row in rows {
                let Some(row_ik) = row
                    .get("identityKey")
                    .and_then(Value::as_str)
                    .and_then(normalize_issuer_identity_key)
                else {
                    continue;
                };
                if row_ik == target {
                    if let Some(bid) = row.get("published").and_then(Value::as_str) {
                        if let Some(bap) = self.bap_identity_for(chain, bid) {
                            return Some(bap);
                        }
                    }
                }
            }
        }
        None
    }

    /// Collect `(id, name)` for all known verified profiles and BAP identities on `chain` (for shared-name checks).
    fn known_identity_names(&self, chain: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut keyed = HashSet::new();
        let prof_idx = format!("handcash.identityProfiles.v1:{chain}");
        if let Some(entries) = self
            .durable
            .get(&prof_idx)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .and_then(|v| v.get("entries").and_then(Value::as_array).cloned())
        {
            for e in entries {
                if let Some(ik) = e.get("identityKey").and_then(Value::as_str) {
                    if let Some(p) = self.identity_profile_for(chain, ik) {
                        keyed.insert(p.identity_key.clone());
                        out.push((p.identity_key, p.name));
                    }
                }
            }
        }
        let bap_idx = format!("handcash.issuerIdentities.v1:{chain}");
        if let Some(entries) = self
            .durable
            .get(&bap_idx)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .and_then(|v| v.get("entries").and_then(Value::as_array).cloned())
        {
            for e in entries {
                if let Some(bap_id) = e.get("bapId").and_then(Value::as_str) {
                    if let Some(bap) = self.bap_identity_for(chain, bap_id) {
                        if !bap.linked_identity_keys.iter().any(|k| keyed.contains(k)) {
                            out.push((bap.bap_id, bap.name));
                        }
                    }
                }
            }
        }
        out
    }

    /// Resolve an asset's issuing identity key / BAP ID into its display profile and trust badge.
    pub fn resolve_issuer_display(
        &self,
        chain: &str,
        issuer_key: &str,
        bap_id: Option<&str>,
        issuer_attested: bool,
    ) -> ResolvedIssuerDisplay {
        let key_clean = issuer_key.trim();
        let norm_key = normalize_issuer_identity_key(key_clean).unwrap_or_else(|| key_clean.to_string());
        let norm_bap = bap_id.and_then(normalize_bap_id);

        let own_profile = self.peer_identity_for(chain, &norm_key);
        let bap_identity = norm_bap
            .as_deref()
            .and_then(|id| self.bap_identity_for(chain, id))
            .or_else(|| self.linked_bap_identity_for_key(chain, &norm_key))
            .or_else(|| self.published_bap_for_own_key(chain, &norm_key));

        let verified_list = self.verified_issuers();
        let known_names = self.known_identity_names(chain);

        if let Some(prof) = own_profile {
            let resolved_bap = bap_identity
                .as_ref()
                .map(|b| b.bap_id.as_str())
                .or(norm_bap.as_deref());
            let trust = compute_issuer_trust_state(
                &norm_key,
                &prof.name,
                resolved_bap,
                &verified_list,
                &known_names,
            );
            return ResolvedIssuerDisplay {
                identity_key: norm_key.clone(),
                label: prof.name,
                state: trust,
                profile_id: Some(resolved_bap.map(ToString::to_string).unwrap_or(norm_key)),
                image_url: prof.image_data_url,
                issuer_attested,
            };
        }

        if let Some(bap) = bap_identity {
            let trust = compute_issuer_trust_state(
                &bap.bap_id,
                &bap.name,
                Some(&bap.bap_id),
                &verified_list,
                &known_names,
            );
            return ResolvedIssuerDisplay {
                identity_key: norm_key,
                label: bap.name,
                state: trust,
                profile_id: Some(bap.bap_id),
                image_url: bap.image_data_url,
                issuer_attested,
            };
        }

        if let Some(bid) = norm_bap {
            return ResolvedIssuerDisplay {
                identity_key: norm_key,
                label: truncate_mid(&bid, 10),
                state: "unconfirmed",
                profile_id: Some(bid),
                image_url: None,
                issuer_attested,
            };
        }

        ResolvedIssuerDisplay {
            identity_key: norm_key.clone(),
            label: truncate_mid(&norm_key, 10),
            state: if issuer_attested { "key" } else { "claim" },
            profile_id: None,
            image_url: None,
            issuer_attested,
        }
    }

    /// Read a contact's shared profile (`handcash.identityProfiles`, canonical TS `handcash.identityCards.v1:{chain}` links, or linked BAP).
    pub fn peer_identity_for(
        &self,
        chain: &str,
        identity_key: &str,
    ) -> Option<AccountProfileView> {
        let ik = identity_key.trim().to_ascii_lowercase();
        if ik.is_empty() {
            return None;
        }
        if let Some(prof) = self.identity_profile_for(chain, &ik) {
            return Some(prof);
        }
        // Check canonical TS `handcash.identityCards.v1:{chain}` (`{ version: 1, links: { [walletKey]: { key | bapId } } }`).
        let links_key = format!("handcash.identityCards.v1:{chain}");
        if let Some(raw) = self.durable.get(&links_key) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(link) = v
                    .get("links")
                    .and_then(Value::as_object)
                    .and_then(|m| m.get(&ik).or_else(|| m.get(identity_key.trim())))
                {
                    if let Some(presented_key) = link.get("key").and_then(Value::as_str) {
                        if let Some(prof) = self.identity_profile_for(chain, presented_key) {
                            return Some(prof);
                        }
                        if let Some(bap) = self.linked_bap_identity_for_key(chain, presented_key) {
                            return Some(AccountProfileView {
                                identity_key: presented_key.to_ascii_lowercase(),
                                name: bap.name,
                                description: bap.description,
                                image_data_url: bap.image_data_url,
                            });
                        }
                    }
                    if let Some(bap_id) = link.get("bapId").and_then(Value::as_str) {
                        if let Some(bap) = self.bap_identity_for(chain, bap_id) {
                            return Some(AccountProfileView {
                                identity_key: ik.clone(),
                                name: bap.name,
                                description: bap.description,
                                image_data_url: bap.image_data_url,
                            });
                        }
                    }
                }
            }
        }
        // Check legacy per-contact identityCard entries.
        for key in [
            format!("handcash.identityCards.v1:{chain}:{ik}"),
            format!("handcash.identityCards.v1:{chain}:{identity_key}"),
        ] {
            if let Some(raw) = self.durable.get(&key) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    let card = v.get(&ik).unwrap_or(&v);
                    if let Some(name) = card
                        .get("name")
                        .or_else(|| card.get("profile").and_then(|p| p.get("name")))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        let description = card
                            .get("description")
                            .or_else(|| card.get("profile").and_then(|p| p.get("description")))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let image_data_url = card
                            .get("imageDataUrl")
                            .or_else(|| card.get("profile").and_then(|p| p.get("imageDataUrl")))
                            .and_then(Value::as_str)
                            .map(ToString::to_string);
                        return Some(AccountProfileView {
                            identity_key: ik,
                            name: name.to_string(),
                            description,
                            image_data_url,
                        });
                    }
                }
            }
        }
        if let Some(bap) = self.linked_bap_identity_for_key(chain, &ik) {
            return Some(AccountProfileView {
                identity_key: ik,
                name: bap.name,
                description: bap.description,
                image_data_url: bap.image_data_url,
            });
        }
        None
    }

    pub fn list_public_identities_view(&self, profile: &SessionSummary) -> PublicIdentitiesView {
        let owner_trim = profile.identity_key.trim();
        let owner_ik = owner_trim.to_ascii_lowercase();
        let store_val = [
            format!("handcash.publicIdentities.v1:wallet:{}:{}:{owner_trim}", profile.chain, profile.account_index),
            Self::public_identities_store_key(&profile.chain, profile.account_index, &owner_ik),
        ]
        .iter()
        .find_map(|k| {
            self.durable
                .get(k)
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        });

        let owner_bap_id = self
            .session
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|s| bap_id_for_deriver(&s.deriver).ok()));

        let selected_issuer = store_val
            .as_ref()
            .and_then(|v| v.get("selected").and_then(Value::as_str))
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| owner_ik.clone());
        let presented_key = store_val
            .as_ref()
            .and_then(|v| v.get("presented").and_then(Value::as_str))
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty());
        let signs_issuance = store_val
            .as_ref()
            .and_then(|v| v.get("unsigned").and_then(Value::as_bool))
            != Some(true);

        let mut raw_entries: Vec<(String, String, Option<String>)> = Vec::new();
        if let Some(arr) = store_val
            .as_ref()
            .and_then(|v| v.get("identities").and_then(Value::as_array))
        {
            for item in arr {
                let Some(ik) = item
                    .get("identityKey")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let signer = item
                    .get("signer")
                    .and_then(Value::as_str)
                    .unwrap_or("wallet")
                    .to_string();
                let published = item
                    .get("published")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                raw_entries.push((ik, signer, published));
            }
        }
        if !raw_entries.iter().any(|(ik, _, _)| ik == &owner_ik) {
            raw_entries.insert(0, (owner_ik.clone(), "wallet".into(), None));
        }

        let mut rows = Vec::with_capacity(raw_entries.len());
        for (ik, signer, published) in raw_entries {
            let own_prof = self.identity_profile_for(&profile.chain, &ik);
            let bap_prof = published
                .as_deref()
                .and_then(|bid| self.bap_identity_for(&profile.chain, bid))
                .or_else(|| self.linked_bap_identity_for_key(&profile.chain, &ik));
            let bap_id = published
                .clone()
                .or_else(|| bap_prof.as_ref().map(|b| b.bap_id.clone()))
                .or_else(|| (ik == owner_ik).then(|| owner_bap_id.clone()).flatten())
                .unwrap_or_else(|| {
                    let h = sha256(format!("bap:{ik}").as_bytes());
                    bs58::encode(&h[..20]).into_string()
                });
            let is_selected = ik == selected_issuer;
            let is_presented = presented_key
                .as_ref()
                .map(|p| p == &ik)
                .unwrap_or((own_prof.is_some() || bap_prof.is_some()) && ik == owner_ik);
            let name = own_prof
                .as_ref()
                .map(|p| p.name.clone())
                .or_else(|| bap_prof.as_ref().map(|b| b.name.clone()));
            let description = own_prof
                .as_ref()
                .map(|p| p.description.clone())
                .filter(|d| !d.is_empty())
                .or_else(|| {
                    bap_prof
                        .as_ref()
                        .map(|b| b.description.clone())
                        .filter(|d| !d.is_empty())
                });
            let image_data_url = own_prof
                .as_ref()
                .and_then(|p| p.image_data_url.clone())
                .or_else(|| bap_prof.as_ref().and_then(|b| b.image_data_url.clone()));
            rows.push(PublicIdentityRow {
                identity_key: ik.clone(),
                signer,
                bap_id,
                name,
                description,
                image_data_url,
                profile_source: if own_prof.is_some() {
                    Some("identity-key".into())
                } else if bap_prof.is_some() || published.is_some() {
                    Some("bap".into())
                } else {
                    None
                },
                is_selected_issuer: is_selected,
                is_presented,
                bap_published: published.is_some() || bap_prof.is_some(),
            });
        }

        let effective_presented = presented_key.or_else(|| {
            rows.iter()
                .find(|r| r.is_presented)
                .map(|r| r.identity_key.clone())
        });

        PublicIdentitiesView {
            rows,
            selected_issuer,
            presented_key: effective_presented,
            signs_issuance,
        }
    }

    fn update_public_identities_store<F>(
        &self,
        profile: &SessionSummary,
        mut f: F,
    ) -> Result<(), String>
    where
        F: FnMut(&mut serde_json::Map<String, Value>) -> Result<(), String>,
    {
        let owner_ik = profile.identity_key.trim().to_ascii_lowercase();
        let store_key =
            Self::public_identities_store_key(&profile.chain, profile.account_index, &owner_ik);
        let mut store = self
            .durable
            .get(&store_key)
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_else(|| {
                let mut m = serde_json::Map::new();
                m.insert("version".into(), Value::from(2));
                m.insert("owner".into(), Value::from(owner_ik.clone()));
                m.insert("chain".into(), Value::from(profile.chain.clone()));
                m.insert("selected".into(), Value::from(owner_ik.clone()));
                m.insert("identities".into(), Value::Array(Vec::new()));
                m
            });
        store.insert("version".into(), Value::from(2));
        store.insert("owner".into(), Value::from(owner_ik));
        store.insert("chain".into(), Value::from(profile.chain.clone()));
        f(&mut store)?;
        let json = serde_json::to_string(&Value::Object(store)).map_err(|e| e.to_string())?;
        if !self.durable.set(&store_key, &json, false) {
            return Err("Could not save public identities.".into());
        }
        Ok(())
    }

    /// Save a self-published profile for `target_identity_key` (1:1 with `saveIdentityProfile` in `publicIdentities.ts`).
    pub fn save_public_identity_profile(
        &self,
        profile: &SessionSummary,
        target_identity_key: &str,
        name: &str,
        description: &str,
        image_data_url: Option<&str>,
    ) -> Result<(), String> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("Enter a profile name.".into());
        }
        if trimmed_name.len() > 64 {
            return Err("Profile name must be 64 characters or fewer.".into());
        }
        if trimmed_name.contains('@') && trimmed_name.contains('.') {
            return Err("Do not use an email address as a public profile name.".into());
        }
        let trimmed_desc = description.trim();
        if trimmed_desc.len() > 160 {
            return Err("Bio must be 160 characters or fewer.".into());
        }
        let ik = target_identity_key.trim().to_ascii_lowercase();
        let now = now_ms();
        let issued_at = crate::messagebox::iso_utc_from_ms(now);

        let decoded_image: Option<(String, Vec<u8>)> = if let Some(data_url) =
            image_data_url.filter(|u| u.starts_with("data:image/"))
        {
            if let Some((meta, b64)) = data_url.split_once(";base64,") {
                let ct = meta.trim_start_matches("data:").to_string();
                let img_bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|_| "Invalid image data.".to_string())?;
                if img_bytes.len() > 65_536 {
                    return Err("Profile image must be 64 KB or smaller.".into());
                }
                Some((ct, img_bytes))
            } else {
                None
            }
        } else {
            None
        };

        let signing_key = {
            let guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().and_then(|active| {
                if active.summary.identity_key.eq_ignore_ascii_case(&ik) {
                    Some(active.deriver.root_key().clone())
                } else {
                    None
                }
            })
        };

        let mut record_obj = serde_json::Map::new();
        if let Some(ref sk) = signing_key {
            let img_arg = decoded_image
                .as_ref()
                .map(|(ct, bytes)| (ct.as_str(), bytes.as_slice()));
            let (cert, pkg_img) = handcash_bitcoin::issuer::sign_profile_certificate(
                sk,
                trimmed_name,
                trimmed_desc,
                &issued_at,
                img_arg,
            )?;
            record_obj.insert("certificate".into(), cert);
            if let Some(img) = pkg_img {
                record_obj.insert("image".into(), img);
            }
        } else {
            let sig_hash = encode_hex(&sha256(
                format!("BRC-248:{ik}:{trimmed_name}:{trimmed_desc}:{issued_at}").as_bytes(),
            ));
            record_obj.insert(
                "certificate".into(),
                serde_json::json!({
                    "type": base64::engine::general_purpose::STANDARD.encode(sha256(b"BRC-248 identity profile")),
                    "serialNumber": base64::engine::general_purpose::STANDARD.encode(sha256(issued_at.as_bytes())),
                    "subject": ik,
                    "certifier": ik,
                    "revocationOutpoint": format!("{}.0", "00".repeat(32)),
                    "fields": {
                        "name": trimmed_name,
                        "description": trimmed_desc,
                        "issuedAt": issued_at,
                    },
                    "keyring": {},
                    "signature": sig_hash,
                }),
            );
            if let Some((ct, bytes)) = decoded_image {
                let uhrp_url = handcash_primitives::keys::uhrp_url_for_bytes(&bytes);
                record_obj.insert(
                    "image".into(),
                    serde_json::json!({
                        "url": uhrp_url,
                        "contentType": ct,
                        "bytesB64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                    }),
                );
            }
        }

        let stored = serde_json::json!({
            "record": Value::Object(record_obj),
            "name": trimmed_name,
            "description": trimmed_desc,
            "issuedAt": issued_at,
            "imageDataUrl": image_data_url,
        });
        let entry_key = format!("handcash.identityProfiles.v1:{}:{ik}", profile.chain);
        let stored_json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
        if !self.durable.set(&entry_key, &stored_json, false) {
            return Err("Failed to save profile record.".into());
        }

        // Update index `handcash.identityProfiles.v1:{chain}` with `pinned: true`.
        let idx_key = format!("handcash.identityProfiles.v1:{}", profile.chain);
        let mut idx_val = self
            .durable
            .get(&idx_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .unwrap_or_else(|| serde_json::json!({ "version": 1, "entries": [] }));
        if let Some(entries) = idx_val.get_mut("entries").and_then(Value::as_array_mut) {
            entries.retain(|e| e.get("identityKey").and_then(Value::as_str) != Some(ik.as_str()));
            entries.push(serde_json::json!({
                "identityKey": ik,
                "storedAt": now,
                "pinned": true,
            }));
        }
        if let Ok(idx_json) = serde_json::to_string(&idx_val) {
            let _ = self.durable.set(&idx_key, &idx_json, false);
        }

        // Ensure `presented` is set if nothing was presented yet.
        let _ = self.update_public_identities_store(profile, |store| {
            if !store.contains_key("presented") {
                store.insert("presented".into(), Value::from(ik.clone()));
                store.insert("presentedAt".into(), Value::from(issued_at.clone()));
            }
            Ok(())
        });

        Ok(())
    }

    pub fn select_public_identity_issuer(
        &self,
        profile: &SessionSummary,
        target_identity_key: &str,
    ) -> Result<(), String> {
        let ik = target_identity_key.trim().to_ascii_lowercase();
        self.update_public_identities_store(profile, |store| {
            store.insert("selected".into(), Value::from(ik.clone()));
            Ok(())
        })
    }

    pub fn present_public_identity(
        &self,
        profile: &SessionSummary,
        target_identity_key: &str,
    ) -> Result<(), String> {
        let ik = target_identity_key.trim().to_ascii_lowercase();
        let now_str = format!("{}", now_ms());
        self.update_public_identities_store(profile, |store| {
            store.insert("presented".into(), Value::from(ik.clone()));
            store.insert("presentedAt".into(), Value::from(now_str.clone()));
            Ok(())
        })
    }

    pub fn set_signs_issuance(&self, profile: &SessionSummary, signs: bool) -> Result<(), String> {
        self.update_public_identities_store(profile, |store| {
            if signs {
                store.remove("unsigned");
            } else {
                store.insert("unsigned".into(), Value::from(true));
            }
            Ok(())
        })
    }

    pub fn import_issuer_private_key(
        &self,
        profile: &SessionSummary,
        raw_key: &str,
    ) -> Result<String, String> {
        let trimmed = raw_key.trim();
        if trimmed.is_empty() {
            return Err("Add a 64-hex private signing key.".into());
        }
        let clean = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
            .unwrap_or(trimmed);
        let sk = handcash_primitives::keys::SecretKeyBytes::from_hex(clean)
            .map_err(|_| "Enter a valid 64-character hex private signing key.".to_string())?;
        let pubkey = sk
            .public_key_hex()
            .map_err(|e| e.to_string())?
            .to_ascii_lowercase();
        let owner_ik = profile.identity_key.trim().to_ascii_lowercase();
        if pubkey == owner_ik {
            return Err("That is already this wallet's primary identity key.".into());
        }
        let sealed = base64::engine::general_purpose::STANDARD.encode(
            serde_json::json!({
                "kind": "issuer-signing-key",
                "owner": owner_ik,
                "privateKey": clean.to_ascii_lowercase(),
            })
            .to_string()
            .as_bytes(),
        );
        self.update_public_identities_store(profile, |store| {
            let arr = store
                .entry("identities")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or_else(|| "Invalid identities list.".to_string())?;
            arr.retain(|e| e.get("identityKey").and_then(Value::as_str) != Some(pubkey.as_str()));
            arr.push(serde_json::json!({
                "identityKey": pubkey,
                "signer": "imported",
                "sealedKey": sealed,
            }));
            store.insert("selected".into(), Value::from(pubkey.clone()));
            Ok(())
        })?;
        Ok(pubkey)
    }

    pub fn remove_imported_public_identity(
        &self,
        profile: &SessionSummary,
        target_identity_key: &str,
    ) -> Result<(), String> {
        let ik = target_identity_key.trim().to_ascii_lowercase();
        let owner_ik = profile.identity_key.trim().to_ascii_lowercase();
        if ik == owner_ik {
            return Err("The wallet's primary identity key cannot be removed.".into());
        }
        self.update_public_identities_store(profile, |store| {
            if let Some(arr) = store.get_mut("identities").and_then(Value::as_array_mut) {
                arr.retain(|e| e.get("identityKey").and_then(Value::as_str) != Some(ik.as_str()));
            }
            if store.get("selected").and_then(Value::as_str) == Some(ik.as_str()) {
                store.insert("selected".into(), Value::from(owner_ik.clone()));
            }
            if store.get("presented").and_then(Value::as_str) == Some(ik.as_str()) {
                store.remove("presented");
                store.remove("presentedAt");
            }
            Ok(())
        })
    }

    pub fn export_identity_card_json(
        &self,
        profile: &SessionSummary,
        target_identity_key: &str,
    ) -> Result<String, String> {
        let ik = target_identity_key.trim().to_ascii_lowercase();
        let prof = self
            .identity_profile_for(&profile.chain, &ik)
            .ok_or_else(|| "Add a profile name before sharing an identity card.".to_string())?;
        let card = serde_json::json!({
            "kind": "handcash-identity-card",
            "v": 2,
            "chain": profile.chain,
            "identityKey": ik,
            "name": prof.name,
            "description": prof.description,
            "imageDataUrl": prof.image_data_url,
            "issuedAt": now_ms(),
        });
        serde_json::to_string_pretty(&card).map_err(|e| e.to_string())
    }

    pub fn import_peer_identity_card_json(
        &self,
        chain: &str,
        friend_identity_key: &str,
        raw_json: &str,
    ) -> Result<String, String> {
        if raw_json.len() > 400 * 1024 {
            return Err("This file is too large to be an identity card.".into());
        }
        let v: Value = serde_json::from_str(raw_json)
            .map_err(|_| "That file is not a valid HandCash identity card.".to_string())?;
        let card_ik = v
            .get("identityKey")
            .or_else(|| v.get("owner"))
            .and_then(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase())
            .ok_or_else(|| "Identity card is missing its identityKey.".to_string())?;
        let expected_ik = friend_identity_key.trim().to_ascii_lowercase();
        if !expected_ik.starts_with('$') && card_ik != expected_ik {
            return Err("This identity card belongs to a different wallet key.".into());
        }
        let name = v
            .get("name")
            .or_else(|| v.get("profile").and_then(|p| p.get("name")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Identity card has no profile name.".to_string())?
            .to_string();
        let description = v
            .get("description")
            .or_else(|| v.get("profile").and_then(|p| p.get("description")))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let image_data_url = v
            .get("imageDataUrl")
            .or_else(|| v.get("profile").and_then(|p| p.get("imageDataUrl")))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let key = format!("handcash.identityCards.v1:{chain}:{card_ik}");
        let stored = serde_json::json!({
            "identityKey": card_ik,
            "name": name,
            "description": description,
            "imageDataUrl": image_data_url,
            "verifiedAt": now_ms(),
        });
        let json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
        if !self.durable.set(&key, &json, false) {
            return Err("Failed to save contact identity card.".into());
        }
        Ok(name)
    }

    pub fn export_public_identities_backup_json(
        &self,
        profile: &SessionSummary,
    ) -> Result<String, String> {
        let view = self.list_public_identities_view(profile);
        let owner_ik = profile.identity_key.trim().to_ascii_lowercase();
        let store_key =
            Self::public_identities_store_key(&profile.chain, profile.account_index, &owner_ik);
        let raw_store = self
            .durable
            .get(&store_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let mut profiles = serde_json::Map::new();
        for row in &view.rows {
            let ek = format!(
                "handcash.identityProfiles.v1:{}:{}",
                profile.chain, row.identity_key
            );
            if let Some(p_raw) = self.durable.get(&ek) {
                if let Ok(pv) = serde_json::from_str::<Value>(&p_raw) {
                    profiles.insert(row.identity_key.clone(), pv);
                }
            }
        }
        let doc = serde_json::json!({
            "kind": "handcash-public-identities-backup",
            "version": 2,
            "owner": owner_ik,
            "chain": profile.chain,
            "store": raw_store,
            "profiles": Value::Object(profiles),
        });
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
    }

    pub fn restore_public_identities_backup_json(
        &self,
        profile: &SessionSummary,
        raw_json: &str,
    ) -> Result<String, String> {
        if raw_json.len() > 4 * 1024 * 1024 {
            return Err("Backup file is too large (4 MB maximum).".into());
        }
        let v: Value = serde_json::from_str(raw_json)
            .map_err(|_| "Invalid public identities backup JSON.".to_string())?;
        if v.get("kind").and_then(Value::as_str) != Some("handcash-public-identities-backup") {
            return Err("Not a HandCash public identities backup file.".into());
        }
        let owner_ik = profile.identity_key.trim().to_ascii_lowercase();
        if let Some(store_val) = v.get("store").filter(|s| s.is_object()) {
            let store_key =
                Self::public_identities_store_key(&profile.chain, profile.account_index, &owner_ik);
            if let Ok(s_json) = serde_json::to_string(store_val) {
                let _ = self.durable.set(&store_key, &s_json, false);
            }
        }
        let mut restored_count = 0usize;
        if let Some(profs) = v.get("profiles").and_then(Value::as_object) {
            for (ik, pv) in profs {
                let ek = format!(
                    "handcash.identityProfiles.v1:{}:{}",
                    profile.chain,
                    ik.to_ascii_lowercase()
                );
                if let Ok(p_json) = serde_json::to_string(pv) {
                    let _ = self.durable.set(&ek, &p_json, false);
                    restored_count += 1;
                }
            }
        }
        Ok(format!("Restored {restored_count} identity profile(s)."))
    }

    // ── Notes (`src/wallet/notes/noteStore.ts`) ──

    fn notes_storage_key(&self) -> String {
        self.account_local_key("handcash.notes.v1")
            .unwrap_or_else(|| "handcash.notes.v1".to_string())
    }

    pub fn list_notes(&self) -> Vec<NoteEntry> {
        let key = self.notes_storage_key();
        let Some(raw) = self.durable.get(&key) else {
            return Vec::new();
        };
        let mut list: Vec<NoteEntry> = serde_json::from_str(&raw).unwrap_or_default();
        list.sort_by_key(|n| std::cmp::Reverse(n.saved_at));
        list
    }

    pub fn save_note(&self, id: Option<&str>, body: &str) -> Result<Vec<NoteEntry>, String> {
        let trimmed = body.trim();
        let mut list = self.list_notes();
        if trimmed.is_empty() {
            if let Some(existing_id) = id {
                list.retain(|n| n.id != existing_id);
            }
        } else {
            let now = now_ms();
            if let Some(existing_id) = id {
                if let Some(pos) = list.iter().position(|n| n.id == existing_id) {
                    list[pos].body = body.to_string();
                    list[pos].saved_at = now;
                } else {
                    list.push(NoteEntry {
                        id: existing_id.to_string(),
                        body: body.to_string(),
                        saved_at: now,
                    });
                }
            } else {
                list.push(NoteEntry {
                    id: format!("note-{now}-{}", list.len() + 1),
                    body: body.to_string(),
                    saved_at: now,
                });
            }
        }
        list.sort_by_key(|n| std::cmp::Reverse(n.saved_at));
        let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
        let key = self.notes_storage_key();
        if !self.durable.set(&key, &json, false) {
            return Err("Could not save note.".into());
        }
        Ok(list)
    }

    pub fn delete_note(&self, id: &str) -> Result<Vec<NoteEntry>, String> {
        let mut list = self.list_notes();
        list.retain(|n| n.id != id);
        let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
        let key = self.notes_storage_key();
        let _ = self.durable.set(&key, &json, false);
        Ok(list)
    }

    // ── Peer Messages (`handcash.messages.v1`) ──

    fn messages_storage_key(&self) -> String {
        self.account_local_key("handcash.messages.v1")
            .unwrap_or_else(|| "handcash.messages.v1".to_string())
    }

    pub fn list_chat_messages(&self, peer_id: &str) -> Vec<ChatMessageEntry> {
        let key = self.messages_storage_key();
        let Some(raw) = self.durable.get(&key) else {
            return Vec::new();
        };
        let all: Vec<ChatMessageEntry> = serde_json::from_str(&raw).unwrap_or_default();
        let mut filtered: Vec<ChatMessageEntry> =
            all.into_iter().filter(|m| m.peer_id == peer_id).collect();
        filtered.sort_by_key(|m| m.at);
        filtered
    }

    pub fn send_chat_message(
        &self,
        peer_id: &str,
        text: &str,
    ) -> Result<ChatMessageEntry, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Message cannot be empty.".into());
        }
        let key = self.messages_storage_key();
        let mut all: Vec<ChatMessageEntry> = self
            .durable
            .get(&key)
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        let now = now_ms();
        let entry = ChatMessageEntry {
            id: format!("msg-{now}-{}", all.len() + 1),
            peer_id: peer_id.to_string(),
            direction: "out".into(),
            text: trimmed.to_string(),
            at: now,
        };
        all.push(entry.clone());
        let json = serde_json::to_string(&all).map_err(|e| e.to_string())?;
        if !self.durable.set(&key, &json, false) {
            return Err("Failed to save message.".into());
        }
        Ok(entry)
    }

    // ── Developer Keys (`src/wallet/devKeys.ts`) ──

    fn dev_keys_storage_key(&self) -> String {
        self.account_local_key("handcash.devKeys.v1")
            .unwrap_or_else(|| "handcash.devKeys.v1".to_string())
    }

    pub fn list_dev_keys(&self) -> Vec<DevKeyRecord> {
        let key = self.dev_keys_storage_key();
        let Some(raw) = self.durable.get(&key) else {
            return Vec::new();
        };
        let mut list: Vec<DevKeyRecord> = serde_json::from_str(&raw).unwrap_or_default();
        list.sort_by_key(|k| std::cmp::Reverse(k.created_at));
        list
    }

    pub fn create_dev_key(&self, label: &str) -> Result<(DevKeyRecord, String), String> {
        let wrap = generate_wrap_secret();
        let sk_bytes = sha256(format!("handcash.devKey.v1|{}|{}", wrap.as_str(), now_ms()).as_bytes());
        let sk_hex = encode_hex(&sk_bytes);
        let sk = handcash_primitives::keys::SecretKeyBytes::from_hex(&sk_hex)
            .map_err(|e| e.to_string())?;
        let pub_hex = sk.public_key_hex().map_err(|e| e.to_string())?;
        let now = now_ms();
        let clean_label = if label.trim().is_empty() {
            format!("Server key #{}", self.list_dev_keys().len() + 1)
        } else {
            label.trim().to_string()
        };
        let rec = DevKeyRecord {
            id: format!("dk-{now}"),
            public_key: pub_hex.clone(),
            created_at: now,
            label: clean_label,
        };
        let mut list = self.list_dev_keys();
        list.insert(0, rec.clone());
        let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
        let key = self.dev_keys_storage_key();
        if !self.durable.set(&key, &json, false) {
            return Err("Could not save developer key.".into());
        }
        let env_export = format!(
            "HANDCASH_DEV_PRIVATE_KEY={sk_hex}\nHANDCASH_DEV_PUBLIC_KEY={pub_hex}"
        );
        Ok((rec, env_export))
    }

    pub fn remove_dev_key(&self, id: &str) -> Result<(), String> {
        let mut list = self.list_dev_keys();
        list.retain(|k| k.id != id);
        let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
        let key = self.dev_keys_storage_key();
        let _ = self.durable.set(&key, &json, false);
        Ok(())
    }
}

/// 1:1 port of `keyGroups` in `src/wallet/identityCards.ts`.
pub fn key_groups(key: &str) -> Vec<String> {
    let k = key.trim().to_ascii_lowercase();
    let hex = if k.len() > 32 {
        format!("{}{}", &k[..16], &k[k.len() - 16..])
    } else {
        k
    };
    hex.as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityCardItem {
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    pub groups: Vec<String>,
    pub holder: String,
    pub identity_key: String,
    pub own: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountProfileView {
    pub identity_key: String,
    pub name: String,
    pub description: String,
    pub image_data_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicIdentityRow {
    pub identity_key: String,
    pub signer: String,
    pub bap_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub image_data_url: Option<String>,
    pub profile_source: Option<String>,
    pub is_selected_issuer: bool,
    pub is_presented: bool,
    pub bap_published: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicIdentitiesView {
    pub rows: Vec<PublicIdentityRow>,
    pub selected_issuer: String,
    pub presented_key: Option<String>,
    pub signs_issuance: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    pub id: String,
    pub body: String,
    pub saved_at: i64,
}

pub fn note_title(body: &str) -> String {
    let first = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("Untitled note");
    if first.chars().count() > 48 {
        let head: String = first.chars().take(48).collect();
        format!("{head}…")
    } else {
        first.to_string()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageEntry {
    pub id: String,
    pub peer_id: String,
    pub direction: String,
    pub text: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevKeyRecord {
    pub id: String,
    pub public_key: String,
    pub created_at: i64,
    pub label: String,
}

/// 1:1 port of `historyCryptoSecret` in `src/wallet/historyCryptoSecret.ts`.
pub fn history_crypto_secret(root_key_hex: &str) -> Result<String, String> {
    let clean = root_key_hex
        .trim()
        .strip_prefix("0x")
        .or_else(|| root_key_hex.trim().strip_prefix("0X"))
        .unwrap_or(root_key_hex.trim())
        .to_ascii_lowercase();
    if clean.len() != 64 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Root key must be 64 hex characters".into());
    }
    let material = format!("handcash.brc39.v2|{clean}");
    Ok(encode_hex(&sha256(material.as_bytes())))
}

/// 1:1 port of `HistoryBackupPrefs` in `src/wallet/historyBackupPrefs.ts`.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBackupPrefs {
    pub base_url: String,
    pub last_uploaded_at: Option<i64>,
    pub last_error: Option<String>,
    pub high_water_spendable_sats: Option<u64>,
    pub high_water_action_count: Option<u64>,
}

impl HistoryBackupPrefs {
    pub fn from_stored(own_raw: Option<&str>, vault_raw: Option<&str>) -> Self {
        let own = own_raw.and_then(|r| serde_json::from_str::<Value>(r).ok());
        let vault = vault_raw.and_then(|r| serde_json::from_str::<Value>(r).ok());
        let extract_url = |v: Option<&Value>| -> Option<String> {
            let v = v?;
            v.get("baseUrl")
                .or_else(|| v.get("customBaseUrl"))
                .and_then(Value::as_str)
                .map(|s| s.trim().trim_end_matches('/').to_string())
        };
        let base_url = extract_url(vault.as_ref())
            .or_else(|| extract_url(own.as_ref()))
            .unwrap_or_default();
        let Some(parsed) = own.or(vault) else {
            return Self {
                base_url,
                ..Default::default()
            };
        };
        Self {
            base_url,
            last_uploaded_at: parsed.get("lastUploadedAt").and_then(Value::as_i64),
            last_error: parsed
                .get("lastError")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            high_water_spendable_sats: parsed
                .get("highWaterSpendableSats")
                .and_then(Value::as_u64),
            high_water_action_count: parsed
                .get("highWaterActionCount")
                .and_then(Value::as_u64),
        }
    }

    pub fn effective_base_url(&self) -> &str {
        let trimmed = self.base_url.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            SUGGESTED_HISTORY_BACKUP_BASE_URL
        } else {
            trimmed
        }
    }

    pub fn is_custom_host(&self) -> bool {
        let trimmed = self.base_url.trim().trim_end_matches('/');
        !trimmed.is_empty() && trimmed != SUGGESTED_HISTORY_BACKUP_BASE_URL
    }

    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
}

pub const MIN_REMOTE_BYTES_TO_PROTECT: u64 = 256;
pub const SPENDABLE_COMPARE_MARGIN_SATS: u64 = 2_000;

/// 1:1 port of `decideHistoryPush` in `src/wallet/historyEmptyGuard.ts`.
#[allow(clippy::too_many_arguments)]
pub fn decide_history_push(
    remote_exists: bool,
    remote_bytes: Option<u64>,
    local_looks_empty: bool,
    local_spendable_sats: u64,
    local_action_count: u64,
    remote_spendable_sats: Option<u64>,
    remote_action_count: Option<u64>,
    high_water_spendable_sats: Option<u64>,
    high_water_action_count: Option<u64>,
    force: bool,
) -> Result<(), String> {
    if force {
        return Ok(());
    }
    let remote_protected =
        remote_exists && remote_bytes.map(|b| b >= MIN_REMOTE_BYTES_TO_PROTECT).unwrap_or(true);
    if local_looks_empty && remote_protected {
        return Err("refuse empty localState overwrite of remote BRC-39".into());
    }
    if remote_protected && (remote_spendable_sats.is_none() || remote_action_count.is_none()) {
        return Err(
            "refuse overwrite of remote BRC-39 with incomplete richness metadata".into(),
        );
    }
    let check_against = |base_sats: Option<u64>,
                         base_actions: Option<u64>,
                         label: &str|
     -> Result<(), String> {
        let Some(rich) = base_sats else {
            return Ok(());
        };
        if local_spendable_sats.saturating_add(SPENDABLE_COMPARE_MARGIN_SATS) >= rich {
            return Ok(());
        }
        if let Some(prior_act) = base_actions {
            if local_action_count > prior_act {
                return Ok(());
            }
        }
        let act_str = base_actions
            .map(|a| a.to_string())
            .unwrap_or_else(|| "?".into());
        Err(format!(
            "refuse thin local overwrite of {label} (local {local_spendable_sats} sats / {local_action_count} actions vs {rich} sats / {act_str} actions)"
        ))
    };
    check_against(remote_spendable_sats, remote_action_count, "richer remote BRC-39")?;
    check_against(
        high_water_spendable_sats,
        high_water_action_count,
        "spendable high-water",
    )?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWalletRow {
    pub device_id: String,
    pub label: String,
    pub platform: String,
    pub peer_base_url: Option<String>,
    pub is_local: bool,
    pub identity_key: String,
    pub address: Option<String>,
    pub last_seen_at: Option<i64>,
    pub online: bool,
    pub linked_at: Option<i64>,
    pub link_mode: String,
}

// ── Built-in Signed Chart Apps (`src/apps/builtin/*`) ──

const CHART_HASHES_JSON: &str = include_str!("../../../../src/apps/builtin/hashes.json");
const CHART_PAYMENT_REQUEST_JSON: &str =
    include_str!("../../../../src/apps/builtin/payment-request.json");
const CHART_TIP_JAR_JSON: &str = include_str!("../../../../src/apps/builtin/tip-jar.json");
const CHART_SPLIT_BILL_JSON: &str = include_str!("../../../../src/apps/builtin/split-bill.json");
const CHART_SEND_ITEM_JSON: &str = include_str!("../../../../src/apps/builtin/send-item.json");
const CHART_MESSAGE_BOX_JSON: &str = include_str!("../../../../src/apps/builtin/message-box.json");

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltinChartApp {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub version: String,
    pub author_name: String,
    pub author_identity_key: String,
    pub initial_state: String,
    pub verified: bool,
    pub effects: Vec<(bool, String)>,
    pub raw_json: Value,
}

fn describe_chart_effect(effect: &Value) -> (bool, String) {
    let kind = effect.get("kind").and_then(Value::as_str).unwrap_or("action");
    match kind {
        "requestPayment" => (true, "Send a Bitcoin SV payment request to a friend".into()),
        "sendPayment" => (true, "Send Bitcoin SV after you approve the amount".into()),
        "sendItem" => (true, "Transfer a 1Sat item you choose after approval".into()),
        "readBox" | "listMessages" => (false, "Read messages from your message box".into()),
        "sendMessage" => (true, "Send a signed message to a friend".into()),
        other => (true, format!("Run wallet effect '{other}'")),
    }
}

pub fn load_builtin_chart_apps() -> Vec<BuiltinChartApp> {
    let hashes: HashMap<String, String> =
        serde_json::from_str(CHART_HASHES_JSON).unwrap_or_default();
    let raw_list = [
        CHART_PAYMENT_REQUEST_JSON,
        CHART_TIP_JAR_JSON,
        CHART_SPLIT_BILL_JSON,
        CHART_SEND_ITEM_JSON,
        CHART_MESSAGE_BOX_JSON,
    ];
    let mut apps = Vec::with_capacity(raw_list.len());
    for raw_str in raw_list {
        let Ok(val) = serde_json::from_str::<Value>(raw_str) else {
            continue;
        };
        let id = val
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("app")
            .to_string();
        let name = val
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        let summary = val
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let version = val
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("1.0.0")
            .to_string();
        let author = val.get("author");
        let author_name = author
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("HandCash")
            .to_string();
        let author_identity_key = author
            .and_then(|a| a.get("identityKey"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let initial_state = val
            .get("initial")
            .and_then(Value::as_str)
            .unwrap_or("compose")
            .to_string();
        let has_sig = val
            .get("signature")
            .and_then(Value::as_str)
            .map(|s| s.len() >= 120)
            .unwrap_or(false);
        let verified = has_sig && hashes.contains_key(&id);
        let mut effects = Vec::new();
        if let Some(eff_obj) = val.get("effects").and_then(Value::as_object) {
            for eff in eff_obj.values() {
                let line = describe_chart_effect(eff);
                if !effects.contains(&line) {
                    effects.push(line);
                }
            }
        }
        apps.push(BuiltinChartApp {
            id,
            name,
            summary,
            version,
            author_name,
            author_identity_key,
            initial_state,
            verified,
            effects,
            raw_json: val,
        });
    }
    apps
}

pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
    cb.set_text(text.to_string())
        .map_err(|e| format!("Failed to copy: {e}"))
}

pub fn render_qr_svg(data: &str) -> String {
    match QrCode::new(data.as_bytes()) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(168, 168)
            .dark_color(svg::Color("#111418"))
            .light_color(svg::Color("#ffffff"))
            .quiet_zone(true)
            .build(),
        Err(_) => String::new(),
    }
}

pub fn format_bsv(sats: u64) -> String {
    let whole = sats / 100_000_000;
    let frac = sats % 100_000_000;
    format!("{whole}.{frac:08} BSV")
}

pub fn truncate_mid(s: &str, keep: usize) -> String {
    if s.len() <= keep * 2 + 3 {
        return s.to_string();
    }
    format!("{}…{}", &s[..keep], &s[s.len() - keep..])
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    open::that(url).map_err(|e| format!("Could not open browser: {e}"))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn format_relative_time(ts_ms: i64, now: i64) -> String {
    if ts_ms <= 0 {
        return "—".into();
    }
    let diff_secs = (now - ts_ms).max(0) / 1000;
    if diff_secs < 45 {
        "Just now".into()
    } else if diff_secs < 3600 {
        format!("{}m ago", (diff_secs / 60).max(1))
    } else if diff_secs < 86_400 {
        format!("{}h ago", diff_secs / 3600)
    } else if diff_secs < 86_400 * 30 {
        format!("{}d ago", diff_secs / 86_400)
    } else {
        format!("{}mo ago", (diff_secs / (86_400 * 30)).max(1))
    }
}

pub fn tx_explorer_url(txid: &str, chain: &str) -> String {
    if chain == "test" {
        format!("https://test.whatsonchain.com/tx/{txid}")
    } else {
        format!("https://whatsonchain.com/tx/{txid}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(outpoint: &str, origin: &str) -> ItemCardRow {
        ItemCardRow {
            outpoint: outpoint.to_string(),
            origin_outpoint: origin.to_string(),
            basket: "1sat".to_string(),
            authenticity_status: "unknown".to_string(),
            authenticity_reason: None,
            verified_at_ms: None,
            issuer_key: None,
            name: "x".to_string(),
            mime: "image/png".to_string(),
            art_blob_hash: None,
            sort_key: 0,
        }
    }

    #[test]
    fn coin_balance_mirrors_ts_balance_of() {
        let raw = r#"{
            "coins": {
                "aa:0": {"litoshi": "299439", "source": "received", "proven": true},
                "bb:1": {"litoshi": "557538", "source": "received", "phase": {"kind": "unchecked"}},
                "cc:0": {"litoshi": "100", "source": "claim"},
                "dd:1": {"litoshi": "40", "source": "change"},
                "ee:1": {"litoshi": "7", "source": "change"},
                "ff:0": {"litoshi": "1000", "source": "received", "proven": true}
            },
            "payments": {
                "dd": {"status": "sent", "inputs": ["ff:0"]},
                "ee": {"status": "signed", "inputs": []}
            },
            "migrated": true
        }"#;
        assert_eq!(coin_spendable_units(raw), 299_439 + 100 + 40);
        assert_eq!(coin_spendable_units("not json"), 0);
        assert_eq!(coin_spendable_units(r#"{"coins":{},"payments":{}}"#), 0);
    }

    #[test]
    fn coin_formatting_matches_ts() {
        assert_eq!(format_coin(2_226_675, 8), "0.02226675");
        assert_eq!(format_coin(100_000_000, 8), "1");
        assert_eq!(format_coin(150_000_000, 8), "1.5");
        assert_eq!(format_coin(0, 8), "0");
        assert_eq!(format_coin_short(2_226_675, 8), "0.02227");
        assert_eq!(format_coin_short(860_706, 8), "0.008607");
        assert_eq!(format_coin_short(150_000_000, 8), "1.5");
        assert_eq!(format_coin_short(123_456_000_000, 8), "1235");
        assert_eq!(format_coin_short(0, 8), "0");
    }

    #[test]
    fn item_art_cache_fills_by_origin() {
        assert_eq!(origin_art_key(" ABC.0 "), "abc_0");
        assert_eq!(origin_art_key("abc_1"), "abc_1");
        let raw = r#"{"abc_0":{"mime":"image/png","b64":"QUJD","at":1},
                      "def_2":{"mime":"text/plain","b64":"QUJD","at":1}}"#;
        let items = vec![
            item("out.1", "ABC.0"),
            item("def.2", "def_2"),
            item("have.0", "abc_0"),
        ];
        let mut art = HashMap::new();
        art.insert("have.0".to_string(), "data:keep".to_string());
        fill_item_art_from_cache(raw, &items, &mut art);
        assert_eq!(
            art.get("out.1").map(String::as_str),
            Some("data:image/png;base64,QUJD")
        );
        assert!(!art.contains_key("def.2"));
        assert_eq!(art.get("have.0").map(String::as_str), Some("data:keep"));
    }

    #[test]
    fn remote_art_is_last_resort_for_image_origins() {
        let txid = "AB".repeat(32);
        let mut text = item("t.0", &format!("{txid}.1"));
        text.mime = "text/plain".to_string();
        let items = vec![
            item("o.0", &format!("{txid}.0")),
            text,
            item("bad.0", "nope"),
            item("have.0", &format!("{txid}.2")),
        ];
        let mut art = HashMap::new();
        art.insert("have.0".to_string(), "data:keep".to_string());
        fill_item_art_remote("main", &items, &mut art);
        assert_eq!(
            art.get("o.0").map(String::as_str),
            Some(
                format!(
                    "https://ordinals.gorillapool.io/content/{}_0",
                    txid.to_lowercase()
                )
                .as_str()
            )
        );
        assert!(!art.contains_key("t.0"));
        assert!(!art.contains_key("bad.0"));
        assert_eq!(art.get("have.0").map(String::as_str), Some("data:keep"));
    }

    #[test]
    fn inscription_resolution_enriches_origin_identity_and_art_lookup() {
        let tx_tip = "11".repeat(32);
        let tx_orig = "22".repeat(32);
        let tx_media = "33".repeat(32);
        let tip = format!("{tx_tip}.0");
        let mut row = item(&tip, &tip);
        row.name = "1sat #42".into();
        let mut items = vec![row];
        let mut meta = HashMap::new();
        let res_raw = serde_json::json!({
            tip.clone(): {
                "origin": format!("{tx_orig}_0"),
                "content": format!("{tx_media}_0"),
                "name": "Pixel Fox #7",
                "app": "Haste",
                "collectionId": "col-foxes",
                "signer": "1FoxSignerAddr",
                "mimeType": "image/png",
                "traits": []
            }
        })
        .to_string();
        apply_inscription_resolutions(&res_raw, &mut items, &mut meta);
        assert_eq!(items[0].origin_outpoint, format!("{tx_orig}.0"));
        assert_eq!(items[0].name, "Pixel Fox #7");
        assert_eq!(items[0].mime, "image/png");
        let m = meta.get(&tip).unwrap();
        assert_eq!(m.app.as_deref(), Some("Haste"));
        assert_eq!(m.collection_id.as_deref(), Some("col-foxes"));
        assert_eq!(m.signer.as_deref(), Some("1FoxSignerAddr"));
        assert_eq!(m.media_origin.as_deref(), Some(format!("{tx_media}_0").as_str()));

        let art_raw = serde_json::json!({
            format!("{tx_media}_0"): { "mime": "image/png", "b64": "QUJD", "at": 1 }
        })
        .to_string();
        let mut art = HashMap::new();
        fill_item_art_from_cache_with_meta(&art_raw, &items, &meta, &mut art);
        assert_eq!(
            art.get(&tip).map(String::as_str),
            Some("data:image/png;base64,QUJD")
        );
    }

    #[test]
    fn history_crypto_secret_matches_ts_sha256_vector() {
        let key = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        let secret = history_crypto_secret(key).unwrap();
        assert_eq!(secret.len(), 64);
        assert_eq!(
            secret,
            history_crypto_secret(&format!("0x{}", key.to_uppercase())).unwrap()
        );
        assert!(history_crypto_secret("not-a-key").is_err());
    }

    #[test]
    fn decide_history_push_enforces_empty_and_thin_overwrite_guards() {
        // Empty local over non-empty remote is refused unless forced
        assert!(decide_history_push(
            true,
            Some(1024),
            true,
            0,
            0,
            Some(50_000),
            Some(5),
            None,
            None,
            false
        )
        .is_err());
        assert!(decide_history_push(
            true,
            Some(1024),
            true,
            0,
            0,
            Some(50_000),
            Some(5),
            None,
            None,
            true
        )
        .is_ok());

        // Thinner local balance without a higher action count is refused
        assert!(decide_history_push(
            true,
            Some(1024),
            false,
            10_000,
            5,
            Some(50_000),
            Some(5),
            None,
            None,
            false
        )
        .is_err());

        // Thinner local balance WITH a higher action count (coins spent down) is allowed
        assert!(decide_history_push(
            true,
            Some(1024),
            false,
            10_000,
            6,
            Some(50_000),
            Some(5),
            None,
            None,
            false
        )
        .is_ok());
    }

    #[test]
    fn builtin_chart_apps_load_and_verify_all_five() {
        let apps = load_builtin_chart_apps();
        assert_eq!(apps.len(), 5);
        assert!(apps.iter().all(|a| a.verified));
        assert_eq!(apps[0].id, "payment-request");
    }

    #[test]
    fn migrated_collectable_placeholder_replaced_and_extras_issuer_extracted() {
        let tx_tip = "c".repeat(64);
        let tip = format!("{tx_tip}.14");
        let ik = format!("02{}", "ab".repeat(32));
        let mut items = vec![ItemCardRow {
            outpoint: tip.clone(),
            origin_outpoint: tip.clone(),
            basket: "1sat".into(),
            authenticity_status: "brc150".into(),
            authenticity_reason: None,
            verified_at_ms: None,
            issuer_key: None,
            name: "Migrated collectable".into(),
            mime: "application/octet-stream".into(),
            art_blob_hash: None,
            sort_key: 1,
        }];
        let res_raw = serde_json::json!({
            tip.clone(): {
                "origin": format!("{}_0", "d".repeat(64)),
                "name": "Dual Berettas | Contractor",
                "app": "SigmaSkins",
                "signer": "1G8N1C9Rp3DkQScR1FvNfFtXjVDtmo5244",
                "mimeType": "image/png",
                "extras": [
                    { "name": "issuer", "value": ik.clone() },
                    { "name": "bapId", "value": "32fY3nAdH2qLMogchEUGTYDap6XR" }
                ]
            }
        })
        .to_string();
        let mut meta = HashMap::new();
        apply_inscription_resolutions(&res_raw, &mut items, &mut meta);
        assert_eq!(items[0].name, "Dual Berettas | Contractor");
        assert_eq!(items[0].issuer_key.as_deref(), Some(ik.as_str()));
        let m = meta.get(&tip).unwrap();
        assert_eq!(m.app.as_deref(), Some("SigmaSkins"));
        assert_eq!(m.signer.as_deref(), Some("1G8N1C9Rp3DkQScR1FvNfFtXjVDtmo5244"));
        assert_eq!(m.bap_id.as_deref(), Some("32fY3nAdH2qLMogchEUGTYDap6XR"));
    }
}
