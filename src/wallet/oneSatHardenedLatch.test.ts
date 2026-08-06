import { beforeAll, describe, expect, it } from 'vitest'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import { bsv } from 'scrypt-ts'
import {
  BASE_LINK,
  Brc156Covenant,
  buildGenesisAnchorTransaction,
  buildGenesisHardenedPair,
  createCovenantInstance,
  createTestSigner,
  loadBrc156CovenantArtifact,
  runAlternatingSettleWithScriptExec,
  runBaseSettleWithScriptExec,
  runCommitWithScriptExec,
  verifyAlternatingProofBounded,
} from './oneSatHardenedLatch'

const ORIGIN = `${'ab'.repeat(32)}_0`
const ORIGIN_SCRIPT = new P2PKH()
  .lock(PrivateKey.fromRandom().toPublicKey().toHash())
  .toHex()

function utxo(tx: bsv.Transaction, vout: number): bsv.Transaction.IUnspentOutput {
  const output = tx.outputs[vout]!
  return {
    txId: tx.id,
    outputIndex: vout,
    script: output.script.toHex(),
    satoshis: output.satoshis,
  }
}

function source(
  script: bsv.Script,
  satoshis: number,
  seed: string,
): bsv.Transaction {
  return new bsv.Transaction()
    .from({
      txId: seed.repeat(32),
      outputIndex: 0,
      script: script.toHex(),
      satoshis,
    })
    .addOutput(new bsv.Transaction.Output({ script, satoshis }))
}

function genesis(owner: bsv.PrivateKey, funder: bsv.PrivateKey) {
  const legacyScript = bsv.Script.buildPublicKeyHashOut(owner.toAddress())
  const legacyParent = source(legacyScript, 1, '10')
  const legacyTx = new bsv.Transaction()
    .from(utxo(legacyParent, 0))
    .addOutput(new bsv.Transaction.Output({ script: legacyScript, satoshis: 1 }))
  const fundingScript = bsv.Script.buildPublicKeyHashOut(funder.toAddress())
  const fundingTx = source(fundingScript, 10_000, '20')
  const pair = buildGenesisHardenedPair({
    origin: ORIGIN,
    originLockingScriptHex: ORIGIN_SCRIPT,
    ownerPublicKeyHex: owner.publicKey.toString(),
    brc150VerifiedForGenesis: true,
    legacyTipOutpoint: `${legacyTx.id}_0`,
  })
  const genesisTx = buildGenesisAnchorTransaction({
    legacyTipUTXO: utxo(legacyTx, 0),
    fundingUTXO: utxo(fundingTx, 0),
    tip: pair.tip,
    changeAddress: funder.toAddress(),
  })
  return {
    legacyTx,
    genesisTx,
    tip: Brc156Covenant.fromTx(genesisTx, 0),
    originScriptHash: pair.originScriptHash,
  }
}

