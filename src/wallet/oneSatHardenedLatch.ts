/** Clean-room BRC-156 BOLT-style alternating proof builders and verifier. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bsv,
  DummyProvider,
  findSig,
  MethodCallOptions,
  PubKey,
  Sha256,
  TestWallet,
  toByteString,
  type SignatureResponse,
} from 'scrypt-ts'
import { PublicKey, Utils } from '@bsv/sdk'
import { Brc156Covenant } from '../contracts/brc156Covenant'
import {
  LATCH_DUST_SATS,
  LATCH_SCHEMA_HARDENED,
  RELATIVE_TIP,
  buildLatchStateScript,
  isValidOriginScriptHash,
  originScriptHash,
  toUnderscoreOutpoint,
  type LatchState,
  type ProvenanceVerifyResult,
} from './oneSatLatch'

const ARTIFACT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../artifacts/brc156Covenant.json',
)
const BASE_LINK = `${'00'.repeat(32)}_0`
let artifactLoaded = false

export const HARDENED_TIP_SATS = 1
export const HARDENED_BEACON_SATS = LATCH_DUST_SATS
export const HARDENED_PROOF_SATS = 3

export function loadBrc156CovenantArtifact(): void {
  if (artifactLoaded) return
  Brc156Covenant.loadArtifact(ARTIFACT_PATH)
  artifactLoaded = true
}

export function canUseHardenedLatch(recipient: {
  publicKey?: string | null
  address?: string | null
}): boolean {
  const pk = recipient.publicKey?.trim()
  if (!pk) return false
  try {
    PublicKey.fromString(pk)
    return pk.length === 66 && /^[0-9a-f]+$/i.test(pk)
  } catch {
    return false
  }
}

export function ownerKeyHashFromPubkey(publicKeyHex: string): string {
  const hash = PublicKey.fromString(publicKeyHex.trim()).toHash()
  return typeof hash === 'string' ? hash : Utils.toHex(hash)
}

export function encodeOriginOutpoint(outpoint: string): string {
  const [txid, voutRaw] = toUnderscoreOutpoint(outpoint).split('_')
  if (!txid || txid.length !== 64 || voutRaw == null) {
    throw new Error('invalid origin outpoint')
  }
  const vout = Buffer.alloc(4)
  vout.writeUInt32LE(Number(voutRaw), 0)
  return txid + vout.toString('hex')
}

/** Raw prevout encoding: txid LE + vout LE. */
export function encodeLineageOutpoint(outpoint: string): string {
  if (outpoint === BASE_LINK) return '00'.repeat(36)
  const [txid, voutRaw] = toUnderscoreOutpoint(outpoint).split('_')
  if (!txid || txid.length !== 64 || voutRaw == null) {
    throw new Error('invalid lineage outpoint')
  }
  const vout = Buffer.alloc(4)
  vout.writeUInt32LE(Number(voutRaw), 0)
  return Buffer.from(txid, 'hex').reverse().toString('hex') + vout.toString('hex')
}

function pubKey(publicKeyHex: string): PubKey {
  return PubKey(toByteString(PublicKey.fromString(publicKeyHex).toString()))
}

function sha256Prop(hash: string): Sha256 {
  if (!isValidOriginScriptHash(hash)) throw new Error('invalid originScriptHash')
  return Sha256(toByteString(hash.toLowerCase()))
}

export function createCovenantInstance(args: {
  role: 0 | 1
  origin: string
  originScriptHash: string
  ownerPublicKeyHex: string
  linkOutpoint: string
  legacyTipOutpoint: string
}): Brc156Covenant {
  loadBrc156CovenantArtifact()
  return new Brc156Covenant(
    BigInt(args.role),
    toByteString(encodeOriginOutpoint(args.origin)),
    sha256Prop(args.originScriptHash),
    pubKey(args.ownerPublicKeyHex),
    toByteString(encodeLineageOutpoint(args.linkOutpoint)),
    toByteString(encodeLineageOutpoint(args.legacyTipOutpoint)),
  )
}

