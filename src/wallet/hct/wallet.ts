import { Beef, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { createActor } from 'xstate'
import { hctMachine } from '../../machines/hctMachine'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN } from '../appActivity'
import { atomicBeefForSubject, getBeefForTxidCached, getLocalBeefForTxid, rememberBeefTree } from '../beefCache'
import { scheduleHistoryBackupPush } from '../deviceSync'
import { stampBrc164Id } from '../itemAccess'
import type { ActiveWallet } from '../session'
import { runExclusiveSpend } from '../spendGuard'
import { activeAccountSpendRefusal } from '../vaultAccountHolding'
import { getWalletRuntime } from '../walletRuntime'
import { signInput, sourceTxidOf } from '../countersign/script'
import {
  freshDerivationString,
  hctHolderPrivateKey,
  hctHolderPublicKey,
  hctIssuerPrivateKey,
  readHctRemittance,
  type HctRemittance,
} from './keys'
import { checkBackingProof, hctBackingScript, type BackingOutpoint, type HctBackingProof } from './backing'
import {
  encodeHctPayload,
  HCT_MAX_CONTENT_BYTES,
  HCT_MAX_ICON_BYTES,
  hctSupplyPolicy,
  type HctBacking,
  type HctDeployFields,
} from './payload'
import { buildHctPackage, hctAncestry, HCT_PACKAGE_BUDGET, readHctPackage, type HctPackage } from './proof'
import {
  HCT_HOLDER_SCOPE,
  HCT_ISSUER_SCOPE,
  HCT_MAX_AMOUNT,
  hctAssetId,
  hctAuthorityLock,
  hctDeployLock,
  hctHeldLock,
  hctOpenUnlock,
  isHctAssetId,
  p2pkLock,
  readHct,
  type HctIssued,
  type HctOutput,
} from './script'
import {
  outboxId,
  notePeerHolds,
  peerHolds,
  readHctState,
  writeHctState,
  type HctDeliveryOutput,
  type HctOutboxEntry,
} from './state'
import {
  getHctBacking,
  getHctDeployRecord,
  getHctTx,
  hasHctBackingSync,
  isHctValidated,
  isHctValidatedSync,
  markHctValidated,
  putHctBacking,
  putHctDeployRecord,
  putHctTx,
} from './store'
import {
  checkHctTx,
  deployIssued,
  hctBackingNeed,
  readHctDeploy,
  readHctDeploys,
  walkHct,
  type BackingSource,
  type HctDeploy,
} from './validity'

/** Store-and-forward box for transfer packages and history requests. */
export const HCT_BOX = 'hct'
/** Open HCT filings (§11). Countersigned assets file in `csft` / `csnft`. */
export const HCT_TOKEN_BASKET = 'p2pft'
export const HCT_ITEM_BASKET = 'p2pnft'
export const HCT_TAG = 'hct'
/** One-satoshi P2PK coins locked to this identity's issuer key; a deploy spends one. */
const ISSUER_BASKET = 'hct-issuer'
const LABEL = 'hct'
const SIG_LENGTH = 73
const MAX_INPUTS = 64
const MAX_DELIVERY_OUTPUTS = 64
const BOX_ACTIVE_POLL_MS = 5_000
const BOX_IDLE_POLL_MS = 20_000
const RETRY_STEPS_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000]
const NEED_RESEND_MS = 10 * 60_000
/** A `history` reply is taken only while a `need` for that asset is this fresh. */
const NEED_OPEN_MS = 60 * 60_000
const KEY_RE = /^0[23][0-9a-f]{64}$/
const TXID_RE = /^[0-9a-f]{64}$/

type Wire =
  | {
      v: 1
      t: 'transfer'
      asset: string
      /** The deploy outpoint, `txid_vout`: the package may omit its body. */
      deploy: string
      senderIdentityKey: string
      outputs: HctDeliveryOutput[]
      proof: HctPackage
      /** Atomic BEEF of the subject for the recipient's toolbox, when it fits. */
      beef?: string
    }
  | { v: 1; t: 'need'; asset: string; deploy: string; txid: string }
  | { v: 1; t: 'history'; asset: string; proof: HctPackage }

export type HctError =
  | 'bad-asset-args'
  | 'not-held'
  | 'insufficient'
  | 'unsupported-mode'
  | 'fixed-supply'
  | 'over-cap'
  | 'invalid-build'
  | 'awaiting-backing'

export class HctRefusal extends Error {
  constructor(
    readonly reason: HctError,
    message: string,
  ) {
    super(message)
    this.name = 'HctRefusal'
  }
}

function refuse(reason: HctError, message: string): never {
  console.warn(`[hct] refuse ${reason} — ${message}`)
  throw new HctRefusal(reason, message)
}

function log(phase: string, startedAt: number): void {
  const ms = Date.now() - startedAt
  if (ms > 250) console.info(`[hct] ${phase} done ${ms}ms`)
}

function currentActive(): ActiveWallet | null {
  return getWalletRuntime()?.instance ?? null
}

function requireActive(): ActiveWallet {
  const active = currentActive()
  if (!active) throw new Error('Wallet locked')
  return active
}

const rootOf = (active: ActiveWallet) => PrivateKey.fromHex(active.rootKeyHex)
const selfOf = (active: ActiveWallet) => active.identityKey.toLowerCase()
const idOf = (tx: Transaction) => String(tx.id('hex')).toLowerCase()

export function hctFilingOf(kind: 'token' | 'item'): string {
  return kind === 'item' ? HCT_ITEM_BASKET : HCT_TOKEN_BASKET
}

// ── Transactions ───────────────────────────────────────────────────────────

async function rawTx(active: ActiveWallet, txid: string): Promise<Transaction | null> {
  if (!TXID_RE.test(txid)) return null
  const stored = await getHctTx(txid)
  if (stored) return stored
  const local = await getLocalBeefForTxid(active, txid).catch(() => null)
  const hit = local?.findTxid(txid)?.tx
  if (hit) return hit
  try {
    const beef = await getBeefForTxidCached(active, txid, { needProof: false, allowUnprovenRawTx: true })
    return beef.findTxid(txid)?.tx ?? null
  } catch {
    return null
  }
}

/** Link every input's source output (Extended Format); null when a parent is not available. */
async function linkSources(active: ActiveWallet, tx: Transaction, beef?: Beef): Promise<Transaction | null> {
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const input = tx.inputs[vin]!
    if (input.sourceTransaction?.outputs[input.sourceOutputIndex]) continue
    const parentId = sourceTxidOf(tx, vin)
    const parent = beef?.findTxid(parentId)?.tx ?? (await rawTx(active, parentId))
    if (!parent?.outputs[input.sourceOutputIndex]) return null
    input.sourceTXID = parentId
    input.sourceTransaction = parent
  }
  return tx
}

async function linkedTx(active: ActiveWallet, txid: string): Promise<Transaction | null> {
  const tx = await rawTx(active, txid)
  return tx ? linkSources(active, tx) : null
}

/** Atomic BEEF of `tx` with every unproven ancestor this wallet can supply. */
async function atomicBeefFor(active: ActiveWallet, tx: Transaction): Promise<number[]> {
  const txid = idOf(tx)
  const local = await getLocalBeefForTxid(active, txid).catch(() => null)
  if (local?.findTxid(txid)?.tx) {
    const framed = atomicBeefForSubject(Array.from(local.toBinary()), txid)
    if (framed) return framed
  }
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  for (let pass = 0; pass < 32; pass++) {
    const need = new Set<string>()
    for (const entry of beef.txs) {
      if (entry.isTxidOnly || !entry.tx || entry.bumpIndex !== undefined) continue
      for (let vin = 0; vin < entry.tx.inputs.length; vin++) {
        const parent = sourceTxidOf(entry.tx, vin)
        if (parent && !beef.findTxid(parent)) need.add(parent)
      }
    }
    if (need.size === 0) break
    let added = false
    for (const parent of need) {
      const held = await getLocalBeefForTxid(active, parent).catch(() => null)
      if (held?.findTxid(parent)?.tx) {
        beef.mergeBeef(held.toBinary())
        added = true
        continue
      }
      try {
        beef.mergeBeef((await getBeefForTxidCached(active, parent, { needProof: false, allowUnprovenRawTx: true })).toBinary())
        added = true
      } catch {
        // A parent this wallet cannot reach leaves the BEEF short; the toolbox refuses it and the caller retries.
      }
    }
    if (!added) break
  }
  return Array.from(beef.toBinaryAtomic(txid))
}

/**
 * Input BEEF holding the source transaction of every outpoint an action
 * names. The engine signs only its own change, so it builds the signable
 * transaction from this BEEF; an input missing here fails `createAction` after
 * storage has already staged (and locked) the action.
 */
async function inputBeefFor(active: ActiveWallet, outpoints: readonly string[]): Promise<{ binary: number[]; txids: string[] }> {
  const beef = new Beef()
  for (const txid of new Set(outpoints.map((op) => op.replace('_', '.').split('.')[0]!.toLowerCase()))) {
    if (beef.findTxid(txid)?.tx) continue
    const tx = await rawTx(active, txid)
    if (!tx) refuse('invalid-build', `Transaction ${txid} that holds an input is not available. Nothing was signed.`)
    beef.mergeBeef(Beef.fromBinary(await atomicBeefFor(active, tx)))
  }
  return { binary: Array.from(beef.toBinary()), txids: beef.txs.map((entry) => entry.txid.toLowerCase()) }
}

// ── Deploys ────────────────────────────────────────────────────────────────

const deployCache = new Map<string, HctDeploy>()

