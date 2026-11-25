// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/notesMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub id: String,
    pub body: String,
    pub saved_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotesState {
    Opening,
    Failed,
    List,
    Editing,
    Saving,
    Deleting,
}

impl NotesState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Failed => "failed",
            Self::List => "list",
            Self::Editing => "editing",
            Self::Saving => "saving",
            Self::Deleting => "deleting",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NotesContext {
    pub notes: Vec<Note>,
    pub unreadable: u32,
    pub note_id: Option<String>,
    pub draft: String,
    pub original: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotesEvent {
    OpenDone { notes: Vec<Note>, unreadable: u32 },
    OpenError { error: String },
    New,
    Open { id: String },
    Edit { body: String },
    Done,
    SaveDone { note: Option<Note> },
    SaveError { error: String },
    Delete,
    DeleteDone,
    DeleteError { error: String },
    Retry,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotesEffect {
    Open,
    Save { id: Option<String>, body: String },
    Remove { id: String },
}

pub struct NotesMachine;

impl Statechart for NotesMachine {
    type State = NotesState;
    type Context = NotesContext;
    type Event = NotesEvent;
    type Input = ();

    const ID: &'static str = "notes";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(NotesState::Opening, NotesContext::default())
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

fn enter_list(ctx: &mut NotesContext) -> NotesState {
    ctx.note_id = None;
    ctx.draft.clear();
    ctx.original.clear();
    ctx.error = None;
    NotesState::List
}

impl HandCashChart for NotesMachine {
    const MANIFEST_ID: &'static str = "notes";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["opening", "failed", "list", "editing", "saving", "deleting"];
    type Effect = NotesEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (NotesState::Opening, NotesEvent::OpenDone { notes, unreadable }) => {
                ctx.notes = notes;
                ctx.unreadable = unreadable;
                enter_list(&mut ctx)
            }
            (NotesState::Opening, NotesEvent::OpenError { error }) => {
                ctx.error = Some(error);
                NotesState::Failed
            }
            (NotesState::Failed, NotesEvent::Retry) => {
                ctx.error = None;
                effects.push(NotesEffect::Open);
                NotesState::Opening
            }
            (NotesState::List, NotesEvent::New) => NotesState::Editing,
            (NotesState::List, NotesEvent::Open { id }) => {
                let body = ctx
                    .notes
                    .iter()
                    .find(|n| n.id == id)
                    .map(|n| n.body.clone())
                    .unwrap_or_default();
                ctx.note_id = Some(id);
                ctx.draft = body.clone();
                ctx.original = body;
                NotesState::Editing
            }
            (NotesState::Editing, NotesEvent::Edit { body }) => {
                ctx.draft = body;
                NotesState::Editing
            }
            (NotesState::Editing, NotesEvent::Done) => {
                if ctx.draft != ctx.original {
                    effects.push(NotesEffect::Save {
                        id: ctx.note_id.clone(),
                        body: ctx.draft.clone(),
                    });
                    NotesState::Saving
                } else {
                    enter_list(&mut ctx)
                }
            }
            (NotesState::Editing, NotesEvent::Delete) => {
                if let Some(id) = ctx.note_id.clone() {
                    effects.push(NotesEffect::Remove { id });
                    NotesState::Deleting
                } else {
                    enter_list(&mut ctx)
                }
            }
            (NotesState::Saving, NotesEvent::SaveDone { note }) => {
                let current_id = ctx.note_id.clone();
                ctx.notes.retain(|n| Some(&n.id) != current_id.as_ref());
                if let Some(saved) = note {
                    ctx.notes.insert(0, saved);
                }
                enter_list(&mut ctx)
            }
            (NotesState::Saving, NotesEvent::SaveError { error }) => {
                ctx.error = Some(error);
                NotesState::Editing
            }
            (NotesState::Deleting, NotesEvent::DeleteDone) => {
                let current_id = ctx.note_id.clone();
                ctx.notes.retain(|n| Some(&n.id) != current_id.as_ref());
                enter_list(&mut ctx)
            }
            (NotesState::Deleting, NotesEvent::DeleteError { error }) => {
                ctx.error = Some(error);
                NotesState::Editing
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn note(id: &str, body: &str) -> Note {
        Note {
            id: id.to_string(),
            body: body.to_string(),
            saved_at: 1,
        }
    }

    fn opened() -> EffectActor<NotesMachine> {
        let mut actor = EffectActor::<NotesMachine>::default();
        actor.send(NotesEvent::OpenDone {
            notes: vec![note("a", "alpha")],
            unreadable: 0,
        });
        actor
    }

    #[test]
    fn opens_to_the_list_saves_a_changed_note_and_lists_it_first() {
        let mut actor = opened();
        actor.send(NotesEvent::New);
        actor.send(NotesEvent::Edit {
            body: "beta".to_string(),
        });
        let fx = actor.send(NotesEvent::Done);
        assert_eq!(*actor.state(), NotesState::Saving);
        assert_eq!(
            fx,
            vec![NotesEffect::Save {
                id: None,
                body: "beta".to_string()
            }]
        );
        actor.send(NotesEvent::SaveDone {
            note: Some(note("new", "beta")),
        });
        assert_eq!(*actor.state(), NotesState::List);
        let bodies: Vec<&str> = actor.context().notes.iter().map(|n| n.body.as_str()).collect();
        assert_eq!(bodies, vec!["beta", "alpha"]);
    }

    #[test]
    fn done_without_a_change_saves_nothing() {
        let mut actor = opened();
        actor.send(NotesEvent::Open {
            id: "a".to_string(),
        });
        assert_eq!(actor.context().draft, "alpha");
        let fx = actor.send(NotesEvent::Done);
        assert_eq!(*actor.state(), NotesState::List);
        assert!(fx.is_empty());
    }

    #[test]
    fn failed_save_returns_to_editing_with_the_draft_and_the_reason() {
        let mut actor = opened();
        actor.send(NotesEvent::Open {
            id: "a".to_string(),
        });
        actor.send(NotesEvent::Edit {
            body: "alpha 2".to_string(),
        });
        actor.send(NotesEvent::Done);
        actor.send(NotesEvent::SaveError {
            error: "Could not save the note on this device".to_string(),
        });
        assert_eq!(*actor.state(), NotesState::Editing);
        assert_eq!(actor.context().draft, "alpha 2");
        assert_eq!(
            actor.context().error.as_deref(),
            Some("Could not save the note on this device")
        );
    }

    #[test]
    fn deletes_a_saved_note_while_a_new_one_is_just_discarded() {
        let mut actor = opened();
        actor.send(NotesEvent::New);
        let fx = actor.send(NotesEvent::Delete);
        assert_eq!(*actor.state(), NotesState::List);
        assert!(fx.is_empty());

        actor.send(NotesEvent::Open {
            id: "a".to_string(),
        });
        let fx = actor.send(NotesEvent::Delete);
        assert_eq!(*actor.state(), NotesState::Deleting);
        assert_eq!(fx, vec![NotesEffect::Remove { id: "a".to_string() }]);
        actor.send(NotesEvent::DeleteDone);
        assert_eq!(*actor.state(), NotesState::List);
        assert!(actor.context().notes.is_empty());
    }

    #[test]
    fn names_an_open_failure_and_retries() {
        let mut actor = EffectActor::<NotesMachine>::default();
        actor.send(NotesEvent::OpenError {
            error: "No account is open".to_string(),
        });
        assert_eq!(*actor.state(), NotesState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("No account is open"));
        let fx = actor.send(NotesEvent::Retry);
        assert_eq!(*actor.state(), NotesState::Opening);
        assert_eq!(fx, vec![NotesEffect::Open]);
        actor.send(NotesEvent::OpenDone {
            notes: Vec::new(),
            unreadable: 0,
        });
        assert_eq!(*actor.state(), NotesState::List);
    }
}
