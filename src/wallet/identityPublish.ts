import { Hash, Transaction, Utils, type PrivateKey } from '@bsv/sdk'
import {
  BAP_BASKET,
  BAP_KEY_ID,
  BAP_PROTOCOL_ID,
  IMPORTED_BAP_BASKET,
  bapAddress,
  bapAliasScript,
  bapIdFor,
  bapIdScript,
  bapKey,
  bFileScript,
} from './bapRecords'
import {
  bapKeyChain,
  buildIssuerIdentityPackage,
  currentIssuerSigningKey,
  issuerIdentityFields,
  issuerIdentityImage,
  issuerIdentityPackageBeef,
  issuerIdentityPackageRoots,
  issuerIdentityImageRef,
  issuerProfile,
  type IssuerIdentity,
  type IssuerIdentityFields,
  type IssuerIdentityImage,
} from './issuerIdentity'
import { issuerIdentityPackage } from './issuerIdentities'
import { normalizeIssuerIdentityKey } from './issuerMetadata'
import {
  identityMasterKey,
  listPublicIdentities,
  publishedIdentityForIssuer,
  recordPublishedIdentity,
} from './publicIdentities'
import type { ActiveWallet } from './session'
import { runExclusiveSpend } from './spendGuard'
import { runtimeIsCurrent, type WalletRuntime } from './walletRuntime'

/**
 * Publish and maintain BAP issuer identities. Every record is a 0-sat,
 * AIP-signed data output, sent through the signed-send lifecycle like any
 * other signed transaction; none of them holds value. The wallet's own key
 * tree sits in basket `bap` exactly as 1Sat wallets keep it, so a 1Sat app on
 * this wallet sees the same identity; an imported master's sits in `bap issuer`.
 */

type DataOutput = {
  lockingScript: string
  satoshis: 0
  outputDescription: string
  basket: string
  tags: string[]
  customInstructions?: string
}

type Signer = { master: PrivateKey; own: boolean; basket: string }

const PROOF_FETCH_MS = 8_000

/** Toolbox `defaultOptions().feeModel`; record transactions are funded at this rate. */
const FEE_SAT_PER_KB = 100
const TX_OVERHEAD_BYTES = 10
const FUNDING_INPUT_BYTES = 148
const CHANGE_OUTPUT_BYTES = 34
/** Managed change: `managedChangePolicy.maxOutputsPerAction`. */
const MAX_CHANGE_OUTPUTS = 8
/** Fee ceiling headroom for a fragmented wallet. */
const MAX_FUNDING_INPUTS = 16
/** Sizes an ALIAS whose new image has no txid until its own transaction is signed. */
const UNSIGNED_IMAGE_TXID = '00'.repeat(32)

export type IdentityPublishRequest =
  | {
      kind: 'profile'
      identityKey: string
      fields: IssuerIdentityFields
      image: IssuerIdentityImage | null
    }
  | { kind: 'rotate'; identityKey: string }

export type IdentityRecordPurpose = 'image' | 'publish' | 'update' | 'rotate'

export type IdentityRecordTx = {
  purpose: IdentityRecordPurpose
  description: string
  outputs: { description: string; bytes: number }[]
  /** One funding input; managed change splits into its full output count while under target. */
  feeSats: number
  /** The staged transaction is aborted unsigned when it would pay more. */
  maxFeeSats: number
}

export type IdentityPlanKey = { seq: number; publicKey: string }

/** Everything the user approves before an identity record is signed. Public data only. */
export type IdentityPublishPlan = {
  kind: 'publish' | 'update' | 'rotate'
  identityKey: string
  bapId: string
  signer: 'wallet' | 'imported'
  name: string
  description: string
  image:
    | { status: 'new'; bytes: number; contentType: string }
    | { status: 'reused'; txid: string }
  /** Signs every asset issued after this publish. */
  signingKey: IdentityPlanKey
  /** Rotation only: the key these records retire. */
  retiredKey: IdentityPlanKey | null
  transactions: IdentityRecordTx[]
  feeSats: number
  maxFeeSats: number
  /** Commits to every record script; a publish refuses a plan whose digest moved. */
  digest: string
}