/** The deploy of `assetId`, read back from its transaction; `at` names it when this wallet has no record. */
async function deployOf(active: ActiveWallet, assetId: string, at?: { txid: string; vout: number }, supplied?: Transaction): Promise<HctDeploy | null> {
  const cached = deployCache.get(assetId)
  if (cached) return cached
  const record = (await getHctDeployRecord(assetId)) ?? null
  if (record && at && (record.txid !== at.txid || record.vout !== at.vout)) return null
  const where = record ?? (at ? { assetId, ...at } : null)
  if (!where || hctAssetId(where.txid, where.vout) !== assetId) return null
  const tx = supplied && idOf(supplied) === where.txid ? await linkSources(active, supplied) : await linkedTx(active, where.txid)
  if (!tx) return null
  const read = readHctDeploy(tx, where.vout)
  if (!read.ok || read.deploy.assetId !== assetId) return null
  await putHctTx(tx)
  if (!record) await putHctDeployRecord({ assetId, txid: where.txid, vout: where.vout })
  await markHctValidated([where.txid], assetId)
  deployCache.set(assetId, read.deploy)
  return read.deploy
}

function parseOutpoint(value: unknown): { txid: string; vout: number } | null {
  if (typeof value !== 'string') return null
  const [txid, vout] = value.trim().toLowerCase().replace('.', '_').split('_')
  const n = Number(vout)
  return TXID_RE.test(txid ?? '') && Number.isInteger(n) && n >= 0 && n <= 255 ? { txid: txid!, vout: n } : null
}

// ── Rows ───────────────────────────────────────────────────────────────────

export type HctRow = {
  outpoint: string
  txid: string
  vout: number
  assetId: string
  read: HctOutput
  /** Units this output carries as an input: a deploy carries its supply. */
  amount: bigint
  authority: boolean
  /** A capped asset's authority: what it has issued so far. */
  issued?: HctIssued
  basket: string
  remittance: HctRemittance
  /** Units of a backed mint whose deposit (or an earlier one they came through) has no burial proof yet: held, not movable. */
  locked: boolean
}

function displayTag(prefix: string, value: string | undefined): string[] {
  const text = value?.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64)
  return text ? [`${prefix}:${text}`] : []
}

function rowTags(assetId: string, deploy: Pick<HctDeploy, 'fields'>, form: 'held' | 'authority' | 'deploy', amount: bigint): string[] {
  const { fields } = deploy
  return stampBrc164Id([
    HCT_TAG,
    `${hctFilingOf(fields.kind)}:${assetId}`,
    form === 'authority' ? 'hct-authority' : `amt:${amount}`,
    ...displayTag('sym', fields.sym),
    ...displayTag('name', fields.name),
    ...(fields.col ? [`collection:${fields.col}`] : []),
    `creator:${fields.iss[0]}`,
  ])
}

/** A deploy row has no asset id until it is signed: readers derive it from the outpoint and script. */
function rowInstructions(
  assetId: string | null,
  fields: Pick<HctDeployFields, 'kind' | 'mode' | 'sym' | 'dec' | 'name' | 'col'>,
  form: 'held' | 'authority' | 'deploy',
  amount: bigint,
  remittance: HctRemittance,
): string {
  return JSON.stringify({
    ...(assetId ? { asset: assetId } : {}),
    kind: fields.kind,
    mode: fields.mode,
    form,
    amt: amount.toString(),
    ...(fields.sym ? { sym: fields.sym } : {}),
    ...(fields.dec != null ? { dec: fields.dec } : {}),
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.col ? { col: fields.col } : {}),
    ...remittance,
  })
}

/**
 * Rows this wallet holds in `basket` that read as canonical HCT, whose
 * remittance derives the clause's holder key, and whose (txid, asset) this
 * device validated. A tag alone never makes a row an asset.
 */
async function heldRows(active: ActiveWallet, basket: string, assetId?: string): Promise<HctRow[]> {
  const page = await active.wallet.listOutputs({
    basket,
    include: 'locking scripts',
    includeTags: true,
    includeCustomInstructions: true,
    limit: 10_000,
  })
  const root = rootOf(active)
  const rows: HctRow[] = []
  for (const o of page.outputs ?? []) {
    if (o.spendable === false || !(o.tags ?? []).includes(HCT_TAG) || !o.lockingScript) continue
    const read = readHct(o.lockingScript)
    if (!read) continue
    const [txid, voutRaw] = o.outpoint.replace('_', '.').split('.')
    const vout = Number(voutRaw)
    const id = read.form === 'deploy' ? hctAssetId(txid!, vout) : read.assetId
    if (assetId && id !== assetId) continue
    let remittance: HctRemittance | null = null
    try {
      remittance = readHctRemittance(JSON.parse(o.customInstructions ?? 'null'))
    } catch {
      remittance = null
    }
    if (!remittance) continue
    if (hctHolderPrivateKey(root, remittance).toPublicKey().toString() !== read.clause.holder) continue
    if (!(await isHctValidated(txid!, id))) continue
    const deploy = read.form === 'deploy' ? await deployOf(active, id, { txid: txid!, vout }) : null
    const issued = read.form === 'authority' ? read.issued : deploy?.fields.auth ? deployIssued(deploy) : null
    const assetDeploy = deploy ?? (await deployOf(active, id))
    const locked = assetDeploy?.fields.bk ? !(await movable(active, assetDeploy, txid!, vout)) : false
    rows.push({
      outpoint: `${txid}.${vout}`,
      txid: txid!,
      vout,
      assetId: id,
      read,
      amount: read.form === 'held' ? read.amount : read.form === 'deploy' ? read.supply : 0n,
      authority: read.form === 'authority' || deploy?.fields.auth === true,
      ...(issued ? { issued } : {}),
      basket,
      remittance,
      locked,
    })
  }
  return rows
}

// ── Backing ────────────────────────────────────────────────────────────────

/** `assetId:txid` pairs whose whole history back to the deploy carries every burial proof it needs. Proofs are only ever added. */
const backedThrough = new Set<string>()

async function hctTxOf(active: ActiveWallet, txid: string): Promise<Transaction | null> {
  return (await getHctTx(txid)) ?? (await linkedTx(active, txid))
}

/** Does every backed transaction whose units `txid`'s history moves have a checked burial proof here? */
async function historyBacked(active: ActiveWallet, deploy: HctDeploy, txid: string): Promise<boolean> {
  const key = `${deploy.assetId}:${txid}`
  if (txid === deploy.txid || backedThrough.has(key)) return true
  const tx = await hctTxOf(active, txid)
  const check = tx ? checkHctTx(tx, deploy) : null
  if (!tx || !check?.ok) return false
  const byParent = new Map<string, number[]>()
  for (const vin of check.inputs) {
    const parent = sourceTxidOf(tx, vin)
    byParent.set(parent, [...(byParent.get(parent) ?? []), tx.inputs[vin]!.sourceOutputIndex])
  }
  for (const [parent, vouts] of byParent) {
    const parentTx = await hctTxOf(active, parent)
    if (!parentTx) return false
    const need = hctBackingNeed(parentTx, parent, deploy, vouts)
    if (need.kind === 'invalid') return false
    if (need.kind === 'needed' && !(await getHctBacking(parent))) return false
    if (!(await historyBacked(active, deploy, parent))) return false
  }
  backedThrough.add(key)
  return true
}

/** May output `vout` of `txid` move? Its own deposit, and every one its history moved units through, must be proven. */
async function movable(active: ActiveWallet, deploy: HctDeploy, txid: string, vout: number): Promise<boolean> {
  const tx = await hctTxOf(active, txid)
  if (!tx) return false
  const need = hctBackingNeed(tx, txid, deploy, [vout])
  if (need.kind === 'invalid') return false
  if (need.kind === 'needed' && !(await getHctBacking(txid))) return false
  return historyBacked(active, deploy, txid)
}

/** Burial proofs a recipient's walk of these transactions may need: every one this device holds for them or their parents. */
async function backingFor(txs: readonly Transaction[], extra: readonly string[] = []): Promise<Map<string, HctBackingProof>> {
  const ids = new Set<string>(extra)
  for (const tx of txs) {
    ids.add(idOf(tx))
    for (let vin = 0; vin < tx.inputs.length; vin++) ids.add(sourceTxidOf(tx, vin))
  }
  const out = new Map<string, HctBackingProof>()
  for (const id of ids) {
    const proof = await getHctBacking(id)
    if (proof) out.set(id, proof)
  }
  return out
}

/** Burial proofs a `history` reply supplied, unchecked until a walk needs one. */
const suppliedBacking = new Map<string, HctBackingProof>()

function backingSource(pkgBacking?: ReadonlyMap<string, HctBackingProof>): BackingSource {
  return {
    proven: (txid) => hasHctBackingSync(txid),
    proofOf: async (txid) => pkgBacking?.get(txid) ?? suppliedBacking.get(txid) ?? (await getHctBacking(txid)),
  }
}

async function keepBacked(backed: ReadonlyArray<{ txid: string; proof: HctBackingProof }>): Promise<void> {
  for (const { txid, proof } of backed) {
    await putHctBacking(txid, proof)
    suppliedBacking.delete(txid)
  }
}

/**
 * Record the burial proof of a backed deploy or mint this wallet wrote, once
 * it checks against the deposit that transaction names. Wallet-internal: the
 * wLTC bridge calls it when a deposit is deep enough.
 */
