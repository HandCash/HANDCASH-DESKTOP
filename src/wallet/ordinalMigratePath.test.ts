import { describe, expect, it } from 'vitest'
import { chooseOrdinalMigratePath } from './ordinalMigratePath'

// The ordinal indexer lists every unspent output an address holds. A Yours
// branch returned a 1,679,834-sat cash output alongside its inscriptions, and
// signing it as a 1-sat tip failed script evaluation on every retry.

const OURS = '76a914aabbccddeeff00112233445566778899aabbccdd88ac'
const THEIRS = '76a914ffffffffffffffffffffffffffffffffffffffff88ac'

describe('chooseOrdinalMigratePath', () => {
  it('migrates a 1-sat tip locked to the phrase key', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: OURS }, OURS),
    ).toEqual({ path: 'migrate', satoshis: 1 })
  })

  it('refuses a cash output the indexer listed with the ordinals', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1_679_834, lockingScriptHex: OURS }, OURS),
    ).toEqual({ path: 'skip', reason: 'notOneSat' })
  })

  it('refuses a tip this key cannot unlock', () => {
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: THEIRS }, OURS),
    ).toEqual({ path: 'skip', reason: 'foreignLock' })
  })

  it('refuses an output that could not be read from the tip BEEF', () => {
    expect(chooseOrdinalMigratePath(null, OURS)).toEqual({
      path: 'skip',
      reason: 'unreadable',
    })
    expect(
      chooseOrdinalMigratePath({ satoshis: 1, lockingScriptHex: null }, OURS),
    ).toEqual({ path: 'skip', reason: 'unreadable' })
  })

  it('ignores lock hex casing', () => {
    expect(
      chooseOrdinalMigratePath(
        { satoshis: 1, lockingScriptHex: OURS.toUpperCase() },
        OURS,
      ).path,
    ).toBe('migrate')
  })
})
