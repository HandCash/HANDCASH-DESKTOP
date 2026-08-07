import { LockingScript, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  verifyAuthenticityLadder,
  verifyOriginScriptCommitment,
} from './oneSatAuthenticity'
import { originScriptHash } from './oneSatLatch'

const HELD = `${'a'.repeat(64)}.0`
const ORD_ENVELOPE =
  '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'

describe('collectable authenticity ladder (BRC-150 only)', () => {
  it('ignores hardened evidence — product authenticity is BRC-150', () => {
    const result = verifyAuthenticityLadder({
      heldOutpoint: HELD,
      hardened: {
        proven: true,
        reason: null,
        originScriptHash: 'b'.repeat(64),
      },
      indexerResolved: true,
    })

    expect(result.tier).toBe('unproven')
    expect(result.proven).toBe(false)
  })

  it('never promotes indexer identity to proven', () => {
    const result = verifyAuthenticityLadder({
      heldOutpoint: HELD,
      indexerResolved: true,
    })

    expect(result.tier).toBe('unproven')
    expect(result.proven).toBe(false)
    expect(result.reason).toMatch(/indexer|BRC-150/i)
  })

  it('pins a valid one-sat ord origin script commitment', async () => {
    const tx = new Transaction()
    tx.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(ORD_ENVELOPE),
    })
    const result = await verifyOriginScriptCommitment({
      origin: `${tx.id('hex')}_0`,
      expectedScriptHash: originScriptHash(ORD_ENVELOPE),
      chain: 'main',
      verifiedOriginTransaction: tx,
    })
    expect(result.proven).toBe(true)
  })
})