export async function proveHctBacking(assetId: string, txid: string, proof: HctBackingProof): Promise<void> {
  const active = requireActive()
  const deploy = await deployOf(active, assetId)
  if (!deploy?.fields.bk) throw new Error('That asset is not backed')
  const tx = await hctTxOf(active, txid)
  if (!tx) throw new Error(`Transaction ${txid} is not available`)
  const need = hctBackingNeed(tx, txid.toLowerCase(), deploy, tx.outputs.map((_, vout) => vout))
  if (need.kind !== 'needed') throw new Error(need.kind === 'invalid' ? need.detail : `${txid} is not a backed mint of ${assetId}`)
  const check = checkBackingProof(deploy.fields.bk, proof, need.deposit, need.minted)
  if (!check.ok) throw new Error(`The burial proof does not check: ${check.detail}`)
  await putHctBacking(txid, proof)
}

export type HctAssetSummary = {
  assetId: string
  kind: 'token' | 'item'
  mode: 'open' | 'countersign'
  sym?: string
  name?: string
  dec?: number
  collection?: string
  issuers: string[]
  balance: string
  /** Of `balance`, units of a backed token waiting for their deposit's burial proof before they can move. */
  locked?: string
  /** A backed token: the chain its units stand for (BRC-255 `bk`). */
  backedBy?: HctBacking['chain']
  outputs: number
  authority: boolean
  deploy: string
  /** Token icon, or an image item's content, from the deploy. */
  imageUrl?: string
  supply: HctSupplySummary
}

/** §5 supply policy as decimal strings; `issued` only when this wallet holds a capped asset's authority. */
export type HctSupplySummary =
  | { policy: 'fixed' }
  | { policy: 'open' }
  | { policy: 'capped'; max?: string; size?: string; issued?: { units: string; members: string } }

function supplySummary(deploy: HctDeploy, rows: HctRow[]): HctSupplySummary {
  const policy = hctSupplyPolicy(deploy.fields)
  if (policy.kind !== 'capped') return { policy: policy.kind }
  const issued = rows.find((r) => r.issued)?.issued
  return {
    policy: 'capped',
    ...(policy.max != null ? { max: policy.max.toString() } : {}),
    ...(policy.size != null ? { size: policy.size.toString() } : {}),
    ...(issued ? { issued: { units: issued.units.toString(), members: issued.members.toString() } } : {}),
  }
}

const IMAGE_ITEM_MAX_BYTES = 512 * 1024

