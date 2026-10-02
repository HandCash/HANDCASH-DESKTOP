import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import {
  Brc140RecoveryError,
  createBrc140Shares,
  extendBrc140Shares,
  extractBrc140Shares,
  recoverRootKeyFromBrc140Shares,
} from './brc140Backup'

const root = PrivateKey.fromRandom()
const rootHex = root.toHex()

function failure(shares: string[]): Brc140RecoveryError {
  try {
    recoverRootKeyFromBrc140Shares(shares)
  } catch (err) {
    if (err instanceof Brc140RecoveryError) return err
    throw err
  }
  throw new Error('expected recovery to fail')
}

describe('BRC-140 recovery', () => {
  it('two splits of one wallet share an integrity tag but do not combine', () => {
    const a = createBrc140Shares(rootHex)
    const b = createBrc140Shares(rootHex)
    expect(a.integrity).toBe(b.integrity)
    expect(() => PrivateKey.fromBackupShares([a.shares[0]!, b.shares[1]!])).toThrow(
      'Integrity hash mismatch',
    )
    expect(failure([a.shares[0]!, b.shares[1]!]).reason).toBe('mixed-sets')
  })

  it('finds the pair that fits among slices from several sets', () => {
    const a = createBrc140Shares(rootHex)
    const b = createBrc140Shares(rootHex)
    const recovered = recoverRootKeyFromBrc140Shares([
      a.shares[0]!,
      b.shares[1]!,
      b.shares[2]!,
    ])
    expect(recovered.rootKeyHex).toBe(rootHex)
    expect(recovered.sharesUsed).toEqual([b.shares[1], b.shares[2]])
  })

  it('reads slices out of pasted emails and slice files', () => {
    const set = createBrc140Shares(rootHex)
    const email = [
      'HandCash key slice 1/3',
      `Integrity: ${set.integrity}`,
      '',
      set.shares[0],
      '',
    ].join('\n')
    const file = `# USB\n# integrity ${set.integrity}\n${set.shares[2]}\n`
    expect(extractBrc140Shares(`${email}\n${file}\n${set.shares[0]}`)).toEqual([
      set.shares[0],
      set.shares[2],
    ])
    expect(recoverRootKeyFromBrc140Shares([email, file]).rootKeyHex).toBe(rootHex)
  })

  it('names the copy, wallet and count failures', () => {
    const set = createBrc140Shares(rootHex)
    const other = createBrc140Shares(PrivateKey.fromRandom().toHex())
    expect(failure([set.shares[0]!]).reason).toBe('too-few')
    expect(failure([set.shares[0]!, `  ${set.shares[0]!}  `]).reason).toBe('too-few')
    expect(failure([set.shares[0]!, other.shares[1]!]).reason).toBe('mixed-wallets')
  })
})

describe('extendBrc140Shares', () => {
  it('keeps every slice of the recovered split valid, including the one not pasted', () => {
    const original = createBrc140Shares(rootHex)
    const [s1, s2, kept] = original.shares as [string, string, string]
    const { sharesUsed } = recoverRootKeyFromBrc140Shares([s1, s2])
    const extended = extendBrc140Shares(rootHex, sharesUsed)

    expect(extended.shares.slice(0, 2)).toEqual([s1, s2])
    expect(extended.shares).toHaveLength(3)
    const fresh = extended.shares[2]!
    expect(fresh).not.toBe(kept)
    for (const pair of [
      [s1, fresh],
      [s2, fresh],
      [kept, fresh],
      [kept, s1],
    ]) {
      expect(PrivateKey.fromBackupShares(pair).toHex()).toBe(rootHex)
    }
  })

  it('refuses slices of another wallet', () => {
    const other = createBrc140Shares(PrivateKey.fromRandom().toHex())
    expect(() => extendBrc140Shares(rootHex, other.shares.slice(0, 2))).toThrow(
      'do not reconstruct this wallet',
    )
  })
})
