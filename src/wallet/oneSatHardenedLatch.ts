/** Clean-room BRC-156 BOLT-style alternating proof builders and verifier. */
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
import brc156Artifact from '../../artifacts/brc156Covenant.json'
import {
  LATCH_DUST_SATS,
  LATCH_SCHEMA_HARDENED,
  RELATIVE_TIP,
  buildLatchStateScript,
  isValidOriginScriptHash,
  originScriptHash,
  toUnderscoreOutpoint,
  type LatchState,
} from './oneSatLatch'
import {
  BASE_LINK as HARDENED_BASE_LINK,
  canUseHardenedLatch,
} from './oneSatHardenedReceive'
import {
  hexToU32Le,
  reverseTxidHex,
  u32LeToHex,
} from './hexBinary'

export {
  BASE_LINK,
  canUseHardenedLatch,
  isHardenedCovenantLockingScript,
  isHardenedSendEnabled,
  parseHardenedTipInstructions,
  resolveAlternatingProofContext,
  verifyAlternatingProofBounded,
  verifyHardenedReceive,
  type AlternatingVerifyArgs,
  type HardenedReceiveArgs,
} from './oneSatHardenedReceive'

const BASE_LINK = HARDENED_BASE_LINK
let artifactLoaded = false

export const HARDENED_TIP_SATS = 1
export const HARDENED_BEACON_SATS = LATCH_DUST_SATS
export const HARDENED_PROOF_SATS = 3
/** Generous vin unlocking length for tip/proof embeds in settle. */
export const HARDENED_UNLOCKING_SCRIPT_LENGTH = 12_000
/** Alias for {@link LATCH_SCHEMA_HARDENED}. */
export const HARDENED_LATCH_SCHEMA_VERSION = LATCH_SCHEMA_HARDENED
/**
 * Relative ref for the OP_RETURN latch-state output on Settle
 * (tip@0, beacon@1, state@2).
 */
export const RELATIVE_HARDENED_PROOF = 'OUTPUT:2' as const

/**
 * scrypt-ts still reads `process.env.NETWORK` / `BASEURL` at call time. Vite
 * define covers the common paths; this fills any residual `process` access in
 * the WebView so covenant signing does not throw into the soft-latch fallback.
 */
function ensureScryptProcessShim(): void {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> }
  }
  if (!g.process) g.process = { env: {} }
  if (!g.process.env) g.process.env = {}
  if (g.process.env.NETWORK === undefined) g.process.env.NETWORK = ''
  if (g.process.env.BASEURL === undefined) g.process.env.BASEURL = ''
  if (g.process.env.NODE_ENV === undefined) {
    g.process.env.NODE_ENV = 'production'
  }
}

export function loadBrc156CovenantArtifact(): void {
  ensureScryptProcessShim()
  if (artifactLoaded) return
  Brc156Covenant.loadArtifact(brc156Artifact)
  artifactLoaded = true
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
  return txid + u32LeToHex(Number(voutRaw))
}

/** Raw prevout encoding: txid LE + vout LE. */
export function encodeLineageOutpoint(outpoint: string): string {
  if (outpoint === BASE_LINK) return '00'.repeat(36)
  const [txid, voutRaw] = toUnderscoreOutpoint(outpoint).split('_')
  if (!txid || txid.length !== 64 || voutRaw == null) {
    throw new Error('invalid lineage outpoint')
  }
  return reverseTxidHex(txid) + u32LeToHex(Number(voutRaw))
}

function pubKey(publicKeyHex: string): PubKey {
  return PubKey(toByteString(PublicKey.fromString(publicKeyHex).toString()))
}

/** PubKey from compressed identity key hex for scrypt-ts method calls. */
export function pubKeyHexToScrypt(publicKeyHex: string): PubKey {
  return pubKey(publicKeyHex)
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
  name?: string
  app?: string
  mimeType?: string
}): LatchState {
  return {
    schema: LATCH_SCHEMA_HARDENED,
    mode: 'hardened',
    origin: toUnderscoreOutpoint(args.origin),
    tip: RELATIVE_TIP,
    latch: RELATIVE_HARDENED_PROOF,
    beacon: 'OUTPUT:1',
    parentLatch: toUnderscoreOutpoint(args.delayedProofOutpoint),
    proofOutpoint: toUnderscoreOutpoint(args.delayedProofOutpoint),
    originScriptHash: args.originScriptHash.toLowerCase(),
    ownerKeyHash: ownerKeyHashFromPubkey(args.ownerPublicKeyHex),
    commitTxid: args.commitTxid,
    settleTxid: 'SELF',
    ...(args.name ? { name: args.name } : {}),
    ...(args.app ? { app: args.app } : {}),
    ...(args.mimeType ? { mimeType: args.mimeType } : {}),
  }
}

