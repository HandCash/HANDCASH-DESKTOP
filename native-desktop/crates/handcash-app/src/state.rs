// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Application services and wallet session state for `handcash-native`.

use crate::machines::{CollectionView, FiatCode};
use crate::theme::{read_resolved_theme, AppearancePreference, ResolvedTheme};
use base64::Engine as _;
use handcash_bitcoin::ord::parse_ord_envelope;
use handcash_bitcoin::signer::{address_to_locking_script, estimate_p2pkh_fee};
use handcash_bitcoin::beef::Beef;
use handcash_bitcoin::recover::{find_recoverable_outputs, parse_recover_txid, RecoverableOutput};
use handcash_bitcoin::tx::{Transaction, TxOutput};
use handcash_engine::WalletEngine;
use handcash_primitives::keys::{KeyDeriver, MnemonicScheme};
use handcash_primitives::vault::{
    change_vault_password, create_new_vault, generate_wrap_secret, restore_vault_from_mnemonic,
    restore_vault_from_root_key, unlock_vault_with_password, UnlockedVault, VaultRecord,
    VAULT_STORAGE_KEY,
};
use handcash_shell::brc100_server::Brc100Bridge;
use handcash_shell::durable::DurableStore;
use handcash_shell::host_log::HostLog;
use handcash_shell::{omarchy_theme, paths};
use handcash_storage::{ActivityRow, BalanceBreakdown, ItemCardRow, ToolboxDbManager};
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
pub const BACKUP_DEFERRED_KEY: &str = "handcash.brc100.backupDeferred";
pub const BACKUP_FORMATS_SAVED_KEY: &str = "handcash.backup.formatsSaved.v1";
pub const APPEARANCE_STORAGE_KEY: &str = "handcash.appearance";
pub const FIAT_CURRENCY_STORAGE_KEY: &str = "handcash.brc100.fiatCurrency";
pub const BSV_USD_STORAGE_KEY: &str = "handcash.brc100.bsvUsd";
pub const APP_ACTIVITY_STORAGE_KEY: &str = "handcash.brc100.appActivity";
pub const COLLECTABLE_PROVEN_V2_KEY: &str = "handcash.collectables.proven.v2";
pub const COLLECTABLE_PROVEN_V1_KEY: &str = "handcash.collectables.proven.v1";
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalletSnapshot {
    pub balance: BalanceSummary,
    pub items: Vec<ItemCardRow>,
    pub items_total: u64,
    pub item_art: HashMap<String, String>,
    pub activity: Vec<ActivityRow>,
    pub activity_total: u64,
    pub bridge_online: bool,
    pub bridge_http_url: String,
    pub bridge_https_url: String,
    pub engine_phase: u64,
    pub engine_generation: u64,
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
    pub host_log: Arc<HostLog>,
    pub session: Mutex<Option<ActiveSession>>,
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
            host_log,
            session: Mutex::new(None),
            patch_tx,
            theme_tx,
            fx_tx,
            health_tx,
        });
        crate::brc100_native::install_direct_handler(&services);
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
    pub async fn refresh_dependency_health_async(self: Arc<Self>) -> crate::health::DependencyHealthSnapshot {
        let probes = crate::health::run_probes().await;
        let summary = crate::health::summarize(&probes);
        self.host_log
            .append("info", "dependency-health", &summary);
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

        // 1. Read `handcash.publicIdentities.v1` (scoped or unscoped).
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
                if let Some(err) = handcash_primitives::vault::password_policy_error(user_password) {
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
            .hydrate_input_txids(&summary.account_id, summary.generation, vec![txid.clone()], true)
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
                tb.read_wallet_snapshot(100, 100)
            {
                // Decode 1Sat inscription artwork & MAP metadata from `cold_blobs` (bounded).
                let mut item_art = HashMap::new();
                for item in &mut items {
                    if let Some(ref hash) = item.art_blob_hash {
                        if let Some(script_bytes) = tb.read_cold_blob(hash) {
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
                }
                snap.balance = bal.into();
                snap.items = items;
                snap.items_total = items_total;
                snap.item_art = item_art;
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

        // 3. Upgrade item authenticity strictly from local BRC-150 proven cache.
        self.apply_proven_collectables(&summary.chain, &mut snap.items);

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

    fn apply_proven_collectables(&self, chain: &str, items: &mut [ItemCardRow]) {
        if items.is_empty() {
            return;
        }
        let mut proven_origins: HashSet<String> = HashSet::new();
        for base in [COLLECTABLE_PROVEN_V2_KEY, COLLECTABLE_PROVEN_V1_KEY] {
            for key in [format!("{base}:{chain}"), base.to_string()] {
                if let Some(raw) = self.durable.get(&key) {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                        if let Some(obj) = v.as_object() {
                            for (k, val) in obj {
                                // Only count entries with proven/brc150 marker or non-null proof object.
                                let ok = val.is_object() || val.as_bool() == Some(true);
                                if ok {
                                    proven_origins.insert(k.replace('_', "."));
                                }
                            }
                        } else if let Some(arr) = v.as_array() {
                            for el in arr {
                                if let Some(s) = el.as_str() {
                                    proven_origins.insert(s.replace('_', "."));
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
            let norm_origin = item.origin_outpoint.replace('_', ".");
            let norm_out = item.outpoint.replace('_', ".");
            if proven_origins.contains(&norm_origin) || proven_origins.contains(&norm_out) {
                item.authenticity_status = "brc150".into();
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
