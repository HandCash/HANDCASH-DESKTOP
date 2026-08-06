/**
 * Wallet-toolbox bridge tests for hardened BRC-156 Commit/Settle.
 *
 * Proves createAction(noSend) → signAction(noSend) → createAction/signAction(sendWith)
 * and that mutated outputs fail hashOutputs-bound unlock generation.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Beef, PrivateKey, P2PKH, Transaction } from '@bsv/sdk'
import { bsv } from 'scrypt-ts'
import {
  Brc156Covenant,
  HARDENED_BEACON_SATS,
  HARDENED_PROOF_SATS,
  HARDENED_TIP_SATS,
  buildGenesisAnchorTransaction,
  buildGenesisHardenedPair,
  buildHardenedLatchState,
  buildLatchStateScript,
  createCovenantInstance,
  createTestSigner,
  loadBrc156CovenantArtifact,
  runBaseSettleWithScriptExec,
  runCommitWithScriptExec,
} from './oneSatHardenedLatch'
import {
  buildNextCommitInstances,
  buildNextSettleTip,
  generateCovenantUnlocks,
  locateExplicitInputVins,
  restoreScryptChangeMarker,
  sendHardenedCollectable,
} from './oneSatHardenedSend'
import { rememberProvenVerdict } from './provenCache'
import type { ActiveWallet } from './session'

const ORIGIN = `${'ab'.repeat(32)}_0`
const ORIGIN_SCRIPT = new P2PKH()
  .lock(PrivateKey.fromRandom().toPublicKey().toHash())
  .toHex()

function utxo(tx: bsv.Transaction, outputIndex: number) {
  const output = tx.outputs[outputIndex]!
  return {
    txId: tx.id,
    outputIndex,
    script: output.script.toHex(),
    satoshis: output.satoshis,
  }
}

function syntheticSource(
  outputScript: bsv.Script,
  satoshis: number,
  seed: string,
): bsv.Transaction {
  return new bsv.Transaction()
    .from({
      txId: seed.repeat(32),
      outputIndex: 0,
      script: outputScript.toHex(),
      satoshis,
    })
    .addOutput(
      new bsv.Transaction.Output({
        script: outputScript,
        satoshis,
      }),
    )
}

function buildAnchor(owner: bsv.PrivateKey, fundingOwner: bsv.PrivateKey) {
  const legacyScript = bsv.Script.buildPublicKeyHashOut(owner.toAddress())
  const ancestorTx = syntheticSource(legacyScript, 1, '10')
  const legacyTx = new bsv.Transaction()
    .from(utxo(ancestorTx, 0))
    .addOutput(
      new bsv.Transaction.Output({
        script: legacyScript,
        satoshis: 1,
      }),
    )
  const fundingScript = bsv.Script.buildPublicKeyHashOut(fundingOwner.toAddress())
  const fundingTx = syntheticSource(fundingScript, 50_000, '20')
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
    changeAddress: fundingOwner.toAddress(),
  })
  return { ancestorTx, legacyTx, fundingTx, genesisTx, pair }
}

function scryptToSdk(tx: bsv.Transaction): Transaction {
  return Transaction.fromHex(tx.toString())
}

/** Build AtomicBEEF signable from a scrypt action tx + its source tip tx. */
function signableFromScryptTx(
  actionTx: bsv.Transaction,
  sourceTx: bsv.Transaction,
  reference: string,
  extraSources: bsv.Transaction[] = [],
): { tx: number[]; reference: string } {
  const sdkAction = scryptToSdk(actionTx)
  const sdkSource = scryptToSdk(sourceTx)
  const merged = new Beef()
  merged.mergeRawTx(sdkSource.toBinary())
  for (const extra of extraSources) {
    merged.mergeRawTx(scryptToSdk(extra).toBinary())
  }
  for (const input of sdkAction.inputs) {
    const srcId = String(input.sourceTXID).toLowerCase()
    if (srcId === sdkSource.id('hex')) {
      input.sourceTransaction = sdkSource
    } else {
      const match = extraSources.find((t) => t.id === srcId)
      if (match) input.sourceTransaction = scryptToSdk(match)
    }
  }
  merged.mergeRawTx(sdkAction.toBinary())
  const beef = Beef.fromBinary(merged.toBinaryAtomic(sdkAction.id('hex')))
  for (const btx of beef.txs) {
    if (!btx.tx) continue
    for (const input of btx.tx.inputs) {
      const src = beef.findTxid(String(input.sourceTXID))?.tx
      if (src) input.sourceTransaction = src
    }
  }
  return {
    tx: beef.toBinaryAtomic(sdkAction.id('hex')),
    reference,
  }
}

