//! One wallet run per spend request, so a retry after a timeout cannot pay twice.
//!
//! Direct Rust port of `electron/spendLedger.ts`.

use crate::bridge_protocol::BridgeReply;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

pub const UNCLAIMED_SPEND_TTL: Duration = Duration::from_secs(15 * 60);

struct Run {
    request_id: u64,
    orphaned: bool,
    lost: Option<BridgeReply>,
    settled: Option<BridgeReply>,
    waiters: Vec<(u64, mpsc::Sender<BridgeReply>)>,
    idle_since: Option<Instant>,
}

pub enum SpendBegin {
    Dispatch,
    Join {
        waiter_id: u64,
        key: String,
        rx: mpsc::Receiver<BridgeReply>,
    },
    Replay(BridgeReply),
}

pub fn spend_request_key(origin: Option<&str>, path: &str, body: &str) -> String {
    let mut h = Sha256::new();
    h.update(origin.unwrap_or("").as_bytes());
    h.update(b"\n");
    h.update(path.as_bytes());
    h.update(b"\n");
    h.update(body.as_bytes());
    hex::encode(h.finalize())
}

struct Inner {
    runs: HashMap<String, Run>,
    key_by_id: HashMap<u64, String>,
    next_waiter_id: u64,
}

pub struct SpendLedger {
    ttl: Duration,
    inner: Mutex<Inner>,
}

impl Default for SpendLedger {
    fn default() -> Self {
        Self::new(UNCLAIMED_SPEND_TTL)
    }
}

