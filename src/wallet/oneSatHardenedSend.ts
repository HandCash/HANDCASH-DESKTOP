/**
 * Wallet-toolbox wiring for hardened BRC-156 Commit + Settle (+ 2-sat beacon).
 *
 * Parent routing is `collectableSendMachine` — there is no soft-latch edge out of
 * a covenant path. This module advances `hardenedSendMachine` phase-by-phase;
 * a send that fires events out of order throws instead of freestyling.
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
import './browserPolyfills'
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
  Brc156Covenant,
  HARDENED_BEACON_SATS,
  HARDENED_LATCH_SCHEMA_VERSION,
  HARDENED_PROOF_SATS,
  HARDENED_TIP_SATS,
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
import {
  markHardenedBroadcastAttempted,
} from './oneSatHardenedReceive'
import { resolveDelayedProof } from './collectableTipKind'
import {
  ONE_SAT_LATCH_BASKET,
  RELATIVE_TIP,
  buildLatchStateScript,
  latchOutputTags,
  toUnderscoreOutpoint,
} from './oneSatLatch'
import { getProvenVerdict } from './provenCache'
import { hexToU32Le } from './hexBinary'
import {
  estimateUnlockingLength,
  hardenedSendMachine,
  spendsFitBudget,
  type HardenedSendPhase,
} from './hardenedSendMachine'
import { createActor, type Actor } from 'xstate'

export { estimateUnlockingLength } from './hardenedSendMachine'

/**
 * Stuck `noSend` hardened commits (failed settle, killed app mid-flight) keep
 * the tip/funding UTXOs reserved. Retries then fail with cryptic abort /
 * sourceTransaction errors. Clear them before a new Commit/Settle pair.
 */
async function abortStuckHardenedNosends(wallet: ActiveWallet): Promise<void> {
  const w = wallet.wallet as ActiveWallet['wallet'] & {
    listNoSendActions?: (
      args: { labels: string[]; limit?: number },
      abort?: boolean,
    ) => Promise<unknown>
  }
  if (typeof w.listNoSendActions !== 'function') return
  try {
    await w.listNoSendActions({ labels: [], limit: 100 }, true)
    console.info('[brc-156] cleared stuck noSend actions before hardened send')
  } catch (err) {
    console.warn('[brc-156] listNoSendActions(abort) failed', err)
  }
}

async function abortHeldReferences(
  wallet: ActiveWallet,
  references: Array<string | undefined>,
): Promise<void> {
  // Settle depends on Commit — abort dependents first.
  for (const reference of references.filter((r): r is string => !!r)) {
    try {
      const result = await wallet.wallet.abortAction({ reference })
      console.info('[brc-156] abortAction', reference, result)
    } catch (err) {
      console.warn('[brc-156] abortAction failed', reference, err)
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string }
  return e.name === 'AbortError' || /^AbortError$/i.test(String(e.message ?? ''))
}

async function withAbortRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isAbortError(err)) throw err
    console.warn(`[brc-156] ${label} AbortError — retrying once after brief pause`, err)
    await new Promise((r) => setTimeout(r, 400))
    return await fn()
  }
}

function pauseMonitor(wallet: ActiveWallet): () => void {
  try {
    wallet.monitor?.stopTasks?.()
    console.info('[brc-156] monitor paused for hardened send')
  } catch (err) {
    console.warn('[brc-156] monitor stop failed', err)
  }
  return () => {
    try {
      void wallet.monitor?.startTasks?.()
    } catch (err) {
      console.warn('[brc-156] monitor restart failed', err)
    }
  }
}

function advanceHardened(
  chart: Actor<typeof hardenedSendMachine>,
  event: Parameters<Actor<typeof hardenedSendMachine>['send']>[0],
  expect: HardenedSendPhase,
): void {
  chart.send(event)
  const snap = chart.getSnapshot()
  if (!snap.matches(expect)) {
    throw new Error(
      `hardenedSendMachine: after ${event.type} expected ${expect}, got ${JSON.stringify(snap.value)}`,
    )
  }
}

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
    const { getBeefForTxidCached } = await import('./beefCache')
    const fetched = await getBeefForTxidCached(wallet, txid)
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
  const vout = hexToU32Le(raw.slice(64))
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
  /** Declared unlockingScriptLength for these inputs (bytes). */
  unlockBudgetBytes?: number
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

  if (args.unlockBudgetBytes != null) {
    const fit = spendsFitBudget(spends, args.unlockBudgetBytes)
    if (!fit.ok) {
      throw new Error(
        `Hardened ${args.mode}: unlockingScript ${fit.actual} bytes exceeds budget ${fit.budget} (vin ${fit.vin})`,
      )
    }
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
  if (!signed.txid) throw new Error(`Hardened ${args.mode} returned no txid`)
  return { txid: signed.txid, tx: atomicBeefToNumberArray(signed.tx) }
}

