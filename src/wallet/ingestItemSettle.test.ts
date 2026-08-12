import { describe, expect, it } from 'vitest'
import { internalizePeerItemSettle } from './ingestItemSettle'

describe('internalizePeerItemSettle', () => {
  it('refuses an invalid txid without touching the wallet', async () => {
    expect(await internalizePeerItemSettle({ txid: 'nope' })).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'invalid-txid',
    })
  })

  it('refuses when Atomic BEEF is missing', async () => {
    const txid = 'a'.repeat(64)
    expect(await internalizePeerItemSettle({ txid })).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'missing-beef',
    })
  })
})
