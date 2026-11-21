// Copyright HandCash. Licensed under the Apache License, Version 2.0.
// Frozen versioned scoped request language (v1) per docs/meridian-engine.md
// and docs/rust-desktop-mobile-migration.md Step 1.

use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fmt;

pub const CONTRACT_VERSION: u32 = 1;
pub const MAX_REPLAY_ENTRIES: usize = 4096;
pub const MAX_ID_LEN: usize = 128;
pub const MAX_ORIGIN_LEN: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ChainNetwork {
    #[serde(rename = "bsv:mainnet")]
    BsvMainnet,
    #[serde(rename = "bsv:testnet")]
    BsvTestnet,
    #[serde(rename = "btc:mainnet")]
    BtcMainnet,
    #[serde(rename = "ltc:mainnet")]
    LtcMainnet,
    #[serde(rename = "bch:mainnet")]
    BchMainnet,
    #[serde(rename = "doge:mainnet")]
    DogeMainnet,
    #[serde(rename = "arc:usdc")]
    ArcUsdc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    ReadBalanceView,
    ReadActivityPage,
    ReadItemProof,
    GetPublicKey,
    CreateSignature,
    SignPayment,
    BroadcastTransaction,
}

/// Host-authenticated session context. Adapter-supplied origin is never trusted
/// without matching this context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedSession {
    pub origin: String,
    pub session_id: String,
    pub active_account_id: String,
    pub active_generation: u64,
}

/// Scoped, expiring permission grant issued to an authenticated origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionGrant {
    pub origin: String,
    pub account_id: String,
    pub chain_network: ChainNetwork,
    pub allowed_capabilities: Vec<Capability>,
    /// Optional exact-integer unit cap per request (e.g. satoshis or base units).
    pub max_amount_units: Option<u64>,
    pub expires_at_ms: u64,
    pub revoked: bool,
}

/// Versioned internal request envelope behind standards adapters.
/// Rejects floating-point amounts and arbitrary method/script execution by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopedRequest {
    pub v: u32,
    pub request_id: String,
    pub origin: String,
    pub session_id: String,
    pub account_id: String,
    pub generation: u64,
    pub chain_network: ChainNetwork,
    pub capability: Capability,
    pub amount_units: Option<u64>,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestRejection {
    UnsupportedVersion,
    InvalidField,
    OriginMismatch,
    SessionMismatch,
    AccountMismatch,
    StaleGeneration,
    RequestExpired,
    GrantRevoked,
    GrantExpired,
    GrantOriginMismatch,
    GrantAccountMismatch,
    GrantNetworkMismatch,
    CapabilityDenied,
    AmountExceedsGrant,
    ReplayDetected,
}

impl fmt::Display for RequestRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for RequestRejection {}

/// Bounded replay-tracking request guard. Fails closed on every security invariant.
#[derive(Debug)]
pub struct RequestGuard {
    seen_set: HashSet<String>,
    seen_order: VecDeque<String>,
    max_entries: usize,
}

impl Default for RequestGuard {
    fn default() -> Self {
        Self::with_capacity(MAX_REPLAY_ENTRIES)
    }
}

impl RequestGuard {
    pub fn with_capacity(max_entries: usize) -> Self {
        Self {
            seen_set: HashSet::new(),
            seen_order: VecDeque::new(),
            max_entries: max_entries.max(1),
        }
    }

    /// Validate a request against host-authenticated session context, active grant, and current time.
    /// Records `request_id` in the replay set only after all checks pass.
    pub fn validate(
        &mut self,
        req: &ScopedRequest,
        session: &AuthenticatedSession,
        grant: &PermissionGrant,
        now_ms: u64,
    ) -> Result<(), RequestRejection> {
        if req.v != CONTRACT_VERSION {
            return Err(RequestRejection::UnsupportedVersion);
        }
        if !valid_token(&req.request_id, MAX_ID_LEN)
            || !valid_token(&req.origin, MAX_ORIGIN_LEN)
            || !valid_token(&req.session_id, MAX_ID_LEN)
            || !valid_token(&req.account_id, MAX_ID_LEN)
        {
            return Err(RequestRejection::InvalidField);
        }
        if req.origin != session.origin {
            return Err(RequestRejection::OriginMismatch);
        }
        if req.session_id != session.session_id {
            return Err(RequestRejection::SessionMismatch);
        }
        if req.account_id != session.active_account_id {
            return Err(RequestRejection::AccountMismatch);
        }
        if req.generation != session.active_generation {
            return Err(RequestRejection::StaleGeneration);
        }
        if now_ms >= req.expires_at_ms {
            return Err(RequestRejection::RequestExpired);
        }
        if grant.revoked {
            return Err(RequestRejection::GrantRevoked);
        }
        if now_ms >= grant.expires_at_ms {
            return Err(RequestRejection::GrantExpired);
        }
        if grant.origin != session.origin {
            return Err(RequestRejection::GrantOriginMismatch);
        }
        if grant.account_id != session.active_account_id {
            return Err(RequestRejection::GrantAccountMismatch);
        }
        if grant.chain_network != req.chain_network {
            return Err(RequestRejection::GrantNetworkMismatch);
        }
        if !grant.allowed_capabilities.contains(&req.capability) {
            return Err(RequestRejection::CapabilityDenied);
        }
        if let (Some(req_amt), Some(cap)) = (req.amount_units, grant.max_amount_units) {
            if req_amt > cap {
                return Err(RequestRejection::AmountExceedsGrant);
            }
        }
        if self.seen_set.contains(&req.request_id) {
            return Err(RequestRejection::ReplayDetected);
        }
        self.record_seen(req.request_id.clone());
        Ok(())
    }

