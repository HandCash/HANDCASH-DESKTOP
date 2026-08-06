/**
 * Wallet-toolbox wiring for hardened BRC-156 Commit + Settle (+ 2-sat beacon).
 *
 * Flow: createAction `noSend` Commit → signAction `noSend` → createAction Settle with
 * `sendWith:[commitTxid]` → signAction `sendWith` so both broadcast together.
 *
 * Covenant inputs are unlocked with scrypt-ts method calls against the exact
 * wallet-built signable transaction (hashOutputs-bound). Never P2PKH templates
 * for covenant scripts (`signOrdinalTransfer` refuses them).
 *
 * Settle layout (matches verifier + import discovery):
 *   tip@0 (1 sat) · beacon@1 (2 sat P2PKH) · OP_RETURN state@2 · change
 * Commit layout: tip@0 · proof@1 (3 sat)
 * Settle consumes commit tip + delayed prior proof (never current sibling proof).
 */
import {
  Beef,
  PrivateKey,
  type SignableTransaction,
  type Transaction,
} from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import {
  bsv,
  findSig,
  toByteString,
  DummyProvider,
  TestWallet,
  type MethodCallOptions,
  type SignatureResponse,
} from 'scrypt-ts'
import type { ActiveWallet } from './session'
import {
  BASE_LINK,
  Brc156Covenant,
  HARDENED_BEACON_SATS,
  HARDENED_LATCH_SCHEMA_VERSION,
  HARDENED_PROOF_SATS,
  HARDENED_TIP_SATS,
  HARDENED_UNLOCKING_SCRIPT_LENGTH,
  RELATIVE_HARDENED_PROOF,
  buildGenesisHardenedPair,
  buildHardenedSettleState,
  canUseHardenedLatch,
  createCovenantInstance,
  decodeHardenedLinkOutpoint,
  encodeLineageOutpoint,
  hardenedTipCustomInstructions,
  isHardenedCovenantLockingScript,
  isHardenedSendEnabled,
  loadBrc156CovenantArtifact,
  pubKeyHexToScrypt,
} from './oneSatHardenedLatch'
import { markHardenedBroadcastAttempted } from './oneSatHardenedReceive'
import {
  ONE_SAT_LATCH_BASKET,
  RELATIVE_TIP,
  buildLatchStateScript,
  latchOutputTags,
  toUnderscoreOutpoint,
} from './oneSatLatch'
import { getProvenVerdict } from './provenCache'

export type HardenedSendArgs = {
  wallet: ActiveWallet
  outpoint: string
  recipientIdentityKey: string
  toAddress: string
  origin: string
  name: string
  app?: string
  mimeType?: string
  tipLockingScript?: string
  tipCustomInstructions?: string
  priorProofOutpoint?: string | null
  priorProofLockingScript?: string
  originLockingScriptHex?: string
  legacyParentOutpoint?: string
  inputBEEF: number[]
  knownTxids: string[]
  buildInputBeefForSpends: (
    wallet: ActiveWallet,
    outpoints: string[],
  ) => Promise<number[]>
  normalizeOutpoint: (op: string) => string
  formatSendError: (err: unknown) => Error
  isAlreadySpentInputError: (err: unknown) => boolean
  releaseStaleSpendableOutputs: () => Promise<unknown>
}

function sdkTxToScrypt(tx: Transaction): bsv.Transaction {
  return new bsv.Transaction(tx.toHex())
}

function attachInputSources(
  scryptTx: bsv.Transaction,
  sdkTx: Transaction,
  beef: Beef,
): void {
  for (let i = 0; i < scryptTx.inputs.length; i++) {
    const sdkIn = sdkTx.inputs[i]
    const scryptIn = scryptTx.inputs[i]
    if (!sdkIn || !scryptIn) continue
    const source =
      sdkIn.sourceTransaction ?? beef.findTxid(String(sdkIn.sourceTXID))?.tx
    if (!source) continue
    const out = source.outputs[sdkIn.sourceOutputIndex]
    if (!out?.lockingScript) continue
    scryptIn.output = new bsv.Transaction.Output({
      script: bsv.Script.fromHex(out.lockingScript.toHex()),
      satoshis: out.satoshis ?? 0,
    })
  }
}

/**
 * Locate the action transaction and vin indices for explicit outpoints —
 * same pattern as `signOrdinalTransfer`.
 */
export function locateExplicitInputVins(
  signable: SignableTransaction,
  outpoints: string[],
): { beef: Beef; unsigned: Transaction; vins: number[]; scryptTx: bsv.Transaction } {
  const targets = new Map<string, number>()
  for (const op of outpoints) {
    const normalized = op.includes('_') ? op.replace(/_(\d+)$/, '.$1') : op
    const [txidIn, voutRaw] = normalized.split('.')
    targets.set(`${txidIn?.toLowerCase()}.${Number(voutRaw)}`, Number(voutRaw))
  }

  const beef = Beef.fromBinary(signable.tx)
  let unsigned: Transaction | undefined
  const vins: number[] = []
  for (const btx of beef.txs) {
    if (!btx.tx) continue
    for (let i = 0; i < btx.tx.inputs.length; i++) {
      const input = btx.tx.inputs[i]
      const key = `${String(input?.sourceTXID).toLowerCase()}.${input?.sourceOutputIndex}`
      if (targets.has(key)) {
        unsigned = btx.tx
        vins.push(i)
      }
    }
    if (unsigned && vins.length === targets.size) break
  }
  if (!unsigned || vins.length === 0) {
    throw new Error('Hardened send: explicit input missing from signable transaction')
  }

  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
  }

  const scryptTx = sdkTxToScrypt(unsigned)
  attachInputSources(scryptTx, unsigned, beef)
  return { beef, unsigned, vins, scryptTx }
}