describe('BRC-156 BOLT-style alternating proof covenant', () => {
  beforeAll(loadBrc156CovenantArtifact)

  it('runs Tx1→Tx6 and consumes proof N-1, never current sibling proof', async () => {
    const alice = createTestSigner()
    const bob = createTestSigner()
    const charlie = createTestSigner()
    const dave = createTestSigner()
    await Promise.all([
      alice.provider.connect(),
      bob.provider.connect(),
      charlie.provider.connect(),
      dave.provider.connect(),
    ])
    const base = genesis(
      alice.key,
      bsv.PrivateKey.fromRandom(bsv.Networks.testnet),
    )

    // Tx1 Commit A→B: creates proofB.
    const tx1 = await runCommitWithScriptExec({
      tip: base.tip,
      signerKey: alice.key,
      signer: alice.signer,
      provider: alice.provider,
      nextRecipientPublicKeyHex: bob.key.publicKey.toString(),
    })
    // Tx2 Settle A→B: proofB remains unspent.
    const tx2 = await runBaseSettleWithScriptExec({
      committedTip: tx1.tip,
      signerKey: alice.key,
      signer: alice.signer,
      recipientPublicKeyHex: bob.key.publicKey.toString(),
      commitTx: tx1.commitTx,
      genesisTx: base.genesisTx,
    })

    // Tx3 Commit B→C: creates proofC; token still points at proofB.
    const tx3 = await runCommitWithScriptExec({
      tip: tx2.tip,
      signerKey: bob.key,
      signer: bob.signer,
      provider: bob.provider,
      nextRecipientPublicKeyHex: charlie.key.publicKey.toString(),
    })
    // Tx4 consumes proofB from Tx1, not proofC from Tx3.
    const tx4 = await runAlternatingSettleWithScriptExec({
      committedTip: tx3.tip,
      delayedProof: tx1.nextProof,
      signerKey: bob.key,
      signer: bob.signer,
      recipientPublicKeyHex: charlie.key.publicKey.toString(),
      currentCommitTx: tx3.commitTx,
      priorSettleTx: tx2.settleTx,
      proofCommitTx: tx1.commitTx,
    })
    expect(tx4.settleTx.inputs[1]!.prevTxId.toString('hex')).toBe(tx1.commitTx.id)
    expect(tx4.settleTx.inputs[1]!.outputIndex).toBe(1)
    expect(tx4.settleTx.outputs[0]!.satoshis).toBe(1)
    expect(tx4.settleTx.outputs[1]!.satoshis).toBe(2)

    // Repeat: Tx5 creates proofD, Tx6 consumes proofC from Tx3.
    const tx5 = await runCommitWithScriptExec({
      tip: tx4.tip,
      signerKey: charlie.key,
      signer: charlie.signer,
      provider: charlie.provider,
      nextRecipientPublicKeyHex: dave.key.publicKey.toString(),
    })
    const tx6 = await runAlternatingSettleWithScriptExec({
      committedTip: tx5.tip,
      delayedProof: tx3.nextProof,
      signerKey: charlie.key,
      signer: charlie.signer,
      recipientPublicKeyHex: dave.key.publicKey.toString(),
      currentCommitTx: tx5.commitTx,
      priorSettleTx: tx4.settleTx,
      proofCommitTx: tx3.commitTx,
    })
    expect(tx6.settleTx.inputs[1]!.prevTxId.toString('hex')).toBe(tx3.commitTx.id)
    expect(tx6.settleTx.inputs[1]!.outputIndex).toBe(1)

    const spv = new Set(
      [tx3.commitTx, tx4.settleTx, tx5.commitTx, tx6.settleTx].map((tx) =>
        tx.id.toLowerCase(),
      ),
    )
    expect(
      verifyAlternatingProofBounded({
        currentOutpoint: `${tx6.settleTx.id}_0`,
        delayedProofOutpoint: `${tx3.commitTx.id}_1`,
        currentCommitTxHex: tx5.commitTx.toString(),
        priorSettleTxHex: tx4.settleTx.toString(),
        proofCommitTxHex: tx3.commitTx.toString(),
        currentSettleTxHex: tx6.settleTx.toString(),
        spvVerifiedTxids: spv,
        recipientPublicKeyHex: dave.key.publicKey.toString(),
      }),
    ).toEqual({ proven: true, reason: null })
  }, 60_000)

  it('base case rejects genesis that did not spend verified legacy tip', async () => {
    const attacker = createTestSigner()
    await attacker.provider.connect()
    const funder = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const real = genesis(attacker.key, funder)

    const fakeFunding = source(
      bsv.Script.buildPublicKeyHashOut(attacker.key.toAddress()),
      10_000,
      '30',
    )
    const fakeBase = createCovenantInstance({
      role: 0,
      origin: ORIGIN,
      originScriptHash: real.originScriptHash,
      ownerPublicKeyHex: attacker.key.publicKey.toString(),
      linkOutpoint: BASE_LINK,
      legacyTipOutpoint: `${real.legacyTx.id}_0`,
    })
    const fakeGenesisTx = new bsv.Transaction()
      .from(utxo(fakeFunding, 0))
      .addOutput(
        new bsv.Transaction.Output({ script: fakeBase.lockingScript, satoshis: 1 }),
      )
    const fakeTx1 = await runCommitWithScriptExec({
      tip: Brc156Covenant.fromTx(fakeGenesisTx, 0),
      signerKey: attacker.key,
      signer: attacker.signer,
      provider: attacker.provider,
      nextRecipientPublicKeyHex: attacker.key.publicKey.toString(),
    })
    await expect(
      runBaseSettleWithScriptExec({
        committedTip: fakeTx1.tip,
        signerKey: attacker.key,
        signer: attacker.signer,
        recipientPublicKeyHex: attacker.key.publicKey.toString(),
        commitTx: fakeTx1.commitTx,
        genesisTx: fakeGenesisTx,
      }),
    ).rejects.toThrow(/genesis did not spend verified legacy tip/)
  }, 60_000)

  it('tracks a structurally exact delayed Tx0→Tx4 counterfeit as must-fail', async () => {
    const attacker = createTestSigner()
    await attacker.provider.connect()
    const real = genesis(
      attacker.key,
      bsv.PrivateKey.fromRandom(bsv.Networks.testnet),
    )
    const funding = source(
      bsv.Script.buildPublicKeyHashOut(attacker.key.toAddress()),
      10_000,
      '41',
    )

    // Fake Tx0 copies every immutable field but does not spend the verified tip.
    const fakeGenesis = new bsv.Transaction()
      .from(utxo(funding, 0))
      .addOutput(
        new bsv.Transaction.Output({
          script: createCovenantInstance({
            role: 0,
            origin: ORIGIN,
            originScriptHash: real.originScriptHash,
            ownerPublicKeyHex: attacker.key.publicKey.toString(),
            linkOutpoint: BASE_LINK,
            legacyTipOutpoint: `${real.legacyTx.id}_0`,
          }).lockingScript,
          satoshis: 1,
        }),
      )

    // Fake Tx1 is a real script-executed Commit and creates delayed proof vout1.
    const fakeTx1 = await runCommitWithScriptExec({
      tip: Brc156Covenant.fromTx(fakeGenesis, 0),
      signerKey: attacker.key,
      signer: attacker.signer,
      nextRecipientPublicKeyHex: attacker.key.publicKey.toString(),
    })

    // Consensus rejects fake Tx2 at the base script. Therefore no SPV proof for
    // Tx2 (or any fabricated descendant) can exist.
    await expect(
      runBaseSettleWithScriptExec({
        committedTip: fakeTx1.tip,
        signerKey: attacker.key,
        signer: attacker.signer,
        recipientPublicKeyHex: attacker.key.publicKey.toString(),
        commitTx: fakeTx1.commitTx,
        genesisTx: fakeGenesis,
      }),
    ).rejects.toThrow(/genesis did not spend verified legacy tip/)

    // Fabricate Tx2/Tx3/Tx4 bytes anyway, placing the fake mint beyond a naive
    // two-hop window. Their links exactly match Tx3→Tx2→Tx1 and proof Tx1:vout1.
    const fakeTip2 = createCovenantInstance({
      role: 0,
      origin: ORIGIN,
      originScriptHash: real.originScriptHash,
      ownerPublicKeyHex: attacker.key.publicKey.toString(),
      linkOutpoint: `${fakeTx1.commitTx.id}_1`,
      legacyTipOutpoint: `${real.legacyTx.id}_0`,
    })
    const fakeTx2 = new bsv.Transaction()
      .from(utxo(fakeTx1.commitTx, 0))
      .addOutput(
        new bsv.Transaction.Output({
          script: fakeTip2.lockingScript,
          satoshis: 1,
        }),
      )
      .addOutput(
        new bsv.Transaction.Output({
          script: bsv.Script.buildPublicKeyHashOut(attacker.key.toAddress()),
          satoshis: 2,
        }),
      )
    const fakeTx3 = await runCommitWithScriptExec({
      tip: Brc156Covenant.fromTx(fakeTx2, 0),
      signerKey: attacker.key,
      signer: attacker.signer,
      nextRecipientPublicKeyHex: attacker.key.publicKey.toString(),
    })
    const fakeTip4 = createCovenantInstance({
      role: 0,
      origin: ORIGIN,
      originScriptHash: real.originScriptHash,
      ownerPublicKeyHex: attacker.key.publicKey.toString(),
      linkOutpoint: `${fakeTx3.commitTx.id}_1`,
      legacyTipOutpoint: `${real.legacyTx.id}_0`,
    })
    const fakeTx4 = new bsv.Transaction()
      .from(utxo(fakeTx3.commitTx, 0))
      .from(utxo(fakeTx1.commitTx, 1))
      .addOutput(
        new bsv.Transaction.Output({
          script: fakeTip4.lockingScript,
          satoshis: 1,
        }),
      )
      .addOutput(
        new bsv.Transaction.Output({
          script: bsv.Script.buildPublicKeyHashOut(attacker.key.toAddress()),
          satoshis: 2,
        }),
      )

    const result = verifyAlternatingProofBounded({
      currentOutpoint: `${fakeTx4.id}_0`,
      delayedProofOutpoint: `${fakeTx1.commitTx.id}_1`,
      currentCommitTxHex: fakeTx3.commitTx.toString(),
      priorSettleTxHex: fakeTx2.toString(),
      proofCommitTxHex: fakeTx1.commitTx.toString(),
      currentSettleTxHex: fakeTx4.toString(),
      spvVerifiedTxids: new Set([fakeTx1.commitTx.id]),
      recipientPublicKeyHex: attacker.key.publicKey.toString(),
    })
    expect(result.proven).toBe(false)
    expect(result.reason).toMatch(/missing SPV inclusion/)
  }, 60_000)

  it('mutated alternating Settle outputs fail hashOutputs', async () => {
    const alice = createTestSigner()
    const bob = createTestSigner()
    const charlie = createTestSigner()
    await Promise.all([alice.provider.connect(), bob.provider.connect()])
    const base = genesis(
      alice.key,
      bsv.PrivateKey.fromRandom(bsv.Networks.testnet),
    )
    const tx1 = await runCommitWithScriptExec({
      tip: base.tip,
      signerKey: alice.key,
      signer: alice.signer,
      nextRecipientPublicKeyHex: bob.key.publicKey.toString(),
    })
    const tx2 = await runBaseSettleWithScriptExec({
      committedTip: tx1.tip,
      signerKey: alice.key,
      signer: alice.signer,
      recipientPublicKeyHex: bob.key.publicKey.toString(),
      commitTx: tx1.commitTx,
      genesisTx: base.genesisTx,
    })
    const tx3 = await runCommitWithScriptExec({
      tip: tx2.tip,
      signerKey: bob.key,
      signer: bob.signer,
      nextRecipientPublicKeyHex: charlie.key.publicKey.toString(),
    })
    await expect(
      runAlternatingSettleWithScriptExec({
        committedTip: tx3.tip,
        delayedProof: tx1.nextProof,
        signerKey: bob.key,
        signer: bob.signer,
        recipientPublicKeyHex: charlie.key.publicKey.toString(),
        currentCommitTx: tx3.commitTx,
        priorSettleTx: tx2.settleTx,
        proofCommitTx: tx1.commitTx,
        mutateOutputs: true,
      }),
    ).rejects.toThrow(/hashOutputs/)
  }, 60_000)
})
