import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { decideWalletDeepLink } from './deepLink'
import { buildBrc29SettlementUri } from './brc29Uri'
import { buildPeerPayUri } from './peerPayUri'

const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
const senderKey = PrivateKey.fromRandom().toPublicKey().toString()
const txid = 'a'.repeat(64)

function receiptUri(sats?: number | null): string {
  return buildBrc29SettlementUri({
    payeeIdentityKey: identityKey,
    senderIdentityKey: senderKey,
    txid,
    remittance: { derivationPrefix: 'pre', derivationSuffix: 'suf', outputIndex: 1 },
    sats,
  })
}

describe('decideWalletDeepLink', () => {
  it('turns a PeerPay request into a Send prefill, amount included', () => {
    const decision = decideWalletDeepLink(buildPeerPayUri(identityKey, 2500))

    expect(decision).toEqual({
      kind: 'send-request',
      uri: `peerpay:${identityKey.toLowerCase()}?sats=2500`,
      identityKey: identityKey.toLowerCase(),
      sats: 2500,
    })
  })

  it('accepts a request that names no amount', () => {
    const decision = decideWalletDeepLink(buildPeerPayUri(identityKey))

    expect(decision.kind === 'send-request' && decision.sats).toBe(null)
  })

  it('refuses a PeerPay link that is not a compressed identity key', () => {
    for (const key of [
      identityKey.slice(0, 40),
      `04${identityKey.slice(2)}`,
      'not-a-key',
    ]) {
      expect(decideWalletDeepLink(`peerpay:${key}`)).toEqual({
        kind: 'refuse',
        reason: 'malformed-peerpay',
        message: 'PeerPay link is not a valid identity key request',
      })
    }
  })

  it('refuses an amount that is not a whole number of satoshis', () => {
    const decision = decideWalletDeepLink(`${buildPeerPayUri(identityKey)}?sats=1.5`)

    expect(decision.kind === 'refuse' && decision.reason).toBe('malformed-peerpay')
  })

  it('refuses schemes this wallet has not claimed', () => {
    for (const uri of ['bitcoin:1abc', 'paymail:me@example.com', 'https://handcash.io']) {
      const decision = decideWalletDeepLink(uri)
      expect(decision.kind === 'refuse' && decision.reason).toBe('unknown-scheme')
    }
  })

  it('turns a BRC-29 receipt into a claim, not a second payment', () => {
    const decision = decideWalletDeepLink(receiptUri(1200))

    expect(decision).toEqual({
      kind: 'settlement-receipt',
      uri: receiptUri(1200),
      identityKey: identityKey.toLowerCase(),
      txid,
      sats: 1200,
    })
  })

  it('accepts a receipt that names no amount', () => {
    const decision = decideWalletDeepLink(receiptUri())

    expect(decision.kind === 'settlement-receipt' && decision.sats).toBe(null)
  })

  it('refuses a BRC-29 link missing the parts needed to internalize it', () => {
    for (const uri of [
      `brc29:${identityKey}`,
      `brc29:${identityKey}?txid=${txid}&dp=pre&ds=suf`,
      receiptUri().replace(`txid=${txid}`, 'txid=nope'),
    ]) {
      const decision = decideWalletDeepLink(uri)
      expect(decision.kind === 'refuse' && decision.reason).toBe('malformed-brc29')
    }
  })

  it('refuses an empty link rather than opening a blank Send', () => {
    for (const raw of ['', '   ']) {
      const decision = decideWalletDeepLink(raw)
      expect(decision.kind === 'refuse' && decision.reason).toBe('empty')
    }
  })

  it('canonicalizes peerpay://key to peerpay:key', () => {
    const decision = decideWalletDeepLink(`peerpay://${identityKey}?sats=100`)
    expect(decision).toEqual({
      kind: 'send-request',
      uri: `peerpay:${identityKey.toLowerCase()}?sats=100`,
      identityKey: identityKey.toLowerCase(),
      sats: 100,
    })
  })
})