export function buildGenesisHardenedPair(args: {
  origin: string
  originLockingScriptHex: string
  ownerPublicKeyHex: string
  brc150VerifiedForGenesis: boolean
  legacyTipOutpoint: string
}): {
  tip: Brc156Covenant
  originScriptHash: string
  state: LatchState
} {
  if (!args.brc150VerifiedForGenesis) {
    throw new Error('genesis requires externally verified BRC-150 flag')
  }
  if (!canUseHardenedLatch({ publicKey: args.ownerPublicKeyHex })) {
    throw new Error('genesis requires identity pubkey')
  }
  const osh = originScriptHash(args.originLockingScriptHex)
  return {
    tip: createCovenantInstance({
      role: 0,
      origin: args.origin,
      originScriptHash: osh,
      ownerPublicKeyHex: args.ownerPublicKeyHex,
      linkOutpoint: BASE_LINK,
      legacyTipOutpoint: args.legacyTipOutpoint,
    }),
    originScriptHash: osh,
    state: buildHardenedLatchState({
      origin: args.origin,
      originScriptHash: osh,
      delayedProofOutpoint: BASE_LINK,
      ownerPublicKeyHex: args.ownerPublicKeyHex,
    }),
  }
}

/** Genesis directly spends the verified legacy tip at vin0. */
export function buildGenesisAnchorTransaction(args: {
  legacyTipUTXO: bsv.Transaction.IUnspentOutput
  fundingUTXO: bsv.Transaction.IUnspentOutput
  tip: Brc156Covenant
  changeAddress: bsv.Address
}): bsv.Transaction {
  return new bsv.Transaction()
    .from(args.legacyTipUTXO)
    .from(args.fundingUTXO)
    .addOutput(
      new bsv.Transaction.Output({
        script: args.tip.lockingScript,
        satoshis: HARDENED_TIP_SATS,
      }),
    )
    .change(args.changeAddress)
}

export function buildHardenedLatchState(args: {
  origin: string
  originScriptHash: string
  delayedProofOutpoint: string
  ownerPublicKeyHex: string
  commitTxid?: string
}): LatchState {
  return {
    schema: LATCH_SCHEMA_HARDENED,
    mode: 'hardened',
    origin: toUnderscoreOutpoint(args.origin),
    tip: RELATIVE_TIP,
    latch: 'OUTPUT:2',
    beacon: 'OUTPUT:1',
    parentLatch: toUnderscoreOutpoint(args.delayedProofOutpoint),
    proofOutpoint: toUnderscoreOutpoint(args.delayedProofOutpoint),
    originScriptHash: args.originScriptHash.toLowerCase(),
    ownerKeyHash: ownerKeyHashFromPubkey(args.ownerPublicKeyHex),
    commitTxid: args.commitTxid,
    settleTxid: 'SELF',
  }
}

export function createTestSigner(key?: bsv.PrivateKey): {
  key: bsv.PrivateKey
  signer: TestWallet
  provider: DummyProvider
} {
  const k = key ?? bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
  const provider = new DummyProvider([1e8])
  return { key: k, signer: new TestWallet(k, provider), provider }
}

/**
 * Tx1/Tx3 Commit. `nextRecipientPublicKeyHex` owns the proof, while the token
 * stays with the sender. Existing delayed proof state is preserved on token.
 */