function resolveTxHexFromBeef(beef: Beef, txid: string): string {
  const tx = beef.findTxid(txid.toLowerCase())?.tx
  if (!tx) {
    throw new Error(`Hardened send: missing transaction ${txid.slice(0, 12)}… in BEEF`)
  }
  return tx.toHex()
}

async function ensureTxHex(
  wallet: ActiveWallet,
  beef: Beef,
  txid: string,
): Promise<string> {
  try {
    return resolveTxHexFromBeef(beef, txid)
  } catch {
    if (!wallet.services?.getBeefForTxid) throw new Error(`Missing tx ${txid}`)
    const fetched = await wallet.services.getBeefForTxid(txid)
    beef.mergeBeef(fetched.toBinary())
    return resolveTxHexFromBeef(beef, txid)
  }
}

function atomicBeefToNumberArray(
  tx: number[] | Uint8Array | undefined,
): number[] | undefined {
  if (!tx) return undefined
  return Array.isArray(tx) ? tx : Array.from(tx)
}

function normalizeOriginScriptHash(raw: string): string {
  const hex = raw.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`invalid originScriptHash from covenant state: ${raw.slice(0, 20)}`)
  }
  return hex
}

function tipSelfOutpoint(tip: Brc156Covenant): string {
  const from = tip.from
  if (from && 'tx' in from && from.tx && typeof from.outputIndex === 'number') {
    return `${from.tx.id}_${from.outputIndex}`
  }
  try {
    return `${tip.utxo.txId}_${tip.utxo.outputIndex}`
  } catch {
    throw new Error('Hardened send: tip instance missing source outpoint')
  }
}

export function buildNextCommitInstances(
  tip: Brc156Covenant,
  nextRecipientPublicKeyHex: string,
): {
  nextTip: Brc156Covenant
  nextProof: Brc156Covenant
} {
  const nextTip = tip.next()
  const tokenOutpoint = tipSelfOutpoint(tip)
  const nextProof = createCovenantInstance({
    role: 1,
    origin: decodeOriginField(String(tip.origin)),
    originScriptHash: normalizeOriginScriptHash(String(tip.originScriptHash)),
    ownerPublicKeyHex: nextRecipientPublicKeyHex,
    linkOutpoint: tokenOutpoint,
    legacyTipOutpoint: decodeHardenedLinkOutpoint(String(tip.legacyTipOutpoint)),
  })
  return { nextTip, nextProof }
}

function decodeOriginField(bytes: string): string {
  const raw = bytes.replace(/^0x/i, '')
  const txid = raw.slice(0, 64)
  const vout = Buffer.from(raw.slice(64), 'hex').readUInt32LE(0)
  return `${txid}_${vout}`
}

export function buildNextSettleTip(
  tip: Brc156Covenant,
  recipientPublicKeyHex: string,
  commitTxid: string,
): { settleTip: Brc156Covenant; beaconScript: bsv.Script } {
  const recipientPub = pubKeyHexToScrypt(recipientPublicKeyHex)
  const settleTip = tip.next()
  settleTip.owner = recipientPub
  settleTip.linkOutpoint = toByteString(encodeLineageOutpoint(`${commitTxid}_1`))
  const beaconScript = bsv.Script.buildPublicKeyHashOut(
    bsv.PublicKey.fromString(recipientPublicKeyHex).toAddress(),
  )
  return { settleTip, beaconScript }
}

/**
 * After AtomicBEEF → scrypt round-trip, bitcore's `_changeAddress` / `_changeIndex`
 * markers are lost. scrypt-ts `buildChangeOutput()` requires them whenever a
 * change output is present so hashOutputs stays bound to the wallet-built tx.
 */
export function restoreScryptChangeMarker(tx: bsv.Transaction): void {
  const txAny = tx as bsv.Transaction & {
    _changeAddress?: bsv.Address
    _changeIndex?: number
    getChangeAmount?: () => number
  }
  if (txAny._changeAddress != null && typeof txAny.getChangeAmount === 'function') {
    if (txAny.getChangeAmount() > 0) return
  }
  // Wallet change is the last positive-sat P2PKH after deterministic outs.
  // Skip the 2-sat discovery beacon (vout 1) and 0-sat OP_RETURN state (vout 2).
  for (let i = tx.outputs.length - 1; i >= 0; i--) {
    const out = tx.outputs[i]
    if (!out || out.satoshis <= 0) continue
    if (!out.script?.isPublicKeyHashOut?.()) continue
    if (out.satoshis === HARDENED_BEACON_SATS && i === 1) continue
    txAny._changeIndex = i
    txAny._changeAddress = bsv.Address.fromPublicKeyHash(
      out.script.getPublicKeyHash(),
    )
    return
  }
}

