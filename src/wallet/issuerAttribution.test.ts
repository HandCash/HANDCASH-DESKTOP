import { Beef, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const held = vi.hoisted(() => ({ beefs: new Map<string, unknown>(), reads: 0 }))
vi.mock('./beefCache', () => ({
  peekSessionBeef: (txid: string) => {
    held.reads++
    return held.beefs.get(txid) ?? null
  },
}))

import {
  resetIssuerAttributionForTests,
  retainedIssuerMetadata,
  retainedMinedHeight,
  retainedScriptIs,
  retainedSignedBy,
} from './issuerAttribution'
import { appendIssuerMetadata, brc162StampScript } from './issuerMetadata'
import { encodeBsv21Binary } from './token/decode162'
import { sigmaSignDeployLockingScript } from './token/issuer'

const issuer = PrivateKey.fromHex('03'.padStart(64, '0'))
const issuerKey = issuer.toPublicKey().toString()
const fundTxid = 'cd'.repeat(32)

function signedDeploy(): { txid: string; script: string } {
  const base = new P2PKH().lock(issuer.toPublicKey().toAddress()).toHex()
  const script = sigmaSignDeployLockingScript({
    lockingScriptHex: appendIssuerMetadata(base, issuerKey),
    fundTxid,
    fundVout: 0,
    identityKeyHex: issuer.toHex(),
  })
  const tx = new Transaction()
  tx.addInput({ sourceTXID: fundTxid, sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(script) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  held.beefs.set(txid, beef)
  return { txid, script }
}

beforeEach(() => {
  held.beefs.clear()
  held.reads = 0
  resetIssuerAttributionForTests()
})

describe('retained issuer attribution', () => {
  it('parses and verifies a retained output once, however often listing asks', () => {
    const { txid, script } = signedDeploy()
    for (let i = 0; i < 50; i++) {
      expect(retainedIssuerMetadata(`${txid}_0`)).toEqual({ issuer: issuerKey })
      expect(retainedScriptIs(`${txid}.0`, script)).toBe(true)
      expect(retainedSignedBy(`${txid}.0`, issuerKey)).toBe(true)
    }
    expect(held.reads).toBe(1)
  })

  it('never rereads an output with no Sigma, and rereads an unmined height at most once a minute', () => {
    vi.useFakeTimers()
    try {
      const tx = new Transaction()
      tx.addInput({ sourceTXID: fundTxid, sourceOutputIndex: 1, unlockingScript: Script.fromHex('') })
      tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(issuer.toPublicKey().toAddress()) })
      const beef = new Beef()
      beef.mergeTransaction(tx)
      const txid = tx.id('hex')
      held.beefs.set(txid, beef)
      for (let i = 0; i < 20; i++) {
        expect(retainedSignedBy(`${txid}.0`, issuerKey)).toBe(false)
        expect(retainedMinedHeight(`${txid}.0`)).toBeUndefined()
      }
      expect(held.reads).toBe(1)
      vi.advanceTimersByTime(60_000)
      expect(retainedMinedHeight(`${txid}.0`)).toBeUndefined()
      expect(held.reads).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('remembers nothing until the transaction is held', () => {
    const txid = 'ef'.repeat(32)
    expect(retainedIssuerMetadata(`${txid}.0`)).toBeNull()
    expect(retainedSignedBy(`${txid}.0`, issuerKey)).toBe(false)
    expect(held.reads).toBe(2)
  })

  it('refuses a different script, a different signer and a malformed outpoint', () => {
    const { txid, script } = signedDeploy()
    expect(retainedScriptIs(`${txid}.0`, script.slice(0, -2) + '00')).toBe(false)
    expect(retainedScriptIs(`${txid}.0`, script)).toBe(true)
    expect(retainedScriptIs(`${txid}.0`, script.slice(0, -2) + '00')).toBe(false)
    expect(retainedScriptIs(`${txid}.0`, script + '00')).toBe(false)
    expect(retainedScriptIs(`${txid}.0`, undefined)).toBe(false)
    expect(retainedSignedBy(`${txid}.0`, PrivateKey.fromHex('04'.padStart(64, '0')).toPublicKey().toString())).toBe(false)
    expect(retainedSignedBy(`${txid}.1`, issuerKey)).toBe(false)
    expect(retainedIssuerMetadata('not-an-outpoint')).toBeNull()
  })
})

describe('BRC-162 deploy stamp output (BRC-247)', () => {
  const owner = new P2PKH().lock(issuer.toPublicKey().toAddress())
  const deploy = (sym: string) => encodeBsv21Binary({ amount: 1000n, payload: { sym }, rest: owner }).toHex()
  const stamp = (deployHex: string) =>
    sigmaSignDeployLockingScript({
      lockingScriptHex: brc162StampScript(issuerKey, deployHex),
      fundTxid,
      fundVout: 0,
      identityKeyHex: issuer.toHex(),
    })
  function hold(outputs: string[]): string {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: fundTxid, sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
    outputs.forEach((hex, i) => tx.addOutput({ satoshis: i === 0 ? 1 : 0, lockingScript: Script.fromHex(hex) }))
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const txid = tx.id('hex')
    held.beefs.set(txid, beef)
    return txid
  }

  it('attributes the deploy to the stamp that names it, leaving the lock plain', () => {
    const lock = deploy('TEST')
    const txid = hold([lock, stamp(lock)])
    expect(retainedIssuerMetadata(`${txid}_0`)).toEqual({ issuer: issuerKey })
    expect(retainedSignedBy(`${txid}_0`, issuerKey)).toBe(true)
    expect(retainedScriptIs(`${txid}.0`, lock)).toBe(true)
  })

  it('ignores a stamp naming another deploy, a second stamp, or a stamp on a non-deploy', () => {
    const lock = deploy('TEST')
    expect(retainedSignedBy(`${hold([lock, stamp(deploy('FAKE'))])}_0`, issuerKey)).toBe(false)
    expect(retainedSignedBy(`${hold([lock, stamp(lock), stamp(lock)])}_0`, issuerKey)).toBe(false)
    const plain = owner.toHex()
    expect(retainedSignedBy(`${hold([plain, stamp(plain)])}_0`, issuerKey)).toBe(false)
  })
})
