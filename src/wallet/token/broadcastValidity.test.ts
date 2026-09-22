import { Beef, Transaction } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { encodeBsv21Binary } from './decode162'
import {
  assertBsv21BroadcastValidity,
  checkBsv21BroadcastValidity,
} from './broadcastValidity'

function deploy(): { beef: Beef; outpoint: string } {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({
      amount: 1_000n,
      rest: `76a914${'11'.repeat(20)}88ac`,
    }),
  })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { beef, outpoint: `${tx.id('hex')}_0` }
}

describe('BSV-21 broadcast validity', () => {
  it('refuses a protocol-valid tip whose Bitcoin ancestor is rejected', async () => {
    const { beef, outpoint } = deploy()
    const fetchFate = vi.fn(async () => ({
      kind: 'rejected' as const,
      status: 'REJECTED',
      reason: 'UTXO_SPENT: already spent',
    }))
    const validity = await checkBsv21BroadcastValidity({
      beef,
      outpoints: [outpoint],
      tokenId: outpoint,
      chain: 'main',
      fetchFate,
    })

    expect(validity).toMatchObject({
      kind: 'refuse',
      reason: 'ancestor-rejected',
    })
    expect(() => assertBsv21BroadcastValidity(validity)).toThrow(
      /BSV-21 send refused/,
    )
  })

  it('allows complete unconfirmed ancestry when no hard rejection exists', async () => {
    const { beef, outpoint } = deploy()
    const validity = await checkBsv21BroadcastValidity({
      beef,
      outpoints: [outpoint],
      tokenId: outpoint,
      chain: 'main',
      fetchFate: async () => ({ kind: 'unknown' }),
    })

    expect(validity).toMatchObject({ kind: 'valid' })
    expect(() => assertBsv21BroadcastValidity(validity)).not.toThrow()
  })
})
