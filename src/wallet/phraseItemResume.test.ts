import { describe, expect, it } from 'vitest'
import {
  decidePhraseItemResume,
  phraseImportBelongsToWallet,
  phraseItemBatchIsDone,
  type PhraseItemMigrateCursor,
} from './phraseSweep'

const cursor: PhraseItemMigrateCursor = {
  sourceAddress: '1source',
  destIdentityKey: `02${'11'.repeat(32)}`,
  offset: 19,
  moved: 15,
  failed: 1,
  skipped: 3,
  stopped: 'funds',
  lastError: null,
}

describe('phraseImportBelongsToWallet', () => {
  it('shows a pending import only in its destination wallet', () => {
    expect(
      phraseImportBelongsToWallet(cursor, cursor.destIdentityKey.toUpperCase()),
    ).toBe(true)
    expect(phraseImportBelongsToWallet(cursor, `03${'22'.repeat(32)}`)).toBe(false)
    expect(phraseImportBelongsToWallet(cursor, null)).toBe(false)
  })
})

describe('decidePhraseItemResume', () => {
  it('starts only when no durable import is pending', () => {
    expect(
      decidePhraseItemResume({
        cursor: null,
        sourceAddress: '1source',
        destIdentityKey: cursor.destIdentityKey,
      }),
    ).toEqual({ kind: 'start' })
  })

  it('resumes the matching source into the matching wallet', () => {
    expect(
      decidePhraseItemResume({
        cursor,
        sourceAddress: cursor.sourceAddress,
        destIdentityKey: cursor.destIdentityKey.toUpperCase(),
      }),
    ).toEqual({ kind: 'resume', cursor })
  })

  it('refuses to replace a pending import with another phrase', () => {
    expect(
      decidePhraseItemResume({
        cursor,
        sourceAddress: '1different',
        destIdentityKey: cursor.destIdentityKey,
      }),
    ).toMatchObject({ kind: 'refuse', reason: 'different-source' })
  })

  it('refuses to resume into another wallet identity', () => {
    expect(
      decidePhraseItemResume({
        cursor,
        sourceAddress: cursor.sourceAddress,
        destIdentityKey: `03${'22'.repeat(32)}`,
      }),
    ).toMatchObject({ kind: 'refuse', reason: 'different-destination' })
  })
})

describe('phraseItemBatchIsDone', () => {
  it('finishes the exact final preview batch without waiting for index catch-up', () => {
    expect(
      phraseItemBatchIsDone({
        stopped: null,
        moved: 465,
        failed: 0,
        expectedItemCount: 465,
        pageExhausted: false,
        consumed: 15,
        pageRows: 15,
      }),
    ).toBe(true)
  })

  it('keeps the cursor when any expected item failed or the count was capped', () => {
    expect(
      phraseItemBatchIsDone({
        stopped: null,
        moved: 464,
        failed: 1,
        expectedItemCount: 465,
        pageExhausted: false,
        consumed: 15,
        pageRows: 15,
      }),
    ).toBe(false)
    expect(
      phraseItemBatchIsDone({
        stopped: null,
        moved: 465,
        failed: 0,
        pageExhausted: false,
        consumed: 15,
        pageRows: 15,
      }),
    ).toBe(false)
  })
})
