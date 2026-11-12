import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'

const account = vi.hoisted(() => ({ rootKeyHex: '' }))
vi.mock('../session', () => ({
  getActiveWallet: () => ({ rootKeyHex: account.rootKeyHex, identityKey: 'id', chain: 'main' }),
}))
vi.mock('../accountLocalKeys', () => ({ accountLocalKey: (base: string) => `${base}:test` }))

import { durableGetItem, durableRemoveItem, durableSetItem } from '../durableStorage'
import { deleteNote, noteTitle, openNotes, saveNote } from './noteStore'

const KEY = 'handcash.notes.v1:test'

describe('private notes', () => {
  beforeEach(() => {
    durableRemoveItem(KEY)
    account.rootKeyHex = PrivateKey.fromRandom().toHex()
  })

  it('keeps only sealed bodies and opens them for the same account', async () => {
    const saved = await saveNote(null, 'seed words go nowhere\nsecond line')
    expect(saved?.id).toMatch(/^[0-9a-f]{32}$/)
    expect(durableGetItem(KEY)).not.toContain('seed words')
    const { notes, unreadable } = await openNotes()
    expect(unreadable).toBe(0)
    expect(notes.map((n) => n.body)).toEqual(['seed words go nowhere\nsecond line'])
    expect(noteTitle(notes[0]!.body)).toBe('seed words go nowhere')
  })

  it('another account counts the note as unreadable and keeps it', async () => {
    await saveNote(null, 'mine')
    account.rootKeyHex = PrivateKey.fromRandom().toHex()
    expect(await openNotes()).toEqual({ notes: [], unreadable: 1 })
    expect(JSON.parse(durableGetItem(KEY)!).notes).toHaveLength(1)
  })

  it('refuses a body moved to another note or another save time', async () => {
    const a = await saveNote(null, 'a')
    const b = await saveNote(null, 'b')
    const record = JSON.parse(durableGetItem(KEY)!)
    const [first, second] = record.notes
    ;[first.sealed, second.sealed] = [second.sealed, first.sealed]
    first.savedAt += 1
    durableSetItem(KEY, JSON.stringify(record))
    const { notes, unreadable } = await openNotes()
    expect(unreadable).toBe(2)
    expect(notes).toEqual([])
    expect(a && b).toBeTruthy()
  })

  it('saving again replaces the note; an empty body or delete removes it', async () => {
    const note = await saveNote(null, 'first')
    await saveNote(note!.id, 'second')
    expect((await openNotes()).notes.map((n) => n.body)).toEqual(['second'])
    expect(await saveNote(note!.id, '   ')).toBeNull()
    expect((await openNotes()).notes).toEqual([])
    const other = await saveNote(null, 'other')
    await deleteNote(other!.id)
    expect((await openNotes()).notes).toEqual([])
  })
})