async function signCovenantActionResilient(
  args: Parameters<typeof signCovenantAction>[0],
): Promise<{ txid: string; tx?: number[] }> {
  const spends = await withAbortRetry(`unlock(${args.mode})`, async () => {
    console.info(`[brc-156] ${args.mode}: building unlock scripts`)
    const built = await generateCovenantUnlocks({
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
    console.info(
      `[brc-156] ${args.mode}: unlock scripts ready (${Object.keys(built).length} vin)`,
    )
    return built
  })

  if (args.unlockBudgetBytes != null) {
    const fit = spendsFitBudget(spends, args.unlockBudgetBytes)
    if (!fit.ok) {
      throw new Error(
        `Hardened ${args.mode}: unlockingScript ${fit.actual} bytes exceeds budget ${fit.budget} (vin ${fit.vin})`,
      )
    }
  }

  return withAbortRetry(`signAction(${args.mode})`, async () => {
    console.info(`[brc-156] ${args.mode}: signAction`)
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
    console.info(`[brc-156] ${args.mode}: signAction ok txid=${signed.txid.slice(0, 12)}…`)
    return { txid: signed.txid, tx: atomicBeefToNumberArray(signed.tx) }
  })
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

  await abortStuckHardenedNosends(args.wallet)
  const resumeMonitor = pauseMonitor(args.wallet)

  const chart = createActor(hardenedSendMachine)
  chart.start()
  advanceHardened(
    chart,
    {
      type: 'SEND',
      outpoint: tipOp,
      mode: tipIsCovenant ? 'resend' : 'genesis',
    },
    'gating',
  )

  let commitReference: string | undefined
  let settleReference: string | undefined
  let broadcastAttempted = false
  let unlockBudgetBytes = 0

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
        advanceHardened(
          chart,
          {
            type: 'PROVEN_FAIL',
            error:
              'Hardened genesis requires a BRC-150-verified tip before the first covenant send',
          },
          'failed',
        )
        throw new Error(
          'Hardened genesis requires a BRC-150-verified tip before the first covenant send',
        )
      }
      advanceHardened(chart, { type: 'PROVEN_OK' }, 'commitBuild')
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
      unlockBudgetBytes = 108

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
      advanceHardened(chart, { type: 'PROVEN_OK' }, 'commitBuild')
      const tipInstance = Brc156Covenant.fromTx(sdkTxToScrypt(tipSrc), tipVout)
      const { nextTip, nextProof } = buildNextCommitInstances(tipInstance, recipientKey)
      commitNextTipScript = nextTip.lockingScript.toHex()
      commitNextProofScript = nextProof.lockingScript.toHex()
      oshForSettle = normalizeOriginScriptHash(String(tipInstance.originScriptHash))

      // Remittance / covenant link / OP_RETURN only — never basket latch.
      // Caller may pass priorProofOutpoint already resolved via chooseSendPath.
      const proof = resolveDelayedProof({
        remittanceProofOutpoint: args.priorProofOutpoint,
        tipCustomInstructions: args.tipCustomInstructions,
        covenantLinkOutpoint: String(tipInstance.linkOutpoint),
      })
      if (!proof.proofOutpoint || !proof.proofSource) {
        const why =
          'reason' in proof && proof.reason
            ? proof.reason
            : 'Hardened resend requires the delayed prior proof outpoint'
        advanceHardened(chart, { type: 'FAIL', error: why }, 'failed')
        throw new Error(why)
      }
      delayedProofOutpoint = proof.proofOutpoint
      console.info(
        `[brc-156] delayed proof ${delayedProofOutpoint} via ${proof.proofSource}`,
      )

      // priorSettle = tx that created the tip we are committing (tipSrc).
      priorSettleTxHex = tipSrc.toHex()
      const proofTxid = delayedProofOutpoint.split('_')[0]!
      try {
        proofCommitTxHex = await ensureTxHex(args.wallet, tipBeef, proofTxid)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        advanceHardened(
          chart,
          {
            type: 'FAIL',
            error: `Hardened resend: delayed proof ${delayedProofOutpoint} is missing on chain (${why})`,
          },
          'failed',
        )
        throw new Error(
          `Hardened resend: delayed proof ${delayedProofOutpoint} is missing on chain (${why})`,
        )
      }

      unlockBudgetBytes = estimateUnlockingLength(
        [tipSrc.toHex()],
        [commitNextProofScript],
      )
      commitInputs = [
        {
          outpoint: tipOp,
          inputDescription: '1sat hardened tip',
          unlockingScriptLength: unlockBudgetBytes,
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

    advanceHardened(chart, { type: 'COMMIT_BUILT', unlockBudgetBytes }, 'commitSign')

    const commitResult = await args.wallet.wallet.createAction({
      description: `Hardened commit ${args.name}`.slice(0, 50),
      labels: ['1sat', '1sat-latch', 'handcash-hardened-commit'],
      inputBEEF: args.inputBEEF,
      inputs: commitInputs,
      outputs: commitOutputs,
      options: {
        trustSelf: 'known',
        // Do not list tip/proof as knownTxids — createAction must take
        // sourceTransaction from inputBEEF. Claiming them known when storage
        // lacks the raw body yields "Every signableTransaction input must have
        // a sourceTransaction".
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
      commitSigned = await signCovenantActionResilient({
        wallet: args.wallet,
        signable: commitResult.signableTransaction,
        mode: 'commit',
        outpoints: [tipOp],
        nextProofScriptHex: commitNextProofScript,
        recipientPublicKeyHex: recipientKey,
        unlockBudgetBytes,
        signOptions: { noSend: true },
      })
    }
    advanceHardened(chart, { type: 'COMMIT_SIGNED', commitTxid: commitSigned.txid }, 'settleBuild')

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
      unlockBudgetBytes = estimateUnlockingLength(
        [settleParentHex, settleGenesisHex],
        [settleStateScript, settleTip.lockingScript.toHex()],
      )
      advanceHardened(chart, { type: 'SETTLE_BUILT', unlockBudgetBytes }, 'settleSign')

      // Internalize commit proof into latch basket via inputBEEF merge (held).
      // Commit AtomicBEEF already has the tip we just signed — no refetch.
      const settleInputBeef = commitSigned.tx!

      const settleResult = await args.wallet.wallet.createAction({
        description: `Hardened settle ${args.name}`.slice(0, 50),
        labels: ['1sat', '1sat-latch', 'handcash-hardened-settle'],
        inputBEEF: settleInputBeef,
        inputs: [
          {
            outpoint: commitTipOp,
            inputDescription: 'Hardened commit tip',
            unlockingScriptLength: unlockBudgetBytes,
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
      settleReference = settleResult.signableTransaction.reference

      broadcastAttempted = true
      const settleSigned = await signCovenantActionResilient({
        wallet: args.wallet,
        signable: settleResult.signableTransaction,
        mode: 'settleBase',
        outpoints: [commitTipOp],
        commitTxHex: settleParentHex,
        genesisTxHex: settleGenesisHex,
        stateScriptHex: settleStateScript,
        recipientPublicKeyHex: recipientKey,
        unlockBudgetBytes,
        signOptions: { sendWith: [commitTxid] },
      })
      advanceHardened(chart, { type: 'SETTLE_SIGNED', settleTxid: settleSigned.txid }, 'done')
      chart.stop()
      return { txid: settleSigned.txid }
    }

    // Alternating settle: tip + delayed prior proof (never current sibling).
    if (!delayedProofOutpoint || !priorSettleTxHex || !proofCommitTxHex) {
      throw new Error('Hardened alternating settle missing delayed-proof context')
    }
    const delayedProofDot = delayedProofOutpoint.replace(/_(\d+)$/, '.$1')
    const proofTxid = delayedProofDot.split('.')[0]!
    const settleParentHex = commitTx.toHex()
    const nextTipScriptHex = settleTip.lockingScript.toHex()
    unlockBudgetBytes = estimateUnlockingLength(
      [settleParentHex, priorSettleTxHex, proofCommitTxHex],
      [settleStateScript, nextTipScriptHex],
    )
    advanceHardened(chart, { type: 'SETTLE_BUILT', unlockBudgetBytes }, 'settleSign')

    // Commit is noSend — never on chain yet. Do not call getBeefForTxid(commit):
    // that 404s (orphan local txid) and used to poison retries / abort cleanup.
    // Merge signed commit AtomicBEEF + tip/proof inputBEEF; chain-fetch proof only.
    const settleMerged = Beef.fromBinary(commitSigned.tx!)
    settleMerged.mergeBeef(args.inputBEEF)
    if (!settleMerged.findTxid(commitTxid)?.tx) {
      throw new Error('Hardened settle: commit tx missing from signed BEEF')
    }
    if (!settleMerged.findTxid(proofTxid)?.tx) {
      try {
        const proofBeef = await args.buildInputBeefForSpends(args.wallet, [
          delayedProofDot,
        ])
        settleMerged.mergeBeef(proofBeef)
      } catch (err) {
        console.warn('[brc-156] delayed-proof BEEF fetch failed', proofTxid, err)
        throw new Error(
          `Hardened settle: could not load delayed proof ${delayedProofOutpoint}`,
        )
      }
    }
    if (!settleMerged.findTxid(proofTxid)?.tx) {
      throw new Error(
        `Hardened settle: delayed proof ${delayedProofOutpoint} missing from BEEF`,
      )
    }
    const settleInputBeef = settleMerged.toBinary()

    const settleResult = await args.wallet.wallet.createAction({
      description: `Hardened settle ${args.name}`.slice(0, 50),
      labels: ['1sat', '1sat-latch', 'handcash-hardened-settle'],
      inputBEEF: settleInputBeef,
      inputs: [
        {
          outpoint: commitTipOp,
          inputDescription: 'Hardened commit tip',
          unlockingScriptLength: unlockBudgetBytes,
        },
        {
          outpoint: delayedProofDot,
          inputDescription: 'Hardened delayed proof',
          unlockingScriptLength: unlockBudgetBytes,
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
    settleReference = settleResult.signableTransaction.reference

    broadcastAttempted = true
    const settleSigned = await signCovenantActionResilient({
      wallet: args.wallet,
      signable: settleResult.signableTransaction,
      mode: 'settle',
      outpoints: [commitTipOp, delayedProofDot],
      currentCommitTxHex: settleParentHex,
      priorSettleTxHex,
      proofCommitTxHex,
      nextTipScriptHex,
      stateScriptHex: settleStateScript,
      recipientPublicKeyHex: recipientKey,
      unlockBudgetBytes,
      signOptions: { sendWith: [commitTxid] },
    })
    advanceHardened(chart, { type: 'SETTLE_SIGNED', settleTxid: settleSigned.txid }, 'done')
    chart.stop()
    return { txid: settleSigned.txid }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[brc-156] hardened send failed', phaseLabel(chart), message, err)
    const phase = chart.getSnapshot().value
    if (phase === 'commitSign' || phase === 'settleBuild' || phase === 'settleSign') {
      chart.send({ type: 'FAIL', error: message })
      chart.send({ type: 'ABORT_DONE' })
    } else if (phase !== 'failed' && phase !== 'done' && phase !== 'idle') {
      chart.send({ type: 'FAIL', error: message })
    }
    chart.stop()
    await abortHeldReferences(args.wallet, [settleReference, commitReference])
    // If individual abort refused (dependent staged action), wipe all nosends.
    await abortStuckHardenedNosends(args.wallet)
    if (args.isAlreadySpentInputError(err)) await args.releaseStaleSpendableOutputs()
    if (broadcastAttempted) markHardenedBroadcastAttempted(err)
    if (isAbortError(err)) {
      throw new Error(
        'Signing was interrupted (wallet storage busy). Wait a second and send again.',
      )
    }
    throw err
  } finally {
    resumeMonitor()
  }
}

function phaseLabel(chart: Actor<typeof hardenedSendMachine>): string {
  try {
    return String(chart.getSnapshot().value)
  } catch {
    return 'unknown'
  }
}
