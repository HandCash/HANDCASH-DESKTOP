// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Executable Rust statecharts mirroring `src/machines/appMachine.ts`,
//! `src/machines/unlockMachine.ts`, `src/machines/walletStatusMachine.ts`, and `src/wallet/navStore.ts`.

use crate::state::SessionSummary;

/// Mirrors `src/machines/appMachine.ts` (`boot -> onboarding | locked | ready | failure`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppSessionState {
    Boot,
    Onboarding,
    Locked,
    Ready,
    Failure,
}

impl AppSessionState {
    pub const fn as_attr(&self) -> &'static str {
        match self {
            Self::Boot => "boot",
            Self::Onboarding => "onboarding",
            Self::Locked => "locked",
            Self::Ready => "ready",
            Self::Failure => "failure",
        }
    }
}

#[derive(Clone, Debug)]
pub struct AppSessionMachine {
    pub state: AppSessionState,
    pub profile: Option<SessionSummary>,
    pub balance_sats: u64,
    pub bridge_online: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub enum AppSessionEvent {
    Bootstrapped {
        has_vault: bool,
    },
    Unlocked {
        profile: SessionSummary,
        balance_sats: u64,
    },
    Created {
        profile: SessionSummary,
        balance_sats: u64,
    },
    Switched {
        profile: SessionSummary,
        balance_sats: u64,
    },
    Lock,
    Refreshed {
        balance_sats: u64,
    },
    Bridge {
        online: bool,
    },
    Fail {
        error: String,
    },
    ClearError,
}

impl AppSessionMachine {
    pub fn new(
        has_vault: bool,
        initial_profile: Option<SessionSummary>,
        balance_sats: u64,
        bridge_online: bool,
    ) -> Self {
        let state = if initial_profile.is_some() {
            AppSessionState::Ready
        } else if has_vault {
            AppSessionState::Locked
        } else {
            AppSessionState::Onboarding
        };
        Self {
            state,
            profile: initial_profile,
            balance_sats,
            bridge_online,
            error: None,
        }
    }

    pub fn send(&mut self, event: AppSessionEvent) {
        match event {
            AppSessionEvent::Bridge { online } => {
                self.bridge_online = online;
            }
            AppSessionEvent::Bootstrapped { has_vault } => {
                if self.state == AppSessionState::Boot {
                    self.state = if has_vault {
                        AppSessionState::Locked
                    } else {
                        AppSessionState::Onboarding
                    };
                    self.error = None;
                }
            }
            AppSessionEvent::Unlocked {
                profile,
                balance_sats,
            }
            | AppSessionEvent::Created {
                profile,
                balance_sats,
            }
            | AppSessionEvent::Switched {
                profile,
                balance_sats,
            } => {
                self.profile = Some(profile);
                self.balance_sats = balance_sats;
                self.error = None;
                self.state = AppSessionState::Ready;
            }
            AppSessionEvent::Lock => {
                if self.state == AppSessionState::Ready {
                    self.profile = None;
                    self.balance_sats = 0;
                    self.error = None;
                    self.state = AppSessionState::Locked;
                }
            }
            AppSessionEvent::Refreshed { balance_sats } => {
                if self.state == AppSessionState::Ready {
                    self.balance_sats = balance_sats;
                }
            }
            AppSessionEvent::Fail { error } => {
                self.error = Some(error);
                if self.state == AppSessionState::Boot {
                    self.state = AppSessionState::Failure;
                }
            }
            AppSessionEvent::ClearError => {
                self.error = None;
            }
        }
    }
}

/// Mirrors `src/machines/unlockMachine.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnlockState {
    Idle,
    Opening,
    Failed,
    Success,
}

impl UnlockState {
    pub const fn as_attr(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Opening => "opening",
            Self::Failed => "failed",
            Self::Success => "success",
        }
    }
}

/// Mirrors `src/components/auth/authModes.ts` (`entry | unlock | create | signin | phrase | shares | key`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthFormMode {
    Entry,
    Signin,
    Unlock,
    Create,
    Phrase,
    Shares,
    Key,
}

