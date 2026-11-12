/**
 * Private notes for the open account. Only sealed bodies are written
 * (`noteCrypto.ts`); opening unseals them here, in memory. Notes stay on this
 * device: they are not part of the BRC-39 history backup and never leave it.
 */

import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'
import { getActiveWallet } from '../session'
import { newNoteId, noteKey, openNote, sealNote } from './noteCrypto'

const VERSION = storageRegistry.privateNotes.version

export type Note = { id: string; body: string; savedAt: number }

type SealedNote = { id: string; savedAt: number; sealed: string }
type NotesRecord = { v: typeof VERSION; notes: SealedNote[] }

export type OpenedNotes = { notes: Note[]; unreadable: number }

function storageKey(): string {
  return accountLocalKey(storageRegistry.privateNotes.key)
}

function accountWallet(): ProtoWallet {
  const active = getActiveWallet()
  if (!active) throw new Error('No account is open')
  return new ProtoWallet(PrivateKey.fromHex(active.rootKeyHex))
}

function isSealedNote(n: unknown): n is SealedNote {
  const o = n as Partial<SealedNote> | null
  return (
    !!o &&
    typeof o.id === 'string' &&
    /^[0-9a-f]{32}$/.test(o.id) &&
    typeof o.savedAt === 'number' &&
    Number.isFinite(o.savedAt) &&
    typeof o.sealed === 'string'
  )
}

function read(key: string): SealedNote[] {
  const raw = durableGetItem(key)
  if (!raw) return []
  try {
    const record = JSON.parse(raw) as Partial<NotesRecord>
    if (record?.v !== VERSION || !Array.isArray(record.notes)) return []
    return record.notes.filter(isSealedNote)
  } catch {
    return []
  }
}

function write(key: string, notes: SealedNote[]): void {
  const record: NotesRecord = { v: VERSION, notes }
  if (!durableSetItem(key, JSON.stringify(record))) {
    throw new Error('Could not save the note on this device')
  }
}

/** Every note of the open account, newest first. A note this account can't open is counted, never dropped. */
export async function openNotes(): Promise<OpenedNotes> {
  const key = storageKey()
  const wallet = accountWallet()
  const notes: Note[] = []
  let unreadable = 0
  for (const n of read(key)) {
    try {
      const body = await openNote(await noteKey(wallet, n.id), n.id, n.savedAt, Uint8Array.from(Utils.toArray(n.sealed, 'base64')))
      notes.push({ id: n.id, body, savedAt: n.savedAt })
    } catch {
      unreadable += 1
    }
  }
  if (unreadable > 0) console.warn(`[notes] ${unreadable} could not be opened`)
  return { notes: notes.sort((a, b) => b.savedAt - a.savedAt), unreadable }
}

/** Seal and keep a note; a new note gets an id. An empty body removes the note instead. */
export async function saveNote(id: string | null, body: string): Promise<Note | null> {
  const key = storageKey()
  if (!body.trim()) {
    if (id) write(key, read(key).filter((n) => n.id !== id))
    return null
  }
  const noteId = id ?? newNoteId()
  const savedAt = Date.now()
  const sealed = await sealNote(await noteKey(accountWallet(), noteId), noteId, savedAt, body)
  const next: SealedNote = { id: noteId, savedAt, sealed: Utils.toBase64(Array.from(sealed)) }
  write(key, [next, ...read(key).filter((n) => n.id !== noteId)])
  return { id: noteId, body, savedAt }
}

export async function deleteNote(id: string): Promise<void> {
  const key = storageKey()
  write(key, read(key).filter((n) => n.id !== id))
}

/** First line, for lists and titles. */
export function noteTitle(body: string): string {
  const line = body.trim().split('\n', 1)[0]?.trim() ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}…` : line || 'Untitled'
}