function estimateUnlockingLength(embeddedTxHexes: string[]): number {
  const embedded = embeddedTxHexes.reduce(
    (sum, hex) => sum + Math.ceil(hex.length / 2),
    0,
  )
  return Math.max(HARDENED_UNLOCKING_SCRIPT_LENGTH, embedded + 4096)
}

async function connectThrowawaySigner(
  instance: Brc156Covenant,
  signerKey: bsv.PrivateKey,
): Promise<TestWallet> {
  const provider = new DummyProvider([1e8])
  await provider.connect()
  const signer = new TestWallet(signerKey, provider)
  await instance.connect(signer)
  return signer
}

export type CovenantUnlockMode = 'commit' | 'settleBase' | 'settle'

/**
 * Generate + locally execute (hashOutputs-bound) unlocking scripts for covenant
 * inputs on the exact wallet-built signable transaction.
 */
export async function generateCovenantUnlocks(args: {
  wallet: ActiveWallet
  signable: SignableTransaction
  mode: CovenantUnlockMode
  /** Tip (+ delayed proof for settle) outpoints that must be unlocked. */
  outpoints: string[]
  nextProofScriptHex?: string
  nextTipScriptHex?: string
  stateScriptHex?: string
  recipientPublicKeyHex?: string
  /** settleBase / settle embedded txs */
  commitTxHex?: string
  genesisTxHex?: string
  currentCommitTxHex?: string
  priorSettleTxHex?: string
  proofCommitTxHex?: string
  /** When true, mutate expected outputs after bind to force hashOutputs failure (tests). */
  mutateOutputsForTest?: boolean
}): Promise<Record<number, { unlockingScript: string }>> {
  loadBrc156CovenantArtifact()
  const { unsigned, vins, scryptTx } = locateExplicitInputVins(
    args.signable,
    args.outpoints,
  )

  restoreScryptChangeMarker(scryptTx)

  if (args.mutateOutputsForTest && scryptTx.outputs[0]) {
    const head = scryptTx.outputs[0]
    scryptTx.outputs[0] = new bsv.Transaction.Output({
      script: head.script,
      satoshis: (head.satoshis ?? 1) + 1,
    })
  }

  const rootKey = PrivateKey.fromHex(args.wallet.rootKeyHex)
  const signerKey = bsv.PrivateKey.fromString(rootKey.toWif())
  const spends: Record<number, { unlockingScript: string }> = {}

  if (args.mode === 'commit') {
    const tipVin = vins[0]
    if (tipVin == null) throw new Error('Hardened commit: tip vin missing')
    if (!args.nextProofScriptHex) {
      throw new Error('Hardened commit requires nextProofScriptHex')
    }
    if (!args.recipientPublicKeyHex) {
      throw new Error('Hardened commit requires recipient identity key')
    }
    const tipInput = unsigned.inputs[tipVin]!
    tipInput.sourceTransaction ??=
      Beef.fromBinary(args.signable.tx).findTxid(String(tipInput.sourceTXID))?.tx
    const source = tipInput.sourceTransaction
    if (!source) throw new Error('Hardened commit: tip source transaction missing')
    const tip = Brc156Covenant.fromTx(sdkTxToScrypt(source), tipInput.sourceOutputIndex)
    const { nextTip, nextProof } = buildNextCommitInstances(
      tip,
      args.recipientPublicKeyHex,
    )

    await connectThrowawaySigner(tip, signerKey)
    tip.bindTxBuilder('commit', async () => ({
      tx: scryptTx,
      atInputIndex: tipVin,
      nexts: [
        { instance: nextTip, balance: HARDENED_TIP_SATS, atOutputIndex: 0 },
        { instance: nextProof, balance: HARDENED_PROOF_SATS, atOutputIndex: 1 },
      ],
    }))

    const { tx } = await tip.methods.commit(
      (sigs: SignatureResponse[]) => findSig(sigs, signerKey.publicKey),
      toByteString(args.nextProofScriptHex),
      {
        pubKeyOrAddrToSign: signerKey.publicKey,
        autoPayFee: false,
        partiallySigned: true,
        verify: false,
        next: [
          { instance: nextTip, balance: HARDENED_TIP_SATS, atOutputIndex: 0 },
          { instance: nextProof, balance: HARDENED_PROOF_SATS, atOutputIndex: 1 },
        ],
      } as MethodCallOptions<Brc156Covenant>,
    )
    const unlocking = tx.inputs[tipVin]?.script?.toHex()
    if (!unlocking) throw new Error('Hardened commit produced no unlocking script')
    spends[tipVin] = { unlockingScript: unlocking }
    return spends
  }

  if (args.mode === 'settleBase') {
    const tipVin = vins[0]
    if (tipVin == null) throw new Error('Hardened settleBase: tip vin missing')
    if (!args.recipientPublicKeyHex || !args.stateScriptHex) {
      throw new Error('Hardened settleBase requires recipient + stateScriptHex')
    }
    if (!args.commitTxHex || !args.genesisTxHex) {
      throw new Error('Hardened settleBase requires commitTxHex + genesisTxHex')
    }
    const tipInput = unsigned.inputs[tipVin]!
    const tipSource = tipInput.sourceTransaction
    if (!tipSource) throw new Error('Hardened settleBase: tip source missing')
    const tip = Brc156Covenant.fromTx(sdkTxToScrypt(tipSource), tipInput.sourceOutputIndex)
    const commitTxid = new bsv.Transaction(args.commitTxHex).id
    const { settleTip } = buildNextSettleTip(tip, args.recipientPublicKeyHex, commitTxid)

    await connectThrowawaySigner(tip, signerKey)
    tip.bindTxBuilder('settleBase', async () => ({
      tx: scryptTx,
      atInputIndex: tipVin,
      nexts: [{ instance: settleTip, balance: HARDENED_TIP_SATS, atOutputIndex: 0 }],
    }))

    const { tx } = await tip.methods.settleBase(
      (sigs: SignatureResponse[]) => findSig(sigs, signerKey.publicKey),
      pubKeyHexToScrypt(args.recipientPublicKeyHex),
      toByteString(args.commitTxHex),
      toByteString(args.genesisTxHex),
      toByteString(args.stateScriptHex),
      {
        pubKeyOrAddrToSign: signerKey.publicKey,
        autoPayFee: false,
        partiallySigned: true,
        verify: false,
        next: { instance: settleTip, balance: HARDENED_TIP_SATS, atOutputIndex: 0 },
      } as MethodCallOptions<Brc156Covenant>,
    )
    const unlocking = tx.inputs[tipVin]?.script?.toHex()
    if (!unlocking) throw new Error('Hardened settleBase produced no unlocking script')
    spends[tipVin] = { unlockingScript: unlocking }
    return spends
  }

  // Alternating settle: tip @ vins[0], delayed proof @ vins[1]
  if (!args.recipientPublicKeyHex || !args.stateScriptHex) {
    throw new Error('Hardened settle requires recipient + stateScriptHex')
  }
  if (
    !args.currentCommitTxHex ||
    !args.priorSettleTxHex ||
    !args.proofCommitTxHex ||
    !args.nextTipScriptHex
  ) {
    throw new Error('Hardened settle requires commit/priorSettle/proofCommit/nextTip hex')
  }
  if (vins.length < 2) {
    throw new Error('Hardened settle requires tip and delayed-proof inputs')
  }
  const tipVin = vins[0]!
  const proofVin = vins[1]!
  const tipInput = unsigned.inputs[tipVin]!
  const proofInput = unsigned.inputs[proofVin]!
  const tipSource = tipInput.sourceTransaction
  const proofSource = proofInput.sourceTransaction
  if (!tipSource || !proofSource) {
    throw new Error('Hardened settle: tip/proof source transactions missing')
  }

  const tip = Brc156Covenant.fromTx(sdkTxToScrypt(tipSource), tipInput.sourceOutputIndex)
  const proof = Brc156Covenant.fromTx(
    sdkTxToScrypt(proofSource),
    proofInput.sourceOutputIndex,
  )
  const commitTxid = new bsv.Transaction(args.currentCommitTxHex).id
  const { settleTip } = buildNextSettleTip(tip, args.recipientPublicKeyHex, commitTxid)
  const recipientPub = pubKeyHexToScrypt(args.recipientPublicKeyHex)
  const nextTipScript = args.nextTipScriptHex
  const stateScript = args.stateScriptHex

  const tipSigner = await connectThrowawaySigner(tip, signerKey)
  await proof.connect(tipSigner)

  tip.bindTxBuilder('settle', async () => ({
    tx: scryptTx,
    atInputIndex: tipVin,
    nexts: [{ instance: settleTip, balance: HARDENED_TIP_SATS, atOutputIndex: 0 }],
  }))
  proof.bindTxBuilder('settleProof', async (_current, options) => {
    const partial = options.partialContractTx
    if (!partial?.tx) throw new Error('settleProof requires partialContractTx')
    return {
      tx: partial.tx,
      atInputIndex: proofVin,
      nexts: partial.nexts,
    }
  })

  const txArgs = [
    toByteString(args.currentCommitTxHex),
    toByteString(args.priorSettleTxHex),
    toByteString(args.proofCommitTxHex),
    toByteString(stateScript),
  ] as const

  const partial = await tip.methods.settle(
    (sigs: SignatureResponse[]) => findSig(sigs, signerKey.publicKey),
    recipientPub,
    ...txArgs,
    {
      multiContractCall: true,
      pubKeyOrAddrToSign: signerKey.publicKey,
      autoPayFee: false,
      next: { instance: settleTip, balance: HARDENED_TIP_SATS, atOutputIndex: 0 },
    } as MethodCallOptions<Brc156Covenant>,
  )

  const partial2 = await proof.methods.settleProof(
    (sigs: SignatureResponse[]) => findSig(sigs, signerKey.publicKey),
    recipientPub,
    toByteString(nextTipScript),
    ...txArgs,
    {
      multiContractCall: true,
      partialContractTx: partial,
      pubKeyOrAddrToSign: signerKey.publicKey,
      next: partial.nexts,
    } as MethodCallOptions<Brc156Covenant>,
  )

  const { tx } = await Brc156Covenant.multiContractCall(partial2, tipSigner, {
    partiallySigned: true,
    autoPayFee: false,
    verify: false,
  })

  for (const vin of [tipVin, proofVin]) {
    const unlocking = tx.inputs[vin]?.script?.toHex()
    if (!unlocking) {
      throw new Error(`Hardened settle produced no unlocking script for vin ${vin}`)
    }
    spends[vin] = { unlockingScript: unlocking }
  }
  return spends
}