    fn record_seen(&mut self, id: String) {
        if self.seen_order.len() >= self.max_entries {
            if let Some(oldest) = self.seen_order.pop_front() {
                self.seen_set.remove(&oldest);
            }
        }
        self.seen_set.insert(id.clone());
        self.seen_order.push_back(id);
    }
}

fn valid_token(value: &str, max_len: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() == value.len()
        && value.len() <= max_len
        && value.bytes().all(|b| b.is_ascii_graphic())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_session() -> AuthenticatedSession {
        AuthenticatedSession {
            origin: "https://app.example".into(),
            session_id: "sess-01".into(),
            active_account_id: "acct-alpha".into(),
            active_generation: 7,
        }
    }

    fn base_grant() -> PermissionGrant {
        PermissionGrant {
            origin: "https://app.example".into(),
            account_id: "acct-alpha".into(),
            chain_network: ChainNetwork::BsvMainnet,
            allowed_capabilities: vec![Capability::ReadBalanceView, Capability::SignPayment],
            max_amount_units: Some(50_000),
            expires_at_ms: 2_000_000,
            revoked: false,
        }
    }

    fn base_request() -> ScopedRequest {
        ScopedRequest {
            v: CONTRACT_VERSION,
            request_id: "req-001".into(),
            origin: "https://app.example".into(),
            session_id: "sess-01".into(),
            account_id: "acct-alpha".into(),
            generation: 7,
            chain_network: ChainNetwork::BsvMainnet,
            capability: Capability::SignPayment,
            amount_units: Some(12_500),
            expires_at_ms: 1_500_000,
        }
    }

    #[test]
    fn accepts_valid_scoped_request_and_blocks_replay() {
        let mut guard = RequestGuard::default();
        let req = base_request();
        assert_eq!(
            guard.validate(&req, &base_session(), &base_grant(), 1_000_000),
            Ok(())
        );
        assert_eq!(
            guard.validate(&req, &base_session(), &base_grant(), 1_000_001),
            Err(RequestRejection::ReplayDetected)
        );
    }

    #[test]
    fn rejects_origin_spoofing_wrong_account_stale_generation_and_expiry() {
        let mut guard = RequestGuard::default();

        let mut spoofed = base_request();
        spoofed.origin = "https://evil.example".into();
        assert_eq!(
            guard.validate(&spoofed, &base_session(), &base_grant(), 1_000_000),
            Err(RequestRejection::OriginMismatch)
        );

        let mut wrong_acct = base_request();
        wrong_acct.account_id = "acct-beta".into();
        assert_eq!(
            guard.validate(&wrong_acct, &base_session(), &base_grant(), 1_000_000),
            Err(RequestRejection::AccountMismatch)
        );

        let mut stale = base_request();
        stale.generation = 6;
        assert_eq!(
            guard.validate(&stale, &base_session(), &base_grant(), 1_000_000),
            Err(RequestRejection::StaleGeneration)
        );

        assert_eq!(
            guard.validate(&base_request(), &base_session(), &base_grant(), 1_500_000),
            Err(RequestRejection::RequestExpired)
        );
    }

    #[test]
    fn rejects_permission_escalation_cross_chain_revoked_and_unknown_version() {
        let mut guard = RequestGuard::default();

        let mut bad_ver = base_request();
        bad_ver.v = 99;
        assert_eq!(
            guard.validate(&bad_ver, &base_session(), &base_grant(), 1_000_000),
            Err(RequestRejection::UnsupportedVersion)
        );

        let mut escalated = base_request();
        escalated.capability = Capability::BroadcastTransaction;
        assert_eq!(
            guard.validate(&escalated, &base_session(), &base_grant(), 1_000_000),
            Err(RequestRejection::CapabilityDenied)
        );

        let mut cross_chain = base_request();
        cross_chain.chain_network = ChainNetwork::LtcMainnet;
        assert_eq!(
            guard.validate(&cross_chain, &base_session(), &base_grant(), 1_000_000),
            Err(RequestRejection::GrantNetworkMismatch)
        );

        let mut over_cap = base_request();
        over_cap.amount_units = Some(50_001);
        assert_eq!(
            guard.validate(&over_cap, &base_session(), &base_grant(), 1_000_000),
            Err(RequestRejection::AmountExceedsGrant)
        );

        let mut revoked = base_grant();
        revoked.revoked = true;
        assert_eq!(
            guard.validate(&base_request(), &base_session(), &revoked, 1_000_000),
            Err(RequestRejection::GrantRevoked)
        );
    }

    #[test]
    fn rejects_unknown_json_fields_and_float_amounts() {
        let unknown_field = r#"{"v":1,"requestId":"r1","origin":"https://a","sessionId":"s1","accountId":"a1","generation":1,"chainNetwork":"bsv:mainnet","capability":"readBalanceView","amountUnits":null,"expiresAtMs":10,"extra":true}"#;
        assert!(serde_json::from_str::<ScopedRequest>(unknown_field).is_err());

        let float_amount = r#"{"v":1,"requestId":"r1","origin":"https://a","sessionId":"s1","accountId":"a1","generation":1,"chainNetwork":"bsv:mainnet","capability":"signPayment","amountUnits":1.5,"expiresAtMs":10}"#;
        assert!(serde_json::from_str::<ScopedRequest>(float_amount).is_err());
    }
}
