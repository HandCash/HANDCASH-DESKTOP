import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { verifyInductionBounded } from './oneSatHardenedReceive'

const COVENANT = '51'.repeat(50)
const LEGACY_TIP_TXID = 'ab'.repeat(32)
const recipient = PrivateKey.fromRandom().toPublicKey()

function beacon(): string {
  return new P2PKH().lock(recipient.toHash()).toHex()
}

/** Commit: spends the legacy tip, mints the covenant tip token plus its proof. */
function commitTx(inductedVout = 0): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: LEGACY_TIP_TXID,
    sourceOutputIndex: inductedVout,
    unlockingScript: new UnlockingScript(),
  })
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(COVENANT) })
  tx.addOutput({ satoshis: 3, lockingScript: LockingScript.fromHex(COVENANT) })
  return tx
}

/** Induction settle: one input (the Commit token), tip + beacon + state out. */
function settleTx(
  commit: Transaction,
  over?: { extraInput?: boolean; tipScript?: string; beaconScript?: string; beaconSats?: number },
): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: commit.id('hex'),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
  })
  if (over?.extraInput) {
    tx.addInput({
      sourceTXID: commit.id('hex'),
      sourceOutputIndex: 1,
      unlockingScript: new UnlockingScript(),
    })
  }
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(over?.tipScript ?? COVENANT),
  })
  tx.addOutput({
    satoshis: over?.beaconSats ?? 2,
    lockingScript: LockingScript.fromHex(over?.beaconScript ?? beacon()),
  })
  tx.addOutput({ satoshis: 0, lockingScript: LockingScript.fromHex('006a0173') })
  return tx
}

function verify(settle: Transaction, commit: Transaction, spvOverride?: Set<string>) {
  return verifyInductionBounded({
    currentOutpoint: `${settle.id('hex')}.0`,
    currentSettleTxHex: settle.toHex(),
    currentCommitTxHex: commit.toHex(),
    spvVerifiedTxids:
      spvOverride ??
      new Set([settle.id('hex').toLowerCase(), commit.id('hex').toLowerCase()]),
    recipientPublicKeyHex: recipient.toString(),
  })
}

describe('verifyInductionBounded', () => {
  it('accepts an induction settle and names the tip it inducted', () => {
    const commit = commitTx(1)
    const result = verify(settleTx(commit), commit)

    expect(result.proven).toBe(true)
    expect(result.inductedTipOutpoint).toBe(`${LEGACY_TIP_TXID}_1`)
  })

  it('rejects a settle that also consumes a delayed proof', () => {
    // Two inputs is the alternating shape, which must face the stronger check.
    const commit = commitTx()
    const result = verify(settleTx(commit, { extraInput: true }), commit)

    expect(result.proven).toBe(false)
    expect(result.reason).toMatch(/only the Commit token/)
  })

  it('rejects a settled tip that is not a covenant', () => {
    const commit = commitTx()
    const p2pkh = new P2PKH().lock(recipient.toHash()).toHex()
    const result = verify(settleTx(commit, { tipScript: p2pkh }), commit)

    expect(result.proven).toBe(false)
    expect(result.reason).toBe('settled tip is not a covenant')
  })

  it('rejects a beacon paying someone else', () => {
    const commit = commitTx()
    const stranger = PrivateKey.fromRandom().toPublicKey()
    const result = verify(
      settleTx(commit, { beaconScript: new P2PKH().lock(stranger.toHash()).toHex() }),
      commit,
    )

    expect(result.proven).toBe(false)
    expect(result.reason).toBe('beacon recipient mismatch')
  })

  it('rejects wrong tip or beacon values', () => {
    const commit = commitTx()
    const result = verify(settleTx(commit, { beaconSats: 5 }), commit)

    expect(result.proven).toBe(false)
    expect(result.reason).toBe('invalid tip/beacon values')
  })

  it('rejects a transaction whose chain inclusion was not verified', () => {
    const commit = commitTx()
    const settle = settleTx(commit)
    const result = verify(settle, commit, new Set([settle.id('hex').toLowerCase()]))

    expect(result.proven).toBe(false)
    expect(result.reason).toMatch(/missing SPV inclusion/)
  })
})
