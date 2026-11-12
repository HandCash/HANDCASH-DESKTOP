import { Button } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { useEffect } from 'react'
import { notesMachine, type NotesPorts } from '../machines/notesMachine'
import { deleteNote, noteTitle, openNotes, saveNote } from '../wallet/notes/noteStore'
import { FileIcon } from './icons'
import { SettingsNavRow } from './settings'

const ports: NotesPorts = { open: openNotes, save: saveNote, remove: deleteNote }

function savedLabel(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Apps → Notes: private notes, sealed per note on this device. */
export function NotesPanel() {
  const [snapshot, send, actor] = useMachine(notesMachine, { input: { ports } })
  const { notes, unreadable, draft, error } = snapshot.context
  const busy = snapshot.matches('saving') || snapshot.matches('deleting')
  const editing = snapshot.matches('editing') || busy

  // Leaving mid-edit keeps a changed draft rather than dropping it.
  useEffect(
    () => () => {
      const last = actor.getSnapshot()
      if (last.matches('editing') && last.context.draft !== last.context.original) {
        void ports.save(last.context.noteId, last.context.draft).catch(() => undefined)
      }
    },
    [actor],
  )

  return (
    <div
      className="nav-section-body settings-detail settings-scroll"
      data-aeon-scope="notes"
      data-aeon-state={stateToAttr(snapshot.value)}
    >
      {snapshot.matches('opening') ? (
        <p className="settings-section-lede" aria-busy="true">Opening your notes…</p>
      ) : null}
      {snapshot.matches('failed') ? (
        <div className="settings-form" data-aeon-part="failed">
          <p className="permission-note" role="alert">Notes could not be opened. {error}</p>
          <div className="actions">
            <Button.Root variant="solid" className="btn btn-primary" onClick={() => send({ type: 'RETRY' })}>
              <Button.Label>Try again</Button.Label>
            </Button.Root>
          </div>
        </div>
      ) : null}
      {snapshot.matches('list') ? (
        <>
          <div data-aeon-part="head">
            <p className="settings-section-lede">Sealed on this device. Only this account can open them.</p>
            <Button.Root variant="solid" className="btn btn-primary btn-compact" data-aeon-part="new" onClick={() => send({ type: 'NEW' })}>
              <Button.Label>New note</Button.Label>
            </Button.Root>
          </div>
          {unreadable > 0 ? (
            <p className="permission-note" role="status" data-aeon-part="unreadable">
              {unreadable === 1 ? '1 note' : `${unreadable} notes`} on this device can't be opened by this account.
            </p>
          ) : null}
          {notes.length === 0 ? (
            <p className="settings-section-lede" data-aeon-part="empty">No notes yet.</p>
          ) : (
            <ul className="settings-list" data-aeon-part="list">
              {notes.map((note) => (
                <SettingsNavRow
                  key={note.id}
                  label={noteTitle(note.body)}
                  description={savedLabel(note.savedAt)}
                  icon={<FileIcon size={17} />}
                  onClick={() => send({ type: 'OPEN', id: note.id })}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
      {editing ? (
        <div className="settings-form" data-aeon-part="editor">
          <textarea
            className="input notes-editor"
            aria-label="Note"
            placeholder="Write a note"
            value={draft}
            disabled={busy}
            onChange={(event) => send({ type: 'EDIT', body: event.target.value })}
          />
          {error ? (
            <p className="permission-note" role="alert">{error}</p>
          ) : null}
          <div className="actions">
            <Button.Root
              variant="ghost"
              className="btn btn-ghost"
              data-aeon-part="delete"
              disabled={busy}
              onClick={() => send({ type: 'DELETE' })}
            >
              <Button.Label>{snapshot.context.noteId ? 'Delete' : 'Discard'}</Button.Label>
            </Button.Root>
            <Button.Root
              variant="solid"
              className="btn btn-primary"
              data-aeon-part="done"
              disabled={busy}
              onClick={() => send({ type: 'DONE' })}
            >
              <Button.Label>{snapshot.matches('saving') ? 'Sealing…' : 'Done'}</Button.Label>
            </Button.Root>
          </div>
        </div>
      ) : null}
    </div>
  )
}
