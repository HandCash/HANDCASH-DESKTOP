// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/importQueueMachine.ts`.

use std::collections::{BTreeMap, BTreeSet};

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const IMPORT_CHUNK: usize = 100;
pub const STALE_FUNDING_PAUSE_MS: u64 = 8_000;
pub const STALE_FUNDING_PAUSES: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportItemResultKind {
    Moved,
    Skipped,
    Funds,
    Deferred,
    Refused,
    Unreadable,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportItemResult {
    pub kind: ImportItemResultKind,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportItemAnswer {
    pub outpoint: String,
    pub result: ImportItemResult,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportStoppedReason {
    Funds,
    StaleFunding,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportItemsResult {
    pub results: Vec<ImportItemAnswer>,
    pub stopped: Option<ImportStoppedReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportNoticeTone {
    Success,
    Warning,
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportNoticeOutcome {
    Item(ImportItemResultKind),
    Batch,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportItemNotice {
    pub tone: ImportNoticeTone,
    pub outcome: ImportNoticeOutcome,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportTally {
    pub total: usize,
    pub moved: usize,
    pub failure: Option<ImportItemNotice>,
    pub stopped: bool,
    pub last: Option<ImportItemNotice>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportQueueEntry {
    pub source_id: String,
    pub identity_key: String,
    pub outpoint: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportQueueEnqueueItem {
    pub outpoint: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportSourceRun {
    pub moving: Vec<String>,
    pub waiting: Vec<String>,
    pub total: usize,
    pub done: usize,
    pub stopping: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportSourceView {
    pub run: Option<ImportSourceRun>,
    pub report: Option<ImportItemNotice>,
    pub paused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportQueueState {
    Idle,
    Deciding,
    Moving,
    Cooling,
}

impl ImportQueueState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Deciding => "deciding",
            Self::Moving => "moving",
            Self::Cooling => "cooling",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportQueueContext {
    pub queue: Vec<ImportQueueEntry>,
    pub moving: Vec<ImportQueueEntry>,
    pub landed: Vec<String>,
    pub tallies: BTreeMap<String, ImportTally>,
    pub reports: BTreeMap<String, ImportItemNotice>,
    pub names: BTreeMap<String, Option<String>>,
    pub stopping: Vec<String>,
    pub pauses: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportQueueEvent {
    Enqueue {
        source_id: String,
        identity_key: String,
        items: Vec<ImportQueueEnqueueItem>,
    },
    Stop {
        source_id: String,
    },
    Dismiss {
        source_id: String,
    },
    Landed {
        outpoints: Vec<String>,
    },
    ChunkDone {
        output: ImportItemsResult,
    },
    ChunkError {
        error: String,
        wallet_changed: bool,
    },
    StaleFundingElapsed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportQueueEffect {
    ImportMany {
        source_id: String,
        identity_key: String,
        outpoints: Vec<String>,
    },
    Prefetch {
        source_id: String,
        outpoints: Vec<String>,
    },
    ScheduleStaleFundingPause {
        delay_ms: u64,
    },
    Answered {
        source_id: String,
        results: Vec<ImportItemAnswer>,
    },
}

fn format_commas(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    let len = s.len();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (len - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn item_title(name: Option<&str>) -> &str {
    name.unwrap_or("Item")
}

pub fn notice_for(name: Option<&str>, result: &ImportItemResult) -> (ImportItemNotice, bool) {
    let title = item_title(name);
    match result.kind {
        ImportItemResultKind::Moved => (
            ImportItemNotice {
                tone: ImportNoticeTone::Success,
                outcome: ImportNoticeOutcome::Item(result.kind),
                title: format!("{title} imported"),
                body: "It is in this wallet now.".to_string(),
            },
            false,
        ),
        ImportItemResultKind::Skipped => (
            ImportItemNotice {
                tone: ImportNoticeTone::Warning,
                outcome: ImportNoticeOutcome::Item(result.kind),
                title: format!("{title} stays at the source"),
                body: result.message.clone(),
            },
            false,
        ),
        ImportItemResultKind::Funds => (
            ImportItemNotice {
                tone: ImportNoticeTone::Warning,
                outcome: ImportNoticeOutcome::Item(result.kind),
                title: "Add BSV to import".to_string(),
                body: result.message.clone(),
            },
            true,
        ),
        ImportItemResultKind::Deferred => (
            ImportItemNotice {
                tone: ImportNoticeTone::Warning,
                outcome: ImportNoticeOutcome::Item(result.kind),
                title: "Import paused".to_string(),
                body: result.message.clone(),
            },
            true,
        ),
        ImportItemResultKind::Refused => (
            ImportItemNotice {
                tone: ImportNoticeTone::Warning,
                outcome: ImportNoticeOutcome::Item(result.kind),
                title: format!("{title} not imported"),
                body: result.message.clone(),
            },
            true,
        ),
        ImportItemResultKind::Unreadable | ImportItemResultKind::Failed => (
            ImportItemNotice {
                tone: ImportNoticeTone::Danger,
                outcome: ImportNoticeOutcome::Item(result.kind),
                title: format!("{title} not imported"),
                body: result.message.clone(),
            },
            true,
        ),
    }
}

pub fn batch_notice(tally: &ImportTally) -> ImportItemNotice {
    let count = format!(
        "{} of {} imported",
        format_commas(tally.moved),
        format_commas(tally.total)
    );
    if tally.moved == tally.total {
        return ImportItemNotice {
            tone: ImportNoticeTone::Success,
            outcome: ImportNoticeOutcome::Batch,
            title: format!("{} items imported", format_commas(tally.total)),
            body: "They are in this wallet now.".to_string(),
        };
    }
    if let Some(failure) = &tally.failure {
        if matches!(
            failure.outcome,
            ImportNoticeOutcome::Item(ImportItemResultKind::Funds | ImportItemResultKind::Deferred)
        ) {
            return ImportItemNotice {
                body: format!("{count}. {}", failure.body),
                ..failure.clone()
            };
        }
    }
    if tally.stopped {
        return ImportItemNotice {
            tone: ImportNoticeTone::Warning,
            outcome: ImportNoticeOutcome::Batch,
            title: "Import stopped".to_string(),
            body: format!("{count}."),
        };
    }
    ImportItemNotice {
        tone: tally
            .failure
            .as_ref()
            .map_or(ImportNoticeTone::Warning, |f| f.tone),
        outcome: ImportNoticeOutcome::Batch,
        title: count,
        body: tally
            .failure
            .as_ref()
            .map_or_else(String::new, |f| format!("{}: {}", f.title, f.body)),
    }
}

pub fn next_chunk(queue: &[ImportQueueEntry]) -> Vec<ImportQueueEntry> {
    let Some(head) = queue.first() else {
        return Vec::new();
    };
    let mut chunk = Vec::new();
    for entry in queue {
        if entry.source_id != head.source_id || entry.identity_key != head.identity_key {
            continue;
        }
        chunk.push(entry.clone());
        if chunk.len() >= IMPORT_CHUNK {
            break;
        }
    }
    chunk
}

pub fn source_run(context: &ImportQueueContext, source_id: &str) -> Option<ImportSourceRun> {
    let tally = context.tallies.get(source_id)?;
    let landed: BTreeSet<&str> = context.landed.iter().map(String::as_str).collect();
    let moving: Vec<String> = context
        .moving
        .iter()
        .filter(|e| e.source_id == source_id && !landed.contains(e.outpoint.as_str()))
        .map(|e| e.outpoint.clone())
        .collect();
    let waiting: Vec<String> = context
        .queue
        .iter()
        .filter(|e| e.source_id == source_id)
        .map(|e| e.outpoint.clone())
        .collect();
    let done = tally.total.saturating_sub(moving.len() + waiting.len());
    Some(ImportSourceRun {
        moving,
        waiting,
        total: tally.total,
        done,
        stopping: context.stopping.iter().any(|s| s == source_id),
    })
}

pub fn source_view(
    snapshot: &Snapshot<ImportQueueState, ImportQueueContext>,
    source_id: &str,
) -> ImportSourceView {
    ImportSourceView {
        run: source_run(&snapshot.context, source_id),
        report: snapshot.context.reports.get(source_id).cloned(),
        paused: snapshot.value == ImportQueueState::Cooling,
    }
}

fn settle_sources(ctx: &mut ImportQueueContext) {
    let live: BTreeSet<String> = ctx
        .queue
        .iter()
        .chain(ctx.moving.iter())
        .map(|e| e.source_id.clone())
        .collect();
    let mut next_tallies = BTreeMap::new();
    let old_tallies = core::mem::take(&mut ctx.tallies);
    for (source_id, tally) in old_tallies {
        if live.contains(&source_id) {
            next_tallies.insert(source_id, tally);
        } else {
            let report = if tally.total == 1 {
                tally.last.clone().unwrap_or_else(|| batch_notice(&tally))
            } else {
                batch_notice(&tally)
            };
            ctx.reports.insert(source_id, report);
        }
    }
    ctx.tallies = next_tallies;
    ctx.stopping.retain(|s| live.contains(s));
}

fn enqueue_items(
    ctx: &mut ImportQueueContext,
    source_id: String,
    identity_key: String,
    items: Vec<ImportQueueEnqueueItem>,
) {
    let mut known: BTreeSet<String> = ctx
        .queue
        .iter()
        .chain(ctx.moving.iter())
        .filter(|e| e.source_id == source_id)
        .map(|e| e.outpoint.clone())
        .collect();
    let mut fresh = Vec::new();
    for item in items {
        if known.insert(item.outpoint.clone()) {
            fresh.push(item);
        }
    }
    if fresh.is_empty() {
        return;
    }
    let tally = ctx.tallies.entry(source_id.clone()).or_default();
    tally.total += fresh.len();
    ctx.reports.remove(&source_id);
    for item in &fresh {
        ctx.names.insert(item.outpoint.clone(), item.name.clone());
    }
    for item in fresh {
        ctx.queue.push(ImportQueueEntry {
            source_id: source_id.clone(),
            identity_key: identity_key.clone(),
            outpoint: item.outpoint,
        });
    }
    ctx.stopping.retain(|s| s != &source_id);
}

fn stop_source(ctx: &mut ImportQueueContext, source_id: &str) {
    let Some(tally) = ctx.tallies.get_mut(source_id) else {
        return;
    };
    tally.stopped = true;
    ctx.queue.retain(|e| e.source_id != source_id);
    if !ctx.stopping.iter().any(|s| s == source_id) {
        ctx.stopping.push(source_id.to_string());
    }
}

fn decide_next(ctx: &mut ImportQueueContext, effects: &mut Vec<ImportQueueEffect>) -> ImportQueueState {
    if ctx.queue.is_empty() {
        return ImportQueueState::Idle;
    }
    let chunk = next_chunk(&ctx.queue);
    let mut remaining = Vec::with_capacity(ctx.queue.len().saturating_sub(chunk.len()));
    let mut taken_indices = BTreeSet::new();
    if let Some(head) = chunk.first() {
        let mut count = 0;
        for (i, entry) in ctx.queue.iter().enumerate() {
            if count < chunk.len()
                && entry.source_id == head.source_id
                && entry.identity_key == head.identity_key
            {
                taken_indices.insert(i);
                count += 1;
            }
        }
    }
    for (i, entry) in ctx.queue.drain(..).enumerate() {
        if !taken_indices.contains(&i) {
            remaining.push(entry);
        }
    }
    ctx.queue = remaining;
    ctx.moving = chunk.clone();
    ctx.landed.clear();
    if let Some(first) = chunk.first() {
        effects.push(ImportQueueEffect::ImportMany {
            source_id: first.source_id.clone(),
            identity_key: first.identity_key.clone(),
            outpoints: chunk.iter().map(|e| e.outpoint.clone()).collect(),
        });
    }
    let next = next_chunk(&ctx.queue);
    if let Some(first) = next.first() {
        effects.push(ImportQueueEffect::Prefetch {
            source_id: first.source_id.clone(),
            outpoints: next.iter().map(|e| e.outpoint.clone()).collect(),
        });
    }
    ImportQueueState::Moving
}

pub struct ImportQueueMachine;

impl Statechart for ImportQueueMachine {
    type State = ImportQueueState;
    type Context = ImportQueueContext;
    type Event = ImportQueueEvent;
    type Input = ();

    const ID: &'static str = "importQueue";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(ImportQueueState::Idle, ImportQueueContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        StateValue::leaf(state.as_str())
    }
}

impl HandCashChart for ImportQueueMachine {
    const MANIFEST_ID: &'static str = "importQueue";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["idle", "deciding", "moving", "cooling"];
    type Effect = ImportQueueEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (_, ImportQueueEvent::Dismiss { source_id }) => {
                ctx.reports.remove(&source_id);
                snapshot.value
            }
            (
                ImportQueueState::Idle,
                ImportQueueEvent::Enqueue {
                    source_id,
                    identity_key,
                    items,
                },
            ) => {
                enqueue_items(&mut ctx, source_id, identity_key, items);
                decide_next(&mut ctx, &mut effects)
            }
            (
                ImportQueueState::Moving,
                ImportQueueEvent::Enqueue {
                    source_id,
                    identity_key,
                    items,
                },
            ) => {
                enqueue_items(&mut ctx, source_id, identity_key, items);
                ImportQueueState::Moving
            }
            (ImportQueueState::Moving, ImportQueueEvent::Stop { source_id }) => {
                stop_source(&mut ctx, &source_id);
                ImportQueueState::Moving
            }
            (ImportQueueState::Moving, ImportQueueEvent::Landed { outpoints }) => {
                let known: BTreeSet<String> = ctx.landed.iter().cloned().collect();
                let in_flight: BTreeSet<&str> =
                    ctx.moving.iter().map(|e| e.outpoint.as_str()).collect();
                for op in outpoints {
                    if in_flight.contains(op.as_str())
                        && !known.contains(&op)
                        && !ctx.landed.contains(&op)
                    {
                        ctx.landed.push(op);
                    }
                }
                ImportQueueState::Moving
            }
            (ImportQueueState::Moving, ImportQueueEvent::ChunkDone { output }) => {
                let chunk = ctx.moving.clone();
                let source_id = chunk.first().map(|e| e.source_id.clone()).unwrap_or_default();
                let identity_key = chunk
                    .first()
                    .map(|e| e.identity_key.clone())
                    .unwrap_or_default();
                let pausing = output.stopped == Some(ImportStoppedReason::StaleFunding)
                    && ctx.pauses < STALE_FUNDING_PAUSES;
                let mut tally = ctx.tallies.get(&source_id).cloned().unwrap_or_default();
                let mut retry = Vec::new();
                let mut answered = Vec::new();
                for answer in output.results {
                    if pausing && answer.result.kind == ImportItemResultKind::Deferred {
                        if let Some(entry) = chunk.iter().find(|e| e.outpoint == answer.outpoint) {
                            retry.push(entry.clone());
                        }
                        continue;
                    }
                    let name = ctx
                        .names
                        .get(&answer.outpoint)
                        .and_then(|n| n.as_deref());
                    let (notice, _) = notice_for(name, &answer.result);
                    tally.last = Some(notice.clone());
                    if answer.result.kind == ImportItemResultKind::Moved {
                        tally.moved += 1;
                    } else if tally.failure.as_ref().map(|f| f.outcome)
                        != Some(ImportNoticeOutcome::Item(ImportItemResultKind::Funds))
                    {
                        tally.failure = Some(notice);
                    }
                    answered.push(answer);
                }
                ctx.tallies.insert(source_id.clone(), tally.clone());
                if output.stopped == Some(ImportStoppedReason::Funds)
                    || (output.stopped == Some(ImportStoppedReason::StaleFunding) && !pausing)
                {
                    let mut dropped: BTreeSet<String> = ctx
                        .queue
                        .iter()
                        .filter(|e| e.identity_key == identity_key)
                        .map(|e| e.source_id.clone())
                        .collect();
                    dropped.remove(&source_id);
                    ctx.queue.retain(|e| e.identity_key != identity_key);
                    for id in dropped {
                        let other = ctx.tallies.entry(id).or_default();
                        if other.failure.is_none() {
                            other.failure = tally.failure.clone();
                        }
                    }
                }
                for answer in &answered {
                    ctx.names.remove(&answer.outpoint);
                }
                ctx.moving = retry;
                ctx.landed.clear();
                ctx.pauses = if pausing { ctx.pauses + 1 } else { 0 };
                settle_sources(&mut ctx);
                if !answered.is_empty() {
                    effects.push(ImportQueueEffect::Answered {
                        source_id,
                        results: answered,
                    });
                }
                if pausing {
                    effects.push(ImportQueueEffect::ScheduleStaleFundingPause {
                        delay_ms: STALE_FUNDING_PAUSE_MS,
                    });
                    ImportQueueState::Cooling
                } else {
                    decide_next(&mut ctx, &mut effects)
                }
            }
            (
                ImportQueueState::Moving,
                ImportQueueEvent::ChunkError {
                    error,
                    wallet_changed,
                },
            ) => {
                let chunk = ctx.moving.clone();
                let source_id = chunk.first().map(|e| e.source_id.clone()).unwrap_or_default();
                let identity_key = chunk
                    .first()
                    .map(|e| e.identity_key.clone())
                    .unwrap_or_default();
                let title = if chunk.len() == 1 {
                    let name = ctx
                        .names
                        .get(&chunk[0].outpoint)
                        .and_then(|n| n.as_deref());
                    format!("{} not imported", item_title(name))
                } else {
                    "Items not imported".to_string()
                };
                let failure = ImportItemNotice {
                    tone: ImportNoticeTone::Danger,
                    outcome: ImportNoticeOutcome::Item(ImportItemResultKind::Failed),
                    title,
                    body: error,
                };
                let mut affected = BTreeSet::new();
                affected.insert(source_id.clone());
                for e in &ctx.queue {
                    let drop = if wallet_changed {
                        e.identity_key == identity_key
                    } else {
                        e.source_id == source_id
                    };
                    if drop {
                        affected.insert(e.source_id.clone());
                    }
                }
                ctx.queue.retain(|e| {
                    if wallet_changed {
                        e.identity_key != identity_key
                    } else {
                        e.source_id != source_id
                    }
                });
                for id in affected {
                    let tally = ctx.tallies.entry(id).or_default();
                    tally.failure = Some(failure.clone());
                    tally.last = Some(failure.clone());
                }
                ctx.moving.clear();
                ctx.landed.clear();
                ctx.pauses = 0;
                settle_sources(&mut ctx);
                decide_next(&mut ctx, &mut effects)
            }
            (ImportQueueState::Cooling, ImportQueueEvent::StaleFundingElapsed) => {
                let mut requeued = core::mem::take(&mut ctx.moving);
                requeued.append(&mut ctx.queue);
                ctx.queue = requeued;
                ctx.landed.clear();
                decide_next(&mut ctx, &mut effects)
            }
            (
                ImportQueueState::Cooling,
                ImportQueueEvent::Enqueue {
                    source_id,
                    identity_key,
                    items,
                },
            ) => {
                enqueue_items(&mut ctx, source_id, identity_key, items);
                ImportQueueState::Cooling
            }
            (ImportQueueState::Cooling, ImportQueueEvent::Stop { source_id }) => {
                let moving_stopped = ctx.moving.iter().any(|e| e.source_id == source_id);
                stop_source(&mut ctx, &source_id);
                if moving_stopped {
                    ctx.moving.retain(|e| e.source_id != source_id);
                    ctx.landed.clear();
                    settle_sources(&mut ctx);
                    decide_next(&mut ctx, &mut effects)
                } else {
                    ImportQueueState::Cooling
                }
            }
            _ => return (snapshot.clone(), effects),
        };
        (Snapshot::new(next, ctx), effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn op(n: usize) -> String {
        format!("{}_{n}", "a".repeat(64))
    }

    fn items(from: usize, count: usize) -> Vec<ImportQueueEnqueueItem> {
        (0..count)
            .map(|i| ImportQueueEnqueueItem {
                outpoint: op(from + i),
                name: Some(format!("Item {}", from + i)),
            })
            .collect()
    }

    fn moved_res() -> ImportItemResult {
        ImportItemResult {
            kind: ImportItemResultKind::Moved,
            message: String::new(),
        }
    }

    fn deferred_res() -> ImportItemResult {
        ImportItemResult {
            kind: ImportItemResultKind::Deferred,
            message: "A spent fee coin delayed the import.".to_string(),
        }
    }

    #[test]
    fn moves_one_source_and_wallet_per_chunk_and_prefetches_next_chunk() {
        let mut actor = EffectActor::<ImportQueueMachine>::default();
        let e1 = actor.send(ImportQueueEvent::Enqueue {
            source_id: "a".to_string(),
            identity_key: "id1".to_string(),
            items: items(1, IMPORT_CHUNK + 1),
        });
        assert_eq!(*actor.state(), ImportQueueState::Moving);
        assert_eq!(e1.len(), 2);
        assert_eq!(
            e1[1],
            ImportQueueEffect::Prefetch {
                source_id: "a".to_string(),
                outpoints: vec![op(IMPORT_CHUNK + 1)],
            }
        );
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "b".to_string(),
            identity_key: "id1".to_string(),
            items: items(500, 2),
        });
        // Duplicate items ignored.
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "a".to_string(),
            identity_key: "id1".to_string(),
            items: items(1, 3),
        });
        let mut calls = Vec::new();
        if let ImportQueueEffect::ImportMany {
            source_id,
            outpoints,
            ..
        } = &e1[0]
        {
            calls.push((source_id.clone(), outpoints.len()));
        }
        while *actor.state() == ImportQueueState::Moving {
            let ops: Vec<String> = actor
                .context()
                .moving
                .iter()
                .map(|e| e.outpoint.clone())
                .collect();
            let effects = actor.send(ImportQueueEvent::ChunkDone {
                output: ImportItemsResult {
                    results: ops
                        .into_iter()
                        .map(|outpoint| ImportItemAnswer {
                            outpoint,
                            result: moved_res(),
                        })
                        .collect(),
                    stopped: None,
                },
            });
            for ef in effects {
                if let ImportQueueEffect::ImportMany {
                    source_id,
                    outpoints,
                    ..
                } = ef
                {
                    calls.push((source_id, outpoints.len()));
                }
            }
        }
        assert_eq!(*actor.state(), ImportQueueState::Idle);
        assert_eq!(
            calls,
            vec![
                ("a".to_string(), IMPORT_CHUNK),
                ("a".to_string(), 1),
                ("b".to_string(), 2)
            ]
        );
        assert_eq!(
            actor.context().reports["a"].title,
            format!("{} items imported", IMPORT_CHUNK + 1)
        );
        assert_eq!(actor.context().reports["b"].title, "2 items imported");
    }

    #[test]
    fn reports_run_and_counts_landed_items_against_whole_run() {
        let mut actor = EffectActor::<ImportQueueMachine>::default();
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "a".to_string(),
            identity_key: "id1".to_string(),
            items: items(1, 79),
        });
        let run = source_run(actor.context(), "a").unwrap();
        assert_eq!(run.total, 79);
        assert_eq!(run.done, 0);
        assert!(source_run(actor.context(), "b").is_none());

        let first_leg: Vec<String> = items(1, 21).into_iter().map(|i| i.outpoint).collect();
        actor.send(ImportQueueEvent::Landed {
            outpoints: first_leg.clone(),
        });
        let mut dup_and_foreign = first_leg;
        dup_and_foreign.push(op(9_999));
        actor.send(ImportQueueEvent::Landed {
            outpoints: dup_and_foreign,
        });
        let run = source_run(actor.context(), "a").unwrap();
        assert_eq!(run.total, 79);
        assert_eq!(run.done, 21);
        assert_eq!(run.moving.len(), 58);

        let ops: Vec<String> = items(1, 79).into_iter().map(|i| i.outpoint).collect();
        actor.send(ImportQueueEvent::ChunkDone {
            output: ImportItemsResult {
                results: ops
                    .into_iter()
                    .map(|outpoint| ImportItemAnswer {
                        outpoint,
                        result: moved_res(),
                    })
                    .collect(),
                stopped: None,
            },
        });
        assert_eq!(*actor.state(), ImportQueueState::Idle);
        assert!(actor.context().landed.is_empty());
        assert_eq!(actor.context().reports["a"].title, "79 items imported");
    }

    #[test]
    fn waits_out_stale_funding_then_retries_only_untried_items() {
        let mut actor = EffectActor::<ImportQueueMachine>::default();
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "a".to_string(),
            identity_key: "id1".to_string(),
            items: items(1, 3),
        });
        let cooling_effects = actor.send(ImportQueueEvent::ChunkDone {
            output: ImportItemsResult {
                results: vec![
                    ImportItemAnswer {
                        outpoint: op(1),
                        result: moved_res(),
                    },
                    ImportItemAnswer {
                        outpoint: op(2),
                        result: deferred_res(),
                    },
                    ImportItemAnswer {
                        outpoint: op(3),
                        result: deferred_res(),
                    },
                ],
                stopped: Some(ImportStoppedReason::StaleFunding),
            },
        });
        assert_eq!(*actor.state(), ImportQueueState::Cooling);
        assert!(cooling_effects.iter().any(|e| matches!(
            e,
            ImportQueueEffect::Answered { results, .. } if results.len() == 1 && results[0].outpoint == op(1)
        )));
        let run = source_run(actor.context(), "a").unwrap();
        assert_eq!(run.moving, vec![op(2), op(3)]);
        assert_eq!(run.done, 1);

        let retry_effects = actor.send(ImportQueueEvent::StaleFundingElapsed);
        assert_eq!(*actor.state(), ImportQueueState::Moving);
        assert_eq!(
            retry_effects,
            vec![ImportQueueEffect::ImportMany {
                source_id: "a".to_string(),
                identity_key: "id1".to_string(),
                outpoints: vec![op(2), op(3)],
            }]
        );
        actor.send(ImportQueueEvent::ChunkDone {
            output: ImportItemsResult {
                results: vec![
                    ImportItemAnswer {
                        outpoint: op(2),
                        result: moved_res(),
                    },
                    ImportItemAnswer {
                        outpoint: op(3),
                        result: moved_res(),
                    },
                ],
                stopped: None,
            },
        });
        assert_eq!(*actor.state(), ImportQueueState::Idle);
        assert_eq!(actor.context().reports["a"].title, "3 items imported");
    }

    #[test]
    fn drops_waiting_items_once_stale_funding_pauses_run_out() {
        let mut actor = EffectActor::<ImportQueueMachine>::default();
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "a".to_string(),
            identity_key: "id1".to_string(),
            items: items(1, 2),
        });
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "b".to_string(),
            identity_key: "id1".to_string(),
            items: items(9, 1),
        });
        for _ in 0..STALE_FUNDING_PAUSES {
            actor.send(ImportQueueEvent::ChunkDone {
                output: ImportItemsResult {
                    results: vec![
                        ImportItemAnswer {
                            outpoint: op(1),
                            result: deferred_res(),
                        },
                        ImportItemAnswer {
                            outpoint: op(2),
                            result: deferred_res(),
                        },
                    ],
                    stopped: Some(ImportStoppedReason::StaleFunding),
                },
            });
            assert_eq!(*actor.state(), ImportQueueState::Cooling);
            actor.send(ImportQueueEvent::StaleFundingElapsed);
        }
        // Final attempt exhausts pauses and drops both sources for id1.
        actor.send(ImportQueueEvent::ChunkDone {
            output: ImportItemsResult {
                results: vec![
                    ImportItemAnswer {
                        outpoint: op(1),
                        result: deferred_res(),
                    },
                    ImportItemAnswer {
                        outpoint: op(2),
                        result: deferred_res(),
                    },
                ],
                stopped: Some(ImportStoppedReason::StaleFunding),
            },
        });
        assert_eq!(*actor.state(), ImportQueueState::Idle);
        assert_eq!(
            actor.context().reports["a"].outcome,
            ImportNoticeOutcome::Item(ImportItemResultKind::Deferred)
        );
        assert!(actor.context().reports["a"].body.starts_with("0 of 2 imported"));
        assert!(actor.context().reports["b"].body.starts_with("0 of 1 imported. A spent fee coin"));
    }

    #[test]
    fn stopping_paused_source_drops_paused_chunk_too() {
        let mut actor = EffectActor::<ImportQueueMachine>::default();
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "a".to_string(),
            identity_key: "id1".to_string(),
            items: items(1, 2),
        });
        actor.send(ImportQueueEvent::ChunkDone {
            output: ImportItemsResult {
                results: vec![
                    ImportItemAnswer {
                        outpoint: op(1),
                        result: deferred_res(),
                    },
                    ImportItemAnswer {
                        outpoint: op(2),
                        result: deferred_res(),
                    },
                ],
                stopped: Some(ImportStoppedReason::StaleFunding),
            },
        });
        assert_eq!(*actor.state(), ImportQueueState::Cooling);
        actor.send(ImportQueueEvent::Stop {
            source_id: "a".to_string(),
        });
        assert_eq!(*actor.state(), ImportQueueState::Idle);
        assert_eq!(actor.context().reports["a"].title, "Import stopped");
        assert_eq!(actor.context().reports["a"].body, "0 of 2 imported.");
    }

    #[test]
    fn drops_every_waiting_item_of_wallet_that_is_no_longer_open() {
        let mut actor = EffectActor::<ImportQueueMachine>::default();
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "a".to_string(),
            identity_key: "old".to_string(),
            items: items(1, 1),
        });
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "b".to_string(),
            identity_key: "old".to_string(),
            items: items(2, 1),
        });
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "c".to_string(),
            identity_key: "new".to_string(),
            items: items(3, 1),
        });
        actor.send(ImportQueueEvent::ChunkError {
            error: "That wallet is locked now".to_string(),
            wallet_changed: true,
        });
        // Now moving source c.
        assert_eq!(*actor.state(), ImportQueueState::Moving);
        assert_eq!(actor.context().moving[0].source_id, "c");
        actor.send(ImportQueueEvent::ChunkDone {
            output: ImportItemsResult {
                results: vec![ImportItemAnswer {
                    outpoint: op(3),
                    result: moved_res(),
                }],
                stopped: None,
            },
        });
        assert_eq!(*actor.state(), ImportQueueState::Idle);
        assert_eq!(actor.context().reports["a"].tone, ImportNoticeTone::Danger);
        assert_eq!(actor.context().reports["b"].tone, ImportNoticeTone::Danger);
        assert_eq!(actor.context().reports["c"].tone, ImportNoticeTone::Success);
    }

    #[test]
    fn ignores_duplicates_dismisses_reports_and_chunks_by_head_source_and_wallet() {
        let mut actor = EffectActor::<ImportQueueMachine>::default();
        let mut dup = items(1, 2);
        dup.extend(items(1, 1));
        actor.send(ImportQueueEvent::Enqueue {
            source_id: "a".to_string(),
            identity_key: "id1".to_string(),
            items: dup,
        });
        assert_eq!(actor.context().moving.len(), 2);
        actor.send(ImportQueueEvent::ChunkDone {
            output: ImportItemsResult {
                results: vec![
                    ImportItemAnswer {
                        outpoint: op(1),
                        result: moved_res(),
                    },
                    ImportItemAnswer {
                        outpoint: op(2),
                        result: moved_res(),
                    },
                ],
                stopped: None,
            },
        });
        actor.send(ImportQueueEvent::Dismiss {
            source_id: "a".to_string(),
        });
        assert!(!actor.context().reports.contains_key("a"));

        let e = |source_id: &str, identity_key: &str, n: usize| ImportQueueEntry {
            source_id: source_id.to_string(),
            identity_key: identity_key.to_string(),
            outpoint: op(n),
        };
        assert_eq!(
            next_chunk(&[e("a", "k", 1), e("b", "k", 2), e("a", "j", 3), e("a", "k", 4)]),
            vec![e("a", "k", 1), e("a", "k", 4)]
        );
        assert!(next_chunk(&[]).is_empty());
    }
}