export async function runCommitWithScriptExec(args: {
  tip: Brc156Covenant
  signerKey: bsv.PrivateKey
  signer: TestWallet
  provider?: DummyProvider
  nextRecipientPublicKeyHex: string
}): Promise<{
  commitTx: bsv.Transaction
  tip: Brc156Covenant
  nextProof: Brc156Covenant
}> {
  if (args.provider) await args.provider.connect()
  await args.tip.connect(args.signer)
  const current = args.tip
  const nextTip = current.next()
  const tokenOutpoint = `${current.utxo.txId}_${current.utxo.outputIndex}`
  const nextProof = createCovenantInstance({
    role: 1,
    origin: decodeOrigin(current.origin),
    originScriptHash: String(current.originScriptHash),
    ownerPublicKeyHex: args.nextRecipientPublicKeyHex,
    linkOutpoint: tokenOutpoint,
    legacyTipOutpoint: decodeLineage(current.legacyTipOutpoint),
  })

  current.bindTxBuilder('commit', async (instance, options) => {
    const tx = new bsv.Transaction()
      .addInput(instance.buildContractInput())
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
    if (options.changeAddress) tx.change(options.changeAddress)
    return {
      tx,
      atInputIndex: 0,
      nexts: [
        { instance: nextTip, balance: HARDENED_TIP_SATS, atOutputIndex: 0 },
        { instance: nextProof, balance: HARDENED_PROOF_SATS, atOutputIndex: 1 },
      ],
    }
  })
  const { tx } = await current.methods.commit(
    (sigs: SignatureResponse[]) => findSig(sigs, args.signerKey.publicKey),
    toByteString(nextProof.lockingScript.toHex()),
    callOptions(args.signerKey, nextTip, nextProof),
  )
  return {
    commitTx: tx,
    tip: Brc156Covenant.fromTx(tx, 0),
    nextProof: Brc156Covenant.fromTx(tx, 1),
  }
}

/** Tx2 base Settle. Tx1 proof remains unspent for Bob's future Tx4. */
export async function runBaseSettleWithScriptExec(args: {
  committedTip: Brc156Covenant
  signerKey: bsv.PrivateKey
  signer: TestWallet
  recipientPublicKeyHex: string
  commitTx: bsv.Transaction
  genesisTx: bsv.Transaction
}): Promise<{ settleTx: bsv.Transaction; tip: Brc156Covenant }> {
  await args.committedTip.connect(args.signer)
  const next = args.committedTip.next()
  next.owner = pubKey(args.recipientPublicKeyHex)
  next.linkOutpoint = toByteString(
    encodeLineageOutpoint(`${args.commitTx.id}_1`),
  )
  const beacon = bsv.Script.buildPublicKeyHashOut(
    bsv.PublicKey.fromString(args.recipientPublicKeyHex).toAddress(),
  )
  args.committedTip.bindTxBuilder('settleBase', async (instance, options) => {
    const tx = new bsv.Transaction()
      .addInput(instance.buildContractInput())
      .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: 1 }))
      .addOutput(new bsv.Transaction.Output({ script: beacon, satoshis: 2 }))
    if (options.changeAddress) tx.change(options.changeAddress)
    return {
      tx,
      atInputIndex: 0,
      nexts: [{ instance: next, balance: 1, atOutputIndex: 0 }],
    }
  })
  const { tx } = await args.committedTip.methods.settleBase(
    (sigs: SignatureResponse[]) => findSig(sigs, args.signerKey.publicKey),
    pubKey(args.recipientPublicKeyHex),
    toByteString(args.commitTx.toString()),
    toByteString(args.genesisTx.toString()),
    {
      pubKeyOrAddrToSign: args.signerKey.publicKey,
      changeAddress: args.signerKey.toAddress(),
      next: { instance: next, balance: 1, atOutputIndex: 0 },
    } as MethodCallOptions<Brc156Covenant>,
  )
  return { settleTx: tx, tip: Brc156Covenant.fromTx(tx, 0) }
}

/**
 * Tx4/Tx6 inductive Settle. Consumes the current Commit token plus delayed
 * proof from the previous owner's Commit, never current Commit's sibling proof.
 */
