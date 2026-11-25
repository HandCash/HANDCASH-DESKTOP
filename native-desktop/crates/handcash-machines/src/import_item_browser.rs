// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/importItemBrowserMachine.ts` (5-region parallel chart).

use std::collections::{BTreeMap, BTreeSet};

pub use crate::import_queue::{
    batch_notice, notice_for, ImportItemAnswer, ImportItemNotice, ImportItemResult,
    ImportItemResultKind, ImportNoticeOutcome, ImportNoticeTone, ImportQueueEnqueueItem,
    ImportSourceView, IMPORT_CHUNK,
};
use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const IMPORT_PAGE_SIZE: usize = 60;
pub const SHELF_REREAD_MS: u64 = 1_200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportItem {
    pub outpoint: String,
    pub name: Option<String>,
    pub group: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportItemChange {
    pub added: usize,
    pub gone: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportItemPage {
    pub items: Vec<ImportItem>,
    pub last: Option<usize>,
    pub more: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportItemShelf {
    pub key: String,
    pub count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImportItemSync {
    pub complete: bool,
    pub total: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportSelection {
    pub outpoint: String,
    pub group: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncRegionState {
    Checking,
    Done,
    Failed,
}

impl SyncRegionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Checking => "checking",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShelvesRegionState {
    Reading,
    Idle,
    Settling,
    Failed,
}

impl ShelvesRegionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Reading => "reading",
            Self::Idle => "idle",
            Self::Settling => "settling",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageRegionState {
    Routing,
    Closed,
    Reading,
    Ready,
    Failed,
}

impl PageRegionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Routing => "routing",
            Self::Closed => "closed",
            Self::Reading => "reading",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GatherRegionState {
    Idle,
    Reading,
}

impl GatherRegionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Reading => "reading",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveRegionState {
    Idle,
    Confirming,
}

impl MoveRegionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Confirming => "confirming",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImportItemBrowserState {
    pub sync: SyncRegionState,
    pub shelves: ShelvesRegionState,
    pub page: PageRegionState,
    pub gather: GatherRegionState,
    pub mv: MoveRegionState,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportItemBrowserInput {
    pub source_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportItemBrowserContext {
    pub source_id: String,
    pub shelves: Vec<ImportItemShelf>,
    pub shelves_stale: bool,
    pub complete: bool,
    pub sync_error: Option<String>,
    pub read_error: Option<String>,
    pub open: Option<String>,
    pub query: String,
    pub items: Vec<ImportItem>,
    pub last: Option<usize>,
    pub more: bool,
    pub grew: bool,
    pub selected: Vec<ImportSelection>,
    pub gathering: Option<String>,
    pub queue: ImportSourceView,
    pub notice: Option<ImportItemNotice>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportItemBrowserEvent {
    Changed {
        change: ImportItemChange,
    },
    Synced {
        sync: ImportItemSync,
    },
    SyncFailed {
        error: String,
    },
    ReadShelvesDone {
        shelves: Vec<ImportItemShelf>,
    },
    ReadShelvesError {
        error: String,
    },
    ShelfRereadElapsed,
    ReadPageDone {
        page: ImportItemPage,
    },
    ReadPageError {
        error: String,
    },
    ShelfOutpointsDone {
        outpoints: Vec<String>,
    },
    ShelfOutpointsError {
        error: String,
    },
    QueueView {
        view: ImportSourceView,
    },
    Answered {
        results: Vec<ImportItemAnswer>,
    },
    Retry,
    Open {
        group: Option<String>,
    },
    Filter {
        query: String,
    },
    More,
    Select {
        items: Vec<ImportSelection>,
        checked: bool,
    },
    SelectShelf {
        group: String,
        checked: bool,
    },
    Clear,
    Import {
        outpoint: String,
    },
    ImportSelected,
    Confirm,
    Cancel,
    EnqueueRefused {
        error: String,
    },
    Stop,
    Dismiss,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportItemBrowserEffect {
    StartSync {
        source_id: String,
    },
    ReadShelves {
        source_id: String,
    },
    ScheduleShelfReread {
        delay_ms: u64,
    },
    ReadPage {
        source_id: String,
        open: Option<String>,
        query: String,
        after: Option<usize>,
        limit: usize,
    },
    ReadShelfOutpoints {
        source_id: String,
        group: String,
    },
    Enqueue {
        source_id: String,
        items: Vec<ImportQueueEnqueueItem>,
    },
    Stop {
        source_id: String,
    },
    DismissReport {
        source_id: String,
    },
}

pub fn selected_per_shelf(selected: &[ImportSelection]) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for sel in selected {
        *out.entry(sel.group.clone()).or_insert(0) += 1;
    }
    out
}

pub fn shelved_total(shelves: &[ImportItemShelf]) -> usize {
    shelves.iter().map(|s| s.count).sum()
}

pub fn queued_outpoints(view: &ImportSourceView) -> (BTreeSet<String>, BTreeSet<String>) {
    match &view.run {
        Some(run) => (
            run.moving.iter().cloned().collect(),
            run.waiting.iter().cloned().collect(),
        ),
        None => (BTreeSet::new(), BTreeSet::new()),
    }
}

fn with_selection(
    selected: &[ImportSelection],
    items: &[ImportSelection],
    checked: bool,
) -> Vec<ImportSelection> {
    let touched: BTreeSet<&str> = items.iter().map(|i| i.outpoint.as_str()).collect();
    let mut rest: Vec<ImportSelection> = selected
        .iter()
        .filter(|s| !touched.contains(s.outpoint.as_str()))
        .cloned()
        .collect();
    if checked {
        rest.extend(items.iter().cloned());
    }
    rest
}

fn apply_change(
    state: &mut ImportItemBrowserState,
    ctx: &mut ImportItemBrowserContext,
    change: ImportItemChange,
    effects: &mut Vec<ImportItemBrowserEffect>,
) {
    let gone: BTreeSet<String> = change.gone.into_iter().collect();
    ctx.shelves_stale = true;
    if !gone.is_empty() {
        ctx.items.retain(|i| !gone.contains(&i.outpoint));
        ctx.selected.retain(|s| !gone.contains(&s.outpoint));
    }
    ctx.grew = ctx.grew || change.added > 0;
    ctx.more = ctx.more || change.added > 0;
    settle_shelves_always(state, ctx, effects);
}

fn settle_shelves_always(
    state: &mut ImportItemBrowserState,
    ctx: &ImportItemBrowserContext,
    effects: &mut Vec<ImportItemBrowserEffect>,
) {
    if state.shelves == ShelvesRegionState::Idle && ctx.shelves_stale {
        state.shelves = ShelvesRegionState::Settling;
        effects.push(ImportItemBrowserEffect::ScheduleShelfReread {
            delay_ms: SHELF_REREAD_MS,
        });
    }
}

fn route_page(
    state: &mut ImportItemBrowserState,
    ctx: &mut ImportItemBrowserContext,
    effects: &mut Vec<ImportItemBrowserEffect>,
) {
    let showing = ctx.open.is_some() || !ctx.query.trim().is_empty();
    if showing {
        ctx.grew = false;
        state.page = PageRegionState::Reading;
        effects.push(ImportItemBrowserEffect::ReadPage {
            source_id: ctx.source_id.clone(),
            open: ctx.open.clone(),
            query: ctx.query.clone(),
            after: ctx.last,
            limit: IMPORT_PAGE_SIZE,
        });
    } else {
        state.page = PageRegionState::Closed;
    }
}

fn emit_enqueue(
    ctx: &mut ImportItemBrowserContext,
    outpoints: Vec<String>,
    clear_selection: bool,
    effects: &mut Vec<ImportItemBrowserEffect>,
) {
    if outpoints.is_empty() {
        return;
    }
    let names: BTreeMap<&str, Option<&str>> = ctx
        .items
        .iter()
        .map(|i| (i.outpoint.as_str(), i.name.as_deref()))
        .collect();
    let items = outpoints
        .into_iter()
        .map(|outpoint| ImportQueueEnqueueItem {
            name: names.get(outpoint.as_str()).and_then(|n| *n).map(str::to_string),
            outpoint,
        })
        .collect();
    effects.push(ImportItemBrowserEffect::Enqueue {
        source_id: ctx.source_id.clone(),
        items,
    });
    ctx.notice = None;
    if clear_selection {
        ctx.selected.clear();
    }
}

pub struct ImportItemBrowserMachine;

impl Statechart for ImportItemBrowserMachine {
    type State = ImportItemBrowserState;
    type Context = ImportItemBrowserContext;
    type Event = ImportItemBrowserEvent;
    type Input = ImportItemBrowserInput;

    const ID: &'static str = "importItemBrowser";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            ImportItemBrowserState {
                sync: SyncRegionState::Checking,
                shelves: ShelvesRegionState::Reading,
                page: PageRegionState::Closed,
                gather: GatherRegionState::Idle,
                mv: MoveRegionState::Idle,
            },
            ImportItemBrowserContext {
                source_id: input.source_id,
                ..ImportItemBrowserContext::default()
            },
        )
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        StateValue::parallel(vec![
            ("sync", StateValue::leaf(state.sync.as_str())),
            ("shelves", StateValue::leaf(state.shelves.as_str())),
            ("page", StateValue::leaf(state.page.as_str())),
            ("gather", StateValue::leaf(state.gather.as_str())),
            ("move", StateValue::leaf(state.mv.as_str())),
        ])
    }
}

impl HandCashChart for ImportItemBrowserMachine {
    const MANIFEST_ID: &'static str = "importItemBrowser";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["sync", "shelves", "page", "gather", "move"];
    type Effect = ImportItemBrowserEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        use ImportItemBrowserEvent as E;

        let mut state = snapshot.value;
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let mut handled = false;

        match event {
            E::Changed { change } => {
                apply_change(&mut state, &mut ctx, change, &mut effects);
                handled = true;
            }
            E::QueueView { view } => {
                ctx.queue = view;
                handled = true;
            }
            E::Answered { results } => {
                let names: BTreeMap<&str, Option<&str>> = ctx
                    .items
                    .iter()
                    .map(|i| (i.outpoint.as_str(), i.name.as_deref()))
                    .collect();
                let gone: Vec<String> = results
                    .into_iter()
                    .filter(|ans| {
                        let name = names.get(ans.outpoint.as_str()).and_then(|n| *n);
                        !notice_for(name, &ans.result).1
                    })
                    .map(|ans| ans.outpoint)
                    .collect();
                if !gone.is_empty() {
                    apply_change(
                        &mut state,
                        &mut ctx,
                        ImportItemChange { added: 0, gone },
                        &mut effects,
                    );
                }
                handled = true;
            }
            E::Select { items, checked } => {
                ctx.selected = with_selection(&ctx.selected, &items, checked);
                handled = true;
            }
            E::SelectShelf { group, checked } => {
                if !checked {
                    ctx.selected.retain(|s| s.group != group);
                    handled = true;
                } else if state.gather == GatherRegionState::Idle {
                    ctx.gathering = Some(group.clone());
                    state.gather = GatherRegionState::Reading;
                    effects.push(ImportItemBrowserEffect::ReadShelfOutpoints {
                        source_id: ctx.source_id.clone(),
                        group,
                    });
                    handled = true;
                }
            }
            E::Clear => {
                ctx.selected.clear();
                handled = true;
            }
            E::Stop => {
                effects.push(ImportItemBrowserEffect::Stop {
                    source_id: ctx.source_id.clone(),
                });
                handled = true;
            }
            E::Dismiss => {
                if ctx.notice.is_some() {
                    ctx.notice = None;
                } else if ctx.queue.report.is_some() {
                    effects.push(ImportItemBrowserEffect::DismissReport {
                        source_id: ctx.source_id.clone(),
                    });
                }
                handled = true;
            }
            E::Synced { sync } => {
                if state.sync == SyncRegionState::Checking {
                    state.sync = SyncRegionState::Done;
                    ctx.complete = sync.complete;
                    ctx.shelves_stale = true;
                    settle_shelves_always(&mut state, &ctx, &mut effects);
                    handled = true;
                }
            }
            E::SyncFailed { error } => {
                if state.sync == SyncRegionState::Checking {
                    state.sync = SyncRegionState::Failed;
                    ctx.sync_error = Some(error);
                    handled = true;
                }
            }
            E::ReadShelvesDone { shelves } => {
                if state.shelves == ShelvesRegionState::Reading {
                    ctx.shelves = shelves;
                    state.shelves = ShelvesRegionState::Idle;
                    settle_shelves_always(&mut state, &ctx, &mut effects);
                    handled = true;
                }
            }
            E::ReadShelvesError { error } => {
                if state.shelves == ShelvesRegionState::Reading {
                    ctx.read_error = Some(error);
                    state.shelves = ShelvesRegionState::Failed;
                    handled = true;
                }
            }
            E::ShelfRereadElapsed => {
                if state.shelves == ShelvesRegionState::Settling {
                    ctx.shelves_stale = false;
                    state.shelves = ShelvesRegionState::Reading;
                    effects.push(ImportItemBrowserEffect::ReadShelves {
                        source_id: ctx.source_id.clone(),
                    });
                    handled = true;
                }
            }
            E::Open { group } => {
                if group != ctx.open {
                    ctx.open = group;
                    ctx.items.clear();
                    ctx.last = None;
                    ctx.more = false;
                    ctx.read_error = None;
                    route_page(&mut state, &mut ctx, &mut effects);
                    handled = true;
                }
            }
            E::Filter { query } => {
                ctx.query = query;
                ctx.items.clear();
                ctx.last = None;
                ctx.more = false;
                ctx.read_error = None;
                route_page(&mut state, &mut ctx, &mut effects);
                handled = true;
            }
            E::ReadPageDone { page } => {
                if state.page == PageRegionState::Reading {
                    let known: BTreeSet<String> =
                        ctx.items.iter().map(|i| i.outpoint.clone()).collect();
                    for item in page.items {
                        if !known.contains(&item.outpoint) {
                            ctx.items.push(item);
                        }
                    }
                    if page.last.is_some() {
                        ctx.last = page.last;
                    }
                    ctx.more = page.more || ctx.grew;
                    state.page = PageRegionState::Ready;
                    handled = true;
                }
            }
            E::ReadPageError { error } => {
                if state.page == PageRegionState::Reading {
                    ctx.read_error = Some(error);
                    state.page = PageRegionState::Failed;
                    handled = true;
                }
            }
            E::More => {
                if state.page == PageRegionState::Ready && ctx.more {
                    ctx.grew = false;
                    state.page = PageRegionState::Reading;
                    effects.push(ImportItemBrowserEffect::ReadPage {
                        source_id: ctx.source_id.clone(),
                        open: ctx.open.clone(),
                        query: ctx.query.clone(),
                        after: ctx.last,
                        limit: IMPORT_PAGE_SIZE,
                    });
                    handled = true;
                }
            }
            E::ShelfOutpointsDone { outpoints } => {
                if state.gather == GatherRegionState::Reading {
                    if let Some(group) = ctx.gathering.take() {
                        let gathered: Vec<ImportSelection> = outpoints
                            .into_iter()
                            .map(|outpoint| ImportSelection {
                                outpoint,
                                group: group.clone(),
                            })
                            .collect();
                        ctx.selected = with_selection(&ctx.selected, &gathered, true);
                    }
                    state.gather = GatherRegionState::Idle;
                    handled = true;
                }
            }
            E::ShelfOutpointsError { error } => {
                if state.gather == GatherRegionState::Reading {
                    ctx.gathering = None;
                    ctx.read_error = Some(error);
                    state.gather = GatherRegionState::Idle;
                    handled = true;
                }
            }
            E::Retry => {
                if state.sync == SyncRegionState::Failed {
                    ctx.sync_error = None;
                    state.sync = SyncRegionState::Checking;
                    effects.push(ImportItemBrowserEffect::StartSync {
                        source_id: ctx.source_id.clone(),
                    });
                    handled = true;
                }
                if state.shelves == ShelvesRegionState::Failed {
                    ctx.shelves_stale = false;
                    state.shelves = ShelvesRegionState::Reading;
                    effects.push(ImportItemBrowserEffect::ReadShelves {
                        source_id: ctx.source_id.clone(),
                    });
                    handled = true;
                }
                if state.page == PageRegionState::Failed {
                    ctx.read_error = None;
                    ctx.grew = false;
                    state.page = PageRegionState::Reading;
                    effects.push(ImportItemBrowserEffect::ReadPage {
                        source_id: ctx.source_id.clone(),
                        open: ctx.open.clone(),
                        query: ctx.query.clone(),
                        after: ctx.last,
                        limit: IMPORT_PAGE_SIZE,
                    });
                    handled = true;
                }
            }
            E::Import { outpoint } => {
                if state.mv == MoveRegionState::Idle {
                    emit_enqueue(&mut ctx, vec![outpoint], false, &mut effects);
                    handled = true;
                }
            }
            E::ImportSelected => {
                if state.mv == MoveRegionState::Idle {
                    if ctx.selected.len() == 1 {
                        let outpoints = vec![ctx.selected[0].outpoint.clone()];
                        emit_enqueue(&mut ctx, outpoints, true, &mut effects);
                        handled = true;
                    } else if !ctx.selected.is_empty() {
                        state.mv = MoveRegionState::Confirming;
                        handled = true;
                    }
                }
            }
            E::Confirm => {
                if state.mv == MoveRegionState::Confirming {
                    if !ctx.selected.is_empty() {
                        let outpoints: Vec<String> =
                            ctx.selected.iter().map(|s| s.outpoint.clone()).collect();
                        emit_enqueue(&mut ctx, outpoints, true, &mut effects);
                    }
                    state.mv = MoveRegionState::Idle;
                    handled = true;
                }
            }
            E::Cancel => {
                if state.mv == MoveRegionState::Confirming {
                    state.mv = MoveRegionState::Idle;
                    handled = true;
                }
            }
            E::EnqueueRefused { error } => {
                ctx.notice = Some(ImportItemNotice {
                    tone: ImportNoticeTone::Danger,
                    outcome: ImportNoticeOutcome::Item(ImportItemResultKind::Failed),
                    title: "Items not imported".to_string(),
                    body: error,
                });
                handled = true;
            }
        }

        if !handled {
            return (snapshot.clone(), Vec::new());
        }
        (Snapshot::new(state, ctx), effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_queue::ImportTally;
    use crate::EffectActor;

    fn op(n: usize) -> String {
        format!("{}_{n}", "a".repeat(64))
    }

    fn item(n: usize, group: &str) -> ImportItem {
        ImportItem {
            outpoint: op(n),
            name: Some(format!("Item {n}")),
            group: group.to_string(),
        }
    }

    #[test]
    fn reads_shelves_pages_filters_and_completes_sync() {
        let mut actor = EffectActor::<ImportItemBrowserMachine>::new(ImportItemBrowserInput {
            source_id: "s1".to_string(),
        });
        assert_eq!(actor.state().sync, SyncRegionState::Checking);
        actor.send(ImportItemBrowserEvent::ReadShelvesDone {
            shelves: vec![
                ImportItemShelf {
                    key: "zoo".to_string(),
                    count: 70,
                },
                ImportItemShelf {
                    key: "alpha".to_string(),
                    count: 1,
                },
            ],
        });
        assert_eq!(actor.state().shelves, ShelvesRegionState::Idle);
        assert_eq!(shelved_total(&actor.context().shelves), 71);

        let open_effects = actor.send(ImportItemBrowserEvent::Open {
            group: Some("zoo".to_string()),
        });
        assert_eq!(actor.state().page, PageRegionState::Reading);
        assert_eq!(
            open_effects,
            vec![ImportItemBrowserEffect::ReadPage {
                source_id: "s1".to_string(),
                open: Some("zoo".to_string()),
                query: String::new(),
                after: None,
                limit: IMPORT_PAGE_SIZE,
            }]
        );
        actor.send(ImportItemBrowserEvent::ReadPageDone {
            page: ImportItemPage {
                items: (0..60).map(|i| item(i + 1, "zoo")).collect(),
                last: Some(59),
                more: true,
            },
        });
        assert_eq!(actor.state().page, PageRegionState::Ready);
        assert_eq!(actor.context().items.len(), 60);
        assert!(actor.context().more);

        let more_effects = actor.send(ImportItemBrowserEvent::More);
        assert_eq!(
            more_effects,
            vec![ImportItemBrowserEffect::ReadPage {
                source_id: "s1".to_string(),
                open: Some("zoo".to_string()),
                query: String::new(),
                after: Some(59),
                limit: IMPORT_PAGE_SIZE,
            }]
        );
        actor.send(ImportItemBrowserEvent::ReadPageDone {
            page: ImportItemPage {
                items: (60..70).map(|i| item(i + 1, "zoo")).collect(),
                last: Some(69),
                more: false,
            },
        });
        assert_eq!(actor.context().items.len(), 70);
        assert!(!actor.context().more);

        actor.send(ImportItemBrowserEvent::Synced {
            sync: ImportItemSync {
                complete: true,
                total: 71,
            },
        });
        assert_eq!(actor.state().sync, SyncRegionState::Done);
        assert!(actor.context().complete);
    }

    #[test]
    fn rereads_shelves_after_settling_and_drops_gone_items() {
        let mut actor = EffectActor::<ImportItemBrowserMachine>::new(ImportItemBrowserInput {
            source_id: "s1".to_string(),
        });
        actor.send(ImportItemBrowserEvent::ReadShelvesDone {
            shelves: vec![ImportItemShelf {
                key: "zoo".to_string(),
                count: 2,
            }],
        });
        actor.send(ImportItemBrowserEvent::Open {
            group: Some("zoo".to_string()),
        });
        actor.send(ImportItemBrowserEvent::ReadPageDone {
            page: ImportItemPage {
                items: vec![item(1, "zoo"), item(2, "zoo")],
                last: Some(1),
                more: false,
            },
        });
        let e1 = actor.send(ImportItemBrowserEvent::Changed {
            change: ImportItemChange {
                added: 1,
                gone: Vec::new(),
            },
        });
        assert_eq!(actor.state().shelves, ShelvesRegionState::Settling);
        assert_eq!(
            e1,
            vec![ImportItemBrowserEffect::ScheduleShelfReread {
                delay_ms: SHELF_REREAD_MS
            }]
        );
        actor.send(ImportItemBrowserEvent::Changed {
            change: ImportItemChange {
                added: 0,
                gone: vec![op(1)],
            },
        });
        assert_eq!(
            actor
                .context()
                .items
                .iter()
                .map(|i| i.outpoint.clone())
                .collect::<Vec<_>>(),
            vec![op(2)]
        );
        assert!(actor.context().more);
        let reread = actor.send(ImportItemBrowserEvent::ShelfRereadElapsed);
        assert_eq!(actor.state().shelves, ShelvesRegionState::Reading);
        assert_eq!(
            reread,
            vec![ImportItemBrowserEffect::ReadShelves {
                source_id: "s1".to_string()
            }]
        );
    }

    #[test]
    fn gathers_shelf_confirms_multi_selection_and_drops_answered_moved_rows() {
        let mut actor = EffectActor::<ImportItemBrowserMachine>::new(ImportItemBrowserInput {
            source_id: "s1".to_string(),
        });
        actor.send(ImportItemBrowserEvent::Open {
            group: Some("zoo".to_string()),
        });
        actor.send(ImportItemBrowserEvent::ReadPageDone {
            page: ImportItemPage {
                items: vec![item(1, "zoo"), item(2, "zoo")],
                last: Some(1),
                more: false,
            },
        });
        let g = actor.send(ImportItemBrowserEvent::SelectShelf {
            group: "zoo".to_string(),
            checked: true,
        });
        assert_eq!(actor.state().gather, GatherRegionState::Reading);
        assert_eq!(
            g,
            vec![ImportItemBrowserEffect::ReadShelfOutpoints {
                source_id: "s1".to_string(),
                group: "zoo".to_string(),
            }]
        );
        actor.send(ImportItemBrowserEvent::ShelfOutpointsDone {
            outpoints: vec![op(1), op(2)],
        });
        assert_eq!(actor.state().gather, GatherRegionState::Idle);
        actor.send(ImportItemBrowserEvent::Select {
            items: vec![ImportSelection {
                outpoint: op(3),
                group: "alpha".to_string(),
            }],
            checked: true,
        });
        let per = selected_per_shelf(&actor.context().selected);
        assert_eq!(per.get("zoo"), Some(&2));
        assert_eq!(per.get("alpha"), Some(&1));

        actor.send(ImportItemBrowserEvent::ImportSelected);
        assert_eq!(actor.state().mv, MoveRegionState::Confirming);
        let effects = actor.send(ImportItemBrowserEvent::Confirm);
        assert_eq!(actor.state().mv, MoveRegionState::Idle);
        assert!(actor.context().selected.is_empty());
        assert!(matches!(effects.as_slice(), [ImportItemBrowserEffect::Enqueue { items, .. }] if items.len() == 3));

        actor.send(ImportItemBrowserEvent::Answered {
            results: vec![ImportItemAnswer {
                outpoint: op(1),
                result: ImportItemResult {
                    kind: ImportItemResultKind::Moved,
                    message: String::new(),
                },
            }],
        });
        assert_eq!(actor.context().items.len(), 1);
        assert_eq!(actor.context().items[0].outpoint, op(2));
    }

    #[test]
    fn retries_failed_sync_and_preserves_notices_and_batch_summaries() {
        let mut actor = EffectActor::<ImportItemBrowserMachine>::new(ImportItemBrowserInput {
            source_id: "s1".to_string(),
        });
        actor.send(ImportItemBrowserEvent::SyncFailed {
            error: "index down".to_string(),
        });
        assert_eq!(actor.state().sync, SyncRegionState::Failed);
        assert_eq!(actor.context().sync_error.as_deref(), Some("index down"));
        let retry = actor.send(ImportItemBrowserEvent::Retry);
        assert_eq!(actor.state().sync, SyncRegionState::Checking);
        assert_eq!(
            retry,
            vec![ImportItemBrowserEffect::StartSync {
                source_id: "s1".to_string()
            }]
        );

        actor.send(ImportItemBrowserEvent::EnqueueRefused {
            error: "Unlock this wallet first".to_string(),
        });
        assert_eq!(
            actor.context().notice.as_ref().unwrap().body,
            "Unlock this wallet first"
        );
        actor.send(ImportItemBrowserEvent::Dismiss);
        assert_eq!(actor.context().notice, None);

        let (moved_n, moved_keep) = notice_for(
            Some("A"),
            &ImportItemResult {
                kind: ImportItemResultKind::Moved,
                message: String::new(),
            },
        );
        assert!(!moved_keep);
        assert_eq!(moved_n.title, "A imported");
        let (_, skipped_keep) = notice_for(
            Some("A"),
            &ImportItemResult {
                kind: ImportItemResultKind::Skipped,
                message: "m".to_string(),
            },
        );
        assert!(!skipped_keep);
        let (failed_n, failed_keep) = notice_for(
            None,
            &ImportItemResult {
                kind: ImportItemResultKind::Failed,
                message: "m".to_string(),
            },
        );
        assert!(failed_keep);
        assert_eq!(failed_n.title, "Item not imported");

        let bn = batch_notice(&ImportTally {
            total: 4,
            moved: 3,
            failure: Some(ImportItemNotice {
                tone: ImportNoticeTone::Danger,
                outcome: ImportNoticeOutcome::Item(ImportItemResultKind::Failed),
                title: "B not imported".to_string(),
                body: "boom".to_string(),
            }),
            stopped: false,
            last: None,
        });
        assert_eq!(bn.tone, ImportNoticeTone::Danger);
        assert_eq!(bn.title, "3 of 4 imported");
        assert_eq!(bn.body, "B not imported: boom");
    }
}