function dataUrl(mediaType: string, bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mediaType};base64,${btoa(binary)}`
}

function deployImage(fields: HctDeployFields): string | undefined {
  if (fields.icon && /^image\//i.test(fields.icon.mediaType)) return dataUrl(fields.icon.mediaType, fields.icon.bytes)
  if (fields.kind === 'item' && fields.c && fields.ctype && /^image\//i.test(fields.ctype) && fields.c.length <= IMAGE_ITEM_MAX_BYTES) {
    return dataUrl(fields.ctype, fields.c)
  }
  return undefined
}

/** Open HCT assets this wallet holds, from validated rows only. */
export async function listHctAssets(): Promise<{ assets: HctAssetSummary[] }> {
  const active = requireActive()
  const startedAt = Date.now()
  const rows = [...(await heldRows(active, HCT_TOKEN_BASKET)), ...(await heldRows(active, HCT_ITEM_BASKET))]
  const byAsset = new Map<string, HctRow[]>()
  for (const row of rows) byAsset.set(row.assetId, [...(byAsset.get(row.assetId) ?? []), row])
  const assets: HctAssetSummary[] = []
  for (const [assetId, list] of byAsset) {
    const deploy = await deployOf(active, assetId)
    if (!deploy) continue
    if (list.some((r) => r.basket !== hctFilingOf(deploy.fields.kind))) continue
    const image = deployImage(deploy.fields)
    const locked = list.reduce((sum, r) => sum + (r.locked && r.read.form !== 'authority' ? r.amount : 0n), 0n)
    assets.push({
      assetId,
      kind: deploy.fields.kind,
      mode: deploy.fields.mode,
      ...(deploy.fields.sym ? { sym: deploy.fields.sym } : {}),
      ...(deploy.fields.name ? { name: deploy.fields.name } : {}),
      ...(deploy.fields.dec != null ? { dec: deploy.fields.dec } : {}),
      ...(deploy.fields.col ? { collection: deploy.fields.col } : {}),
      issuers: deploy.fields.iss,
      balance: list.reduce((sum, r) => sum + (r.read.form === 'authority' ? 0n : r.amount), 0n).toString(),
      ...(locked > 0n ? { locked: locked.toString() } : {}),
      ...(deploy.fields.bk ? { backedBy: deploy.fields.bk.chain } : {}),
      outputs: list.length,
      authority: list.some((r) => r.authority),
      deploy: `${deploy.txid}_${deploy.vout}`,
      ...(image ? { imageUrl: image } : {}),
      supply: supplySummary(deploy, list),
    })
  }
  log('list', startedAt)
  return { assets }
}

// ── Building ───────────────────────────────────────────────────────────────

type PlannedOutput = {
  lockingScript: string
  satoshis: number
  outputDescription: string
  basket?: string
  tags?: string[]
  customInstructions?: string
}

type SignedHct = { txid: string; atomic: number[]; tx: Transaction }

/** A fresh holder key for `recipient` and the remittance that names it. */
function freshHolder(active: ActiveWallet, recipient: string, prefix: string): { holder: string; remittance: HctRemittance } {
  const suffix = freshDerivationString()
  return {
    holder: hctHolderPublicKey(rootOf(active), recipient, prefix, suffix),
    remittance: { derivationPrefix: prefix, derivationSuffix: suffix, senderIdentityKey: selfOf(active) },
  }
}

/**
 * Stage, sign and check one HCT action. The toolbox funds it and keeps the
 * change; this wallet signs the inputs it names with `keys`, then `check`
 * must pass on the fully linked transaction before `signAction` commits.
 * Anything short of that aborts the action, so the inputs stay put.
 */
async function signHctAction(
  active: ActiveWallet,
  args: {
    description: string
    labels: string[]
    inputs: Array<{ outpoint: string; description: string; key: PrivateKey; scope: number }>
    outputs: PlannedOutput[]
    check: (tx: Transaction) => string | null
  },
): Promise<SignedHct> {
  const inputBEEF = await inputBeefFor(active, args.inputs.map((i) => i.outpoint))
  const created = await active.wallet.createAction({
    description: args.description.slice(0, 50),
    labels: args.labels,
    inputBEEF: inputBEEF.binary,
    inputs: args.inputs.map((i) => ({ outpoint: i.outpoint, inputDescription: i.description, unlockingScriptLength: SIG_LENGTH })),
    outputs: args.outputs,
    options: { trustSelf: 'known', knownTxids: inputBEEF.txids, noSend: true, randomizeOutputs: false, signAndProcess: true },
  })
  const signable = created.signableTransaction
  if (!signable?.reference) throw new Error('The HCT action returned nothing to sign')
  const reference = signable.reference
  try {
    const beef = Beef.fromBinary(Array.from(signable.tx))
    const targets = new Map(args.inputs.map((i) => [i.outpoint.replace('_', '.').toLowerCase(), i]))
    const tx = beef.txs
      .map((entry) => entry.tx)
      .find((t) => t?.inputs.some((input, vin) => targets.has(`${sourceTxidOf(t, vin)}.${input.sourceOutputIndex}`)))
    if (!tx) throw new Error('The staged HCT action does not spend its inputs')
    if (!(await linkSources(active, tx, beef))) throw new Error('A staged HCT input has no source transaction')
    const spends: Record<number, { unlockingScript: string }> = {}
    for (let vin = 0; vin < tx.inputs.length; vin++) {
      const input = tx.inputs[vin]!
      const planned = targets.get(`${sourceTxidOf(tx, vin)}.${input.sourceOutputIndex}`)
      if (!planned) continue
      input.unlockingScript = hctOpenUnlock(signInput(tx, vin, planned.key, planned.scope))
      spends[vin] = { unlockingScript: input.unlockingScript.toHex() }
    }
    if (Object.keys(spends).length !== args.inputs.length) throw new Error('An HCT input is missing from the staged action')
    const problem = args.check(tx)
    if (problem) refuse('invalid-build', `The built transaction fails BRC-255: ${problem}. Nothing was signed.`)
    const signed = await active.wallet.signAction({ reference, spends, options: { noSend: true } })
    const txid = typeof signed.txid === 'string' ? signed.txid.toLowerCase() : ''
    const raw = signed.tx
    const atomic = Array.isArray(raw) ? (raw as number[]) : raw ? Array.from(raw as Uint8Array) : []
    if (!TXID_RE.test(txid) || atomic.length === 0) throw new Error('The HCT action was not signed')
    const final = Beef.fromBinary(atomic).findTxid(txid)?.tx
    if (!final || idOf(final) !== txid) throw new Error('The signed HCT action is missing from its BEEF')
    final.inputs.forEach((input, vin) => {
      const staged = tx.inputs[vin]
      if (staged && sourceTxidOf(final, vin) === sourceTxidOf(tx, vin) && input.sourceOutputIndex === staged.sourceOutputIndex) {
        input.sourceTransaction ??= staged.sourceTransaction
      }
    })
    if (!(await linkSources(active, final))) throw new Error('The signed HCT action lost a source transaction')
    const after = args.check(final)
    if (after) {
      await active.wallet.abortAction({ reference: txid }).catch(() => {})
      throw new Error(`The signed HCT action fails BRC-255: ${after}`)
    }
    return { txid, atomic, tx: final }
  } catch (err) {
    await active.wallet.abortAction({ reference }).catch(() => {})
    throw err
  }
}

async function commitSigned(signed: SignedHct, assetIds: readonly string[], awaitMiners: boolean): Promise<void> {
  rememberBeefTree(signed.atomic, signed.txid)
  await putHctTx(signed.tx)
  for (const assetId of assetIds) await markHctValidated([signed.txid], assetId)
  const { registerSignedSend, propagateSignedSend, startSignedSendPropagation } = await import('../signedSendLifecycle')
  const handle = await registerSignedSend({ txid: signed.txid, atomicBeef: signed.atomic, flow: 'hct' })
  if (!awaitMiners) {
    startSignedSendPropagation(handle)
    return
  }
  await propagateSignedSend(handle).catch((err) => {
    console.warn('[hct] propagation queued', err instanceof Error ? err.message : String(err))
  })
}

/**
 * Finish an HCT action this wallet signed but never committed, because the
 * app stopped between `signAction` and `commitSigned`: re-check every asset it
 * carries against its deploy, then validate and propagate it as the build
 * would have. A committed action is left alone.
 */
export async function adoptSignedHctAction(txid: string): Promise<void> {
  const active = requireActive()
  const id = txid.toLowerCase()
  if (await getHctTx(id)) return
  const tx = await linkedTx(active, id)
  if (!tx) throw new Error(`Transaction ${id} is not in this wallet`)
  const assetIds = new Set<string>()
  const deployed = new Set<string>()
  tx.outputs.forEach((output, vout) => {
    const read = readHct(output.lockingScript)
    if (!read) return
    if (read.form === 'deploy') deployed.add(hctAssetId(id, vout))
    else assetIds.add(read.assetId)
  })
  for (const assetId of deployed) {
    const vout = tx.outputs.findIndex((_, i) => hctAssetId(id, i) === assetId)
    if (!(await deployOf(active, assetId, { txid: id, vout }, tx))) throw new Error(`${id} does not read back as the deploy of ${assetId}`)
    await putHctDeployRecord({ assetId, txid: id, vout })
  }
  for (const assetId of assetIds) {
    if (deployed.has(assetId)) continue
    const deploy = await deployOf(active, assetId)
    if (!deploy) throw new Error(`No deploy of ${assetId} for ${id}`)
    const check = checkHctTx(tx, deploy)
    if (!check.ok) throw new Error(`${id} fails BRC-255: ${check.reason}: ${check.detail}`)
  }
  if (deployed.size + assetIds.size === 0) throw new Error(`${id} carries no HCT asset`)
  await commitSigned({ txid: id, atomic: await atomicBeefFor(active, tx), tx }, [...deployed, ...assetIds], false)
  console.info(`[hct] adopted ${id.slice(0, 12)} (${[...deployed, ...assetIds].length} asset(s))`)
}

// ── Issue ──────────────────────────────────────────────────────────────────

async function issuerCoin(active: ActiveWallet, issuerPub: string): Promise<string> {
  const lock = p2pkLock(issuerPub).toHex()
  const page = await active.wallet.listOutputs({ basket: ISSUER_BASKET, include: 'locking scripts', limit: 100 })
  const held = (page.outputs ?? []).find((o) => o.spendable !== false && (o.lockingScript ?? '').toLowerCase() === lock)
  if (held) return held.outpoint.replace('_', '.')
  const startedAt = Date.now()
  const created = await active.wallet.createAction({
    description: 'HCT issuer coin',
    labels: [LABEL, 'hct-issuer'],
    outputs: [{ lockingScript: lock, satoshis: 1, outputDescription: 'HCT issuer coin', basket: ISSUER_BASKET, tags: ['hct-issuer'] }],
    options: { randomizeOutputs: false, noSend: true, acceptDelayedBroadcast: true },
  })
  const txid = created.txid?.toLowerCase() ?? ''
  const atomic = created.tx ? Array.from(created.tx) : []
  if (!TXID_RE.test(txid) || atomic.length === 0) throw new Error('The HCT issuer coin was not signed')
  rememberBeefTree(atomic, txid)
  const { registerSignedSend, propagateSignedSend } = await import('../signedSendLifecycle')
  await propagateSignedSend(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'hct' }))
  log('issuer coin', startedAt)
  return `${txid}.0`
}

type MediaArg = { mediaType?: unknown; base64?: unknown }

function mediaOf(arg: MediaArg | undefined, max: number, what: string): { mediaType: string; bytes: Uint8Array } | undefined {
  if (arg == null) return undefined
  const mediaType = typeof arg.mediaType === 'string' ? arg.mediaType.trim() : ''
  const bytes = typeof arg.base64 === 'string' ? Uint8Array.from(Utils.toArray(arg.base64, 'base64')) : new Uint8Array()
  if (!mediaType || bytes.length === 0 || bytes.length > max) {
    refuse('bad-asset-args', `The ${what} needs a media type and 1 byte to ${Math.round(max / 1024)} KiB.`)
  }
  return { mediaType, bytes }
}

export type IssueHctArgs = {
  kind?: unknown
  supply?: unknown
  sym?: unknown
  name?: unknown
  dec?: unknown
  icon?: MediaArg
  content?: MediaArg
  /** A token whose deploy is its mint authority (a collection's authority for items). */
  auth?: unknown
  /** Cap on the units that may ever exist, the supply included; implies `auth`. */
  max?: unknown
  /** Cap on the member items a collection may ever deploy; implies `auth`. */
  size?: unknown
  /** An item's collection: a token asset whose authority this wallet holds. */
  collection?: unknown
  mode?: unknown
}

/** Wallet-internal options; the BRC-100 dispatcher never passes them, so an app cannot set them. */
export type HctWalletOptions = {
  /** Extra action labels, written atomically with the transaction (they ride the BRC-39 history). */
  labels?: readonly string[]
  /**
   * A backed token (BRC-255 `bk`): the deposit this deploy or mint issues
   * units against. A deploy also names the chain and reserve.
   */
  backing?: { deposit: BackingOutpoint; bk?: HctBacking }
}

export type IssueHctResult = { assetId: string; txid: string; kind: 'token' | 'item'; supply: string; basket: string }

/** Plain checks of issue arguments, before anything is staged. */
export function hctIssueFields(args: IssueHctArgs, identityKey: string): { fields: HctDeployFields; supply: bigint } {
  if (args.mode != null && args.mode !== 'open') {
    refuse('unsupported-mode', 'This wallet issues open HCT assets; countersigned assets use issueCountersignedAsset.')
  }
  const kind = args.kind === 'item' ? 'item' : args.kind === 'token' || args.kind == null ? 'token' : null
  if (!kind) refuse('bad-asset-args', 'kind must be "token" or "item".')
  const supplyRaw = kind === 'item' ? String(args.supply ?? '1') : String(args.supply ?? '').trim()
  if (!/^\d+$/.test(supplyRaw) || BigInt(supplyRaw) <= 0n || BigInt(supplyRaw) > HCT_MAX_AMOUNT) {
    refuse('bad-asset-args', 'supply must be a whole number from 1 to 2^64-1.')
  }
  if (kind === 'item' && supplyRaw !== '1') refuse('bad-asset-args', 'An item has a supply of exactly 1.')
  const sym = typeof args.sym === 'string' ? args.sym.trim() : ''
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (kind === 'token' && !sym) refuse('bad-asset-args', 'A token needs a symbol.')
  if (kind === 'item' && !name) refuse('bad-asset-args', 'An item needs a name.')
  const dec = args.dec == null ? undefined : Number(args.dec)
  const icon = mediaOf(args.icon, HCT_MAX_ICON_BYTES, 'icon')
  const content = kind === 'item' ? mediaOf(args.content, HCT_MAX_CONTENT_BYTES, 'content') : undefined
  if (kind === 'token' && args.content != null) refuse('bad-asset-args', 'Only an item carries content.')
  const collection = args.collection == null ? undefined : String(args.collection).trim().toLowerCase()
  if (collection != null && (kind !== 'item' || !isHctAssetId(collection))) {
    refuse('bad-asset-args', 'collection is the 40-hex asset id of a token whose authority you hold, on an item.')
  }
  if (args.auth != null && typeof args.auth !== 'boolean') refuse('bad-asset-args', 'auth is true or false.')
  const cap = (name: 'max' | 'size'): bigint | undefined => {
    const raw = args[name]
    if (raw == null) return undefined
    const text = String(raw).trim()
    if (!/^\d+$/.test(text) || BigInt(text) < 1n || BigInt(text) > HCT_MAX_AMOUNT) {
      refuse('bad-asset-args', `${name} must be a whole number from 1 to 2^64-1.`)
    }
    return BigInt(text)
  }
  const max = cap('max')
  const size = cap('size')
  if ((max != null || size != null) && (kind !== 'token' || args.auth === false)) {
    refuse('bad-asset-args', 'max and size cap minting, so they go on a token with a mint authority.')
  }
  if (max != null && BigInt(supplyRaw) > max) refuse('bad-asset-args', `supply ${supplyRaw} is over max ${max}.`)
  const auth = args.auth === true || max != null || size != null
  const fields: HctDeployFields = {
    mode: 'open',
    kind,
    iss: [identityKey.toLowerCase()],
    m: 1,
    ...(auth ? { auth: true } : {}),
    ...(max != null ? { max } : {}),
    ...(size != null ? { size } : {}),
    ...(sym ? { sym } : {}),
    ...(name ? { name } : {}),
    ...(dec != null ? { dec } : {}),
    ...(icon ? { icon } : {}),
    ...(content ? { ctype: content.mediaType, c: content.bytes } : {}),
    ...(collection ? { col: collection } : {}),
  }
  try {
    encodeHctPayload(fields)
  } catch (err) {
    refuse('bad-asset-args', err instanceof Error ? err.message : String(err))
  }
  return { fields, supply: BigInt(supplyRaw) }
}

/**
 * Outputs that hand an authority (and a deploy's units) spent by this wallet
 * back to it. A capped authority states `issued`: the row's count plus what
 * this transaction issues.
 */
function carryBack(active: ActiveWallet, row: HctRow, deploy: HctDeploy, prefix: string, issued: HctIssued | undefined = row.issued): PlannedOutput[] {
  const out: PlannedOutput[] = []
  if (row.read.form !== 'authority' && row.amount > 0n) {
    const { holder, remittance } = freshHolder(active, selfOf(active), prefix)
    out.push({
      lockingScript: hctHeldLock({ assetId: row.assetId, amount: row.amount, clause: { mode: 'open', holder } }).toHex(),
      satoshis: 1,
      outputDescription: 'HCT units back to the holder',
      basket: hctFilingOf(deploy.fields.kind),
      tags: rowTags(row.assetId, deploy, 'held', row.amount),
      customInstructions: rowInstructions(row.assetId, deploy.fields, 'held', row.amount, remittance),
    })
  }
  if (row.authority) {
    const { holder, remittance } = freshHolder(active, selfOf(active), prefix)
    out.push({
      lockingScript: hctAuthorityLock({ assetId: row.assetId, clause: { mode: 'open', holder }, ...(issued ? { issued } : {}) }).toHex(),
      satoshis: 1,
      outputDescription: 'HCT authority',
      basket: hctFilingOf(deploy.fields.kind),
      tags: rowTags(row.assetId, deploy, 'authority', 0n),
      customInstructions: rowInstructions(row.assetId, deploy.fields, 'authority', 0n, remittance),
    })
  }
  return out
}

/**
 * Deploy an open BRC-255 token or item. This identity is the issuer: an
 * issuer coin signed ALL|FORKID proves it (§3). Output 0 is the deploy, held
 * by this wallet in `p2pft` (token) or `p2pnft` (item). An item in a
 * collection spends that collection's authority and gets it back.
 */
export async function issueHctAsset(args: IssueHctArgs, opts: HctWalletOptions = {}): Promise<IssueHctResult> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const chart = createActor(hctMachine).start()
    chart.send({ type: 'ISSUE' })
    try {
      const parsed = hctIssueFields(args, active.identityKey)
      const supply = parsed.supply
      const fields: HctDeployFields = opts.backing?.bk ? { ...parsed.fields, bk: opts.backing.bk } : parsed.fields
      if (fields.bk) {
        try {
          encodeHctPayload(fields)
        } catch (err) {
          refuse('bad-asset-args', err instanceof Error ? err.message : String(err))
        }
      }
      const root = rootOf(active)
      const issuerKey = hctIssuerPrivateKey(root)
      const prefix = freshDerivationString()
      const first = freshHolder(active, selfOf(active), prefix)
      const basket = hctFilingOf(fields.kind)
      const inputs: Array<{ outpoint: string; description: string; key: PrivateKey; scope: number }> = []
      const outputs: PlannedOutput[] = [
        {
          lockingScript: hctDeployLock({ supply, payload: encodeHctPayload(fields), clause: { mode: 'open', holder: first.holder } }).toHex(),
          satoshis: 1,
          outputDescription: `HCT ${fields.kind} deploy`,
          basket,
          tags: rowTags('deploy', { fields }, 'deploy', supply),
          customInstructions: rowInstructions(null, fields, 'deploy', supply, first.remittance),
        },
      ]
      let collection: { row: HctRow; deploy: HctDeploy } | null = null
      if (fields.col) {
        const authority = (await heldRows(active, HCT_TOKEN_BASKET, fields.col)).find((r) => r.authority)
        const deploy = authority ? await deployOf(active, fields.col) : null
        if (!authority || !deploy) refuse('not-held', 'This wallet holds no authority of that collection.')
        if (deploy.fields.mode !== 'open') refuse('unsupported-mode', 'The collection is not an open HCT asset.')
        if (deploy.fields.size != null && authority.issued && authority.issued.members >= deploy.fields.size) {
          refuse('over-cap', `The collection is full: all ${deploy.fields.size} of its items are deployed.`)
        }
        collection = { row: authority, deploy }
        inputs.push({ outpoint: authority.outpoint, description: 'HCT collection authority', key: hctHolderPrivateKey(root, authority.remittance), scope: HCT_HOLDER_SCOPE })
        const issued = authority.issued ? { units: authority.issued.units, members: authority.issued.members + 1n } : undefined
        outputs.push(...carryBack(active, authority, deploy, prefix, issued))
      }
      if (fields.bk) {
        outputs.push({ lockingScript: hctBackingScript(opts.backing!.deposit, null), satoshis: 0, outputDescription: 'HCT backing deposit' })
      }
      const issuerPub = issuerKey.toPublicKey().toString()
      inputs.unshift({ outpoint: await issuerCoin(active, issuerPub), description: 'HCT issuer signature', key: issuerKey, scope: HCT_ISSUER_SCOPE })
      // The next deploy's issuer coin rides this one; the issuer key is public by design (§3).
      outputs.push({ lockingScript: p2pkLock(issuerPub).toHex(), satoshis: 1, outputDescription: 'HCT issuer coin', basket: ISSUER_BASKET, tags: ['hct-issuer'] })
      chart.send({ type: 'BUILT' })
      const label = fields.kind === 'item' ? fields.name! : `${supply} ${fields.sym}`
      let deploy: HctDeploy | null = null
      const signed = await signHctAction(active, {
        description: `Issue ${label} (HCT)`,
        labels: [LABEL, 'hct-issue', ...(opts.labels ?? [])],
        inputs,
        outputs,
        check: (tx) => {
          const read = readHctDeploy(tx, 0)
          if (!read.ok) return `${read.reason}: ${read.detail}`
          if (collection) {
            if (!read.deploy.member) return 'the item does not spend its collection authority'
            const carried = checkHctTx(tx, collection.deploy)
            if (!carried.ok) return `${carried.reason}: ${carried.detail}`
          }
          deploy = read.deploy
          return null
        },
      })
      const issued = deploy as HctDeploy | null
      if (!issued) throw new Error('The signed deploy does not read back')
      chart.send({ type: 'SIGNED', txid: signed.txid })
      await putHctDeployRecord({ assetId: issued.assetId, txid: signed.txid, vout: 0 })
      deployCache.set(issued.assetId, issued)
      await commitSigned(signed, [issued.assetId, ...(collection ? [collection.row.assetId] : [])], true)
      chart.send({ type: 'BROADCASTED' })
      chart.send({ type: 'DELIVERED' })
      recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: 'event', sats: 0, method: 'hct-issue', note: `Issued ${label} (HCT ${fields.kind})`, txid: signed.txid })
      scheduleHistoryBackupPush('hct')
      log('issue', startedAt)
      return { assetId: issued.assetId, txid: signed.txid, kind: fields.kind, supply: supply.toString(), basket }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

// ── Mint ───────────────────────────────────────────────────────────────────

/**
 * Move a proven backed deploy's units and its authority into separate
 * outputs, issuing nothing. A mint that spent the deploy would rewrite those
 * proven units into outputs that wait on the new deposit's proof.
 */
async function splitBackedDeploy(active: ActiveWallet, row: HctRow, deploy: HctDeploy): Promise<HctRow> {
  const signed = await signHctAction(active, {
    description: `Split ${deploy.fields.sym ?? 'units'} deploy (HCT)`,
    labels: [LABEL, 'hct-split'],
    inputs: [{ outpoint: row.outpoint, description: 'HCT deploy', key: hctHolderPrivateKey(rootOf(active), row.remittance), scope: HCT_HOLDER_SCOPE }],
    outputs: carryBack(active, row, deploy, freshDerivationString()),
    check: (tx) => {
      const check = checkHctTx(tx, deploy)
      if (!check.ok) return `${check.reason}: ${check.detail}`
      if (check.minted !== 0n) return `it issues ${check.minted} units`
      return null
    },
  })
  await commitSigned(signed, [deploy.assetId], true)
  const authority = (await heldRows(active, HCT_TOKEN_BASKET, deploy.assetId)).find((r) => r.authority && r.txid === signed.txid)
  if (!authority) throw new Error('The split deploy left no authority')
  return authority
}

export type MintHctResult = { assetId: string; txid: string; amount: string; issued?: { units: string; members: string } }

/**
 * Mint units of an open HCT token whose authority this wallet holds (§5).
 * The new units and the authority come back to this wallet; a capped
 * token's authority states the new total, and the cap is never passed.
 */
export async function mintHctAsset(args: { assetId?: unknown; amount?: unknown }, opts: HctWalletOptions = {}): Promise<MintHctResult> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const chart = createActor(hctMachine).start()
    chart.send({ type: 'MINT' })
    try {
      const assetId = String(args.assetId ?? '').trim().toLowerCase()
      if (!isHctAssetId(assetId)) refuse('bad-asset-args', 'assetId is a 40-hex HCT asset id.')
      const amountRaw = String(args.amount ?? '').trim()
      if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n || BigInt(amountRaw) > HCT_MAX_AMOUNT) {
        refuse('bad-asset-args', 'amount is a whole number of units, at least 1.')
      }
      const amount = BigInt(amountRaw)
      const deploy = await deployOf(active, assetId)
      if (!deploy) refuse('not-held', 'This wallet does not know that asset.')
      if (deploy.fields.mode !== 'open') refuse('unsupported-mode', 'This wallet mints open HCT assets only.')
      const policy = hctSupplyPolicy(deploy.fields)
      if (policy.kind === 'fixed') refuse('fixed-supply', 'This asset has a fixed supply; nothing more can be minted.')
      let authority = (await heldRows(active, HCT_TOKEN_BASKET, assetId)).find((r) => r.authority)
      if (!authority) refuse('not-held', "This wallet does not hold the asset's mint authority.")
      if (deploy.fields.bk) {
        if (!opts.backing) refuse('bad-asset-args', 'A backed token mints only against a deposit.')
        if (authority.amount > 0n) {
          // Spending the deploy moves its units; they wait for the first deposit's proof.
          if (authority.locked) refuse('awaiting-backing', 'The first deposit has no burial proof yet; this mint waits for it.')
          authority = await splitBackedDeploy(active, authority, deploy)
        }
      } else if (opts.backing) {
        refuse('bad-asset-args', 'Only a backed token mints against a deposit.')
      }
      let issued: HctIssued | undefined
      if (policy.kind === 'capped') {
        if (!authority.issued) refuse('invalid-build', 'The authority carries no issued count.')
        issued = { units: authority.issued.units + amount, members: authority.issued.members }
        if (policy.max != null && issued.units > policy.max) {
          refuse('over-cap', `At most ${policy.max - authority.issued.units} more can be minted; the cap is ${policy.max}.`)
        }
      }
      const root = rootOf(active)
      const prefix = freshDerivationString()
      const minted = freshHolder(active, selfOf(active), prefix)
      const basket = hctFilingOf(deploy.fields.kind)
      const outputs: PlannedOutput[] = [
        {
          lockingScript: hctHeldLock({ assetId, amount, clause: { mode: 'open', holder: minted.holder } }).toHex(),
          satoshis: 1,
          outputDescription: 'HCT minted units',
          basket,
          tags: rowTags(assetId, deploy, 'held', amount),
          customInstructions: rowInstructions(assetId, deploy.fields, 'held', amount, minted.remittance),
        },
        ...carryBack(active, authority, deploy, prefix, issued),
        ...(opts.backing ? [{ lockingScript: hctBackingScript(opts.backing.deposit, assetId), satoshis: 0, outputDescription: 'HCT backing deposit' }] : []),
      ]
      chart.send({ type: 'BUILT' })
      const label = `${amount} ${deploy.fields.sym ?? 'units'}`
      const signed = await signHctAction(active, {
        description: `Mint ${label} (HCT)`,
        labels: [LABEL, 'hct-mint', ...(opts.labels ?? [])],
        inputs: [{ outpoint: authority.outpoint, description: 'HCT mint authority', key: hctHolderPrivateKey(root, authority.remittance), scope: HCT_HOLDER_SCOPE }],
        outputs,
        check: (tx) => {
          const check = checkHctTx(tx, deploy)
          if (!check.ok) return `${check.reason}: ${check.detail}`
          const written = check.outputs.reduce((sum, o) => sum + o.amount, 0n)
          if (written !== authority.amount + amount) return `it writes ${written} units, not ${authority.amount + amount}`
          if (!check.outputs.some((o) => o.authority)) return 'the authority is not handed back'
          return null
        },
      })
      chart.send({ type: 'SIGNED', txid: signed.txid })
      await commitSigned(signed, [assetId], true)
      chart.send({ type: 'BROADCASTED' })
      chart.send({ type: 'DELIVERED' })
      recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: 'event', sats: 0, method: 'hct-mint', note: `Minted ${label} (HCT)`, txid: signed.txid })
      scheduleHistoryBackupPush('hct')
      log('mint', startedAt)
      return {
        assetId,
        txid: signed.txid,
        amount: amount.toString(),
        ...(issued ? { issued: { units: issued.units.toString(), members: issued.members.toString() } } : {}),
      }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

// ── Transfer ───────────────────────────────────────────────────────────────

export type TransferHctResult = { assetId: string; txid: string; amount: string; recipient: string; delivered: boolean }

function pickRows(rows: HctRow[], amount: bigint): HctRow[] | null {
  const chosen: HctRow[] = []
  let sum = 0n
  for (const row of [...rows].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))) {
    if (sum >= amount) break
    if (row.read.form === 'authority' || row.locked) continue
    chosen.push(row)
    sum += row.amount
  }
  return sum >= amount && chosen.length <= MAX_INPUTS ? chosen : null
}

/**
 * Send units of an open HCT asset to an identity. The holder signs each input
 * ALL|ANYONECANPAY|FORKID; the recipient's output is locked to a fresh
 * `[2, "hct holder"]` key it derives from the remittance in the package,
 * which goes to its box (and the durable outbox until it lands).
 */
export async function transferHctAsset(args: { assetId?: unknown; recipient?: unknown; amount?: unknown }): Promise<TransferHctResult> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const chart = createActor(hctMachine).start()
    chart.send({ type: 'TRANSFER' })
    try {
      const assetId = String(args.assetId ?? '').trim().toLowerCase()
      if (!isHctAssetId(assetId)) refuse('bad-asset-args', 'assetId is a 40-hex HCT asset id.')
      const recipient = String(args.recipient ?? '').trim().toLowerCase()
      if (!KEY_RE.test(recipient)) refuse('bad-asset-args', 'recipient is an identity key.')
      const deploy = await deployOf(active, assetId)
      if (!deploy) refuse('not-held', 'This wallet does not know that asset.')
      if (deploy.fields.mode !== 'open') refuse('unsupported-mode', 'Countersigned assets move through transferCountersignedAsset.')
      const amountRaw = deploy.fields.kind === 'item' ? String(args.amount ?? '1') : String(args.amount ?? '').trim()
      if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n || BigInt(amountRaw) > HCT_MAX_AMOUNT) {
        refuse('bad-asset-args', 'amount is a whole number of units, at least 1.')
      }
      const amount = BigInt(amountRaw)
      if (deploy.fields.kind === 'item' && amount !== 1n) refuse('bad-asset-args', 'An item moves whole: amount is 1.')
      const basket = hctFilingOf(deploy.fields.kind)
      const rows = await heldRows(active, basket, assetId)
      const chosen = pickRows(rows, amount)
      if (!chosen) refuse('insufficient', `This wallet holds less than ${amount} of that asset in at most ${MAX_INPUTS} outputs.`)
      const total = chosen.reduce((sum, r) => sum + r.amount, 0n)
      const self = selfOf(active)
      const root = rootOf(active)
      const prefix = freshDerivationString()
      const pay = freshHolder(active, recipient, prefix)
      const toSelf = recipient === self
      const outputs: PlannedOutput[] = [
        {
          lockingScript: hctHeldLock({ assetId, amount, clause: { mode: 'open', holder: pay.holder } }).toHex(),
          satoshis: 1,
          outputDescription: 'HCT units',
          ...(toSelf
            ? { basket, tags: rowTags(assetId, deploy, 'held', amount), customInstructions: rowInstructions(assetId, deploy.fields, 'held', amount, pay.remittance) }
            : {}),
        },
      ]
      if (total > amount) {
        const change = freshHolder(active, self, prefix)
        outputs.push({
          lockingScript: hctHeldLock({ assetId, amount: total - amount, clause: { mode: 'open', holder: change.holder } }).toHex(),
          satoshis: 1,
          outputDescription: 'HCT change',
          basket,
          tags: rowTags(assetId, deploy, 'held', total - amount),
          customInstructions: rowInstructions(assetId, deploy.fields, 'held', total - amount, change.remittance),
        })
      }
      for (const row of chosen.filter((r) => r.authority)) {
        outputs.push(...carryBack(active, { ...row, amount: 0n, read: { form: 'authority', assetId, clause: row.read.clause } }, deploy, prefix, row.issued))
      }
      chart.send({ type: 'BUILT' })
      const label = deploy.fields.kind === 'item' ? deploy.fields.name ?? 'item' : `${amount} ${deploy.fields.sym ?? 'units'}`
      const signed = await signHctAction(active, {
        description: `Send ${label} (HCT)`,
        labels: [LABEL, 'hct-transfer'],
        inputs: chosen.map((row) => ({ outpoint: row.outpoint, description: 'HCT units', key: hctHolderPrivateKey(root, row.remittance), scope: HCT_HOLDER_SCOPE })),
        outputs,
        check: (tx) => {
          const check = checkHctTx(tx, deploy)
          if (!check.ok) return `${check.reason}: ${check.detail}`
          if (tx.outputs[0]?.lockingScript?.toHex() !== outputs[0]!.lockingScript) return 'the payment is not output 0'
          return null
        },
      })
      chart.send({ type: 'SIGNED', txid: signed.txid })
      await commitSigned(signed, [assetId], false)
      chart.send({ type: 'BROADCASTED' })
      let delivered = toSelf
      if (!toSelf) {
        const entry: HctOutboxEntry = {
          recipient,
          assetId,
          txid: signed.txid,
          outputs: [{ vout: 0, derivationPrefix: pay.remittance.derivationPrefix, derivationSuffix: pay.remittance.derivationSuffix }],
          at: Date.now(),
          attempts: 0,
          nextAt: Date.now(),
        }
        const state = readHctState()
        state.outbox[outboxId(recipient, signed.txid)] = entry
        writeHctState(state)
        delivered = await deliverEntry(active, entry)
      }
      chart.send({ type: delivered ? 'DELIVERED' : 'QUEUED' })
      recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: 'event', sats: 0, method: 'hct-transfer', note: `Sent ${label} (HCT)`, txid: signed.txid })
      scheduleHistoryBackupPush('hct')
      log('transfer', startedAt)
      return { assetId, txid: signed.txid, amount: amount.toString(), recipient, delivered }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

export type BurnHctResult = { assetId: string; txid: string; amount: string }

/**
 * Lock units of a token this wallet holds to `holder`, a key nobody can sign
 * for, so they can never move again (conservation forbids destroying units).
 * Wallet-internal: the wLTC bridge burns what it redeems. `memo` rides an
 * OP_RETURN output so the burn names what it paid for.
 */
export async function burnHctUnits(
  args: { assetId: string; amount: bigint; holder: string; memo: string },
  opts: HctWalletOptions = {},
): Promise<BurnHctResult> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const chart = createActor(hctMachine).start()
    chart.send({ type: 'BURN' })
    try {
      const assetId = args.assetId.trim().toLowerCase()
      if (!isHctAssetId(assetId)) refuse('bad-asset-args', 'assetId is a 40-hex HCT asset id.')
      if (!KEY_RE.test(args.holder)) refuse('bad-asset-args', 'The burn holder is a compressed public key.')
      if (args.amount <= 0n || args.amount > HCT_MAX_AMOUNT) refuse('bad-asset-args', 'amount is a whole number of units, at least 1.')
      const deploy = await deployOf(active, assetId)
      if (!deploy) refuse('not-held', 'This wallet does not know that asset.')
      if (deploy.fields.mode !== 'open' || deploy.fields.kind !== 'token') refuse('unsupported-mode', 'Only open HCT tokens are burned.')
      const rows = await heldRows(active, HCT_TOKEN_BASKET, assetId)
      const chosen = pickRows(rows, args.amount)
      if (!chosen) refuse('insufficient', `This wallet holds less than ${args.amount} of that asset in at most ${MAX_INPUTS} outputs.`)
      const total = chosen.reduce((sum, r) => sum + r.amount, 0n)
      const root = rootOf(active)
      const prefix = freshDerivationString()
      const memo = Utils.toArray(args.memo, 'utf8')
      if (memo.length === 0 || memo.length > 75) refuse('bad-asset-args', 'The burn memo is 1 to 75 bytes.')
      const outputs: PlannedOutput[] = [
        {
          lockingScript: hctHeldLock({ assetId, amount: args.amount, clause: { mode: 'open', holder: args.holder } }).toHex(),
          satoshis: 1,
          outputDescription: 'HCT burned units',
        },
        { lockingScript: `006a${Utils.toHex([memo.length])}${Utils.toHex(memo)}`, satoshis: 0, outputDescription: 'HCT burn memo' },
      ]
      if (total > args.amount) {
        const change = freshHolder(active, selfOf(active), prefix)
        outputs.push({
          lockingScript: hctHeldLock({ assetId, amount: total - args.amount, clause: { mode: 'open', holder: change.holder } }).toHex(),
          satoshis: 1,
          outputDescription: 'HCT change',
          basket: HCT_TOKEN_BASKET,
          tags: rowTags(assetId, deploy, 'held', total - args.amount),
          customInstructions: rowInstructions(assetId, deploy.fields, 'held', total - args.amount, change.remittance),
        })
      }
      chart.send({ type: 'BUILT' })
      const label = `${args.amount} ${deploy.fields.sym ?? 'units'}`
      const signed = await signHctAction(active, {
        description: `Burn ${label} (HCT)`,
        labels: [LABEL, 'hct-burn', ...(opts.labels ?? [])],
        inputs: chosen.map((row) => ({ outpoint: row.outpoint, description: 'HCT units', key: hctHolderPrivateKey(root, row.remittance), scope: HCT_HOLDER_SCOPE })),
        outputs,
        check: (tx) => {
          const check = checkHctTx(tx, deploy)
          if (!check.ok) return `${check.reason}: ${check.detail}`
          if (tx.outputs[0]?.lockingScript?.toHex() !== outputs[0]!.lockingScript) return 'the burn is not output 0'
          return null
        },
      })
      chart.send({ type: 'SIGNED', txid: signed.txid })
      await commitSigned(signed, [assetId], true)
      chart.send({ type: 'BROADCASTED' })
      chart.send({ type: 'DELIVERED' })
      recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: 'event', sats: 0, method: 'hct-burn', note: `Burned ${label} (HCT)`, txid: signed.txid })
      scheduleHistoryBackupPush('hct')
      log('burn', startedAt)
      return { assetId, txid: signed.txid, amount: args.amount.toString() }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

// ── Delivery ───────────────────────────────────────────────────────────────

async function packageFor(
  active: ActiveWallet,
  subject: Transaction,
  deploy: HctDeploy,
  holds: ReadonlySet<string>,
  budget: number,
): Promise<{ pkg: HctPackage; shipped: string[] } | null> {
  const ancestry = await hctAncestry(subject, deploy, (txid) => linkedTx(active, txid), (txid) => holds.has(txid))
  if (!ancestry.ok) {
    console.warn(`[hct] package ancestry ${ancestry.txid} — ${ancestry.detail}`)
    return null
  }
  const deployTx = holds.has(deploy.txid) ? null : await linkedTx(active, deploy.txid)
  const backing = deploy.fields.bk ? await backingFor([subject, ...ancestry.txs], [deploy.txid]) : new Map<string, HctBackingProof>()
  const { pkg } = buildHctPackage(subject, ancestry.txs, deployTx ? [deployTx] : [], budget, backing)
  const shipped = [pkg.subject, ...ancestry.txs.map(idOf).slice(0, pkg.txs.length - 1), ...(pkg.deploys.length ? [deploy.txid] : [])]
  return { pkg, shipped }
}

/** Send one outbox entry; true once the box took it. Failure reschedules, never voids the transfer. */
async function deliverEntry(active: ActiveWallet, entry: HctOutboxEntry): Promise<boolean> {
  const id = outboxId(entry.recipient, entry.txid)
  try {
    const subject = await linkedTx(active, entry.txid)
    const deploy = await deployOf(active, entry.assetId)
    if (!subject || !deploy) throw new Error('the transfer or its deploy is not available here')
    const beefBytes = await atomicBeefFor(active, subject).catch(() => [] as number[])
    const beef = beefBytes.length ? Utils.toBase64(beefBytes) : ''
    const withBeef = beef.length > 0 && beef.length <= HCT_PACKAGE_BUDGET / 2
    const holds = peerHolds(readHctState(), entry.recipient, entry.assetId)
    const built = await packageFor(active, subject, deploy, holds, HCT_PACKAGE_BUDGET - (withBeef ? beef.length : 0))
    if (!built) throw new Error('the package could not be built')
    const wire: Wire = {
      v: 1,
      t: 'transfer',
      asset: entry.assetId,
      deploy: `${deploy.txid}_${deploy.vout}`,
      senderIdentityKey: selfOf(active),
      outputs: entry.outputs,
      proof: built.pkg,
      ...(withBeef ? { beef } : {}),
    }
    const { sendSealedToPeerBox } = await import('../messageTransport')
    await sendSealedToPeerBox(active.rootKeyHex, entry.recipient, HCT_BOX, JSON.stringify(wire))
    const state = readHctState()
    delete state.outbox[id]
    notePeerHolds(state, entry.recipient, entry.assetId, built.shipped)
    writeHctState(state)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[hct] delivery to ${entry.recipient.slice(0, 12)}… queued — ${message}`)
    const state = readHctState()
    const current = state.outbox[id]
    if (current) {
      const attempts = current.attempts + 1
      state.outbox[id] = {
        ...current,
        attempts,
        lastError: message.slice(0, 200),
        nextAt: Date.now() + RETRY_STEPS_MS[Math.min(attempts - 1, RETRY_STEPS_MS.length - 1)]!,
      }
      writeHctState(state)
    }
    return false
  }
}