export type IdentityPublishRefusal =
  | 'invalid-key'
  | 'wallet-changed'
  | 'revoked'
  | 'no-image'
  | 'not-published'
  | 'missing-package'
  | 'plan-changed'
  | 'staged-mismatch'
  | 'fee-over-plan'
  | 'not-signed'

export class IdentityPublishRefused extends Error {
  constructor(
    readonly reason: IdentityPublishRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'IdentityPublishRefused'
  }
}

function refuse(reason: IdentityPublishRefusal, message: string): never {
  console.warn(`[identity-publish] refused ${reason}`)
  throw new IdentityPublishRefused(reason, message)
}

function assertCurrent(runtime: WalletRuntime): ActiveWallet {
  if (!runtimeIsCurrent(runtime)) refuse('wallet-changed', 'Wallet changed; review the publish again.')
  return runtime.instance
}

function signerFor(runtime: WalletRuntime, identityKey: string): Signer {
  const { master, own } = identityMasterKey(runtime, identityKey)
  return { master, own, basket: own ? BAP_BASKET : IMPORTED_BAP_BASKET }
}

function logSlow(phase: string, started: number) {
  const ms = Date.now() - started
  if (ms > 250) console.info(`[identity-publish] ${phase} done ${ms}ms`)
}

const varIntBytes = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9)

function outputBytes(lockingScript: string): number {
  const length = lockingScript.length / 2
  return 8 + varIntBytes(length) + length
}

const feeFor = (bytes: number) => Math.ceil((bytes * FEE_SAT_PER_KB) / 1000)

function recordTx(purpose: IdentityRecordPurpose, description: string, outputs: DataOutput[]): IdentityRecordTx {
  const sized = outputs.map((o) => ({ description: o.outputDescription, bytes: outputBytes(o.lockingScript) }))
  const body = TX_OVERHEAD_BYTES + sized.reduce((sum, o) => sum + o.bytes, 0)
  return {
    purpose,
    description,
    outputs: sized,
    feeSats: feeFor(body + FUNDING_INPUT_BYTES + MAX_CHANGE_OUTPUTS * CHANGE_OUTPUT_BYTES),
    maxFeeSats: feeFor(body + MAX_FUNDING_INPUTS * FUNDING_INPUT_BYTES + MAX_CHANGE_OUTPUTS * CHANGE_OUTPUT_BYTES),
  }
}

/** Fee of a staged transaction, after checking it carries exactly our records first, in order. */
function stagedFee(signable: number[], outputs: DataOutput[]): number {
  const tx = Transaction.fromAtomicBEEF(signable)
  outputs.forEach((planned, vout) => {
    const staged = tx.outputs[vout]
    if (staged?.satoshis !== 0 || staged.lockingScript.toHex() !== planned.lockingScript.toLowerCase())
      refuse('staged-mismatch', 'The wallet staged different records than you approved. Nothing was signed.')
  })
  let paid = 0
  for (const input of tx.inputs) {
    const satoshis = input.sourceTransaction?.outputs[input.sourceOutputIndex]?.satoshis
    if (typeof satoshis !== 'number')
      refuse('staged-mismatch', 'The staged transaction is missing an input value. Nothing was signed.')
    paid += satoshis
  }
  return paid - tx.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0)
}

/**
 * Stage unsigned, hold the fee to what was approved, then sign. Refusing
 * before `signAction` releases the reserved change; nothing reached a miner.
 */
