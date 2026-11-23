// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Upstream dependency probes — 1:1 port of `src/wallet/dependencyHealth.ts`.
//! Arcade V2, HandCash Chain, Bitails, BananaBlocks, ord content (GorillaPool).
//! Surfaced in Settings → Support → Wallet health so outages are visible.

use std::time::{Duration, Instant};

/// Canonical BRC-CLOUD origin (`PUBLIC_BRC_CLOUD_ORIGIN` in `walletConfig.ts`).
pub const PUBLIC_BRC_CLOUD_ORIGIN: &str = "https://brc-cloud.bcryderman.workers.dev";

const PROBE_TIMEOUT: Duration = Duration::from_millis(5_000);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeStatus {
    Ok,
    Degraded,
    Down,
}

impl ProbeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Degraded => "degraded",
            Self::Down => "down",
        }
    }

    /// `statusLabel` in `WalletHealthPanel.tsx`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::Degraded => "Slow",
            Self::Down => "Down",
        }
    }

    /// `tone` in `WalletHealthPanel.tsx`.
    pub fn tone(self) -> &'static str {
        match self {
            Self::Ok => "muted",
            Self::Degraded => "warn",
            Self::Down => "error",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DependencyProbe {
    pub id: &'static str,
    pub label: &'static str,
    pub status: ProbeStatus,
    pub detail: String,
    pub latency_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DependencyHealthSnapshot {
    /// 0 = never checked.
    pub at: i64,
    pub probes: Vec<DependencyProbe>,
    pub summary: String,
}

impl Default for DependencyHealthSnapshot {
    fn default() -> Self {
        Self {
            at: 0,
            probes: Vec::new(),
            summary: "Not checked yet".into(),
        }
    }
}

/// Worst status across probes — drives the Settings → Wallet health badge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HealthAlert {
    Unknown,
    Ok,
    Warn,
    Error,
}

impl HealthAlert {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

pub fn dependency_health_alert(snap: &DependencyHealthSnapshot) -> HealthAlert {
    if snap.at == 0 || snap.probes.is_empty() {
        return HealthAlert::Unknown;
    }
    if snap.probes.iter().any(|p| p.status == ProbeStatus::Down) {
        return HealthAlert::Error;
    }
    if snap.probes.iter().any(|p| p.status == ProbeStatus::Degraded) {
        return HealthAlert::Warn;
    }
    HealthAlert::Ok
}

pub fn status_from_http(code: u16, timed_out: bool) -> ProbeStatus {
    if timed_out {
        return ProbeStatus::Down;
    }
    match code {
        200..=399 => ProbeStatus::Ok,
        404 | 405 => ProbeStatus::Ok,
        400..=499 => ProbeStatus::Degraded,
        _ => ProbeStatus::Down,
    }
}

pub fn summarize(probes: &[DependencyProbe]) -> String {
    let down: Vec<_> = probes.iter().filter(|p| p.status == ProbeStatus::Down).collect();
    let degraded: Vec<_> = probes
        .iter()
        .filter(|p| p.status == ProbeStatus::Degraded)
        .collect();
    if !down.is_empty() {
        return if down.len() == 1 {
            format!("{} down", down[0].label)
        } else {
            format!("{} down", down.len())
        };
    }
    if !degraded.is_empty() {
        return if degraded.len() == 1 {
            format!("{} slow", degraded[0].label)
        } else {
            format!("{} slow", degraded.len())
        };
    }
    "All OK".into()
}

struct HttpOutcome {
    code: u16,
    timed_out: bool,
    latency_ms: u64,
    body: Option<String>,
}

async fn probe_url(client: &reqwest::Client, url: &str, head: bool, read_body: bool) -> HttpOutcome {
    let started = Instant::now();
    let req = if head {
        client.head(url)
    } else {
        client.get(url).header("Accept", "application/json")
    };
    match tokio::time::timeout(PROBE_TIMEOUT, async {
        let resp = req.send().await?;
        let code = resp.status().as_u16();
        let body = if read_body { resp.text().await.ok() } else { None };
        Ok::<_, reqwest::Error>((code, body))
    })
    .await
    {
        Ok(Ok((code, body))) => HttpOutcome {
            code,
            timed_out: false,
            latency_ms: started.elapsed().as_millis() as u64,
            body,
        },
        Ok(Err(err)) => HttpOutcome {
            code: 0,
            timed_out: err.is_timeout(),
            latency_ms: if err.is_timeout() {
                PROBE_TIMEOUT.as_millis() as u64
            } else {
                started.elapsed().as_millis() as u64
            },
            body: None,
        },
        Err(_) => HttpOutcome {
            code: 0,
            timed_out: true,
            latency_ms: PROBE_TIMEOUT.as_millis() as u64,
            body: None,
        },
    }
}

/// Detail line shared by Arcade V2, Bitails, BananaBlocks.
fn standard_detail(status: ProbeStatus, out: &HttpOutcome) -> String {
    if status == ProbeStatus::Ok {
        format!("{}ms", out.latency_ms)
    } else if out.timed_out {
        "Timeout".into()
    } else if out.code == 0 {
        "Down".into()
    } else {
        format!("HTTP {}", out.code)
    }
}

async fn probe_json(
    client: &reqwest::Client,
    id: &'static str,
    label: &'static str,
    url: &str,
) -> DependencyProbe {
    let out = probe_url(client, url, false, false).await;
    let status = status_from_http(out.code, out.timed_out);
    DependencyProbe {
        id,
        label,
        status,
        detail: standard_detail(status, &out),
        latency_ms: Some(out.latency_ms),
    }
}

/// HandCash Chain health: body must be `{ ok: true }`.
pub fn handcash_chain_probe_from(code: u16, timed_out: bool, latency_ms: u64, body: Option<&str>) -> (ProbeStatus, String) {
    if code == 0 {
        let status = status_from_http(0, timed_out);
        return (status, if timed_out { "Timeout".into() } else { "Down".into() });
    }
    let mut status = status_from_http(code, false);
    let mut detail = if status == ProbeStatus::Ok {
        format!("{latency_ms}ms")
    } else if code >= 400 {
        format!("HTTP {code}")
    } else {
        "Down".into()
    };
    if status == ProbeStatus::Ok {
        match body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) {
            Some(v) => {
                if v.get("ok") != Some(&serde_json::Value::Bool(true)) {
                    status = ProbeStatus::Degraded;
                    detail = "Unhealthy".into();
                }
            }
            None => {
                status = ProbeStatus::Degraded;
                detail = "Unreadable".into();
            }
        }
    }
    (status, detail)
}

async fn probe_handcash_chain(client: &reqwest::Client) -> DependencyProbe {
    let url = format!("{PUBLIC_BRC_CLOUD_ORIGIN}/v1/chain/health");
    let out = probe_url(client, &url, false, true).await;
    let (status, detail) =
        handcash_chain_probe_from(out.code, out.timed_out, out.latency_ms, out.body.as_deref());
    DependencyProbe {
        id: "handcash-chain",
        label: "HandCash Chain",
        status,
        detail,
        latency_ms: Some(out.latency_ms),
    }
}

async fn probe_gorillapool(client: &reqwest::Client) -> DependencyProbe {
    let out = probe_url(client, "https://ordinals.gorillapool.io/favicon.ico", true, false).await;
    let status = status_from_http(out.code, out.timed_out);
    let detail = if status == ProbeStatus::Ok {
        format!("{}ms", out.latency_ms)
    } else if out.timed_out {
        "Timeout".into()
    } else {
        "Down".into()
    };
    DependencyProbe {
        id: "gorillapool",
        label: "Ordinals",
        status,
        detail,
        latency_ms: Some(out.latency_ms),
    }
}

/// Run all probes concurrently (same order as TS).
pub async fn run_probes() -> Vec<DependencyProbe> {
    let client = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
        Ok(c) => c,
        Err(_) => reqwest::Client::new(),
    };
    let (arcade, chain, bitails, banana, gorilla) = tokio::join!(
        probe_json(
            &client,
            "arcade-v2",
            "Arcade V2",
            "https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v2/height"
        ),
        probe_handcash_chain(&client),
        probe_json(&client, "bitails", "Bitails", "https://api.bitails.io/block/latest"),
        probe_json(
            &client,
            "bananablocks",
            "BananaBlocks",
            "https://bananablocks.com/api/v1/bsv/main/chain/info"
        ),
        probe_gorillapool(&client),
    );
    vec![arcade, chain, bitails, banana, gorilla]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(label: &'static str, status: ProbeStatus) -> DependencyProbe {
        DependencyProbe {
            id: label,
            label,
            status,
            detail: String::new(),
            latency_ms: None,
        }
    }

    #[test]
    fn status_mapping_matches_ts() {
        assert_eq!(status_from_http(200, false), ProbeStatus::Ok);
        assert_eq!(status_from_http(302, false), ProbeStatus::Ok);
        assert_eq!(status_from_http(404, false), ProbeStatus::Ok);
        assert_eq!(status_from_http(405, false), ProbeStatus::Ok);
        assert_eq!(status_from_http(429, false), ProbeStatus::Degraded);
        assert_eq!(status_from_http(503, false), ProbeStatus::Down);
        assert_eq!(status_from_http(0, false), ProbeStatus::Down);
        assert_eq!(status_from_http(200, true), ProbeStatus::Down);
    }

    #[test]
    fn summary_and_alert_match_ts() {
        assert_eq!(dependency_health_alert(&DependencyHealthSnapshot::default()), HealthAlert::Unknown);
        let ok = vec![probe("A", ProbeStatus::Ok), probe("B", ProbeStatus::Ok)];
        assert_eq!(summarize(&ok), "All OK");
        let one_slow = vec![probe("A", ProbeStatus::Degraded), probe("B", ProbeStatus::Ok)];
        assert_eq!(summarize(&one_slow), "A slow");
        let two_slow = vec![probe("A", ProbeStatus::Degraded), probe("B", ProbeStatus::Degraded)];
        assert_eq!(summarize(&two_slow), "2 slow");
        let mixed = vec![probe("A", ProbeStatus::Degraded), probe("B", ProbeStatus::Down)];
        assert_eq!(summarize(&mixed), "B down");
        let snap = DependencyHealthSnapshot { at: 1, probes: mixed, summary: String::new() };
        assert_eq!(dependency_health_alert(&snap), HealthAlert::Error);
        let snap = DependencyHealthSnapshot { at: 1, probes: one_slow, summary: String::new() };
        assert_eq!(dependency_health_alert(&snap), HealthAlert::Warn);
        let snap = DependencyHealthSnapshot { at: 1, probes: ok, summary: String::new() };
        assert_eq!(dependency_health_alert(&snap), HealthAlert::Ok);
    }

    #[test]
    fn handcash_chain_body_rules() {
        assert_eq!(handcash_chain_probe_from(200, false, 12, Some(r#"{"ok":true}"#)), (ProbeStatus::Ok, "12ms".into()));
        assert_eq!(handcash_chain_probe_from(200, false, 12, Some(r#"{"ok":false}"#)), (ProbeStatus::Degraded, "Unhealthy".into()));
        assert_eq!(handcash_chain_probe_from(200, false, 12, Some("nope")), (ProbeStatus::Degraded, "Unreadable".into()));
        assert_eq!(handcash_chain_probe_from(500, false, 12, None), (ProbeStatus::Down, "HTTP 500".into()));
        assert_eq!(handcash_chain_probe_from(0, true, 5000, None), (ProbeStatus::Down, "Timeout".into()));
        assert_eq!(handcash_chain_probe_from(0, false, 3, None), (ProbeStatus::Down, "Down".into()));
    }
}