impl AuthFormMode {
    pub const RESTORE_METHODS: [(Self, &'static str); 3] = [
        (Self::Phrase, "Phrase"),
        (Self::Shares, "Key slices"),
        (Self::Key, "Emergency key"),
    ];

    pub const fn is_restore_method(self) -> bool {
        matches!(self, Self::Phrase | Self::Shares | Self::Key)
    }
}

/// Mirrors `RestoreRole` in `src/components/AuthScreen.tsx`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RestoreRole {
    #[default]
    Replace,
    Keep,
}

impl RestoreRole {
    pub const ALL: [(Self, &'static str, &'static str); 2] = [
        (
            Self::Replace,
            "Replace old device",
            "This device takes over every wallet. Your old device stops spending them when it next connects.",
        ),
        (
            Self::Keep,
            "Keep both",
            "Your other device keeps its wallets and this one gets a new wallet. Move a wallet between them from the wallet menu.",
        ),
    ];
}

/// Mirrors `OnboardStep` in `src/wallet/onboardSteps.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnboardStep {
    KeysBackup,
    History,
    Accept,
    Fiat,
    Protect,
}

/// Mirrors `src/machines/walletStatusMachine.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusTone {
    Ok,
    Busy,
    Warn,
    Error,
    Muted,
}

impl StatusTone {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Busy => "busy",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Muted => "muted",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletStatusView {
    pub state_attr: &'static str,
    pub label: &'static str,
    pub tone: StatusTone,
    pub detail: &'static str,
}

pub fn resolve_wallet_status(
    session: &AppSessionState,
    bridge_online: bool,
    syncing: bool,
) -> WalletStatusView {
    match session {
        AppSessionState::Boot => WalletStatusView {
            state_attr: "opening",
            label: "Opening",
            tone: StatusTone::Busy,
            detail: "Starting HandCash",
        },
        AppSessionState::Failure => WalletStatusView {
            state_attr: "failed",
            label: "Failed",
            tone: StatusTone::Error,
            detail: "App hit an error — retry",
        },
        AppSessionState::Onboarding => WalletStatusView {
            state_attr: "setup",
            label: "Setup",
            tone: StatusTone::Muted,
            detail: "Create or restore a wallet",
        },
        AppSessionState::Locked => WalletStatusView {
            state_attr: "locked",
            label: "Locked",
            tone: StatusTone::Muted,
            detail: "Unlock to spend or connect apps",
        },
        AppSessionState::Ready => {
            if syncing {
                WalletStatusView {
                    state_attr: "refreshing",
                    label: "Syncing",
                    tone: StatusTone::Busy,
                    detail: "Refreshing funds and history against the network",
                }
            } else if bridge_online {
                WalletStatusView {
                    state_attr: "synced",
                    label: "Synced",
                    tone: StatusTone::Ok,
                    detail: "Chain OK — BRC-100 bridge online — tap to refresh",
                }
            } else {
                WalletStatusView {
                    state_attr: "bridge-off",
                    label: "Bridge off",
                    tone: StatusTone::Warn,
                    detail: "Local BRC-100 bridge is not listening — tap to refresh",
                }
            }
        }
    }
}

/// Mirrors `src/wallet/navStore.ts` sections and child flows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavSection {
    Activity,
    Apps,
    Collectables,
    Friends,
    Identity,
    Settings,
}