async function sendIdentityRecords(
  active: ActiveWallet,
  step: IdentityRecordTx,
  outputs: DataOutput[],
): Promise<{ txid: string; tx: number[] }> {
  const created = await active.wallet.createAction({
    description: step.description,
    labels: ['bap-identity'],
    outputs,
    options: { randomizeOutputs: false, acceptDelayedBroadcast: true, signAndProcess: false },
  })
  const signable = created.signableTransaction
  if (!signable?.reference || !signable.tx?.length)
    refuse('not-signed', `${step.description} could not be staged. Nothing was signed.`)
  const { reference } = signable
  let fee: number
  try {
    fee = stagedFee(Array.from(signable.tx), outputs)
    if (fee > step.maxFeeSats)
      refuse(
        'fee-over-plan',
        `${step.description} needs a ${fee}-sat network fee, above the ${step.maxFeeSats} sats you approved. Nothing was signed.`,
      )
  } catch (error) {
    await active.wallet
      .abortAction({ reference })
      .catch((err) => console.warn(`[identity-publish] could not release ${reference.slice(0, 12)}`, err))
    throw error
  }
  const signed = await active.wallet.signAction({ reference, spends: {}, options: { acceptDelayedBroadcast: true } })
  const txid = typeof signed.txid === 'string' ? signed.txid.toLowerCase() : ''
  const tx = signed.tx ? Array.from(signed.tx) : []
  if (!/^[0-9a-f]{64}$/.test(txid) || !tx.length) refuse('not-signed', `${step.description} was not signed.`)
  console.info(`[identity-publish] ${step.purpose} ${txid.slice(0, 12)} fee ${fee} sats (approved ≤ ${step.maxFeeSats})`)
  const { registerSignedSend, startSignedSendPropagation } = await import('./signedSendLifecycle')
  const handle = await registerSignedSend({ txid, atomicBeef: tx, flow: 'identity_publish', satoshis: 0 })
  startSignedSendPropagation(handle)
  return { txid, tx }
}

/**
 * BAP records for `bapId` this wallet holds: its own publishes, records the
 * earlier ID-panel compose wrote, and records another BRC-100 app wrote into
 * `bap`. Null when it holds none.
 */
async function heldBapRecords(active: ActiveWallet, basket: string, bapId: string): Promise<number[] | null> {
  try {
    const held = await active.wallet.listOutputs({
      basket,
      tags: [`bapId:${bapId}`],
      include: 'entire transactions',
      limit: 100,
    })
    return held.outputs.length && held.BEEF?.length ? Array.from(held.BEEF) : null
  } catch (error) {
    console.warn('[identity-publish] held BAP records unreadable', error)
    return null
  }
}

/** Every record this wallet knows for `bapId`: its stored package and what it holds. */
async function knownRecords(active: ActiveWallet, basket: string, bapId: string): Promise<number[][]> {
  const pkg = issuerIdentityPackage(active.chain, bapId)
  const held = await heldBapRecords(active, basket, bapId)
  return [...(pkg ? [issuerIdentityPackageBeef(pkg)] : []), ...(held ? [held] : [])]
}

const idOutput = (signer: Signer, bapId: string, seq: number, lockingScript: string): DataOutput => ({
  lockingScript,
  satoshis: 0,
  outputDescription: 'BAP ID',
  basket: signer.basket,
  tags: ['type:id', `bapId:${bapId}`, `seq:${seq}`],
  ...(signer.own
    ? { customInstructions: JSON.stringify({ protocolID: BAP_PROTOCOL_ID, keyID: `${BAP_KEY_ID}-${seq}` }) }
    : {}),
})

const aliasOutput = (signer: Signer, bapId: string, lockingScript: string): DataOutput => ({
  lockingScript,
  satoshis: 0,
  outputDescription: 'BAP ALIAS',
  basket: signer.basket,
  tags: ['type:alias', `bapId:${bapId}`, `publishedAt:${Date.now()}`],
})

const sameImage = (a: IssuerIdentityImage, b: IssuerIdentityImage) =>
  a.contentType === b.contentType &&
  a.bytes.length === b.bytes.length &&
  a.bytes.every((byte, i) => byte === b.bytes[i])

function packaged(
  runtime: WalletRuntime,
  identityKey: string,
  bapId: string,
  beefs: number[][],
  aliasTxid: string,
): IssuerIdentity {
  const pkg = buildIssuerIdentityPackage(bapId, beefs, { preferAlias: aliasTxid })
  if (!pkg)
    throw new Error(`Identity ${aliasTxid.slice(0, 12)} is broadcasting, but its proof could not be packaged.`)
  return recordPublishedIdentity(runtime, identityKey, pkg)
}