async function signP2pkhExplicitInputs(args: {
  wallet: ActiveWallet
  signable: SignableTransaction
  outpoints: string[]
  signOptions?: { noSend?: boolean; sendWith?: string[] }
}): Promise<{ txid: string; tx?: number[] }> {
  const { unsigned, vins, beef } = locateExplicitInputVins(args.signable, args.outpoints)
  const rootKey = PrivateKey.fromHex(args.wallet.rootKeyHex)
  const spends: Record<number, { unlockingScript: string }> = {}

  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    const satoshis = input.sourceTransaction?.outputs[input.sourceOutputIndex]?.satoshis
    if (typeof satoshis !== 'number') {
      throw new Error('Hardened genesis: tip source missing satoshis')
    }
    const locking =
      input.sourceTransaction?.outputs[input.sourceOutputIndex]?.lockingScript?.toHex()
    if (isHardenedCovenantLockingScript(locking)) {
      throw new Error('Expected P2PKH tip for genesis commit')
    }
    input.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(rootKey, satoshis)
  }
  await unsigned.sign()
  for (const vin of vins) {
    const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Hardened genesis: could not sign P2PKH tip')
    spends[vin] = { unlockingScript }
  }

  const signed = await args.wallet.wallet.signAction({
    reference: args.signable.reference,
    spends,
    options: {
      acceptDelayedBroadcast: false,
      ...(args.signOptions?.noSend ? { noSend: true } : {}),
      ...(args.signOptions?.sendWith ? { sendWith: args.signOptions.sendWith } : {}),
    },
  })
  if (!signed.txid) throw new Error('Hardened genesis commit returned no txid')
  return { txid: signed.txid, tx: atomicBeefToNumberArray(signed.tx) }
}

