import { describe, expect, it, vi } from 'vitest'
import { createActor, waitFor } from 'xstate'
import { notesMachine, type NotesPorts } from './notesMachine'

const note = (id: string, body: string) => ({ id, body, savedAt: 1 })

function start(ports: Partial<NotesPorts> = {}) {
  const full: NotesPorts = {
    open: async () => ({ notes: [note('a', 'alpha')], unreadable: 0 }),
    save: async (id, body) => (body.trim() ? note(id ?? 'new', body) : null),
    remove: async () => undefined,
    ...ports,
  }
  return createActor(notesMachine, { input: { ports: full } }).start()
}

describe('notes chart', () => {
  it('opens to the list, saves a changed note and lists it first', async () => {
    const actor = start()
    await waitFor(actor, (s) => s.matches('list'))
    actor.send({ type: 'NEW' })
    actor.send({ type: 'EDIT', body: 'beta' })
    actor.send({ type: 'DONE' })
    await waitFor(actor, (s) => s.matches('list'))
    expect(actor.getSnapshot().context.notes.map((n) => n.body)).toEqual(['beta', 'alpha'])
  })

  it('Done without a change saves nothing', async () => {
    const save = vi.fn(async () => null)
    const actor = start({ save })
    await waitFor(actor, (s) => s.matches('list'))
    actor.send({ type: 'OPEN', id: 'a' })
    expect(actor.getSnapshot().context.draft).toBe('alpha')
    actor.send({ type: 'DONE' })
    expect(actor.getSnapshot().matches('list')).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('a failed save returns to editing with the draft and the reason', async () => {
    const actor = start({ save: async () => { throw new Error('Could not save the note on this device') } })
    await waitFor(actor, (s) => s.matches('list'))
    actor.send({ type: 'OPEN', id: 'a' })
    actor.send({ type: 'EDIT', body: 'alpha 2' })
    actor.send({ type: 'DONE' })
    await waitFor(actor, (s) => s.matches('editing') && s.context.error !== null)
    expect(actor.getSnapshot().context).toMatchObject({ draft: 'alpha 2', error: 'Could not save the note on this device' })
  })

  it('deletes a saved note; a new one is just discarded', async () => {
    const remove = vi.fn(async () => undefined)
    const actor = start({ remove })
    await waitFor(actor, (s) => s.matches('list'))
    actor.send({ type: 'NEW' })
    actor.send({ type: 'DELETE' })
    expect(actor.getSnapshot().matches('list')).toBe(true)
    actor.send({ type: 'OPEN', id: 'a' })
    actor.send({ type: 'DELETE' })
    await waitFor(actor, (s) => s.matches('list'))
    expect(remove).toHaveBeenCalledWith('a')
    expect(actor.getSnapshot().context.notes).toEqual([])
  })

  it('names an open failure and retries', async () => {
    let calls = 0
    const actor = start({
      open: async () => {
        calls += 1
        if (calls === 1) throw new Error('No account is open')
        return { notes: [], unreadable: 0 }
      },
    })
    await waitFor(actor, (s) => s.matches('failed'))
    expect(actor.getSnapshot().context.error).toBe('No account is open')
    actor.send({ type: 'RETRY' })
    await waitFor(actor, (s) => s.matches('list'))
  })
})
