import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { fromHex, type Bytes } from '../ltc/litecoin'
import { htlcScript, sha256, signHtlcSpend, type HtlcCoin } from './htlc'
import { bsvCosignValid, bsvRefundValue, cosignBsvRefund, judgeSpend } from './legChains'

const claimKey = PrivateKey.fromString('11'.repeat(32), 'hex')
const refundKey = PrivateKey.fromString('22'.repeat(32), 'hex')
const cosignKey = PrivateKey.fromString('33'.repeat(32), 'hex')
const pub = (k: PrivateKey): Bytes => Uint8Array.from(k.toPublicKey().encode(true) as number[])
const secret = fromHex('ab'.repeat(32))
const hash = sha256(secret)
const locktime = 1_800_000_000
const to = fromHex('76a914' + '00'.repeat(20) + '88ac')

const bsvCoin: HtlcCoin = {
  txid: 'cd'.repeat(32),
  vout: 0,
  amount: 100_000n,
  script: htlcScript('bsv', { hash, claimPub: pub(claimKey), refundPub: pub(refundKey), cosignPub: pub(cosignKey), locktime }),
}
const ltcCoin: HtlcCoin = { txid: 'ef'.repeat(32), vout: 1, amount: 100_000n, script: htlcScript('ltc', { hash, claimPub: pub(claimKey), refundPub: pub(refundKey), locktime }) }

describe('BSV refund co-signature', () => {
  const value = bsvRefundValue(bsvCoin.amount)
  const cosig = cosignBsvRefund(bsvCoin, to, value, locktime, cosignKey)

  it('verifies for exactly the refund it was made for', () => {
    expect(bsvCosignValid(bsvCoin, to, value, locktime, pub(cosignKey), cosig)).toBe(true)
    expect(bsvCosignValid(bsvCoin, to, value - 1n, locktime, pub(cosignKey), cosig)).toBe(false)
    expect(bsvCosignValid(bsvCoin, to, value, locktime + 1, pub(cosignKey), cosig)).toBe(false)
    expect(bsvCosignValid(bsvCoin, fromHex('6a'), value, locktime, pub(cosignKey), cosig)).toBe(false)
    expect(bsvCosignValid(bsvCoin, to, value, locktime, pub(claimKey), cosig)).toBe(false)
  })

  it('refuses to co-sign a refund paying more than its lock', () => {
    expect(() => cosignBsvRefund(bsvCoin, to, bsvCoin.amount + 1n, locktime, cosignKey)).toThrow(/out of its lock/)
    expect(() => cosignBsvRefund(bsvCoin, to, 0n, locktime, cosignKey)).toThrow(/out of its lock/)
  })

  it('keeps the refund fee small and fixed', () => {
    expect(bsvCoin.amount - value).toBe(40n)
  })
})

describe('judgeSpend', () => {
  const outpoint = { txid: ltcCoin.txid, vout: ltcCoin.vout }

  it('reads the secret out of a claim', () => {
    const claim = signHtlcSpend('ltc', { coins: [ltcCoin], to, key: claimKey, path: { kind: 'claim', preimage: secret } })
    expect(judgeSpend('ltc', claim.tx, outpoint, hash)).toEqual({ kind: 'claimed', txid: claim.txid, secret })
  })

  it('names a refund, an unspent lock, and a spender of something else', () => {
    const refund = signHtlcSpend('ltc', { coins: [ltcCoin], to, key: refundKey, path: { kind: 'refund', locktime } })
    expect(judgeSpend('ltc', refund.tx, outpoint, hash)).toEqual({ kind: 'refunded', txid: refund.txid })
    expect(judgeSpend('ltc', null, outpoint, hash)).toEqual({ kind: 'unspent' })
    expect(judgeSpend('ltc', refund.tx, { ...outpoint, vout: 7 }, hash).kind).toBe('unknown')
  })

  it('does not take a preimage of another hash for the secret', () => {
    const claim = signHtlcSpend('ltc', { coins: [ltcCoin], to, key: claimKey, path: { kind: 'claim', preimage: secret } })
    expect(judgeSpend('ltc', claim.tx, outpoint, sha256(fromHex('cd'.repeat(32)))).kind).toBe('refunded')
  })
})