async function flushOutbox(active: ActiveWallet): Promise<void> {
  const now = Date.now()
  for (const entry of Object.values(readHctState().outbox)) {
    if (entry.nextAt <= now) await deliverEntry(active, entry)
  }
}

// ── Receive ────────────────────────────────────────────────────────────────

function parseWire(plaintext: string | null): Wire | null {
  if (!plaintext) return null
  try {
    const msg = JSON.parse(plaintext) as Wire
    return msg && msg.v === 1 && typeof msg.t === 'string' && isHctAssetId(msg.asset) ? msg : null
  } catch {
    return null
  }
}

function deliveryOutputs(value: unknown): HctDeliveryOutput[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DELIVERY_OUTPUTS) return null
  const seen = new Set<number>()
  const out: HctDeliveryOutput[] = []
  for (const raw of value) {
    const o = raw as Partial<HctDeliveryOutput>
    if (!Number.isInteger(o.vout) || o.vout! < 0 || seen.has(o.vout!)) return null
    if (typeof o.derivationPrefix !== 'string' || typeof o.derivationSuffix !== 'string') return null
    seen.add(o.vout!)
    out.push({ vout: o.vout!, derivationPrefix: o.derivationPrefix, derivationSuffix: o.derivationSuffix })
  }
  return out
}

