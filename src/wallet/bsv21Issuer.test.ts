import { PrivateKey, P2PKH, Script, Spend, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  issuerFromRemittance,
  normalizeIssuerPubKey,
  shortIssuerLabel,
  sigmaSignDeployLockingScript,
  issuerFromSigmaLockingScript,
  isBsv21IdentityMintArgs,
  bsv21IdentityMintHints,
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

  it('detects identity-backed deploy+mint createAction args', () => {
    const args = {
      description: 'Mint DEMO',
      outputs: [
        {
          satoshis: 1,
          basket: 'bsv21',
          tags: ['bsv21', 'op:deploy+mint', 'sym:DEMO', 'amt:1000'],
          customInstructions: JSON.stringify({
            p: 'bsv-20',
            op: 'deploy+mint',
            sym: 'DEMO',
            amt: '1000',
          }),
        },
      ],
    }
    expect(isBsv21IdentityMintArgs('createAction', args)).toBe(true)
    expect(isBsv21IdentityMintArgs('signAction', args)).toBe(false)
    expect(bsv21IdentityMintHints(args)).toEqual({ sym: 'DEMO', amt: '1000' })
    expect(
      isBsv21IdentityMintArgs('createAction', {
        outputs: [{ satoshis: 1000, basket: 'default' }],
      }),
    ).toBe(false)
  })

  it('detects identity-backed deploy+auth and mint createAction args', () => {
    expect(
      isBsv21IdentityMintArgs('createAction', {
        outputs: [
          {
            satoshis: 1,
            basket: 'bsv21',
            tags: ['bsv21', 'op:deploy+auth', 'sym:DEMO'],
            customInstructions: JSON.stringify({
              p: 'bsv-20',
              op: 'deploy+auth',
              sym: 'DEMO',
              dec: '0',
            }),
          },
        ],
      }),
    ).toBe(true)
    const mintArgs = {
      outputs: [
        {
          satoshis: 1,
          basket: 'bsv21',
          tags: [
            'bsv21',
            `bsv21:${'aa'.repeat(32)}_0`,
            'op:mint',
            'amt:500',
            'sym:DEMO',
          ],
          customInstructions: JSON.stringify({
            p: 'bsv-20',
            op: 'mint',
            id: `${'aa'.repeat(32)}_0`,
            amt: '500',
            sym: 'DEMO',
          }),
        },
      ],
    }
    expect(isBsv21IdentityMintArgs('createAction', mintArgs)).toBe(true)
    expect(bsv21IdentityMintHints(mintArgs)).toEqual({
      sym: 'DEMO',
      amt: '500',
    })
  })

  it('unlocks inscription‖P2PKH‖Sigma tips with full locking-script sighash', async () => {
    const plain = new P2PKH().lock(root.toAddress())
    const json = new TextEncoder().encode(
      JSON.stringify({ p: 'bsv-20', op: 'deploy+auth', sym: 'FOX', dec: '0' }),
    )
    const insc =
      '0063036f726451126170706c69636174696f6e2f6273762d323000' +
      '4c' +
      json.length.toString(16).padStart(2, '0') +
      Buffer.from(json).toString('hex') +
      '68' +
      plain.toHex()
    const signedHex = sigmaSignDeployLockingScript({
      lockingScriptHex: insc,
      fundTxid: 'ab'.repeat(32),
      fundVout: 0,
      identityKeyHex: root.toHex(),
    })
    const lockingScript = Script.fromHex(signedHex)
    expect(signedHex).toContain('5349474d41')

    const source = new Transaction()
    source.addOutput({ satoshis: 1, lockingScript })
    const spend = new Transaction()
    spend.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(
        root,
        'all',
        false,
        1,
        lockingScript,
      ),
    })
    spend.addOutput({ satoshis: 1, lockingScript: plain })
    await spend.sign()

    const check = new Spend({
      sourceTXID: source.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript,
      transactionVersion: spend.version,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript: spend.inputs[0]!.unlockingScript!,
      outputs: spend.outputs,
      inputSequence: spend.inputs[0]!.sequence ?? 0xffffffff,
      lockTime: spend.lockTime,
    })
    expect(check.validate()).toBe(true)
  })
})