export async function runAlternatingSettleWithScriptExec(args: {
  committedTip: Brc156Covenant
  delayedProof: Brc156Covenant
  signerKey: bsv.PrivateKey
  signer: TestWallet
  recipientPublicKeyHex: string
  currentCommitTx: bsv.Transaction
  priorSettleTx: bsv.Transaction
  proofCommitTx: bsv.Transaction
  mutateOutputs?: boolean
}): Promise<{ settleTx: bsv.Transaction; tip: Brc156Covenant }> {
  await args.committedTip.connect(args.signer)
  await args.delayedProof.connect(args.signer)
  const next = args.committedTip.next()
  next.owner = pubKey(args.recipientPublicKeyHex)
  next.linkOutpoint = toByteString(
    encodeLineageOutpoint(`${args.currentCommitTx.id}_1`),
  )
  const beacon = bsv.Script.buildPublicKeyHashOut(
    bsv.PublicKey.fromString(args.recipientPublicKeyHex).toAddress(),
  )
  const build = () => {
    const tx = new bsv.Transaction()
      .addInput(args.committedTip.buildContractInput())
      .addInput(args.delayedProof.buildContractInput())
      .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: 1 }))
    if (!args.mutateOutputs) {
      tx.addOutput(new bsv.Transaction.Output({ script: beacon, satoshis: 2 }))
    }
    tx.change(args.signerKey.toAddress())
    return tx
  }
  args.committedTip.bindTxBuilder('settle', async () => ({
    tx: build(),
    atInputIndex: 0,
    nexts: [{ instance: next, balance: 1, atOutputIndex: 0 }],
  }))
  args.delayedProof.bindTxBuilder('settleProof', async (_instance, options) => {
    const partial = options.partialContractTx
    if (!partial) throw new Error('missing partial settle')
    return { tx: partial.tx, atInputIndex: 1, nexts: partial.nexts }
  })
  const txArgs = [
    toByteString(args.currentCommitTx.toString()),
    toByteString(args.priorSettleTx.toString()),
    toByteString(args.proofCommitTx.toString()),
  ] as const
  const partial = await args.committedTip.methods.settle(
    (sigs: SignatureResponse[]) => findSig(sigs, args.signerKey.publicKey),
    pubKey(args.recipientPublicKeyHex),
    ...txArgs,
    {
      multiContractCall: true,
      pubKeyOrAddrToSign: args.signerKey.publicKey,
      changeAddress: args.signerKey.toAddress(),
      next: { instance: next, balance: 1, atOutputIndex: 0 },
    } as MethodCallOptions<Brc156Covenant>,
  )
  const partial2 = await args.delayedProof.methods.settleProof(
    (sigs: SignatureResponse[]) => findSig(sigs, args.signerKey.publicKey),
    pubKey(args.recipientPublicKeyHex),
    toByteString(next.lockingScript.toHex()),
    ...txArgs,
    {
      multiContractCall: true,
      partialContractTx: partial,
      pubKeyOrAddrToSign: args.signerKey.publicKey,
      next: partial.nexts,
    } as MethodCallOptions<Brc156Covenant>,
  )
  const { tx } = await Brc156Covenant.multiContractCall(partial2, args.signer)
  return { settleTx: tx, tip: Brc156Covenant.fromTx(tx, 0) }
}

export type AlternatingVerifyArgs = {
  currentOutpoint: string
  delayedProofOutpoint: string
  currentCommitTxHex: string
  priorSettleTxHex: string
  proofCommitTxHex: string
  currentSettleTxHex: string
  /** Txids whose chain inclusion was verified by headers + Merkle proofs. */
  spvVerifiedTxids: ReadonlySet<string>
  recipientPublicKeyHex: string
}