impl NavSection {
    pub const ALL: [Self; 6] = [
        Self::Activity,
        Self::Apps,
        Self::Collectables,
        Self::Friends,
        Self::Identity,
        Self::Settings,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Activity => "Activity",
            Self::Apps => "Connect",
            Self::Collectables => "Collect",
            Self::Friends => "Friends",
            Self::Identity => "Identity",
            Self::Settings => "Settings",
        }
    }

    pub const fn short_label(self) -> &'static str {
        match self {
            Self::Activity => "Activity",
            Self::Apps => "Connect",
            Self::Collectables => "Collect",
            Self::Friends => "Friends",
            Self::Identity => "ID",
            Self::Settings => "Set",
        }
    }

    pub const fn as_attr(self) -> &'static str {
        match self {
            Self::Activity => "activity",
            Self::Apps => "apps",
            Self::Collectables => "collectables",
            Self::Friends => "friends",
            Self::Identity => "identity",
            Self::Settings => "settings",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingSubpage {
    HandCashRecovery,
    Backup,
    HistoryBackup,
    DeviceHandoff,
    SigninEmail,
    Import,
    Unlock,
    WipeWallet,
    WalletHealth,
    RecoverTx,
    Logs,
    ChartApps,
    Labs,
    About,
    Statecharts,
}

impl SettingSubpage {
    /// 1:1 port of `settingLabel` in `src/components/settings/settingLabel.ts`.
    pub const fn label(self) -> &'static str {
        match self {
            Self::HandCashRecovery => "HandCash Recovery",
            Self::Backup => "Recovery backup",
            Self::HistoryBackup => "History",
            Self::DeviceHandoff => "Device backup",
            Self::SigninEmail => "Sign-in email",
            Self::Import => "Import",
            Self::Unlock => "Unlock",
            Self::WipeWallet => "Wipe wallet",
            Self::WalletHealth => "Wallet health",
            Self::RecoverTx => "Recover from transaction",
            Self::Logs => "Session logs",
            Self::ChartApps => "Apps",
            Self::Labs => "Labs",
            Self::About => "HandCash",
            Self::Statecharts => "Statecharts",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NavChild {
    Send(Option<String>),
    Receive,
    Swap,
    Scan,
    PaymentDetails(String),
    CollectableDetails(String),
    SendCollectable(String),
    BurnAsset(String),
    AddFriend,
    FriendDetails(String),
    AppDetails(String),
    Setting(SettingSubpage),
}

impl NavChild {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Send(_) => "Send",
            Self::Receive => "Receive",
            Self::Swap => "Swap",
            Self::Scan => "Scan",
            Self::PaymentDetails(_) => "Details",
            Self::CollectableDetails(_) => "Item",
            Self::SendCollectable(_) => "Send item",
            Self::BurnAsset(_) => "Burn",
            Self::AddFriend => "Add friend",
            Self::FriendDetails(_) => "Friend",
            Self::AppDetails(_) => "App",
            Self::Setting(sub) => sub.label(),
        }
    }
}

/// Mirrors `src/wallet/collectionView.ts` (`list` | `grid`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CollectionView {
    #[default]
    Grid,
    List,
}

impl CollectionView {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Grid => "grid",
            Self::List => "list",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "list" => Self::List,
            _ => Self::Grid,
        }
    }
}

/// Mirrors `src/wallet/fiatCurrency.ts` (`FIAT_OPTIONS`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FiatCode {
    #[default]
    Usd,
    Eur,
    Gbp,
    Jpy,
    Cad,
    Aud,
    Chf,
    Cny,
    Inr,
    Brl,
    Mxn,
    Krw,
}

