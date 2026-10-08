import { describe, expect, it } from 'vitest'
import {
  phraseImportBelongsToWallet,
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
