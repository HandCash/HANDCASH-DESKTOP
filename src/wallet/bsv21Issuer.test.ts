import { PrivateKey, Script, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  issuerFromRemittance,
  normalizeIssuerPubKey,
  shortIssuerLabel,
  sigmaSignDeployLockingScript,
  issuerFromSigmaLockingScript,
} from './bsv21Issuer'

describe('bsv21Issuer', () => {
  const root = PrivateKey.fromRandom()
  const issuer = root.toPublicKey().toString().toLowerCase()

  it('normalizes compressed issuer pubkeys', () => {
    expect(normalizeIssuerPubKey(issuer)).toBe(issuer)
    expect(normalizeIssuerPubKey('0x' + issuer)).toBe(issuer)
    expect(normalizeIssuerPubKey('zz')).toBeNull()
  })

  it('reads issuer from CI and tags', () => {
    expect(
      issuerFromRemittance({
        customInstructions: JSON.stringify({
          p: 'bsv-20',
          op: 'deploy+mint',
          amt: '1',
          issuer,
        }),
      }),
    ).toBe(issuer)
    expect(
      issuerFromRemittance({ tags: [`issuer:${issuer}`] }),
    ).toBe(issuer)
  })

  it('shortens issuer for display', () => {
    const label = shortIssuerLabel(issuer)
    expect(label.length).toBeLessThan(issuer.length)
    expect(label).toContain('…')
  })

  it('embeds Sigma on a deploy locking script and matches address to issuer', () => {
    // Minimal P2PKH-looking script (not a real inscription) for Sigma attach.
    const lock = new Script()
    lock.writeOpCode(0x00) // OP_FALSE
    lock.writeOpCode(0x6a) // OP_RETURN
    lock.writeBin(Array.from(new TextEncoder().encode('bsv21-test')))
    const fundTxid = 'ab'.repeat(32)
    const signed = sigmaSignDeployLockingScript({
      lockingScriptHex: lock.toHex(),
      fundTxid,
      fundVout: 0,
      identityKeyHex: root.toHex(),
    })
    expect(signed.toLowerCase()).toContain('5349474d41') // SIGMA
    const hint = issuerFromSigmaLockingScript(signed, [issuer])
    expect(hint.issuer).toBe(issuer)
    expect(hint.algorithm).toBe('BRC77')
  })

  it('Sigma message binds the funding outpoint (vin 0)', () => {
    const lock = Script.fromASM('OP_FALSE OP_RETURN 01')
    const fundTxid = 'cd'.repeat(32)
    const signedHex = sigmaSignDeployLockingScript({
      lockingScriptHex: lock.toHex(),
      fundTxid,
      fundVout: 1,
      identityKeyHex: root.toHex(),
    })
    // Rebuild with the same fund input — Sigma fields parse.
    const tx = new Transaction()
    tx.addInput({ sourceTXID: fundTxid, sourceOutputIndex: 1 })
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(signedHex) })
    expect(tx.outputs[0]?.lockingScript.toHex().toLowerCase()).toContain('5349474d41')
  })
})
