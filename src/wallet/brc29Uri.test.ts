import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import {
  buildBrc29SettlementUri,
  parseBrc29SettlementUri,
  tryParseBrc29SettlementUri,
} from './brc29Uri'
import { looksLikePeerPayUri, tryParsePeerPayUri } from './peerPayUri'

describe('brc29 settlement URI', () => {
  const payee = PrivateKey.fromRandom().toPublicKey().toString().toLowerCase()
  const sender = PrivateKey.fromRandom().toPublicKey().toString().toLowerCase()
  const txid = 'ab'.repeat(32)

  it('round-trips remittance without looking like a PeerPay request', () => {
    const uri = buildBrc29SettlementUri({
      payeeIdentityKey: payee,
      senderIdentityKey: sender,
      txid,
      remittance: {
        derivationPrefix: 'pre==',
        derivationSuffix: 'suf==',
        outputIndex: 0,
      },
      sats: 500,
    })
    expect(uri.startsWith('brc29:')).toBe(true)
    expect(looksLikePeerPayUri(uri)).toBe(false)
    expect(tryParsePeerPayUri(uri)).toBeNull()

    const parsed = parseBrc29SettlementUri(uri)
    expect(parsed.payeeIdentityKey).toBe(payee)
    expect(parsed.senderIdentityKey).toBe(sender)
    expect(parsed.txid).toBe(txid)
    expect(parsed.remittance).toEqual({
      derivationPrefix: 'pre==',
      derivationSuffix: 'suf==',
      outputIndex: 0,
    })
    expect(parsed.sats).toBe(500)
  })

  it('tryParse returns null for PeerPay requests', () => {
    expect(tryParseBrc29SettlementUri(`peerpay:${payee}?sats=1`)).toBeNull()
  })
})