type Step = { tx: IdentityRecordTx; outputs: (imageTxid: string) => DataOutput[] }

type Prepared = {
  key: string
  plan: IdentityPublishPlan
  steps: Step[]
  beefs: number[][]
  /** Set when the ALIAS references an image already on chain. */
  imageTxid?: string
}

type PlanBase = Omit<IdentityPublishPlan, 'transactions' | 'feeSats' | 'maxFeeSats' | 'digest'>

const planKey = (seq: number, key: PrivateKey): IdentityPlanKey => ({
  seq,
  publicKey: key.toPublicKey().toString(),
})

const imageOutput = (signer: Signer, bapId: string, image: IssuerIdentityImage): DataOutput => ({
  lockingScript: bFileScript(image),
  satoshis: 0,
  outputDescription: 'Identity image',
  basket: signer.basket,
  tags: ['type:image', `bapId:${bapId}`],
})

/**
 * The records a publish or rotation writes, from what this wallet knows now.
 * Quote and publish both build through here, so an approved digest pins the
 * exact scripts that get signed.
 *
 * Profile: without a key chain the root declares `identity-1` beside the
 * ALIAS; with one, only a new ALIAS signed by the current key. A new image is
 * its own B:// transaction; an unchanged one is referenced, never re-uploaded.
 *
 * Rotation: the outgoing key declares `identity-N+1`, which re-signs the same
 * profile in the same transaction. Assets the old key signed stay attributed
 * when mined before the rotation is.
 */
async function prepare(runtime: WalletRuntime, request: IdentityPublishRequest): Promise<Prepared> {
  const key = normalizeIssuerIdentityKey(request.identityKey)
  if (!key) refuse('invalid-key', 'Invalid issuer identity key.')
  const fields = request.kind === 'profile' ? issuerIdentityFields(request.fields) : null
  const bitmap = request.kind === 'profile' && request.image ? issuerIdentityImage(request.image) : null
  const active = assertCurrent(runtime)
  const signer = signerFor(runtime, key)
  const { master } = signer
  const bapId = bapIdFor(master)
  const prior = publishedIdentityForIssuer(runtime, key)
  const beefs = await knownRecords(active, signer.basket, bapId)
  assertCurrent(runtime)
  const chain = bapKeyChain(bapId, beefs)
  if (chain?.revoked) refuse('revoked', 'This identity was revoked and cannot be updated.')
  const who = { identityKey: key, bapId, signer: signer.own ? ('wallet' as const) : ('imported' as const) }
  const steps: Step[] = []
  let base: PlanBase
  let imageTxid: string | undefined
  const priorImage = prior ? issuerIdentityImageRef(prior) : undefined
  if (!fields) {
    if (!prior) refuse('not-published', 'Publish the identity before rotating its key.')
    if (!priorImage) refuse('no-image', 'Publish an image before rotating the key.')
    if (!chain) refuse('missing-package', 'The identity package is missing; restore an identity backup.')
    const seq = chain.keys.at(-1)!.seq
    const outgoing = currentIssuerSigningKey(master, chain)
    const next = bapKey(master, seq + 1)
    imageTxid = priorImage
    const profile = issuerProfile({ name: prior.name, description: prior.description }, imageTxid)
    const outputs = [
      idOutput(signer, bapId, seq + 1, bapIdScript({ bapId, address: next.toAddress(), signer: outgoing })),
      aliasOutput(signer, bapId, bapAliasScript({ bapId, profile, signer: next })),
    ]
    steps.push({ tx: recordTx('rotate', 'Rotate issuer signing key', outputs), outputs: () => outputs })
    base = {
      kind: 'rotate',
      ...who,
      name: prior.name,
      description: prior.description,
      image: { status: 'reused', txid: imageTxid },
      signingKey: planKey(seq + 1, next),
      retiredKey: planKey(seq, outgoing),
    }
  } else {
    imageTxid =
      priorImage && (!bitmap || (prior?.image && sameImage(prior.image, bitmap))) ? priorImage : undefined
    if (!imageTxid && !bitmap) refuse('no-image', 'Choose an image first.')
    const seq = chain ? chain.keys.at(-1)!.seq : 1
    const signingKey = chain ? currentIssuerSigningKey(master, chain) : bapKey(master, 1)
    if (!imageTxid) {
      const outputs = [imageOutput(signer, bapId, bitmap!)]
      steps.push({ tx: recordTx('image', 'Issuer identity image', outputs), outputs: () => outputs })
    }
    const records = (txid: string): DataOutput[] => [
      ...(chain
        ? []
        : [idOutput(signer, bapId, 1, bapIdScript({ bapId, address: bapAddress(master, 1), signer: bapKey(master, 0) }))]),
      aliasOutput(signer, bapId, bapAliasScript({ bapId, profile: issuerProfile(fields, txid), signer: signingKey })),
    ]
    steps.push({
      tx: recordTx(
        chain ? 'update' : 'publish',
        chain ? 'Update issuer identity' : 'Publish issuer identity',
        records(imageTxid ?? UNSIGNED_IMAGE_TXID),
      ),
      outputs: records,
    })
    base = {
      kind: chain ? 'update' : 'publish',
      ...who,
      name: fields.name,
      description: fields.description,
      image: imageTxid
        ? { status: 'reused', txid: imageTxid }
        : { status: 'new', bytes: bitmap!.bytes.length, contentType: bitmap!.contentType },
      signingKey: planKey(seq, signingKey),
      retiredKey: null,
    }
  }
  const transactions = steps.map((step) => step.tx)
  const body = {
    ...base,
    transactions,
    feeSats: transactions.reduce((sum, tx) => sum + tx.feeSats, 0),
    maxFeeSats: transactions.reduce((sum, tx) => sum + tx.maxFeeSats, 0),
  }
  const scripts = steps.map((step) =>
    step.outputs(imageTxid ?? UNSIGNED_IMAGE_TXID).map((output) => output.lockingScript),
  )
  const digest = Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify({ plan: body, scripts }), 'utf8')))
  return { key, plan: { ...body, digest }, steps, beefs, imageTxid }
}

