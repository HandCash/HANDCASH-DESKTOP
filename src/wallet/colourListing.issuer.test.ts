import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { sigmaSignDeployLockingScript } from './bsv21Issuer'
import { buildBsv21ValueLock } from './bsv21Send'
import { decodeListedBsv21Tip } from './colourListing'

describe('decodeListedBsv21Tip issuer', () => {
  const root = PrivateKey.fromRandom()
  const issuer = root.toPublicKey().toString().toLowerCase()
  const address = root.toAddress()
  const tokenId = `${'ab'.repeat(32)}_0`
  const outpoint = `${'cd'.repeat(32)}.1`
  const lockingScript = buildBsv21ValueLock({
    tokenId,
    amount: 42n,
    address,
  })

  it('copies issuer from an issuer: tag', () => {
    const tip = decodeListedBsv21Tip({
      outpoint,
      satoshis: 1,
      lockingScript,
      tags: ['bsv21', `bsv21:${tokenId}`, 'amt:42', `issuer:${issuer}`],
      customInstructions: JSON.stringify({
        p: 'bsv-20',
        op: 'transfer',
        id: tokenId,
        amt: '42',
      }),
    })
    expect(tip?.issuer).toBe(issuer)
    expect(tip?.issuerAttested).toBeUndefined()
  })

  it('copies issuer from Sigma when identityKey matches', () => {
    const signed = sigmaSignDeployLockingScript({
      lockingScriptHex: lockingScript,
      fundTxid: 'ab'.repeat(32),
      fundVout: 0,
      identityKeyHex: root.toHex(),
    })
    expect(signed.toLowerCase()).toContain('5349474d41')
    const tip = decodeListedBsv21Tip(
      {
        outpoint,
        satoshis: 1,
        lockingScript: signed,
        tags: ['bsv21', `bsv21:${tokenId}`, 'amt:42'],
      },
      issuer,
    )
    expect(tip?.issuer).toBe(issuer)
    expect(tip?.issuerAttested).toBe(true)
  })
})
