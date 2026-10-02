import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { durableGetItem } from './durableStorage'
import { createBrc140Shares, recoverRootKeyFromBrc140Shares } from './brc140Backup'
import {
  adoptRecoveredBrc140Set,
  loadOrIssueBrc140Set,
  readBrc140IssuedSet,
  rotateBrc140Set,
} from './brc140IssuedSet'

describe('BRC-140 issued slice set', () => {
  it('shows the same set on every reveal until rotated', async () => {
    const rootHex = PrivateKey.fromRandom().toHex()
    const first = await loadOrIssueBrc140Set(rootHex)
    const again = await loadOrIssueBrc140Set(rootHex)
    expect(again.shares).toEqual(first.shares)
    expect(PrivateKey.fromBackupShares([first.shares[0]!, again.shares[2]!]).toHex()).toBe(rootHex)

    const rotated = await rotateBrc140Set(rootHex)
    expect(rotated.shares).not.toEqual(first.shares)
    expect((await loadOrIssueBrc140Set(rootHex)).shares).toEqual(rotated.shares)
  })

  it('stores no slice in the clear', async () => {
    const rootHex = PrivateKey.fromRandom().toHex()
    const set = await loadOrIssueBrc140Set(rootHex)
    const identityKey = PrivateKey.fromHex(rootHex).toPublicKey().toString()
    const raw = durableGetItem(`${storageRegistry.brc140IssuedSet.key}${identityKey}`)!
    for (const share of set.shares) {
      expect(raw).not.toContain(share.split('.')[0])
    }
  })

  it('keeps each wallet’s set apart', async () => {
    const a = PrivateKey.fromRandom().toHex()
    const b = PrivateKey.fromRandom().toHex()
    const setA = await loadOrIssueBrc140Set(a)
    expect(await readBrc140IssuedSet(b)).toBeNull()
    await loadOrIssueBrc140Set(b)
    expect((await readBrc140IssuedSet(a))?.shares).toEqual(setA.shares)
  })

  it('after a slice restore, keeps the holder’s split', async () => {
    const rootHex = PrivateKey.fromRandom().toHex()
    const held = createBrc140Shares(rootHex).shares
    const { sharesUsed } = recoverRootKeyFromBrc140Shares([held[0]!, held[1]!])
    await adoptRecoveredBrc140Set(rootHex, sharesUsed)

    const shown = await loadOrIssueBrc140Set(rootHex)
    expect(shown.origin).toBe('restored')
    expect(shown.shares.slice(0, 2)).toEqual([held[0], held[1]])
    expect(PrivateKey.fromBackupShares([held[2]!, shown.shares[2]!]).toHex()).toBe(rootHex)
  })
})