async function signCovenantAction(args: {
  wallet: ActiveWallet
  signable: SignableTransaction
  mode: CovenantUnlockMode
  outpoints: string[]
  nextProofScriptHex?: string
  nextTipScriptHex?: string
  stateScriptHex?: string
  recipientPublicKeyHex?: string
  commitTxHex?: string
  genesisTxHex?: string
  currentCommitTxHex?: string
  priorSettleTxHex?: string
  proofCommitTxHex?: string
  signOptions?: { noSend?: boolean; sendWith?: string[] }
}): Promise<{ txid: string; tx?: number[] }> {
  const spends = await generateCovenantUnlocks({
    wallet: args.wallet,
    signable: args.signable,
    mode: args.mode,
    outpoints: args.outpoints,
    nextProofScriptHex: args.nextProofScriptHex,
    nextTipScriptHex: args.nextTipScriptHex,
    stateScriptHex: args.stateScriptHex,
    recipientPublicKeyHex: args.recipientPublicKeyHex,
    commitTxHex: args.commitTxHex,
    genesisTxHex: args.genesisTxHex,
    currentCommitTxHex: args.currentCommitTxHex,
    priorSettleTxHex: args.priorSettleTxHex,
    proofCommitTxHex: args.proofCommitTxHex,
  })

  const signed = await args.wallet.wallet.signAction({
    reference: args.signable.reference,
    spends,
    options: {
      acceptDelayedBroadcast: false,
      ...(args.signOptions?.noSend ? { noSend: true } : {}),
      ...(args.signOptions?.sendWith ? { sendWith: args.signOptions.sendWith } : {}),
    },
  })
  if (!signed.txid) throw new Error(`Hardened ${args.mode} returned no txid`)
  return { txid: signed.txid, tx: atomicBeefToNumberArray(signed.tx) }
}

function tipTags(args: {
  origin: string
  name: string
  app?: string
}): string[] {
  const originTag = args.origin.replace(/_(\d+)$/, '.$1')
  return [
    'ordinal',
    `origin:${originTag}`,
    `name:${args.name.slice(0, 80)}`,
    ...(args.app ? [`app:${args.app.slice(0, 40)}`] : []),
  ]
}

/**
 * Hardened send entry: requires recipient identity key. Bare addresses must not
 * call this — `sendCollectable` falls through to soft-latch / BRC-150 instead.
 */