impl FiatCode {
    pub const ALL: [Self; 12] = [
        Self::Usd,
        Self::Eur,
        Self::Gbp,
        Self::Jpy,
        Self::Cad,
        Self::Aud,
        Self::Chf,
        Self::Cny,
        Self::Inr,
        Self::Brl,
        Self::Mxn,
        Self::Krw,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Usd => "usd",
            Self::Eur => "eur",
            Self::Gbp => "gbp",
            Self::Jpy => "jpy",
            Self::Cad => "cad",
            Self::Aud => "aud",
            Self::Chf => "chf",
            Self::Cny => "cny",
            Self::Inr => "inr",
            Self::Brl => "brl",
            Self::Mxn => "mxn",
            Self::Krw => "krw",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "usd" => Some(Self::Usd),
            "eur" => Some(Self::Eur),
            "gbp" => Some(Self::Gbp),
            "jpy" => Some(Self::Jpy),
            "cad" => Some(Self::Cad),
            "aud" => Some(Self::Aud),
            "chf" => Some(Self::Chf),
            "cny" => Some(Self::Cny),
            "inr" => Some(Self::Inr),
            "brl" => Some(Self::Brl),
            "mxn" => Some(Self::Mxn),
            "krw" => Some(Self::Krw),
            _ => None,
        }
    }

    pub const fn iso(self) -> &'static str {
        match self {
            Self::Usd => "USD",
            Self::Eur => "EUR",
            Self::Gbp => "GBP",
            Self::Jpy => "JPY",
            Self::Cad => "CAD",
            Self::Aud => "AUD",
            Self::Chf => "CHF",
            Self::Cny => "CNY",
            Self::Inr => "INR",
            Self::Brl => "BRL",
            Self::Mxn => "MXN",
            Self::Krw => "KRW",
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::Usd => "US Dollar",
            Self::Eur => "Euro",
            Self::Gbp => "British Pound",
            Self::Jpy => "Japanese Yen",
            Self::Cad => "Canadian Dollar",
            Self::Aud => "Australian Dollar",
            Self::Chf => "Swiss Franc",
            Self::Cny => "Chinese Yuan",
            Self::Inr => "Indian Rupee",
            Self::Brl => "Brazilian Real",
            Self::Mxn => "Mexican Peso",
            Self::Krw => "Korean Won",
        }
    }

    pub const fn flag(self) -> &'static str {
        match self {
            Self::Usd => "🇺🇸",
            Self::Eur => "🇪🇺",
            Self::Gbp => "🇬🇧",
            Self::Jpy => "🇯🇵",
            Self::Cad => "🇨🇦",
            Self::Aud => "🇦🇺",
            Self::Chf => "🇨🇭",
            Self::Cny => "🇨🇳",
            Self::Inr => "🇮🇳",
            Self::Brl => "🇧🇷",
            Self::Mxn => "🇲🇽",
            Self::Krw => "🇰🇷",
        }
    }

    pub const fn symbol(self) -> &'static str {
        match self {
            Self::Usd | Self::Cad | Self::Aud | Self::Mxn => "$",
            Self::Eur => "€",
            Self::Gbp => "£",
            Self::Jpy | Self::Cny => "¥",
            Self::Chf => "CHF ",
            Self::Inr => "₹",
            Self::Brl => "R$",
            Self::Krw => "₩",
        }
    }
}

/// Mirrors `src/machines/sendMachine.ts` stages.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendStage {
    EditingDestination,
    EditingAmount,
    Confirming,
    Failure(String),
}