const needAskedAt = new Map<string, number>()
const needOpenAt = new Map<string, number>()
const needServedAt = new Map<string, number>()

async function askFor(active: ActiveWallet, peer: string, wire: Extract<Wire, { t: 'transfer' }>, txid: string): Promise<void> {
  const key = `${peer}:${txid}`
  if (Date.now() - (needAskedAt.get(key) ?? 0) < NEED_RESEND_MS) return
  needAskedAt.set(key, Date.now())
  needOpenAt.set(wire.asset, Date.now())
  const { sendSealedToPeerBox } = await import('../messageTransport')
  const need: Wire = { v: 1, t: 'need', asset: wire.asset, deploy: wire.deploy, txid }
  await sendSealedToPeerBox(active.rootKeyHex, peer, HCT_BOX, JSON.stringify(need)).catch(() => {})
}

/**
 * File the outputs of a delivered transfer that pay this wallet (§8): the
 * sender must be the box sender, each named output must read as this asset
 * locked to the holder key its remittance derives, and the walk must reach
 * the deploy. A deploy is never credited by a transfer, and a countersigned
 * asset is left in the box until this wallet can file it.
 */
async function ingestTransfer(active: ActiveWallet, sender: string, wire: Extract<Wire, { t: 'transfer' }>): Promise<'filed' | 'invalid' | 'retry'> {
  const startedAt = Date.now()
  const from = sender.trim().toLowerCase()
  if (!KEY_RE.test(from) || String(wire.senderIdentityKey ?? '').toLowerCase() !== from) return 'invalid'
  const outputs = deliveryOutputs(wire.outputs)
  const pkg = readHctPackage(wire.proof)
  const at = parseOutpoint(wire.deploy)
  if (!outputs || !pkg || !at || hctAssetId(at.txid, at.vout) !== wire.asset) return 'invalid'
  const subject = pkg.subject
  const txid = idOf(subject)
  if (txid === at.txid) return 'invalid'
  const root = rootOf(active)
  const mine: Array<{ vout: number; read: Extract<HctOutput, { form: 'held' | 'authority' }>; remittance: HctRemittance }> = []
  for (const o of outputs) {
    const remittance = readHctRemittance({ ...o, senderIdentityKey: from })
    const script = subject.outputs[o.vout]?.lockingScript
    const read = script ? readHct(script) : null
    if (!remittance || !read || read.form === 'deploy' || read.assetId !== wire.asset) return 'invalid'
    if (hctHolderPrivateKey(root, remittance).toPublicKey().toString() !== read.clause.holder) return 'invalid'
    if (read.clause.mode !== 'open') return 'retry'
    mine.push({ vout: o.vout, read, remittance })
  }
  const deploy = await deployOf(active, wire.asset, at, pkg.deploys.get(at.txid))
  if (!deploy) {
    if ((await getHctDeployRecord(wire.asset)) && !deployCache.has(wire.asset)) return 'invalid'
    await askFor(active, from, wire, at.txid)
    return 'retry'
  }
  if (deploy.fields.mode !== 'open') return 'retry'
  const basket = hctFilingOf(deploy.fields.kind)
  const filed = await active.wallet.listOutputs({ basket, includeTags: true, limit: 10_000 })
  if ((filed.outputs ?? []).some((o) => o.outpoint.replace('_', '.').startsWith(`${txid}.`))) return 'filed'
  for (const tx of [...pkg.txs.values(), ...pkg.deploys.values()]) await putHctTx(tx).catch(() => {})
  const walk = await walkHct(
    txid,
    deploy,
    async (id) => {
      const tx = pkg.txs.get(id) ?? (await linkedTx(active, id))
      await isHctValidated(id, wire.asset)
      return tx
    },
    (id) => isHctValidatedSync(id, wire.asset),
    backingSource(pkg.backing),
  )
  if (!walk.ok) {
    console.warn(`[hct] transfer ${txid.slice(0, 12)}… ${walk.reason} at ${walk.txid.slice(0, 12)}… — ${walk.detail}`)
    if (walk.reason === 'invalid') return 'invalid'
    await askFor(active, from, wire, walk.txid)
    return 'retry'
  }
  let atomic = wire.beef ? atomicBeefForSubject(Utils.toArray(wire.beef, 'base64'), txid) : undefined
  atomic ??= await atomicBeefFor(active, subject).catch(() => undefined)
  if (!atomic?.length) return 'retry'
  try {
    rememberBeefTree(atomic, txid)
    const { withRestoredInternalizeStatus } = await import('../peerIngestHelpers')
    await withRestoredInternalizeStatus(txid, () =>
      active.wallet.internalizeAction({
        tx: atomic!,
        description: `Receive ${deploy.fields.sym ?? deploy.fields.name ?? 'asset'} (HCT)`.slice(0, 50),
        labels: [LABEL],
        outputs: mine.map((m) => {
          const form = m.read.form
          const amount = form === 'held' ? m.read.amount : 0n
          return {
            outputIndex: m.vout,
            protocol: 'basket insertion' as const,
            insertionRemittance: {
              basket,
              tags: rowTags(wire.asset, deploy, form, amount),
              customInstructions: rowInstructions(wire.asset, deploy.fields, form, amount, m.remittance),
            },
          }
        }),
      }),
    )
  } catch (err) {
    console.warn('[hct] transfer filing deferred', err instanceof Error ? err.message : String(err))
    return 'retry'
  }
  await markHctValidated(walk.validated, wire.asset)
  await keepBacked(walk.backed)
  const state = readHctState()
  notePeerHolds(state, from, wire.asset, [txid])
  writeHctState(state)
  const amount = mine.reduce((sum, m) => sum + (m.read.form === 'held' ? m.read.amount : 0n), 0n)
  recordAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'event',
    sats: 0,
    method: 'hct-receive',
    note: `Received ${deploy.fields.kind === 'item' ? deploy.fields.name ?? 'item' : `${amount} ${deploy.fields.sym ?? 'units'}`} (HCT)`,
    txid,
  })
  scheduleHistoryBackupPush('hct')
  log('receive', startedAt)
  return 'filed'
}