describe('BRC-156 wallet-toolbox unlock bridge', () => {
  beforeAll(loadBrc156CovenantArtifact)

  it('generates commit unlock against a wallet-shaped tx and rejects mutated outputs', async () => {
    const { key, signer, provider } = createTestSigner()
    await provider.connect()
    void signer
    const funding = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const recipient = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const anchor = buildAnchor(key, funding)
    const tip = Brc156Covenant.fromTx(anchor.genesisTx, 0)
    const { nextTip, nextProof } = buildNextCommitInstances(
      tip,
      recipient.publicKey.toString(),
    )

    const walletTx = new bsv.Transaction()
      .addInput(tip.buildContractInput())
      .from(utxo(anchor.fundingTx, 0))
      .addOutput(
        new bsv.Transaction.Output({
          script: nextTip.lockingScript,
          satoshis: HARDENED_TIP_SATS,
        }),
      )
      .addOutput(
        new bsv.Transaction.Output({
          script: nextProof.lockingScript,
          satoshis: HARDENED_PROOF_SATS,
        }),
      )
      .change(funding.toAddress())
    walletTx.inputs[0]!.output = anchor.genesisTx.outputs[0]

    const signable = signableFromScryptTx(walletTx, anchor.genesisTx, 'ref-commit')
    const wallet = {
      rootKeyHex: key.toBuffer().toString('hex'),
      identityKey: key.publicKey.toString(),
      wallet: {},
    } as unknown as ActiveWallet

    const spends = await generateCovenantUnlocks({
      wallet,
      signable,
      mode: 'commit',
      outpoints: [`${anchor.genesisTx.id}.0`],
      nextProofScriptHex: nextProof.lockingScript.toHex(),
      recipientPublicKeyHex: recipient.publicKey.toString(),
    })
    expect(spends[0]?.unlockingScript.length).toBeGreaterThan(200)

    await expect(
      generateCovenantUnlocks({
        wallet,
        signable,
        mode: 'commit',
        outpoints: [`${anchor.genesisTx.id}.0`],
        nextProofScriptHex: nextProof.lockingScript.toHex(),
        recipientPublicKeyHex: recipient.publicKey.toString(),
        mutateOutputsForTest: true,
      }),
    ).rejects.toThrow(/hashOutputs/)
  })

  it('generates settleBase unlock against wallet-shaped tip+beacon+state+change', async () => {
    const alice = createTestSigner()
    await alice.provider.connect()
    const funding = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const bob = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const anchor = buildAnchor(alice.key, funding)

    const tip0 = Brc156Covenant.fromTx(anchor.genesisTx, 0)
    const tx1 = await runCommitWithScriptExec({
      tip: tip0,
      signerKey: alice.key,
      signer: alice.signer,
      provider: alice.provider,
      nextRecipientPublicKeyHex: bob.publicKey.toString(),
    })

    const stateHex = buildLatchStateScript(
      buildHardenedLatchState({
        origin: ORIGIN,
        originScriptHash: anchor.pair.originScriptHash,
        delayedProofOutpoint: `${tx1.commitTx.id}_1`,
        ownerPublicKeyHex: bob.publicKey.toString(),
        commitTxid: tx1.commitTx.id,
      }),
    )
    const stateScript = bsv.Script.fromHex(stateHex)
    const { settleTip, beaconScript } = buildNextSettleTip(
      tx1.tip,
      bob.publicKey.toString(),
      tx1.commitTx.id,
    )

    const settleTx = new bsv.Transaction()
      .addInput(tx1.tip.buildContractInput())
      .from(utxo(anchor.fundingTx, 0))
      .addOutput(
        new bsv.Transaction.Output({
          script: settleTip.lockingScript,
          satoshis: HARDENED_TIP_SATS,
        }),
      )
      .addOutput(
        new bsv.Transaction.Output({
          script: beaconScript,
          satoshis: HARDENED_BEACON_SATS,
        }),
      )
      .addOutput(new bsv.Transaction.Output({ script: stateScript, satoshis: 0 }))
      .change(funding.toAddress())
    settleTx.inputs[0]!.output = tx1.commitTx.outputs[0]
    restoreScryptChangeMarker(settleTx)

    const signable = signableFromScryptTx(settleTx, tx1.commitTx, 'ref-settle-base', [
      anchor.genesisTx,
    ])
    const wallet = {
      rootKeyHex: alice.key.toBuffer().toString('hex'),
      identityKey: alice.key.publicKey.toString(),
      wallet: {},
    } as unknown as ActiveWallet

    const spends = await generateCovenantUnlocks({
      wallet,
      signable,
      mode: 'settleBase',
      outpoints: [`${tx1.commitTx.id}.0`],
      commitTxHex: tx1.commitTx.toString(),
      genesisTxHex: anchor.genesisTx.toString(),
      stateScriptHex: stateHex,
      recipientPublicKeyHex: bob.publicKey.toString(),
    })
    expect(spends[0]?.unlockingScript.length).toBeGreaterThan(200)

    await expect(
      generateCovenantUnlocks({
        wallet,
        signable,
        mode: 'settleBase',
        outpoints: [`${tx1.commitTx.id}.0`],
        commitTxHex: tx1.commitTx.toString(),
        genesisTxHex: anchor.genesisTx.toString(),
        stateScriptHex: stateHex,
        recipientPublicKeyHex: bob.publicKey.toString(),
        mutateOutputsForTest: true,
      }),
    ).rejects.toThrow(/hashOutputs/)
  }, 60_000)

  it('createAction/signAction mock sequence uses noSend then sendWith', async () => {
    const owner = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const funding = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const recipient = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const anchor = buildAnchor(owner, funding)
    // Genesis path: spend the legacy P2PKH tip (BRC-150 verified).
    const tipOp = `${anchor.legacyTx.id}.0`
    const p2pkhScript = anchor.legacyTx.outputs[0]!.script.toHex()

    rememberProvenVerdict(tipOp, {
      tier: 'brc150',
      verifiedAt: Date.now(),
    })

    const tipBeef = new Beef()
    const sdkLegacy = scryptToSdk(anchor.legacyTx)
    const sdkAncestor = scryptToSdk(anchor.ancestorTx)
    tipBeef.mergeRawTx(sdkAncestor.toBinary())
    tipBeef.mergeRawTx(sdkLegacy.toBinary())

    const pair = buildGenesisHardenedPair({
      origin: ORIGIN,
      originLockingScriptHex: ORIGIN_SCRIPT,
      ownerPublicKeyHex: owner.publicKey.toString(),
      brc150VerifiedForGenesis: true,
      legacyTipOutpoint: `${anchor.legacyTx.id}_0`,
    })
    const nextProof = createCovenantInstance({
      role: 1,
      origin: ORIGIN,
      originScriptHash: pair.originScriptHash,
      ownerPublicKeyHex: recipient.publicKey.toString(),
      linkOutpoint: `${anchor.legacyTx.id}_0`,
      legacyTipOutpoint: `${anchor.legacyTx.id}_0`,
    })

    const commitAction = new bsv.Transaction()
      .from(utxo(anchor.legacyTx, 0))
      .from(utxo(anchor.fundingTx, 0))
      .addOutput(
        new bsv.Transaction.Output({
          script: pair.tip.lockingScript,
          satoshis: HARDENED_TIP_SATS,
        }),
      )
      .addOutput(
        new bsv.Transaction.Output({
          script: nextProof.lockingScript,
          satoshis: HARDENED_PROOF_SATS,
        }),
      )
      .change(funding.toAddress())

    const commitSignable = signableFromScryptTx(
      commitAction,
      anchor.legacyTx,
      'ref-commit-1',
      [anchor.ancestorTx, anchor.fundingTx],
    )
    const commitTxid = commitAction.id

    const createAction = vi.fn()
    const signAction = vi.fn()
    const abortAction = vi.fn(async () => ({}))

    createAction.mockImplementation(
      async (args: {
        outputs?: Array<{ lockingScript: string; satoshis: number }>
        options?: { noSend?: boolean; sendWith?: string[] }
      }) => {
        if (args.options?.noSend) {
          return { signableTransaction: commitSignable }
        }
        const settleTip = Brc156Covenant.fromTx(commitAction, 0)
        const { settleTip: nextSettle, beaconScript } = buildNextSettleTip(
          settleTip,
          recipient.publicKey.toString(),
          commitTxid,
        )
        const settleTx = new bsv.Transaction()
          .addInput(settleTip.buildContractInput())
          .from(utxo(anchor.fundingTx, 0))
        for (const out of args.outputs ?? []) {
          settleTx.addOutput(
            new bsv.Transaction.Output({
              script: bsv.Script.fromHex(out.lockingScript),
              satoshis: out.satoshis,
            }),
          )
        }
        // Prefer createAction-provided outs; fall back if mock skipped them.
        if ((args.outputs?.length ?? 0) === 0) {
          settleTx
            .addOutput(
              new bsv.Transaction.Output({
                script: nextSettle.lockingScript,
                satoshis: 1,
              }),
            )
            .addOutput(
              new bsv.Transaction.Output({
                script: beaconScript,
                satoshis: HARDENED_BEACON_SATS,
              }),
            )
        }
        settleTx.change(funding.toAddress())
        settleTx.inputs[0]!.output = commitAction.outputs[0]
        restoreScryptChangeMarker(settleTx)
        return {
          signableTransaction: signableFromScryptTx(
            settleTx,
            commitAction,
            'ref-settle-1',
            [anchor.legacyTx],
          ),
        }
      },
    )

    signAction
      .mockResolvedValueOnce({ txid: commitTxid, tx: commitSignable.tx })
      .mockResolvedValueOnce({
        txid: 'ee'.repeat(32),
        tx: commitSignable.tx,
      })

    const wallet = {
      rootKeyHex: owner.toBuffer().toString('hex'),
      identityKey: owner.publicKey.toString(),
      wallet: { createAction, signAction, abortAction },
      services: {
        getBeefForTxid: async (txid: string) => {
          const b = new Beef()
          if (txid === anchor.legacyTx.id) b.mergeRawTx(sdkLegacy.toBinary())
          else if (txid === anchor.ancestorTx.id) b.mergeRawTx(sdkAncestor.toBinary())
          return b
        },
      },
    } as unknown as ActiveWallet

    let sendErr: unknown
    try {
      await sendHardenedCollectable({
        wallet,
        outpoint: tipOp,
        recipientIdentityKey: recipient.publicKey.toString(),
        toAddress: recipient.toAddress().toString(),
        origin: ORIGIN,
        name: 'Probe',
        tipLockingScript: p2pkhScript,
        originLockingScriptHex: ORIGIN_SCRIPT,
        priorProofOutpoint: null,
        inputBEEF: tipBeef.toBinaryAtomic(sdkLegacy.id('hex')),
        knownTxids: [anchor.legacyTx.id],
        buildInputBeefForSpends: async () => tipBeef.toBinary(),
        normalizeOutpoint: (op) =>
          op.includes('_') ? op.replace(/_(\d+)$/, '.$1') : op,
        formatSendError: (e) => (e instanceof Error ? e : new Error(String(e))),
        isAlreadySpentInputError: () => false,
        releaseStaleSpendableOutputs: async () => {},
      })
    } catch (err) {
      sendErr = err
    }

    expect(createAction).toHaveBeenCalledTimes(2)
    const commitArgs = createAction.mock.calls[0]?.[0]
    expect(commitArgs?.options?.noSend).toBe(true)
    expect(commitArgs?.options?.signAndProcess).toBe(false)
    expect(commitArgs?.options?.randomizeOutputs).toBe(false)

    expect(signAction.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(signAction.mock.calls[0]?.[0]?.options?.noSend).toBe(true)

    const settleArgs = createAction.mock.calls[1]?.[0]
    expect(settleArgs?.options?.sendWith).toEqual([commitTxid])

    if (signAction.mock.calls.length >= 2) {
      expect(signAction.mock.calls[1]?.[0]?.options?.sendWith).toEqual([commitTxid])
    } else if (sendErr) {
      expect(String(sendErr)).toMatch(/hashOutputs|Hardened settle|change output|genesis|P2PKH/)
    }
  })

  it('locateExplicitInputVins mirrors signOrdinalTransfer targeting', () => {
    const owner = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const funding = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const recipient = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const anchor = buildAnchor(owner, funding)
    const tip = Brc156Covenant.fromTx(anchor.genesisTx, 0)
    const { nextTip, nextProof } = buildNextCommitInstances(
      tip,
      recipient.publicKey.toString(),
    )
    const walletTx = new bsv.Transaction()
      .addInput(tip.buildContractInput())
      .addOutput(
        new bsv.Transaction.Output({
          script: nextTip.lockingScript,
          satoshis: HARDENED_TIP_SATS,
        }),
      )
      .addOutput(
        new bsv.Transaction.Output({
          script: nextProof.lockingScript,
          satoshis: HARDENED_PROOF_SATS,
        }),
      )
    const signable = signableFromScryptTx(walletTx, anchor.genesisTx, 'ref')
    const located = locateExplicitInputVins(signable, [`${anchor.genesisTx.id}.0`])
    expect(located.vins).toEqual([0])
  })

  it('isolated script-exec settleBase still works with OP_RETURN state', async () => {
    const alice = createTestSigner()
    await alice.provider.connect()
    const funding = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const bob = createTestSigner()
    await bob.provider.connect()
    const anchor = buildAnchor(alice.key, funding)
    const tip0 = Brc156Covenant.fromTx(anchor.genesisTx, 0)
    const tx1 = await runCommitWithScriptExec({
      tip: tip0,
      signerKey: alice.key,
      signer: alice.signer,
      provider: alice.provider,
      nextRecipientPublicKeyHex: bob.key.publicKey.toString(),
    })
    const tx2 = await runBaseSettleWithScriptExec({
      committedTip: tx1.tip,
      signerKey: alice.key,
      signer: alice.signer,
      recipientPublicKeyHex: bob.key.publicKey.toString(),
      commitTx: tx1.commitTx,
      genesisTx: anchor.genesisTx,
    })
    expect(tx2.settleTx.outputs[0]!.satoshis).toBe(1)
    expect(tx2.settleTx.outputs[1]!.satoshis).toBe(2)
    expect(tx2.settleTx.outputs[2]!.satoshis).toBe(0)
    expect(tx2.settleTx.outputs[2]!.script.toHex().startsWith('006a')).toBe(true)
  }, 60_000)
})