/** What publishing `request` would sign and cost. Signs nothing. */
export async function planIdentityPublish(
  runtime: WalletRuntime,
  request: IdentityPublishRequest,
): Promise<IdentityPublishPlan> {
  const started = Date.now()
  const { plan } = await prepare(runtime, request)
  logSlow('quote', started)
  return plan
}

/**
 * Sign and broadcast an approved plan. It is rebuilt under the spend lock: a
 * rotation, a new image or a wallet switch since review refuses rather than
 * signing records the user never saw, and each transaction's fee is held to
 * its approved ceiling before it is signed.
 */
export async function publishIdentityPlan(
  runtime: WalletRuntime,
  request: IdentityPublishRequest,
  approved: IdentityPublishPlan,
): Promise<IssuerIdentity> {
  const started = Date.now()
  return runExclusiveSpend(async () => {
    const prepared = await prepare(runtime, request)
    if (prepared.plan.digest !== approved.digest)
      refuse('plan-changed', 'This identity changed since you reviewed it. Review the publish again.')
    const active = assertCurrent(runtime)
    let imageTxid = prepared.imageTxid
    let aliasTxid = ''
    for (const step of prepared.steps) {
      if (step.tx.purpose !== 'image' && !imageTxid) refuse('no-image', 'Choose an image first.')
      const sent = await sendIdentityRecords(active, step.tx, step.outputs(imageTxid ?? UNSIGNED_IMAGE_TXID))
      prepared.beefs.push(sent.tx)
      if (step.tx.purpose === 'image') imageTxid = sent.txid
      else aliasTxid = sent.txid
      assertCurrent(runtime)
    }
    const identity = packaged(runtime, prepared.key, approved.bapId, prepared.beefs, aliasTxid)
    logSlow(approved.kind, started)
    return identity
  })
}