/** Answer a peer's `need` with the history behind `txid`, once per peer and txid per resend window. */
async function answerNeed(active: ActiveWallet, sender: string, wire: Extract<Wire, { t: 'need' }>): Promise<void> {
  if (!TXID_RE.test(String(wire.txid))) return
  const key = `${sender}:${wire.txid}`
  if (Date.now() - (needServedAt.get(key) ?? 0) < NEED_RESEND_MS) return
  needServedAt.set(key, Date.now())
  const at = parseOutpoint(wire.deploy)
  const deploy = at ? await deployOf(active, wire.asset, at) : null
  if (!deploy) return
  const subject = wire.txid === deploy.txid ? null : await getHctTx(wire.txid)
  const built = subject ? await packageFor(active, subject, deploy, new Set(), HCT_PACKAGE_BUDGET) : null
  const deployTx = built ? null : await linkedTx(active, deploy.txid)
  const deployBacking = deployTx && deploy.fields.bk ? await backingFor([], [deploy.txid]) : undefined
  const pkg = built?.pkg ?? (deployTx ? buildHctPackage(deployTx, [], [], HCT_PACKAGE_BUDGET, deployBacking).pkg : null)
  if (!pkg) return
  const { sendSealedToPeerBox } = await import('../messageTransport')
  const reply: Wire = { v: 1, t: 'history', asset: wire.asset, proof: pkg }
  await sendSealedToPeerBox(active.rootKeyHex, sender, HCT_BOX, JSON.stringify(reply)).catch(() => {})
}

