import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { legacyImportMachine, type LegacyImportEvent } from './legacyImportMachine'

function run(...events: LegacyImportEvent[]) {
  const actor = createActor(legacyImportMachine).start()
  for (const event of events) actor.send(event)
  return actor.getSnapshot()
}

describe('legacyImportMachine', () => {
  it('saves then scans a new source, never sweeps on its own', () => {
    const snap = run(
      { type: 'LOADED' },
      { type: 'ADD' },
      { type: 'PICK', kind: 'handcash' },
      { type: 'SUBMIT' },
      { type: 'SAVED', sourceId: 's1' },
    )
    expect(snap.matches({ source: 'scanning' })).toBe(true)
    expect(snap.context).toMatchObject({ kind: 'handcash', sourceId: 's1' })
    const after = run(
      { type: 'LOADED' },
      { type: 'ADD' },
      { type: 'PICK', kind: 'handcash' },
      { type: 'SUBMIT' },
      { type: 'SAVED', sourceId: 's1' },
      { type: 'SCANNED' },
    )
    expect(after.matches({ source: 'viewing' })).toBe(true)
  })

  it('opens the HandCash form straight from the list for key recovery', () => {
    const snap = run({ type: 'LOADED' }, { type: 'PICK', kind: 'handcash' })
    expect(snap.matches('entering')).toBe(true)
    expect(snap.context.kind).toBe('handcash')
    expect(run({ type: 'LOADED' }, { type: 'PICK', kind: 'handcash' }, { type: 'BACK' }).matches('picking')).toBe(true)
  })

  it('waits for HandCash history from a source, then scans; cancel or a wrong account returns to the view', () => {
    const opened: LegacyImportEvent[] = [{ type: 'LOADED' }, { type: 'OPEN', sourceId: 's1' }]
    const waiting = run(...opened, { type: 'ASK_HINTS' })
    expect(waiting.matches({ source: 'awaitingHints' })).toBe(true)
    expect(run(...opened, { type: 'ASK_HINTS' }, { type: 'HINTS' }).matches({ source: 'scanning' })).toBe(true)
    expect(run(...opened, { type: 'ASK_HINTS' }, { type: 'BACK' }).matches({ source: 'viewing' })).toBe(true)
    const refused = run(...opened, { type: 'ASK_HINTS' }, { type: 'FAIL', error: 'other handle' })
    expect(refused.matches({ source: 'viewing' })).toBe(true)
    expect(refused.context.error).toBe('other handle')
    expect(run(...opened, { type: 'ASK_HINTS' }, { type: 'CONFIRM' }).matches({ source: 'awaitingHints' })).toBe(true)
    expect(run(...opened, { type: 'HINTS' }).matches({ source: 'viewing' })).toBe(true)
  })

  it('reaches sweeping only through review and confirm', () => {
    const opened: LegacyImportEvent[] = [{ type: 'LOADED' }, { type: 'OPEN', sourceId: 's1' }]
    expect(run(...opened, { type: 'CONFIRM' }).matches({ source: 'viewing' })).toBe(true)
    expect(run(...opened, { type: 'RESCAN' }, { type: 'CONFIRM' }).matches({ source: 'scanning' })).toBe(true)
    expect(run(...opened, { type: 'REVIEW' }, { type: 'CONFIRM' }).matches({ source: 'sweeping' })).toBe(true)
  })

  it('pauses long work cooperatively and clears the request on exit', () => {
    const sweeping: LegacyImportEvent[] = [
      { type: 'LOADED' },
      { type: 'OPEN', sourceId: 's1' },
      { type: 'REVIEW' },
      { type: 'CONFIRM' },
      { type: 'PROGRESS', message: 'Moving…', percent: 40 },
      { type: 'PAUSE' },
    ]
    const paused = run(...sweeping)
    expect(paused.context).toMatchObject({ stopRequested: true, progress: 'Moving…', percent: 40 })
    const done = run(...sweeping, { type: 'SWEPT' })
    expect(done.matches({ source: 'viewing' })).toBe(true)
    expect(done.context).toMatchObject({ stopRequested: false, progress: null })
  })

  it('removes only after its own confirm', () => {
    const snap = run(
      { type: 'LOADED' },
      { type: 'OPEN', sourceId: 's1' },
      { type: 'REMOVE' },
      { type: 'CONFIRM' },
      { type: 'REMOVED' },
    )
    expect(snap.matches('list')).toBe(true)
    expect(snap.context.sourceId).toBeNull()
  })

  it('keeps a save failure on the form with its reason', () => {
    const snap = run(
      { type: 'LOADED' },
      { type: 'ADD' },
      { type: 'PICK', kind: 'phrase' },
      { type: 'SUBMIT' },
      { type: 'FAIL', error: 'bad phrase' },
    )
    expect(snap.matches('entering')).toBe(true)
    expect(snap.context.error).toBe('bad phrase')
  })
})