/**
 * Settle-state alias used by the wallet bridge. `proofOutpoint` /
 * `parentLatch` point at the delayed proof (Commit vout1), never a
 * same-tx sibling.
 */
export function buildHardenedSettleState(args: {
  origin: string
  originScriptHash: string
  /** Delayed proof outpoint (typically `${commitTxid}_1` after base settle). */
  delayedProofOutpoint?: string
  parentLatch?: string
  grandparentOutpoint?: string
  ownerPublicKeyHex: string
  commitTxid?: string
  name?: string
  app?: string
  mimeType?: string
  proofOutpoint?: string
}): LatchState {
  const delayed =
    args.proofOutpoint ??
    args.delayedProofOutpoint ??
    args.parentLatch ??
    BASE_LINK
  void args.grandparentOutpoint
  return buildHardenedLatchState({
    origin: args.origin,
    originScriptHash: args.originScriptHash,
    delayedProofOutpoint: delayed,
    ownerPublicKeyHex: args.ownerPublicKeyHex,
    commitTxid: args.commitTxid,
    name: args.name,
    app: args.app,
    mimeType: args.mimeType,
  })
}

/** Tip `customInstructions` JSON for hardened covenant outputs. */
export function hardenedTipCustomInstructions(args: {
  origin: string
  name: string
  app?: string
  originScriptHash: string
  ownerPublicKeyHex: string
  proofOutpoint?: string
  commitTxid?: string
}): string {
  return JSON.stringify({
    mode: 'hardened',
    origin: toUnderscoreOutpoint(args.origin),
    name: args.name.slice(0, 80),
    ...(args.app ? { app: args.app.slice(0, 40) } : {}),
    originScriptHash: args.originScriptHash.toLowerCase(),
    ownerKeyHash: ownerKeyHashFromPubkey(args.ownerPublicKeyHex),
    ...(args.proofOutpoint
      ? { proofOutpoint: toUnderscoreOutpoint(args.proofOutpoint) }
      : {}),
    ...(args.commitTxid ? { commitTxid: args.commitTxid.toLowerCase() } : {}),
  })
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
  stateScriptHex?: string
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
  const stateHex =
    args.stateScriptHex ??
    buildLatchStateScript(
      buildHardenedLatchState({
        origin: decodeOrigin(args.committedTip.origin),
        originScriptHash: String(args.committedTip.originScriptHash),
        delayedProofOutpoint: `${args.commitTx.id}_1`,
        ownerPublicKeyHex: args.recipientPublicKeyHex,
        commitTxid: args.commitTx.id,
      }),
    )
  const stateScript = bsv.Script.fromHex(stateHex)
  args.committedTip.bindTxBuilder('settleBase', async (instance, options) => {
    const tx = new bsv.Transaction()
      .addInput(instance.buildContractInput())
      .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: 1 }))
      .addOutput(new bsv.Transaction.Output({ script: beacon, satoshis: 2 }))
      .addOutput(new bsv.Transaction.Output({ script: stateScript, satoshis: 0 }))
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
    toByteString(stateHex),
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
  stateScriptHex?: string
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
  const stateHex =
    args.stateScriptHex ??
    buildLatchStateScript(
      buildHardenedLatchState({
        origin: decodeOrigin(args.committedTip.origin),
        originScriptHash: String(args.committedTip.originScriptHash),
        delayedProofOutpoint: `${args.proofCommitTx.id}_1`,
        ownerPublicKeyHex: args.recipientPublicKeyHex,
        commitTxid: args.currentCommitTx.id,
      }),
    )
  const stateScript = bsv.Script.fromHex(stateHex)
  const build = () => {
    const tx = new bsv.Transaction()
      .addInput(args.committedTip.buildContractInput())
      .addInput(args.delayedProof.buildContractInput())
      .addOutput(new bsv.Transaction.Output({ script: next.lockingScript, satoshis: 1 }))
    if (!args.mutateOutputs) {
      tx.addOutput(new bsv.Transaction.Output({ script: beacon, satoshis: 2 }))
      tx.addOutput(new bsv.Transaction.Output({ script: stateScript, satoshis: 0 }))
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
    toByteString(stateHex),
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
  const txid = reverseTxidHex(bytes.slice(0, 64))
  const vout = hexToU32Le(bytes.slice(64))
  return `${txid}_${vout}`
}

/** Decode tip/proof `linkOutpoint` state to `txid_vout`. */
export function decodeHardenedLinkOutpoint(bytes: string): string {
  return decodeLineage(String(bytes).replace(/^0x/i, ''))
}

function decodeOrigin(bytes: string): string {
  const raw = String(bytes).replace(/^0x/i, '')
  const txid = raw.slice(0, 64)
  const vout = hexToU32Le(raw.slice(64))
  return `${txid}_${vout}`
}

export { Brc156Covenant, buildLatchStateScript, originScriptHash }