/** Keep the transactions of a `history` reply this wallet asked for; validity is decided by the next walk. */
async function takeHistory(wire: Extract<Wire, { t: 'history' }>): Promise<void> {
  if (Date.now() - (needOpenAt.get(wire.asset) ?? 0) > NEED_OPEN_MS) return
  const pkg = readHctPackage(wire.proof)
  if (!pkg) return
  for (const tx of [...pkg.txs.values(), ...pkg.deploys.values()]) await putHctTx(tx).catch(() => {})
  for (const [txid, proof] of pkg.backing) suppliedBacking.set(txid, proof)
}

let boxPolledAt = 0
let serving = false

/**
 * Serve box `hct`: file delivered transfers, answer `need`, keep requested
 * history, and retry the outbox. A transfer is acknowledged only once filed
 * or proven invalid.
 */
export async function serveHctBox(opts?: { force?: boolean }): Promise<void> {
  const active = currentActive()
  if (!active || serving) return
  if (activeAccountSpendRefusal(active)) return
  const busy = Object.keys(readHctState().outbox).length > 0 || needOpenAt.size > 0
  const now = Date.now()
  if (!opts?.force && now - boxPolledAt < (busy ? BOX_ACTIVE_POLL_MS : BOX_IDLE_POLL_MS)) return
  boxPolledAt = now
  serving = true
  try {
    const { listSealedOwnBox, acknowledgeOwnBox } = await import('../messageTransport')
    const messages = await listSealedOwnBox(active.rootKeyHex, HCT_BOX)
    const acks: string[] = []
    for (const m of messages ?? []) {
      const wire = parseWire(m.plaintext)
      if (!wire) {
        if (m.messageId) acks.push(m.messageId)
        continue
      }
      try {
        if (wire.t === 'transfer') {
          const fate = await runExclusiveSpend(() => ingestTransfer(active, m.sender, wire), undefined, { promote: false })
          if (fate !== 'retry') acks.push(m.messageId)
        } else if (wire.t === 'need') {
          await answerNeed(active, m.sender.toLowerCase(), wire)
          acks.push(m.messageId)
        } else if (wire.t === 'history') {
          await takeHistory(wire)
          acks.push(m.messageId)
        } else {
          acks.push(m.messageId)
        }
      } catch (err) {
        console.warn(`[hct] box ${wire.t} failed`, err instanceof Error ? err.message : String(err))
      }
    }
    if (acks.length) await acknowledgeOwnBox(active.rootKeyHex, HCT_BOX, acks).catch(() => {})
    for (const [asset, at] of needOpenAt) if (Date.now() - at > NEED_OPEN_MS) needOpenAt.delete(asset)
    await flushOutbox(active).catch((err) => {
      console.warn('[hct] outbox deferred', err instanceof Error ? err.message : String(err))
    })
  } finally {
    serving = false
  }
}

/** Every deploy output a transaction carries, for callers that only hold its body. */
export function hctDeploysOf(tx: Transaction): HctDeploy[] {
  return readHctDeploys(tx)
}
