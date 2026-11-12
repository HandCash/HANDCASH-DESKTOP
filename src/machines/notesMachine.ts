import { assign, fromPromise, setup } from 'xstate'
import type { Note, OpenedNotes } from '../wallet/notes/noteStore'

export type NotesPorts = {
  open: () => Promise<OpenedNotes>
  save: (id: string | null, body: string) => Promise<Note | null>
  remove: (id: string) => Promise<void>
}

type Context = {
  ports: NotesPorts
  notes: Note[]
  unreadable: number
  noteId: string | null
  draft: string
  original: string
  error: string | null
}

const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong')

/**
 * Chart: notes — private notes, sealed per note.
 * opening (unseal in memory) → list | failed; list → editing (new or open);
 * editing → saving (on Done, when changed) | deleting → list. A failed save
 * or delete returns to editing with the draft kept and the reason named.
 */
export const notesMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { ports: NotesPorts },
    events: {} as
      | { type: 'NEW' }
      | { type: 'OPEN'; id: string }
      | { type: 'EDIT'; body: string }
      | { type: 'DONE' }
      | { type: 'DELETE' }
      | { type: 'RETRY' },
  },
  actors: {
    open: fromPromise(({ input }: { input: NotesPorts }) => input.open()),
    save: fromPromise(({ input }: { input: { ports: NotesPorts; id: string | null; body: string } }) =>
      input.ports.save(input.id, input.body),
    ),
    remove: fromPromise(({ input }: { input: { ports: NotesPorts; id: string } }) => input.ports.remove(input.id)),
  },
  guards: {
    changed: ({ context }) => context.draft !== context.original,
    saved: ({ context }) => context.noteId !== null,
  },
}).createMachine({
  id: 'notes',
  initial: 'opening',
  context: ({ input }) => ({
    ports: input.ports,
    notes: [],
    unreadable: 0,
    noteId: null,
    draft: '',
    original: '',
    error: null,
  }),
  states: {
    opening: {
      invoke: {
        src: 'open',
        input: ({ context }) => context.ports,
        onDone: {
          target: 'list',
          actions: assign({ notes: ({ event }) => event.output.notes, unreadable: ({ event }) => event.output.unreadable }),
        },
        onError: { target: 'failed', actions: assign({ error: ({ event }) => message(event.error) }) },
      },
    },
    failed: { on: { RETRY: { target: 'opening', actions: assign({ error: null }) } } },
    list: {
      entry: assign({ noteId: null, draft: '', original: '', error: null }),
      on: {
        NEW: 'editing',
        OPEN: {
          target: 'editing',
          actions: assign(({ context, event }) => {
            const body = context.notes.find((n) => n.id === event.id)?.body ?? ''
            return { noteId: event.id, draft: body, original: body }
          }),
        },
      },
    },
    editing: {
      on: {
        EDIT: { actions: assign({ draft: ({ event }) => event.body }) },
        DONE: [{ guard: 'changed', target: 'saving' }, { target: 'list' }],
        DELETE: [{ guard: 'saved', target: 'deleting' }, { target: 'list' }],
      },
    },
    saving: {
      invoke: {
        src: 'save',
        input: ({ context }) => ({ ports: context.ports, id: context.noteId, body: context.draft }),
        onDone: {
          target: 'list',
          actions: assign({
            notes: ({ context, event }) => {
              const rest = context.notes.filter((n) => n.id !== context.noteId)
              return event.output ? [event.output, ...rest] : rest
            },
          }),
        },
        onError: { target: 'editing', actions: assign({ error: ({ event }) => message(event.error) }) },
      },
    },
    deleting: {
      invoke: {
        src: 'remove',
        input: ({ context }) => ({ ports: context.ports, id: context.noteId! }),
        onDone: {
          target: 'list',
          actions: assign({ notes: ({ context }) => context.notes.filter((n) => n.id !== context.noteId) }),
        },
        onError: { target: 'editing', actions: assign({ error: ({ event }) => message(event.error) }) },
      },
    },
  },
})