export async function sendHardenedCollectable(
  args: HardenedSendArgs,
): Promise<{ txid: string }> {
  if (!isHardenedSendEnabled()) {
    throw new Error(
      'Hardened BRC-156 alternating Commit/Settle is not enabled for wallet sends yet — use soft-latch / BRC-150',
    )
  }
  if (!canUseHardenedLatch({ publicKey: args.recipientIdentityKey })) {
    throw new Error('Hardened BRC-156 requires a recipient identity public key')
  }
  loadBrc156CovenantArtifact()

  const tipOp = args.normalizeOutpoint(args.outpoint)
  const tipIsCovenant = isHardenedCovenantLockingScript(args.tipLockingScript)
  const recipientKey = args.recipientIdentityKey.trim()
  const originU = toUnderscoreOutpoint(args.origin)
  const tags = tipTags({ origin: args.origin, name: args.name, app: args.app })

  const tipBeef = Beef.fromBinary(args.inputBEEF)
  const tipTxid = tipOp.split('.')[0]!
  const tipVout = Number(tipOp.split('.')[1])
  const tipSrc = tipBeef.findTxid(tipTxid)?.tx
  if (!tipSrc) throw new Error('Hardened send: tip source transaction missing from BEEF')

  let commitReference: string | undefined
  let broadcastAttempted = false

  try {
    // ─── COMMIT (noSend) ─────────────────────────────────────────────
    let commitNextTipScript: string
    let commitNextProofScript: string
    let commitInputs: Array<{
      outpoint: string
      inputDescription: string
      unlockingScriptLength: number
    }>
    let commitOutputs: Array<{
      lockingScript: string
      satoshis: number
      outputDescription: string
      basket?: string
      tags?: string[]
      customInstructions?: string
    }>
    let genesisP2pkh = false
    let oshForSettle: string
    let delayedProofOutpoint: string | null = null
    let priorSettleTxHex: string | undefined
    let proofCommitTxHex: string | undefined

    if (!tipIsCovenant) {
      const verdict = getProvenVerdict(tipOp)
      const brc150Ok = verdict?.tier === 'brc150' || verdict?.tier === 'brc156'
      if (!brc150Ok) {
        throw new Error(
          'Hardened genesis requires a BRC-150-verified tip before the first covenant send',
        )
      }
      if (!args.originLockingScriptHex) {
        throw new Error('Hardened genesis requires the origin locking script')
      }

      // Direct genesis-commit: Commit spends the verified legacy tip.
      const pair = buildGenesisHardenedPair({
        origin: args.origin,
        originLockingScriptHex: args.originLockingScriptHex,
        ownerPublicKeyHex: args.wallet.identityKey,
        brc150VerifiedForGenesis: true,
        legacyTipOutpoint: toUnderscoreOutpoint(tipOp),
      })
      const nextProof = createCovenantInstance({
        role: 1,
        origin: args.origin,
        originScriptHash: pair.originScriptHash,
        ownerPublicKeyHex: recipientKey,
        linkOutpoint: toUnderscoreOutpoint(tipOp),
        legacyTipOutpoint: toUnderscoreOutpoint(tipOp),
      })
      genesisP2pkh = true
      commitNextTipScript = pair.tip.lockingScript.toHex()
      commitNextProofScript = nextProof.lockingScript.toHex()
      oshForSettle = pair.originScriptHash

      commitInputs = [
        {
          outpoint: tipOp,
          inputDescription: '1sat genesis tip',
          unlockingScriptLength: 108,
        },
      ]
      commitOutputs = [
        {
          lockingScript: commitNextTipScript,
          satoshis: HARDENED_TIP_SATS,
          outputDescription: 'Hardened tip',
          basket: '1sat',
          tags,
          customInstructions: hardenedTipCustomInstructions({
            origin: args.origin,
            name: args.name,
            app: args.app,
            originScriptHash: pair.originScriptHash,
            ownerPublicKeyHex: args.wallet.identityKey,
          }),
        },
        {
          lockingScript: commitNextProofScript,
          satoshis: HARDENED_PROOF_SATS,
          outputDescription: 'Hardened proof',
          basket: ONE_SAT_LATCH_BASKET,
          tags: latchOutputTags({ origin: originU, tip: RELATIVE_TIP }),
          customInstructions: JSON.stringify({
            schema: HARDENED_LATCH_SCHEMA_VERSION,
            mode: 'hardened',
            origin: originU,
            tip: RELATIVE_TIP,
            latch: RELATIVE_HARDENED_PROOF,
          }),
        },
      ]
    } else {
      const tipInstance = Brc156Covenant.fromTx(sdkTxToScrypt(tipSrc), tipVout)
      const { nextTip, nextProof } = buildNextCommitInstances(tipInstance, recipientKey)
      commitNextTipScript = nextTip.lockingScript.toHex()
      commitNextProofScript = nextProof.lockingScript.toHex()
      oshForSettle = normalizeOriginScriptHash(String(tipInstance.originScriptHash))

      delayedProofOutpoint =
        args.priorProofOutpoint?.trim() ||
        decodeHardenedLinkOutpoint(String(tipInstance.linkOutpoint))
      if (!delayedProofOutpoint || delayedProofOutpoint === BASE_LINK) {
        throw new Error('Hardened resend requires the delayed prior proof outpoint')
      }
      delayedProofOutpoint = toUnderscoreOutpoint(delayedProofOutpoint)

      // priorSettle = tx that created the tip we are committing (tipSrc).
      priorSettleTxHex = tipSrc.toHex()
      const proofTxid = delayedProofOutpoint.split('_')[0]!
      proofCommitTxHex = await ensureTxHex(args.wallet, tipBeef, proofTxid)

      const unlockLen = estimateUnlockingLength([tipSrc.toHex()])
      commitInputs = [
        {
          outpoint: tipOp,
          inputDescription: '1sat hardened tip',
          unlockingScriptLength: unlockLen,
        },
      ]
      commitOutputs = [
        {
          lockingScript: commitNextTipScript,
          satoshis: HARDENED_TIP_SATS,
          outputDescription: 'Hardened tip',
          basket: '1sat',
          tags,
          customInstructions: hardenedTipCustomInstructions({
            origin: args.origin,
            name: args.name,
            app: args.app,
            originScriptHash: oshForSettle,
            ownerPublicKeyHex: args.wallet.identityKey,
            proofOutpoint: delayedProofOutpoint,
          }),
        },
        {
          lockingScript: commitNextProofScript,
          satoshis: HARDENED_PROOF_SATS,
          outputDescription: 'Hardened proof',
          basket: ONE_SAT_LATCH_BASKET,
          tags: latchOutputTags({ origin: originU, tip: RELATIVE_TIP }),
        },
      ]
    }

    const commitResult = await args.wallet.wallet.createAction({
      description: `Hardened commit ${args.name}`.slice(0, 50),
      labels: ['1sat', '1sat-latch', 'handcash-hardened-commit'],
      inputBEEF: args.inputBEEF,
      inputs: commitInputs,
      outputs: commitOutputs,
      options: {
        trustSelf: 'known',
        ...(args.knownTxids.length > 0 ? { knownTxids: args.knownTxids } : {}),
        randomizeOutputs: false,
        acceptDelayedBroadcast: false,
        signAndProcess: false,
        noSend: true,
      },
    })

    if (!commitResult.signableTransaction) {
      throw new Error('Hardened commit: createAction returned no signable transaction')
    }
    commitReference = commitResult.signableTransaction.reference

    let commitSigned: { txid: string; tx?: number[] }
    if (genesisP2pkh) {
      commitSigned = await signP2pkhExplicitInputs({
        wallet: args.wallet,
        signable: commitResult.signableTransaction,
        outpoints: [tipOp],
        signOptions: { noSend: true },
      })
    } else {
      commitSigned = await signCovenantAction({
        wallet: args.wallet,
        signable: commitResult.signableTransaction,
        mode: 'commit',
        outpoints: [tipOp],
        nextProofScriptHex: commitNextProofScript,
        recipientPublicKeyHex: recipientKey,
        signOptions: { noSend: true },
      })
    }

    const commitTxid = commitSigned.txid
    if (!commitSigned.tx) {
      throw new Error('Hardened commit: signAction returned no transaction bytes')
    }

    // ─── SETTLE (sendWith commit) ────────────────────────────────────
    const commitBeef = Beef.fromBinary(commitSigned.tx)
    const commitTx = commitBeef.findTxid(commitTxid)?.tx
    if (!commitTx) throw new Error('Hardened settle: commit tx missing from signed BEEF')

    const commitScrypt = sdkTxToScrypt(commitTx)
    const commitTip = Brc156Covenant.fromTx(commitScrypt, 0)
    const { settleTip, beaconScript } = buildNextSettleTip(
      commitTip,
      recipientKey,
      commitTxid,
    )

    const settleState = buildHardenedSettleState({
      origin: args.origin,
      originScriptHash: oshForSettle,
      // After this settle, the delayed proof for the *next* send is this Commit's proof.
      delayedProofOutpoint: `${commitTxid}_1`,
      ownerPublicKeyHex: recipientKey,
      commitTxid,
      name: args.name,
      app: args.app,
      mimeType: args.mimeType,
    })
    const settleStateScript = buildLatchStateScript(settleState)

    void args.toAddress

    const commitTipOp = `${commitTxid}.0`
    const settleOutputs = [
      {
        lockingScript: settleTip.lockingScript.toHex(),
        satoshis: HARDENED_TIP_SATS,
        outputDescription: 'Hardened recipient tip',
        basket: '1sat',
        tags,
        customInstructions: hardenedTipCustomInstructions({
          origin: args.origin,
          name: args.name,
          app: args.app,
          originScriptHash: oshForSettle,
          ownerPublicKeyHex: recipientKey,
          proofOutpoint: `${commitTxid}_1`,
          commitTxid,
        }),
      },
      {
        lockingScript: beaconScript.toHex(),
        satoshis: HARDENED_BEACON_SATS,
        outputDescription: 'Hardened discovery beacon',
        basket: ONE_SAT_LATCH_BASKET,
        tags: latchOutputTags({ origin: originU, tip: RELATIVE_TIP }),
      },
      {
        lockingScript: settleStateScript,
        satoshis: 0,
        outputDescription: 'Hardened latch state',
      },
    ]

    if (genesisP2pkh) {
      // Base settle: tip only. Sibling proof stays unspent for the next send.
      const settleParentHex = commitTx.toHex()
      const settleGenesisHex = tipSrc.toHex()
      const settleUnlockLen = estimateUnlockingLength([
        settleParentHex,
        settleGenesisHex,
      ])

      // Internalize commit proof into latch basket via inputBEEF merge (held).
      const settleInputBeef = await args.buildInputBeefForSpends(args.wallet, [
        commitTipOp,
      ]).catch(() => commitSigned.tx!)

      const settleResult = await args.wallet.wallet.createAction({
        description: `Hardened settle ${args.name}`.slice(0, 50),
        labels: ['1sat', '1sat-latch', 'handcash-hardened-settle'],
        inputBEEF: settleInputBeef,
        inputs: [
          {
            outpoint: commitTipOp,
            inputDescription: 'Hardened commit tip',
            unlockingScriptLength: settleUnlockLen,
          },
        ],
        outputs: settleOutputs,
        options: {
          trustSelf: 'known',
          knownTxids: [commitTxid],
          randomizeOutputs: false,
          acceptDelayedBroadcast: false,
          signAndProcess: false,
          sendWith: [commitTxid],
        },
      })

      if (!settleResult.signableTransaction) {
        throw new Error('Hardened settle: createAction returned no signable transaction')
      }

      broadcastAttempted = true
      const settleSigned = await signCovenantAction({
        wallet: args.wallet,
        signable: settleResult.signableTransaction,
        mode: 'settleBase',
        outpoints: [commitTipOp],
        commitTxHex: settleParentHex,
        genesisTxHex: settleGenesisHex,
        stateScriptHex: settleStateScript,
        recipientPublicKeyHex: recipientKey,
        signOptions: { sendWith: [commitTxid] },
      })
      return { txid: settleSigned.txid }
    }

    // Alternating settle: tip + delayed prior proof (never current sibling).
    if (!delayedProofOutpoint || !priorSettleTxHex || !proofCommitTxHex) {
      throw new Error('Hardened alternating settle missing delayed-proof context')
    }
    const delayedProofDot = delayedProofOutpoint.replace(/_(\d+)$/, '.$1')
    const settleParentHex = commitTx.toHex()
    const settleUnlockLen = estimateUnlockingLength([
      settleParentHex,
      priorSettleTxHex,
      proofCommitTxHex,
    ])

    const settleSpendOps = [commitTipOp, delayedProofDot]
    const settleInputBeef = await args.buildInputBeefForSpends(
      args.wallet,
      settleSpendOps,
    ).catch(() => {
      // Fall back to commit AtomicBEEF + whatever tipBeef already has.
      const merged = Beef.fromBinary(commitSigned.tx!)
      merged.mergeBeef(args.inputBEEF)
      return merged.toBinary()
    })

    const settleResult = await args.wallet.wallet.createAction({
      description: `Hardened settle ${args.name}`.slice(0, 50),
      labels: ['1sat', '1sat-latch', 'handcash-hardened-settle'],
      inputBEEF: settleInputBeef,
      inputs: [
        {
          outpoint: commitTipOp,
          inputDescription: 'Hardened commit tip',
          unlockingScriptLength: settleUnlockLen,
        },
        {
          outpoint: delayedProofDot,
          inputDescription: 'Hardened delayed proof',
          unlockingScriptLength: settleUnlockLen,
        },
      ],
      outputs: settleOutputs,
      options: {
        trustSelf: 'known',
        knownTxids: [commitTxid],
        randomizeOutputs: false,
        acceptDelayedBroadcast: false,
        signAndProcess: false,
        sendWith: [commitTxid],
      },
    })

    if (!settleResult.signableTransaction) {
      throw new Error('Hardened settle: createAction returned no signable transaction')
    }

    broadcastAttempted = true
    const settleSigned = await signCovenantAction({
      wallet: args.wallet,
      signable: settleResult.signableTransaction,
      mode: 'settle',
      outpoints: [commitTipOp, delayedProofDot],
      currentCommitTxHex: settleParentHex,
      priorSettleTxHex,
      proofCommitTxHex,
      nextTipScriptHex: settleTip.lockingScript.toHex(),
      stateScriptHex: settleStateScript,
      recipientPublicKeyHex: recipientKey,
      signOptions: { sendWith: [commitTxid] },
    })

    return { txid: settleSigned.txid }
  } catch (err) {
    if (commitReference) {
      try {
        await args.wallet.wallet.abortAction({ reference: commitReference })
      } catch {
        // Best-effort cleanup of the held noSend commit.
      }
    }
    if (args.isAlreadySpentInputError(err)) await args.releaseStaleSpendableOutputs()
    if (broadcastAttempted) markHardenedBroadcastAttempted(err)
    throw err
  }
}