impl SpendLedger {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            inner: Mutex::new(Inner {
                runs: HashMap::new(),
                key_by_id: HashMap::new(),
                next_waiter_id: 1,
            }),
        }
    }

    pub fn begin(&self, key: String, request_id: u64) -> SpendBegin {
        let mut inner = self.inner.lock().unwrap();
        Self::prune_locked(&mut inner, self.ttl);

        if let Some(run) = inner.runs.get_mut(&key) {
            if let Some(reply) = run.settled.clone() {
                Self::forget_locked(&mut inner, &key);
                return SpendBegin::Replay(reply);
            }
            if let Some(reply) = run.lost.clone() {
                return SpendBegin::Replay(reply);
            }
            let (tx, rx) = mpsc::channel();
            let waiter_id = inner.next_waiter_id;
            inner.next_waiter_id += 1;
            inner
                .runs
                .get_mut(&key)
                .unwrap()
                .waiters
                .push((waiter_id, tx));
            return SpendBegin::Join { waiter_id, key, rx };
        }

        inner.runs.insert(
            key.clone(),
            Run {
                request_id,
                orphaned: false,
                lost: None,
                settled: None,
                waiters: Vec::new(),
                idle_since: None,
            },
        );
        inner.key_by_id.insert(request_id, key);
        SpendBegin::Dispatch
    }

    pub fn leave_waiter(&self, key: &str, waiter_id: u64) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(run) = inner.runs.get_mut(key) {
            run.waiters.retain(|(id, _)| *id != waiter_id);
        }
    }

    pub fn settle(&self, request_id: u64, reply: BridgeReply) {
        let mut inner = self.inner.lock().unwrap();
        let Some(key) = inner.key_by_id.get(&request_id).cloned() else {
            return;
        };
        let should_forget = {
            let Some(run) = inner.runs.get_mut(&key) else {
                return;
            };
            let claimed = !run.waiters.is_empty();
            for (_, tx) in run.waiters.drain(..) {
                let _ = tx.send(reply.clone());
            }
            if claimed && run.orphaned {
                true
            } else {
                run.settled = Some(reply);
                if run.orphaned {
                    run.idle_since = Some(Instant::now());
                }
                false
            }
        };
        if should_forget {
            Self::forget_locked(&mut inner, &key);
        }
    }

    pub fn orphan(&self, request_id: u64) {
        let mut inner = self.inner.lock().unwrap();
        let Some(key) = inner.key_by_id.get(&request_id).cloned() else {
            return;
        };
        if let Some(run) = inner.runs.get_mut(&key) {
            if !run.orphaned {
                run.orphaned = true;
                run.idle_since = Some(Instant::now());
            }
        }
    }

    pub fn done(&self, request_id: u64) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(key) = inner.key_by_id.get(&request_id).cloned() {
            Self::forget_locked(&mut inner, &key);
        }
    }

    pub fn lose_all(&self, reply: BridgeReply) {
        let mut inner = self.inner.lock().unwrap();
        let now = Instant::now();
        for run in inner.runs.values_mut() {
            if run.settled.is_some() {
                continue;
            }
            for (_, tx) in run.waiters.drain(..) {
                let _ = tx.send(reply.clone());
            }
            run.lost = Some(reply.clone());
            run.orphaned = true;
            run.idle_since = Some(now);
        }
    }

    fn forget_locked(inner: &mut Inner, key: &str) {
        if let Some(run) = inner.runs.remove(key) {
            inner.key_by_id.remove(&run.request_id);
        }
    }

    fn prune_locked(inner: &mut Inner, ttl: Duration) {
        let now = Instant::now();
        let expired: Vec<String> = inner
            .runs
            .iter()
            .filter_map(|(k, r)| {
                if r.orphaned
                    && r.waiters.is_empty()
                    && r.idle_since
                        .is_some_and(|since| now.saturating_duration_since(since) > ttl)
                {
                    Some(k.clone())
                } else {
                    None
                }
            })
            .collect();
        for k in expired {
            Self::forget_locked(inner, &k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplicates_in_flight_and_orphaned_spends() {
        let ledger = SpendLedger::default();
        let key = spend_request_key(Some("https://app.test"), "/createAction", r#"{"a":1}"#);

        assert!(matches!(ledger.begin(key.clone(), 1), SpendBegin::Dispatch));

        // Second identical request joins the in-flight run.
        let rx = match ledger.begin(key.clone(), 2) {
            SpendBegin::Join { rx, .. } => rx,
            _ => panic!("expected Join"),
        };

        ledger.orphan(1);
        let reply = BridgeReply {
            status: 200,
            body: r#"{"txid":"abc"}"#.into(),
        };
        ledger.settle(1, reply.clone());
        assert_eq!(rx.recv().unwrap(), reply);

        // Once claimed by the waiter, a deliberate third request dispatches fresh.
        assert!(matches!(ledger.begin(key.clone(), 3), SpendBegin::Dispatch));

        // Orphan + settle with no waiter → next retry replays once then forgets.
        ledger.orphan(3);
        ledger.settle(3, reply.clone());
        match ledger.begin(key.clone(), 4) {
            SpendBegin::Replay(r) => assert_eq!(r, reply),
            _ => panic!("expected Replay"),
        }
        assert!(matches!(ledger.begin(key, 5), SpendBegin::Dispatch));
    }

    #[test]
    fn lose_all_answers_waiters_and_replays_until_ttl() {
        let ledger = SpendLedger::new(Duration::from_millis(10));
        let key = spend_request_key(None, "/createAction", "{}");
        assert!(matches!(ledger.begin(key.clone(), 1), SpendBegin::Dispatch));
        let rx = match ledger.begin(key.clone(), 2) {
            SpendBegin::Join { rx, .. } => rx,
            _ => panic!("expected Join"),
        };
        let lost = BridgeReply {
            status: 503,
            body: r#"{"code":"WALLET_BRIDGE_PENDING"}"#.into(),
        };
        ledger.lose_all(lost.clone());
        assert_eq!(rx.recv().unwrap(), lost);
        assert!(matches!(ledger.begin(key.clone(), 3), SpendBegin::Replay(r) if r == lost));

        std::thread::sleep(Duration::from_millis(20));
        assert!(matches!(ledger.begin(key, 4), SpendBegin::Dispatch));
    }
}
