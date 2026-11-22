// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Per-host concurrency semaphore, token-bucket pacing, and 429/5xx circuit breaker.
//!
//! Prevents multi-input burns/sends (e.g. 17 collectables) from firing simultaneous
//! bursts into WhatsOnChain's 3 req/s rate limit.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

#[derive(Debug, Clone, Copy)]
pub struct HostPolicy {
    pub max_concurrent: usize,
    pub min_spacing: Duration,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
}

impl HostPolicy {
    pub fn whatsonchain() -> Self {
        Self {
            max_concurrent: 2,
            min_spacing: Duration::from_millis(360),
            base_backoff: Duration::from_secs(2),
            max_backoff: Duration::from_secs(30),
        }
    }

    pub fn default_indexer() -> Self {
        Self {
            max_concurrent: 6,
            min_spacing: Duration::from_millis(40),
            base_backoff: Duration::from_millis(500),
            max_backoff: Duration::from_secs(15),
        }
    }
}

struct HostGate {
    policy: HostPolicy,
    sem: Arc<Semaphore>,
    pacing: Mutex<PacingState>,
}

struct PacingState {
    next_allowed: Instant,
    consecutive_failures: u32,
    backoff_until: Option<Instant>,
}

impl HostGate {
    fn new(policy: HostPolicy) -> Self {
        Self {
            sem: Arc::new(Semaphore::new(policy.max_concurrent.max(1))),
            policy,
            pacing: Mutex::new(PacingState {
                next_allowed: Instant::now(),
                consecutive_failures: 0,
                backoff_until: None,
            }),
        }
    }
}

/// Permit holding a per-host concurrency slot until dropped.
pub struct HostPermit {
    _permit: OwnedSemaphorePermit,
}

/// Shared rate-limiter registry keyed by lowercase hostname.
#[derive(Clone, Default)]
pub struct HostRateLimiter {
    gates: Arc<Mutex<HashMap<String, Arc<HostGate>>>>,
}

impl HostRateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    async fn gate_for(&self, host: &str) -> Arc<HostGate> {
        let key = host.trim().to_ascii_lowercase();
        let mut map = self.gates.lock().await;
        if let Some(g) = map.get(&key) {
            return Arc::clone(g);
        }
        let policy = if key.contains("whatsonchain.com") {
            HostPolicy::whatsonchain()
        } else {
            HostPolicy::default_indexer()
        };
        let gate = Arc::new(HostGate::new(policy));
        map.insert(key, Arc::clone(&gate));
        gate
    }

    /// Acquire a paced, concurrency-bounded slot for `host`.
    /// Returns `Err(wait_remaining)` if the host circuit breaker is currently open beyond `max_wait`.
    pub async fn acquire(&self, host: &str, max_wait: Duration) -> Result<HostPermit, Duration> {
        let gate = self.gate_for(host).await;
        let deadline = Instant::now() + max_wait;

        let sleep_dur = {
            let mut state = gate.pacing.lock().await;
            let now = Instant::now();
            if let Some(until) = state.backoff_until {
                if until > deadline {
                    return Err(until.saturating_duration_since(now));
                }
                if until > now {
                    state.next_allowed = state.next_allowed.max(until);
                }
            }
            let scheduled = state.next_allowed.max(now);
            if scheduled > deadline {
                return Err(scheduled.saturating_duration_since(now));
            }
            state.next_allowed = scheduled + gate.policy.min_spacing;
            scheduled.saturating_duration_since(now)
        };

        if !sleep_dur.is_zero() {
            tokio::time::sleep(sleep_dur).await;
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        let permit = tokio::time::timeout(remaining, Arc::clone(&gate.sem).acquire_owned())
            .await
            .map_err(|_| Duration::ZERO)?
            .map_err(|_| Duration::ZERO)?;
        Ok(HostPermit { _permit: permit })
    }

    /// Record a successful response, resetting backoff state.
    pub async fn note_success(&self, host: &str) {
        let gate = self.gate_for(host).await;
        let mut state = gate.pacing.lock().await;
        state.consecutive_failures = 0;
        state.backoff_until = None;
    }

    /// Record a 429 or 5xx response and open exponential backoff for `host`.
    pub async fn note_rate_limited(&self, host: &str, retry_after: Option<Duration>) {
        let gate = self.gate_for(host).await;
        let mut state = gate.pacing.lock().await;
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        let exp = gate
            .policy
            .base_backoff
            .saturating_mul(1u32 << state.consecutive_failures.min(5).saturating_sub(1));
        let wait = retry_after.unwrap_or(exp).min(gate.policy.max_backoff);
        let until = Instant::now() + wait;
        state.backoff_until = Some(until);
        state.next_allowed = state.next_allowed.max(until);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enforces_whatsonchain_spacing_and_backoff_breaker() {
        let limiter = HostRateLimiter::new();
        let t0 = Instant::now();
        let p1 = limiter
            .acquire("api.whatsonchain.com", Duration::from_secs(5))
            .await
            .unwrap();
        drop(p1);
        let p2 = limiter
            .acquire("api.whatsonchain.com", Duration::from_secs(5))
            .await
            .unwrap();
        drop(p2);
        // Second acquire must wait at least ~300ms for WoC token bucket spacing.
        assert!(t0.elapsed() >= Duration::from_millis(300));

        // Rate limit opens circuit breaker beyond a short max_wait.
        limiter
            .note_rate_limited("api.whatsonchain.com", Some(Duration::from_secs(5)))
            .await;
        let blocked = limiter
            .acquire("api.whatsonchain.com", Duration::from_millis(50))
            .await;
        assert!(blocked.is_err());

        limiter.note_success("api.whatsonchain.com").await;
    }
}
