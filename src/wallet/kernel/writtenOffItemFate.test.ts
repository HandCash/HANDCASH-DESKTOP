import { describe, expect, it } from 'vitest'
import { decideWrittenOffItemFate, type WrittenOffItemFacts } from './writtenOffItemFate'

const facts = (patch: Partial<WrittenOffItemFacts> = {}): WrittenOffItemFacts => ({
  spentLocally: false,
  leftOnPurpose: false,
  overlayHeld: false,
  creatorStatus: 'completed',
  ...patch,
})

describe('decideWrittenOffItemFate', () => {
  it('restores a hidden tip whose creator is settled or live', () => {
    expect(decideWrittenOffItemFate(facts())).toEqual({ kind: 'restore' })
    expect(decideWrittenOffItemFate(facts({ creatorStatus: 'unproven' }))).toEqual({ kind: 'restore' })
    expect(decideWrittenOffItemFate(facts({ creatorStatus: 'sending' }))).toEqual({ kind: 'restore' })
  })

  it('revives a creator failed locally while the chain holds its output', () => {
    expect(decideWrittenOffItemFate(facts({ creatorStatus: 'failed' }))).toEqual({ kind: 'reviveCreator' })
  })

  it('pins a creator still broadcast-held locally', () => {
    expect(decideWrittenOffItemFate(facts({ creatorStatus: 'nosend' }))).toEqual({ kind: 'pinCreator' })
    expect(decideWrittenOffItemFate(facts({ creatorStatus: 'unsent' }))).toEqual({ kind: 'pinCreator' })
  })

  it('never hands back a tip a send, the holder or the lock overlay owns', () => {
    expect(decideWrittenOffItemFate(facts({ spentLocally: true }))).toEqual({ kind: 'keep', reason: 'spentLocally' })
    expect(decideWrittenOffItemFate(facts({ leftOnPurpose: true }))).toEqual({ kind: 'keep', reason: 'leftOnPurpose' })
    expect(decideWrittenOffItemFate(facts({ overlayHeld: true }))).toEqual({ kind: 'keep', reason: 'overlayHeld' })
  })

  it('keeps a row whose creator was never signed or is gone', () => {
    expect(decideWrittenOffItemFate(facts({ creatorStatus: 'unsigned' }))).toEqual({ kind: 'keep', reason: 'creatorUnsigned' })
    expect(decideWrittenOffItemFate(facts({ creatorStatus: 'unprocessed' }))).toEqual({ kind: 'keep', reason: 'creatorUnsigned' })
    expect(decideWrittenOffItemFate(facts({ creatorStatus: '' }))).toEqual({ kind: 'keep', reason: 'creatorMissing' })
  })
})