/**
 * Bring this wallet's identity packages in line with the BAP records it holds:
 * adopt a chain the earlier BAP compose published, and follow a rotation or
 * revocation another BRC-100 app wrote into `bap`, so issuance never signs with
 * a retired key. A profile change alone is left to this wallet's own publish,
 * whose ALIAS choice it would otherwise override.
 */
export async function syncHeldIssuerIdentities(runtime: WalletRuntime | null, onlyKey?: string): Promise<number> {
  if (!runtime || !runtimeIsCurrent(runtime)) return 0
  const active = runtime.instance
  let synced = 0
  for (const row of listPublicIdentities(runtime)) {
    if (onlyKey && row.identityKey !== onlyKey) continue
    const basket = row.signer === 'wallet' ? BAP_BASKET : IMPORTED_BAP_BASKET
    const held = await heldBapRecords(active, basket, row.bapId)
    if (!held || !runtimeIsCurrent(runtime)) continue
    const stored = row.identity ? issuerIdentityPackage(active.chain, row.bapId) : null
    const beefs = stored ? [issuerIdentityPackageBeef(stored), held] : [held]
    if (row.identity) {
      const chain = bapKeyChain(row.bapId, beefs)
      if (!chain || (chain.keys.length === row.identity.keys.length && !!chain.revoked === !!row.identity.revoked))
        continue
    }
    const pkg = buildIssuerIdentityPackage(row.bapId, beefs)
    if (!pkg) {
      if (row.identity) console.warn('[identity-publish] key chain moved; publish an update to re-sign the profile')
      continue
    }
    try {
      recordPublishedIdentity(runtime, row.identityKey, pkg)
      synced++
    } catch (error) {
      console.warn('[identity-publish] held identity not synced', error)
    }
  }
  return synced
}

/**
 * Swap unmined records in this wallet's own packages for mined copies, once
 * their proofs exist and match block headers. Heights are what order a key
 * rotation for every holder, so packages should carry them as soon as they can.
 */
export async function upgradeIssuerIdentityProofs(runtime: WalletRuntime): Promise<number> {
  if (!runtimeIsCurrent(runtime)) return 0
  const active = runtime.instance
  const tracker = await Promise.resolve(active.services?.getChainTracker?.()).catch(() => null)
  if (!tracker) return 0
  const { getBeefForTxidCached } = await import('./beefCache')
  let upgraded = 0
  for (const row of listPublicIdentities(runtime)) {
    const identity = row.identity
    const pkg = identity ? issuerIdentityPackage(active.chain, identity.bapId) : null
    if (!identity || !pkg) continue
    const unmined = new Set([
      ...identity.keys.filter((k) => k.minedHeight === undefined).map((k) => k.txid),
      ...(identity.alias.minedHeight === undefined ? [identity.alias.txid] : []),
      ...(identity.revoked && identity.revoked.minedHeight === undefined ? [identity.revoked.txid] : []),
    ])
    if (!unmined.size) continue
    const proven: number[][] = []
    for (const txid of unmined) {
      try {
        const beef = await Promise.race([
          getBeefForTxidCached(active, txid, { needProof: true }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PROOF_FETCH_MS)),
        ])
        if (beef.findTxid(txid)?.bumpIndex !== undefined) proven.push(beef.toBinary())
      } catch {
        /* not mined yet, or no proof source answered */
      }
    }
    if (!proven.length || !runtimeIsCurrent(runtime)) continue
    const next = buildIssuerIdentityPackage(identity.bapId, [issuerIdentityPackageBeef(pkg), ...proven], {
      preferAlias: identity.alias.txid,
    })
    const roots = next && next.beefB64 !== pkg.beefB64 ? issuerIdentityPackageRoots(next) : null
    if (!next || !roots) continue
    try {
      let confirmed = true
      for (const { root, height } of roots)
        if (!(await tracker.isValidRootForHeight(root, height))) confirmed = false
      if (!confirmed) continue
      recordPublishedIdentity(runtime, row.identityKey, next)
      upgraded++
    } catch (error) {
      console.warn('[identity-publish] proof upgrade skipped', error)
    }
  }
  return upgraded
}