impl SendStage {
    pub fn as_attr(&self) -> &'static str {
        match self {
            Self::EditingDestination => "editing.destination",
            Self::EditingAmount => "editing.amount",
            Self::Confirming => "confirming",
            Self::Failure(_) => "failure",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SendUnit {
    #[default]
    Bsv,
    Sats,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecipientKind {
    P2pkhAddress(String),
    PeerPay { identity_key: String },
    IdentityKey(String),
    Handle(String),
}

impl RecipientKind {
    pub fn display_label(&self) -> String {
        match self {
            Self::P2pkhAddress(a) => crate::state::truncate_mid(a, 10),
            Self::PeerPay { identity_key } | Self::IdentityKey(identity_key) => {
                crate::state::truncate_mid(identity_key, 10)
            }
            Self::Handle(h) => format!("${h}"),
        }
    }

    pub fn raw_value(&self) -> String {
        match self {
            Self::P2pkhAddress(a) => a.clone(),
            Self::PeerPay { identity_key } => format!("peerpay:{identity_key}"),
            Self::IdentityKey(k) => k.clone(),
            Self::Handle(h) => format!("${h}"),
        }
    }
}

/// Classify a send recipient input (P2PKH address, `peerpay:` URI, 66-hex compressed pubkey, or `$handle`).
pub fn classify_recipient(raw: &str) -> Option<RecipientKind> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("peerpay:") {
        let key = rest.split(['?', '#']).next().unwrap_or("").trim();
        if is_compressed_pubkey_hex(key) {
            return Some(RecipientKind::PeerPay {
                identity_key: key.to_ascii_lowercase(),
            });
        }
        return None;
    }
    if is_compressed_pubkey_hex(trimmed) {
        return Some(RecipientKind::IdentityKey(trimmed.to_ascii_lowercase()));
    }
    if let Some(handle) = trimmed.strip_prefix('$') {
        let clean = handle.trim();
        if clean.len() >= 2
            && clean.len() <= 32
            && clean
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        {
            return Some(RecipientKind::Handle(clean.to_ascii_lowercase()));
        }
        return None;
    }
    if handcash_primitives::keys::decode_p2pkh_address(trimmed).is_ok() {
        return Some(RecipientKind::P2pkhAddress(trimmed.to_string()));
    }
    None
}

fn is_compressed_pubkey_hex(s: &str) -> bool {
    s.len() == 66
        && (s.starts_with("02") || s.starts_with("03"))
        && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Mirrors `src/wallet/paymentFilters.ts`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PaymentKindFilter {
    #[default]
    All,
    Spent,
    Earned,
    Event,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PaymentStatusFilter {
    #[default]
    All,
    Success,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PaymentTimeFilter {
    #[default]
    All,
    H24,
    D7,
    D30,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PaymentFilters {
    pub kind: PaymentKindFilter,
    pub status: PaymentStatusFilter,
    pub time: PaymentTimeFilter,
    pub origin: Option<String>,
}

impl PaymentFilters {
    pub fn active_count(&self) -> usize {
        let mut n = 0;
        if self.kind != PaymentKindFilter::All {
            n += 1;
        }
        if self.status != PaymentStatusFilter::All {
            n += 1;
        }
        if self.time != PaymentTimeFilter::All {
            n += 1;
        }
        if self.origin.is_some() {
            n += 1;
        }
        n
    }

    pub fn matches(&self, row: &handcash_storage::ActivityRow, now_ms: i64) -> bool {
        let dir = row.direction.to_ascii_lowercase();
        let kind = row.kind.to_ascii_lowercase();
        let status = row.status.to_ascii_lowercase();

        let kind_ok = match self.kind {
            PaymentKindFilter::All => true,
            PaymentKindFilter::Spent => {
                dir == "out" || dir == "outgoing" || dir == "spent" || row.satoshis < 0
            }
            PaymentKindFilter::Earned => {
                dir == "in" || dir == "incoming" || dir == "earned" || row.satoshis > 0
            }
            PaymentKindFilter::Event => {
                kind == "event"
                    || (row.satoshis == 0
                        && dir != "out"
                        && dir != "outgoing"
                        && dir != "in"
                        && dir != "incoming")
            }
        };
        if !kind_ok {
            return false;
        }

        let is_failed =
            status.contains("fail") || status.contains("error") || status.contains("reject");
        let status_ok = match self.status {
            PaymentStatusFilter::All => true,
            PaymentStatusFilter::Success => !is_failed,
            PaymentStatusFilter::Failed => is_failed,
        };
        if !status_ok {
            return false;
        }

        let time_ok = match self.time {
            PaymentTimeFilter::All => true,
            PaymentTimeFilter::H24 => now_ms.saturating_sub(row.sort_ts_ms) <= 24 * 60 * 60 * 1000,
            PaymentTimeFilter::D7 => {
                now_ms.saturating_sub(row.sort_ts_ms) <= 7 * 24 * 60 * 60 * 1000
            }
            PaymentTimeFilter::D30 => {
                now_ms.saturating_sub(row.sort_ts_ms) <= 30 * 24 * 60 * 60 * 1000
            }
        };
        if !time_ok {
            return false;
        }

        if let Some(ref origin) = self.origin {
            let row_origin = row.app_origin.as_deref().unwrap_or("wallet");
            if row_origin != origin.as_str() {
                return false;
            }
        }
        true
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DisplayCurrency {
    #[default]
    Bsv,
    Usd,
}

impl DisplayCurrency {
    pub const fn as_attr(self) -> &'static str {
        match self {
            Self::Bsv => "bsv",
            Self::Usd => "usd",
        }
    }

    pub const fn toggle(self) -> Self {
        match self {
            Self::Bsv => Self::Usd,
            Self::Usd => Self::Bsv,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToastNotice {
    pub title: String,
    pub body: Option<String>,
    pub tone: &'static str,
}