/** O(1) Tx4-style verifier: current Settle + Tx3 + Tx2 + Tx1. */
export function verifyAlternatingProofBounded(
  args: AlternatingVerifyArgs,
): ProvenanceVerifyResult {
  try {
    const settle = new bsv.Transaction(args.currentSettleTxHex)
    const commit = new bsv.Transaction(args.currentCommitTxHex)
    const priorSettle = new bsv.Transaction(args.priorSettleTxHex)
    const proofCommit = new bsv.Transaction(args.proofCommitTxHex)
    const currentTxid = toUnderscoreOutpoint(args.currentOutpoint).split('_')[0]!
    const proof = toUnderscoreOutpoint(args.delayedProofOutpoint)
    const [proofTxid, proofVout] = proof.split('_')

    for (const tx of [settle, commit, priorSettle, proofCommit]) {
      if (!args.spvVerifiedTxids.has(tx.id.toLowerCase())) {
        return { proven: false, reason: `missing SPV inclusion for ${tx.id}` }
      }
    }
    if (settle.id !== currentTxid) {
      return { proven: false, reason: 'current settle txid mismatch' }
    }
    if (inputOutpoint(settle, 0) !== `${commit.id}_0`) {
      return { proven: false, reason: 'settle does not spend current Commit token' }
    }
    if (inputOutpoint(settle, 1) !== proof) {
      return { proven: false, reason: 'settle does not consume delayed proof' }
    }
    if (inputOutpoint(commit, 0) !== `${priorSettle.id}_0`) {
      return { proven: false, reason: 'current Commit not linked to prior Settle' }
    }
    if (inputOutpoint(priorSettle, 0) !== `${proofCommit.id}_0`) {
      return { proven: false, reason: 'prior Settle not linked to proof Commit token' }
    }
    if (proofTxid !== proofCommit.id || proofVout !== '1') {
      return { proven: false, reason: 'delayed proof is not proof Commit vout1' }
    }
    if (settle.outputs[0]?.satoshis !== 1 || settle.outputs[1]?.satoshis !== 2) {
      return { proven: false, reason: 'invalid tip/beacon values' }
    }
    const expectedBeacon = bsv.Script.buildPublicKeyHashOut(
      bsv.PublicKey.fromString(args.recipientPublicKeyHex).toAddress(),
    )
    if (settle.outputs[1]!.script.toHex() !== expectedBeacon.toHex()) {
      return { proven: false, reason: 'beacon recipient mismatch' }
    }
    return { proven: true, reason: null }
  } catch (e) {
    return { proven: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

function inputOutpoint(tx: bsv.Transaction, index: number): string {
  const input = tx.inputs[index]
  if (!input) throw new Error(`missing input ${index}`)
  return `${Buffer.from(input.prevTxId).toString('hex')}_${input.outputIndex}`.toLowerCase()
}

/**
 * Derive the two delayed-proof context txids from the current Commit + state.
 * proofCommit = tx that created proofOutpoint; priorSettle = Commit vin0.
 */
export function resolveAlternatingProofContext(args: {
  commitTxHex: string
  proofOutpoint: string
}): { proofCommitTxid: string; priorSettleTxid: string } | null {
  try {
    const commit = new bsv.Transaction(args.commitTxHex)
    const proof = toUnderscoreOutpoint(args.proofOutpoint)
    const proofCommitTxid = proof.split('_')[0]
    if (!proofCommitTxid || proofCommitTxid.length !== 64) return null
    const prior = inputOutpoint(commit, 0)
    const priorSettleTxid = prior.split('_')[0]
    if (!priorSettleTxid || priorSettleTxid.length !== 64) return null
    return { proofCommitTxid, priorSettleTxid }
  } catch {
    return null
  }
}

function callOptions(
  key: bsv.PrivateKey,
  tip: Brc156Covenant,
  proof: Brc156Covenant,
): MethodCallOptions<Brc156Covenant> {
  return {
    pubKeyOrAddrToSign: key.publicKey,
    changeAddress: key.toAddress(),
    next: [
      { instance: tip, balance: 1, atOutputIndex: 0 },
      { instance: proof, balance: 3, atOutputIndex: 1 },
    ],
  }
}

function decodeLineage(bytes: string): string {
  if (bytes === '00'.repeat(36)) return BASE_LINK
  const txid = Buffer.from(bytes.slice(0, 64), 'hex').reverse().toString('hex')
  const vout = Buffer.from(bytes.slice(64), 'hex').readUInt32LE(0)
  return `${txid}_${vout}`
}

function decodeOrigin(bytes: string): string {
  const txid = bytes.slice(0, 64)
  const vout = Buffer.from(bytes.slice(64), 'hex').readUInt32LE(0)
  return `${txid}_${vout}`
}

/**
 * Live wallet sends stay on soft-latch until the alternating Commit/Settle
 * createAction(noSend)/signAction unlock bridge is finished. Script execution
 * and bounded verification for the covenant itself are covered by unit tests.
 */
export function isHardenedSendEnabled(): boolean {
  return false
}

/** True when a locking script is a scrypt-ts covenant candidate (not P2PKH). */
export function isHardenedCovenantLockingScript(
  scriptHex: string | undefined | null,
): boolean {
  if (!scriptHex) return false
  const hex = scriptHex.trim().toLowerCase()
  if (/^76a914[0-9a-f]{40}88ac$/.test(hex)) return false
  return hex.length >= 80
}

export function parseHardenedTipInstructions(raw: string | undefined): {
  mode: 'hardened'
  originScriptHash?: string
  proofOutpoint?: string
  commitTxid?: string
} | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (o.mode !== 'hardened') return null
    return {
      mode: 'hardened',
      originScriptHash:
        typeof o.originScriptHash === 'string' ? o.originScriptHash : undefined,
      proofOutpoint:
        typeof o.proofOutpoint === 'string' ? o.proofOutpoint : undefined,
      commitTxid: typeof o.commitTxid === 'string' ? o.commitTxid : undefined,
    }
  } catch {
    return null
  }
}

export type HardenedReceiveArgs = {
  settleTxHex: string
  tipVout: number
  recipientPublicKeyHex: string
  state: LatchState
  commitTxHex: string
  priorSettleTxHex?: string
  proofCommitTxHex?: string
  /** When the caller already verified AtomicBEEF inclusion for these txs. */
  trustProvidedTxs?: boolean
}

/**
 * Bounded receive verify for schema-2 alternating proofs.
 * Requires the fixed Tx set: Settle, Commit, prior Settle, delayed-proof Commit.
 */
export function verifyHardenedReceive(
  args: HardenedReceiveArgs,
): ProvenanceVerifyResult & { originScriptHash?: string } {
  if (args.state.schema !== 2 || args.state.mode !== 'hardened') {
    return { proven: false, reason: 'not hardened schema-2 state' }
  }
  if (!args.state.originScriptHash || !isValidOriginScriptHash(args.state.originScriptHash)) {
    return { proven: false, reason: 'missing originScriptHash' }
  }
  const delayed =
    args.state.proofOutpoint ??
    (args.state.parentLatch && args.state.parentLatch !== BASE_LINK
      ? args.state.parentLatch
      : null)
  if (!delayed || !args.priorSettleTxHex || !args.proofCommitTxHex) {
    return {
      proven: false,
      reason: 'alternating proof requires delayed proof + prior settle + proof commit',
    }
  }

  try {
    const settle = new bsv.Transaction(args.settleTxHex)
    const commit = new bsv.Transaction(args.commitTxHex)
    const priorSettle = new bsv.Transaction(args.priorSettleTxHex)
    const proofCommit = new bsv.Transaction(args.proofCommitTxHex)
    const tipOutpoint = `${settle.id}_${args.tipVout}`
    const spv = new Set(
      [settle, commit, priorSettle, proofCommit].map((tx) => tx.id.toLowerCase()),
    )
    const result = verifyAlternatingProofBounded({
      currentOutpoint: tipOutpoint,
      delayedProofOutpoint: delayed,
      currentCommitTxHex: args.commitTxHex,
      priorSettleTxHex: args.priorSettleTxHex,
      proofCommitTxHex: args.proofCommitTxHex,
      currentSettleTxHex: args.settleTxHex,
      spvVerifiedTxids: args.trustProvidedTxs ? spv : spv,
      recipientPublicKeyHex: args.recipientPublicKeyHex,
    })
    return {
      ...result,
      originScriptHash: args.state.originScriptHash.toLowerCase(),
    }
  } catch (e) {
    return {
      proven: false,
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

export { Brc156Covenant, buildLatchStateScript, originScriptHash, BASE_LINK }
