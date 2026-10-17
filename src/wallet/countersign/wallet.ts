import { Beef, Hash, KeyDeriver, LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { createActor } from 'xstate'
import { countersignMachine } from '../../machines/countersignMachine'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN } from '../appActivity'
import { atomicBeefForSubject, getBeefForTxidCached, getLocalBeefForTxid, rememberBeefTree } from '../beefCache'
import { scheduleHistoryBackupPush } from '../deviceSync'
import { COUNTERSIGNED_SCHEMES, countersignedSchemeFor, stampBrc164Id, type CountersignedScheme } from '../itemAccess'
import type { ActiveWallet } from '../session'
import type { TransactionFlow } from '../transactionTelemetry'
import { getWalletRuntime } from '../walletRuntime'
import { runExclusiveSpend } from '../spendGuard'
import { activeAccountSpendRefusal } from '../vaultAccountHolding'
import { normalizeTokenId } from '../token/types'
import { readDeliveryRemittance, type ColorRemittance } from '../colorKeys'
import {
  deliveryOutputsFor,
  deliveryOutputsFromEntries,
  holderKeyAsset,
  holderPkhFor,
  holderPrivateKey,
  holderRemittanceOf,
  planHolderRemittance,
  provenRecipientPkh,
  readRecipientEntries,
  recipientEntries,
  type DeliveryOutput,
  type HolderRemittance,
  type RecipientEntry,
} from './holderKeys'
import {
  ACCEPT_REFUSAL_COPY,
  chooseCosignerQuorum,
  chooseCountersignSwapPath,
  chooseCountersignTransferPath,
  chooseReleaseCustody,
  isQuorum,
  type CountersignSwapPath,
  type ReleaseCustody,
  CountersignError,
  type CountersignRefuse,
} from './path'
import { beaconPhase, readBeaconChain, type CountersignPhase } from './beacon'
import { whatsOnChainBeaconSource } from './beaconSource'
import { encodeCountersignPayload, MIN_SILENCE_SECONDS, type CountersignDeployFields } from './payload'
import {
  assetOfInput,
  blockingPriorSpends,
  checkAcceptRequest,
  plainInputsOf,
  readCountersignDeploy,
  resolveCountersignTransfer,
  type AcceptCheck,
  type AcceptRefusal,
  type CountersignDeploy,
  type PriorSpend,
} from './resolve'
import {
  beaconLock,
  beaconUnlock,
  contentLock,
  COUNTERSIGN_SCOPE,
  countersignatureValid,
  countersignDeployLock,
  countersignedLock,
  countersignedUnlock,
  disclosedReleaseKeys,
  HOLDER_SCOPE,
  holderUnlock,
  inputScriptValid,
  pubkeyHashHex,
  readCountersigned,
  holderScopeOf,
  quorumSignatures,
  readHolderUnlock,
  releaseDisclosureLock,
  requestIdOf,
  retireMarkerLock,
  signInput,
  sourceOutputOf,
  sourceTxidOf,
  SWAP_HOLDER_SCOPE,
  unlockBranch,
  type CountersignBranch,
  type CountersignKeySets,
  type KeySet,
} from './script'
import {
  deployMap,
  readCountersignState,
  toStoredDeploy,
  writeCountersignState,
  type AcceptorRecord,
  type BeaconProposal,
  type CountersignState,
  type OutgoingRequest,
  type SignedRefusal,
  type StoredDeploy,
} from './store'

/** Store-and-forward box for requests, decisions and deliveries. */
export const COUNTERSIGN_BOX = 'countersign'
const BEACON_BASKET = 'countersign-beacon'
/** Root-key P2PKH fee inputs: the toolbox tracks them but never funds with them. */
const FEE_BASKET = 'countersign-fee'
const FEE_COIN_SATS = 200
const FEE_COIN_BATCH = 4
const FEE_SATS_PER_KB = 100
const DEFAULT_SILENCE_SECONDS = 30 * 24 * 60 * 60
const REMOTE_ACCEPT_WAIT_MS = 45_000
const REMOTE_POLL_MS = 1_500
/** Open quorum requests and pending quorum cancels are re-sent to silent cosigners this often. */
const QUORUM_RESEND_MS = 5 * 60_000
/** A beacon proposal short of a quorum is sent again to the cosigners missing from it this often. */
const BEACON_PROPOSAL_RESEND_MS = 10 * 60_000/** An unanswered request holds its inputs back from new transfers this long; the acceptor still refuses a second spend. */
const OPEN_REQUEST_RESERVE_MS = 15 * 60_000
const BOX_ACTIVE_POLL_MS = 5_000
const BOX_IDLE_POLL_MS = 20_000
const MAX_CONTENT_BYTES = 1024 * 1024
const MAX_ICON_BYTES = 96 * 1024
const DECISION_PROTOCOL: [2, string] = [2, 'countersign decision']
const RELEASE_PROTOCOL: [2, string] = [2, 'countersign release']
/** A release-branch transfer is final only once mined; ask the chain at most this often per txid. */
const MINED_CHECK_MS = 60_000
const LABEL = 'countersign'
/** Tag on an output a market listing holds. */
export const MARKET_HELD_TAG = 'market-held'

type Wire =
  | {
      v: 1
      t: 'request'
      token: string
      ef: string
      /** Who holds each listed output, each proven by a linkage encrypted to the addressed acceptor. */
      recipients: RecipientEntry[]
      /** Ancestors of the request, so a cosigner can prove each input was accepted. */
      beef?: string
      /** A trade the requester funded and broadcasts: the answer is `cosigned`, never a transaction. */
      funding?: 'sender'
    }
  | { v: 1; t: 'accepted'; token: string; request: string; ef: string; beef?: string }
  /** A cosigner's countersignature per asset input (quorum path). */
  | { v: 1; t: 'cosigned'; token: string; request: string; signatures: string[] }
  | { v: 1; t: 'refused'; token: string; request: string; reason: AcceptRefusal; signature: string }
  /** A quorum cancel carries signed refusals proving no quorum can sign the request. */
  | { v: 1; t: 'cancel'; token: string; request: string; refusals?: Record<string, SignedRefusal> }
  | { v: 1; t: 'cancelled'; token: string; request: string; signature: string }
  | {
      v: 1
      t: 'transfer'
      token: string
      ef: string
      /** Remittance for the recipient's outputs: it derives each holder key from these. */
      senderIdentityKey?: string
      outputs?: DeliveryOutput[]
      beef?: string
      deploy?: string
    }
  /** The issuer names this wallet as a cosigner; nothing happens until its user joins. */
  | { v: 1; t: 'join'; token: string; deploy: string }
  /** A cosigner proposes the next beacon; input 0 (the beacon) is unsigned. */
  | { v: 1; t: 'beacon-sign'; token: string; ef: string }
  | { v: 1; t: 'beacon-signed'; token: string; proposal: string; signature: string }

type Decision =
  | { kind: 'accepted'; tx: Transaction; efHex: string; atomic?: number[] }
  /** A cosigner's countersignature per asset input; the holder assembles the quorum. */
  | { kind: 'cosigned'; signatures: number[][] }
  | { kind: 'refused'; reason: AcceptRefusal; detail?: string; signed?: SignedRefusal }
  | { kind: 'silent' }

export type CountersignHolding = {
  outpoint: string
  assetId: string
  amount: bigint
  lockingScript: string
  /** The `p color` remittance of the holder key; absent for an identity-key holding. */
  remittance?: ColorRemittance
  /** Held by a market listing (only returned with `includeListed`). */
  listed?: true
}

type HolderRequest = { tx: Transaction; recipients: RecipientEntry[]; requestId: string; prover: string }

function currentActive(): ActiveWallet | null {
  return getWalletRuntime()?.instance ?? null
}

function requireActive(): ActiveWallet {
  const active = currentActive()
  if (!active) throw new Error('Wallet locked')
  return active
}

function rootKeyOf(active: ActiveWallet): PrivateKey {
  return PrivateKey.fromHex(active.rootKeyHex)
}

function selfPkh(active: ActiveWallet): string {
  return pubkeyHashHex(active.identityKey.toLowerCase())
}

/** The key that signs as holder of one output. */
function holderKeyOf(active: ActiveWallet, holding: Pick<CountersignHolding, 'assetId' | 'outpoint' | 'remittance'>): PrivateKey {
  const root = rootKeyOf(active)
  return holding.remittance
    ? holderPrivateKey(root, holderKeyAsset(holding.assetId, holding.outpoint), holding.remittance)
    : root
}

/** Holder hashes of one transfer that this wallet keeps, with the remittance each is filed with. */
function heldHashes(active: ActiveWallet, tx: Transaction, remittances: ReadonlyMap<number, ColorRemittance>): Map<string, ColorRemittance | null> {
  const held = new Map<string, ColorRemittance | null>([[selfPkh(active), null]])
  const root = rootKeyOf(active)
  for (const [vout, remittance] of remittances) {
    const script = tx.outputs[vout]?.lockingScript
    const read = script ? readCountersigned(script) : null
    if (!read?.assetId) continue
    try {
      const key = holderPrivateKey(root, read.assetId, remittance)
      const pkh = Utils.toHex(Hash.hash160(key.toPublicKey().encode(true) as number[]))
      if (pkh === read.holderPkhHex) held.set(pkh, remittance)
    } catch {
      // A malformed row derives nothing; the output stays unclaimed.
    }
  }
  return held
}

/** The remittance rows of the outputs this wallet keeps from its own transfer. */
function ownRemittances(active: ActiveWallet, remittance: HolderRemittance | undefined): Map<number, ColorRemittance> {
  const self = active.identityKey.toLowerCase()
  return new Map(
    (remittance?.outputs ?? [])
      .filter((o) => o.identityKey === self)
      .map((o) => [o.vout, { derivationPrefix: remittance!.prefix, derivationSuffix: o.derivationSuffix, senderIdentityKey: self }]),
  )
}

/**
 * The holder hash each request entry proves, read with this acceptor's key.
 * An entry whose linkage does not decrypt refuses the request.
 */
function provenRecipients(
  active: ActiveWallet,
  request: HolderRequest,
): { ok: true; recipients: Array<{ vout: number; holderPkhHex: string }> } | { ok: false; detail: string } {
  const root = rootKeyOf(active)
  const recipients: Array<{ vout: number; holderPkhHex: string }> = []
  for (const entry of request.recipients) {
    const script = request.tx.outputs[entry.vout]?.lockingScript
    const assetId = script ? readCountersigned(script)?.assetId : null
    if (!assetId) return { ok: false, detail: `recipient ${entry.vout} names no asset output` }
    const holderPkhHex = provenRecipientPkh(root, request.prover, assetId, entry)
    if (!holderPkhHex) return { ok: false, detail: `recipient ${entry.vout} linkage does not open` }
    recipients.push({ vout: entry.vout, holderPkhHex })
  }
  return { ok: true, recipients }
}

function underscore(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace('.', '_')
}

function refuse(code: CountersignRefuse, message: string, acceptorReason?: AcceptRefusal): never {
  console.warn(`[countersign] refuse ${code}${acceptorReason ? ` ${acceptorReason}` : ''}`)
  throw new CountersignError(code, message, acceptorReason)
}

function log(phase: string, startedAt: number): void {
  const ms = Date.now() - startedAt
  if (ms >= 250) console.info(`[countersign] ${phase} done ${ms}ms`)
}

/** This wallet's release (custodian) key: one self-derived child of the root. */
function ownReleaseKey(active: ActiveWallet): PrivateKey {
  return new KeyDeriver(rootKeyOf(active)).derivePrivateKey(RELEASE_PROTOCOL, '1', 'self')
}

/** A 1-of-1 release set on this wallet's own release key (`release: 'self'`). */
function defaultRelease(active: ActiveWallet): KeySet {
  return { threshold: 1, keys: [ownReleaseKey(active).toPublicKey().toString()] }
}

function releaseCustodyOf(active: ActiveWallet, release: unknown): ReleaseCustody {
  const ownRelease = defaultRelease(active)
  return chooseReleaseCustody({ release, issuerHeld: [active.identityKey, ...ownRelease.keys], ownRelease })
}

/** An issue's cosigner or release refusal, checked before the approval prompt; null when it may proceed. */
export function issueRefusal(args: IssueCountersignedArgs): { reason: CountersignRefuse; message: string } | null {
  const active = requireActive()
  const quorum = chooseCosignerQuorum({ cosigners: args.cosigners, identityKey: active.identityKey })
  if (quorum.quorum === 'refuse') return { reason: quorum.reason, message: quorum.message }
  const custody = releaseCustodyOf(active, args.release)
  return custody.custody === 'refuse' ? { reason: custody.reason, message: custody.message } : null
}

/** The release keys this wallet can sign with, when they meet the threshold. */
function releaseKeysHeld(active: ActiveWallet, release: KeySet): PrivateKey[] | null {
  return disclosedReleaseKeys([ownReleaseKey(active).toHex()], release)
}

/**
 * An issuer whose last refresh is older than the silence period has lapsed,
 * whatever it broadcasts next. A shared quorum may refresh without this
 * cosigner, so its lapse is read from the beacon chain (`refreshPhase`).
 */
function endedReason(record: AcceptorRecord, deploy: StoredDeploy | undefined): AcceptorRecord['ended'] {
  if (record.ended || record.shared) return record.ended
  if (deploy && Date.now() - record.beaconAt > deploy.fields.sil * 1000) return 'lapsed'
  return undefined
}

function decisionPreimage(t: string, token: string, request: string, reason = ''): number[] {
  return Utils.toArray(`countersign\nv1\n${t}\n${token}\n${request}\n${reason}`, 'utf8')
}

async function signDecision(active: ActiveWallet, preimage: number[]): Promise<string> {
  const { signature } = await new ProtoWallet(rootKeyOf(active)).createSignature({
    data: preimage,
    protocolID: DECISION_PROTOCOL,
    keyID: '1',
    counterparty: 'anyone',
  })
  return Utils.toHex(signature)
}

async function decisionSignedBy(acceptor: string, preimage: number[], signatureHex: string): Promise<boolean> {
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: preimage,
      signature: Utils.toArray(signatureHex, 'hex'),
      protocolID: DECISION_PROTOCOL,
      keyID: '1',
      counterparty: acceptor,
    })
    return valid
  } catch {
    return false
  }
}

// ── Deploy bodies ──────────────────────────────────────────────────────────

async function fullTx(active: ActiveWallet, txid: string, state?: CountersignState): Promise<Transaction | null> {
  const local = await getLocalBeefForTxid(active, txid)
  const fromLocal = local?.findTxid(txid)?.tx
  if (fromLocal) return fromLocal
  for (const record of Object.values(state?.acceptor ?? {})) {
    const hit = Object.values(record.requests).find((r) => r.txid === txid)
    if (hit) return Transaction.fromEF(Utils.toArray(hit.efHex, 'hex'))
    if (record.beacon.startsWith(txid) && record.beaconTxHex) return Transaction.fromHex(record.beaconTxHex)
  }
  try {
    const beef = await getBeefForTxidCached(active, txid, { needProof: false, allowUnprovenRawTx: true })
    return beef.findTxid(txid)?.tx ?? null
  } catch {
    return null
  }
}

/** The deploy for an asset id, kept once its body hashes to the id's txid. */
async function deployFor(
  active: ActiveWallet,
  assetId: string,
  state: CountersignState,
  bodyHex?: string,
): Promise<CountersignDeploy | null> {
  const known = deployMap(state).get(assetId)
  if (known) return known
  const txid = assetId.slice(0, 64)
  let tx: Transaction | null = null
  if (bodyHex) {
    try {
      const candidate = Transaction.fromHex(bodyHex)
      if (String(candidate.id('hex')) === txid) tx = candidate
    } catch {
      tx = null
    }
  }
  tx ??= await fullTx(active, txid)
  const deploy = tx ? readCountersignDeploy(tx) : null
  if (!deploy || deploy.assetId !== assetId) return null
  state.deploys[assetId] = toStoredDeploy(deploy)
  return deploy
}

// ── Holdings ───────────────────────────────────────────────────────────────

/** Resolved outputs this wallet holds, from the `csft` and `csnft` filings. */
export async function listCountersignedHoldings(
  active: ActiveWallet,
  assetId?: string,
  opts: { includeListed?: boolean } = {},
): Promise<CountersignHolding[]> {
  const pages = await Promise.all(
    COUNTERSIGNED_SCHEMES.map((basket) =>
      active.wallet.listOutputs({
        basket,
        include: 'locking scripts',
        includeTags: true,
        includeCustomInstructions: true,
        limit: 1000,
      }),
    ),
  )
  const self = selfPkh(active)
  return pages.flatMap((page) => page.outputs ?? []).flatMap((o) => {
    if (o.spendable === false || !o.lockingScript) return []
    // A listed output moves only by its sale or its cancel.
    if (!opts.includeListed && (o.tags ?? []).includes(MARKET_HELD_TAG)) return []
    const read = readCountersigned(o.lockingScript)
    if (!read) return []
    const id = read.assetId ?? underscore(o.outpoint)
    if (assetId && id !== assetId) return []
    const outpoint = o.outpoint.replace('_', '.')
    const remittance = holderRemittanceOf(o.customInstructions) ?? undefined
    if (read.holderPkhHex !== self) {
      if (!remittance) return []
      try {
        const key = holderKeyOf(active, { assetId: id, outpoint, remittance })
        if (Utils.toHex(Hash.hash160(key.toPublicKey().encode(true) as number[])) !== read.holderPkhHex) return []
      } catch {
        return []
      }
    }
    return [{
      outpoint,
      assetId: id,
      amount: read.amount,
      lockingScript: o.lockingScript,
      ...(read.holderPkhHex !== self && remittance ? { remittance } : {}),
      ...((o.tags ?? []).includes(MARKET_HELD_TAG) ? { listed: true as const } : {}),
    }]
  })
}

/** The profile of a countersigned deploy this wallet has read, without a basket read. */
export function knownCountersignedProfile(assetId: string): CountersignedScheme | null {
  const deploy = readCountersignState().deploys[underscore(assetId)]
  return deploy ? countersignedSchemeFor(deploy.kind) : null
}

/**
 * The countersigned profile (`csft` / `csnft`) of an asset id or held outpoint,
 * or null when it is neither. Market and direct-offer paths route on it.
 */
export async function countersignedProfileOf(
  active: ActiveWallet,
  idOrOutpoint: string,
): Promise<CountersignedScheme | null> {
  const id = underscore(idOrOutpoint)
  const known = knownCountersignedProfile(id)
  if (known) return known
  for (const scheme of COUNTERSIGNED_SCHEMES) {
    const page = await active.wallet.listOutputs({ basket: scheme, includeTags: true, limit: 1000 })
    const hit = (page.outputs ?? []).some(
      (o) => underscore(o.outpoint) === id || (o.tags ?? []).includes(`${scheme}:${id}`),
    )
    if (hit) return scheme
  }
  return null
}

/** Display tags: `p csft` / `p csnft` views list tags, never the remittance in customInstructions. */
function displayTag(prefix: string, value: string | undefined): string[] {
  const text = value?.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64)
  return text ? [`${prefix}:${text}`] : []
}

function countersignedTags(
  assetId: string | null,
  deploy: Pick<CountersignDeploy, 'kind'> & { fields?: Pick<CountersignDeployFields, 'sym' | 'name'> },
  amount: bigint,
): string[] {
  const scheme = countersignedSchemeFor(deploy.kind)
  return stampBrc164Id([
    assetId ? `${scheme}:${assetId}` : `${scheme}:deploy`,
    `amt:${amount}`,
    ...displayTag('sym', deploy.fields?.sym),
    ...displayTag('name', deploy.fields?.name),
  ])
}

function countersignedInstructions(
  assetId: string | null,
  deploy: { kind: string; fields: Pick<CountersignDeployFields, 'sym' | 'dec' | 'name' | 'col'> },
  amount: bigint,
  remittance?: ColorRemittance | null,
): string {
  return JSON.stringify({
    ...(assetId ? { id: assetId } : {}),
    kind: deploy.kind,
    amt: amount.toString(),
    ...(deploy.fields.sym ? { sym: deploy.fields.sym } : {}),
    ...(deploy.fields.dec != null ? { dec: deploy.fields.dec } : {}),
    ...(deploy.fields.name ? { name: deploy.fields.name } : {}),
    ...(deploy.fields.col ? { col: deploy.fields.col } : {}),
    ...(remittance ?? {}),
  })
}

// ── Fee inputs ─────────────────────────────────────────────────────────────

type FeeCoin = { txid: string; vout: number; satoshis: number; lockingScript: string }

async function listFeeCoins(active: ActiveWallet, exclude: ReadonlySet<string>): Promise<FeeCoin[]> {
  const lock = new P2PKH().lock(active.address).toHex().toLowerCase()
  const page = await active.wallet.listOutputs({ basket: FEE_BASKET, include: 'locking scripts', limit: 100 })
  return (page.outputs ?? []).flatMap((o) => {
    const [txid, vout] = o.outpoint.replace('_', '.').split('.')
    if (o.spendable === false || (o.lockingScript ?? '').toLowerCase() !== lock || exclude.has(o.outpoint)) return []
    return [{ txid: txid!, vout: Number(vout), satoshis: o.satoshis, lockingScript: o.lockingScript! }]
  })
}

async function mintFeeCoins(active: ActiveWallet): Promise<void> {
  const startedAt = Date.now()
  const created = await active.wallet.createAction({
    description: 'Countersign fee inputs',
    labels: [LABEL, 'countersign-fee'],
    outputs: Array.from({ length: FEE_COIN_BATCH }, () => ({
      lockingScript: new P2PKH().lock(active.address).toHex(),
      satoshis: FEE_COIN_SATS,
      outputDescription: 'Countersign fee input',
      basket: FEE_BASKET,
      tags: ['countersign-fee'],
    })),
    options: { randomizeOutputs: false, noSend: true, acceptDelayedBroadcast: true },
  })
  const txid = created.txid?.toLowerCase() ?? ''
  const atomic = created.tx ? Array.from(created.tx) : []
  if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) throw new Error('Countersign fee inputs were not signed')
  rememberBeefTree(atomic, txid)
  const { registerSignedSend, propagateSignedSend } = await import('../signedSendLifecycle')
  await propagateSignedSend(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'countersign' }))
  log('fee inputs', startedAt)
}

/** Fee coins summing to at least `need`, `prefer` first, minting a batch when short. */
async function takeFeeCoins(active: ActiveWallet, need: number, prefer: readonly string[] = []): Promise<FeeCoin[]> {
  const preferred = new Set(prefer)
  const pick = (coins: FeeCoin[]) => {
    const chosen: FeeCoin[] = []
    let sum = 0
    const order = [...coins].sort(
      (a, b) => Number(preferred.has(feeCoinKey(b))) - Number(preferred.has(feeCoinKey(a))) || b.satoshis - a.satoshis,
    )
    for (const coin of order) {
      if (sum >= need) break
      chosen.push(coin)
      sum += coin.satoshis
    }
    return sum >= need ? chosen : null
  }
  const held = feeCoinsHeld()
  for (const coin of preferred) held.delete(coin)
  const first = pick(await listFeeCoins(active, held))
  if (first) return first
  await mintFeeCoins(active)
  const second = pick(await listFeeCoins(active, held))
  if (!second) throw new Error('Countersign fee inputs are not available yet')
  return second
}

/**
 * Fee coins already in a signed transaction someone may still complete: an
 * open quorum request, a beacon proposal, or a trade an acceptor may have
 * signed unheard (kept for that trade's retry).
 */
function feeCoinsHeld(): Set<string> {
  const state = readCountersignState()
  const held = new Set<string>()
  for (const request of Object.values(state.outgoing)) {
    if (request.state === 'open') for (const coin of request.feeCoins ?? []) held.add(coin)
  }
  for (const swap of Object.values(state.swaps)) {
    if (swap.state !== 'done') for (const coin of swap.feeCoins) held.add(coin)
  }
  for (const record of Object.values(state.acceptor)) {
    for (const coin of record.beaconProposal?.feeCoins ?? []) held.add(coin)
  }
  return held
}

const feeCoinKey = (coin: FeeCoin) => `${coin.txid}.${coin.vout}`

/** The toolbox did not build the spending transaction, so it is told the coins are gone. */
async function relinquishFeeCoins(active: ActiveWallet, coins: FeeCoin[]): Promise<void> {
  for (const coin of coins) {
    await active.wallet.relinquishOutput({ basket: FEE_BASKET, output: `${coin.txid}.${coin.vout}` }).catch(() => {})
  }
}

/** Network fee plus the satoshis the outputs carry beyond the inputs already there. */
function acceptorNeed(tx: Transaction, feeInputs: number, countersigs = 1): number {
  const countersignBytes = 2 + 74 * countersigs
  const bytes = tx.toBinary().length + tx.inputs.length * countersignBytes + feeInputs * 148
  const fee = Math.ceil((bytes * FEE_SATS_PER_KB) / 1000) + 1
  const inSats = tx.inputs.reduce((sum, input) => sum + (input.sourceTransaction?.outputs[input.sourceOutputIndex]?.satoshis ?? 0), 0)
  const outSats = tx.outputs.reduce((sum, output) => sum + (output.satoshis ?? 0), 0)
  return fee + Math.max(0, outSats - inSats)
}

/** Add fee coins covering `tx`; they are signed last, by `signFeeInputs`. */
async function fundWithFeeCoins(
  active: ActiveWallet,
  tx: Transaction,
  state: CountersignState,
  countersigs: number,
  prefer: readonly string[] = [],
): Promise<FeeCoin[]> {
  let feeCount = 1
  let coins = await takeFeeCoins(active, acceptorNeed(tx, feeCount, countersigs), prefer)
  if (coins.length > feeCount) {
    feeCount = coins.length
    coins = await takeFeeCoins(active, acceptorNeed(tx, feeCount, countersigs), prefer)
  }
  for (const coin of coins) {
    const parent = await fullTx(active, coin.txid, state)
    if (!parent) throw new Error('A countersign fee input has no source transaction')
    tx.addInput({
      sourceTransaction: parent,
      sourceTXID: coin.txid,
      sourceOutputIndex: coin.vout,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff,
    })
  }
  return coins
}

async function signFeeInputs(active: ActiveWallet, tx: Transaction, coins: FeeCoin[], from: number): Promise<void> {
  const root = rootKeyOf(active)
  for (let vin = from; vin < tx.inputs.length; vin++) {
    const coin = coins[vin - from]!
    tx.inputs[vin]!.unlockingScript = await new P2PKH()
      .unlock(root, 'all', false, coin.satoshis, new P2PKH().lock(active.address))
      .sign(tx, vin)
  }
}

// ── Atomic BEEF ────────────────────────────────────────────────────────────

/** Atomic BEEF of `tx` with every unproven ancestor this wallet can supply. */
async function atomicBeefFor(active: ActiveWallet, tx: Transaction, state: CountersignState): Promise<number[]> {
  const txid = String(tx.id('hex'))
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  for (let pass = 0; pass < 32; pass++) {
    const need = new Set<string>()
    for (const entry of beef.txs) {
      if (entry.isTxidOnly || !entry.tx || entry.bumpIndex !== undefined) continue
      for (const input of entry.tx.inputs) {
        const parent = String(input.sourceTXID ?? '')
        if (parent && !beef.findTxid(parent)) need.add(parent)
      }
    }
    if (need.size === 0) break
    let added = false
    for (const parent of need) {
      const local = await getLocalBeefForTxid(active, parent)
      if (local?.findTxid(parent)?.tx) {
        beef.mergeBeef(local.toBinary())
        added = true
        continue
      }
      const known = await fullTx(active, parent, state)
      if (known) {
        beef.mergeRawTx(known.toBinary())
        added = true
      }
    }
    if (!added) break
  }
  return Array.from(beef.toBinaryAtomic(txid))
}

// ── Issue ──────────────────────────────────────────────────────────────────

type MediaArg = { mediaType?: unknown; base64?: unknown }

function mediaBytes(arg: MediaArg | undefined, max: number, what: string): { mediaType: string; bytes: Uint8Array } | undefined {
  if (!arg) return undefined
  const mediaType = typeof arg.mediaType === 'string' ? arg.mediaType.trim() : ''
  const bytes = typeof arg.base64 === 'string' ? Uint8Array.from(Utils.toArray(arg.base64, 'base64')) : new Uint8Array()
  if (!mediaType || bytes.length === 0 || bytes.length > max) {
    refuse('bad-asset-args', `The ${what} needs a media type and 1 byte to ${Math.round(max / 1024)} KiB.`)
  }
  return { mediaType, bytes }
}

export type IssueCountersignedArgs = {
  kind?: unknown
  sym?: unknown
  name?: unknown
  supply?: unknown
  dec?: unknown
  icon?: MediaArg
  content?: MediaArg
  /**
   * Custodians' release set `{ threshold, keys }`, which keys this wallet does
   * not hold must meet; or `'self'` for this wallet's own release key alone.
   */
  release?: unknown
  /**
   * The issuer set `{ threshold, keys }`: m of n cosigners' identity keys,
   * this wallet's among them, with m more than half of n. Omitted: this
   * wallet alone.
   */
  cosigners?: unknown
  silenceSeconds?: unknown
}

/**
 * Deploy a countersigned token or item. The issuer set is this wallet alone
 * or m of n cosigners including it; this wallet is the first holder. Output 1
 * is the first beacon and an item's content is output 2. Countersigning suits
 * assets whose value comes from their issuer; the release set frees holders
 * once the issuer is gone. Each other cosigner gets a `join` invitation and
 * countersigns only after its user joins.
 */
export async function issueCountersignedAsset(args: IssueCountersignedArgs): Promise<{
  assetId: string
  txid: string
  kind: 'token' | 'item'
  supply: string
  acceptor: string
  cosigners: KeySet
  release: KeySet
  releaseCustody: 'independent' | 'issuer-only'
}> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const chart = createActor(countersignMachine).start()
    chart.send({ type: 'ISSUE' })
    try {
      const kind = args.kind === 'item' ? 'item' : args.kind === 'token' || args.kind == null ? 'token' : null
      if (!kind) refuse('bad-asset-args', 'kind must be "token" or "item".')
      const supplyRaw = kind === 'item' ? '1' : String(args.supply ?? '').trim()
      if (!/^\d+$/.test(supplyRaw) || BigInt(supplyRaw) <= 0n || BigInt(supplyRaw) > (1n << 64n) - 1n) {
        refuse('bad-asset-args', 'supply must be a whole number from 1 to 2^64-1.')
      }
      if (kind === 'item' && args.supply != null && String(args.supply) !== '1') {
        refuse('bad-asset-args', 'An item has a supply of exactly 1.')
      }
      const sym = typeof args.sym === 'string' ? args.sym.trim() : ''
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (kind === 'token' && !sym) refuse('bad-asset-args', 'A token needs a symbol.')
      if (kind === 'item' && !name) refuse('bad-asset-args', 'An item needs a name.')
      const dec = args.dec == null ? undefined : Number(args.dec)
      const icon = mediaBytes(args.icon, MAX_ICON_BYTES, 'icon')
      const content = kind === 'item' ? mediaBytes(args.content, MAX_CONTENT_BYTES, 'content') : undefined
      const silence = args.silenceSeconds == null ? DEFAULT_SILENCE_SECONDS : Number(args.silenceSeconds)
      if (!Number.isSafeInteger(silence) || silence < MIN_SILENCE_SECONDS) {
        refuse('bad-asset-args', `silenceSeconds must be at least ${MIN_SILENCE_SECONDS}.`)
      }
      const quorum = chooseCosignerQuorum({ cosigners: args.cosigners, identityKey: active.identityKey })
      if (quorum.quorum === 'refuse') refuse(quorum.reason, quorum.message)
      const custody = releaseCustodyOf(active, args.release)
      if (custody.custody === 'refuse') refuse(custody.reason, custody.message)
      const sets: CountersignKeySets = { issuer: quorum.issuer, release: custody.release }
      let payload: number[]
      try {
        payload = encodeCountersignPayload({
          kind,
          sil: silence,
          ...(sym ? { sym } : {}),
          ...(name ? { name } : {}),
          ...(dec != null ? { dec } : {}),
          ...(icon ? { icon } : {}),
          ...(content ? { ctype: content.mediaType } : {}),
        })
      } catch (err) {
        refuse('bad-asset-args', err instanceof Error ? err.message : String(err))
      }
      const self = active.identityKey.toLowerCase()
      const deployHolder = planHolderRemittance([{ vout: 0, identityKey: self }])
      const deployRemittance: ColorRemittance = {
        derivationPrefix: deployHolder.prefix,
        derivationSuffix: deployHolder.outputs[0]!.derivationSuffix,
        senderIdentityKey: self,
      }
      let deployLock: string
      try {
        deployLock = countersignDeployLock({
          supply: BigInt(supplyRaw),
          payload,
          holderPkhHex: holderPkhFor(rootKeyOf(active), 'ISSUE', deployHolder.prefix, deployHolder.outputs[0]!),
          sets,
        }).toHex()
      } catch (err) {
        refuse('bad-asset-args', err instanceof Error ? err.message : String(err))
      }
      const label = kind === 'item' ? name : `${supplyRaw} ${sym}`
      const shape = { kind: kind as 'token' | 'item', fields: { sym, dec, name } }
      const created = await active.wallet.createAction({
        description: `Issue ${label} (countersigned)`.slice(0, 50),
        labels: [LABEL, 'countersign-issue'],
        outputs: [
          {
            lockingScript: deployLock,
            satoshis: 1,
            outputDescription: `Countersigned ${kind} deploy`,
            basket: countersignedSchemeFor(kind),
            tags: countersignedTags(null, shape, BigInt(supplyRaw)),
            customInstructions: countersignedInstructions(null, shape, BigInt(supplyRaw), deployRemittance),
          },
          {
            lockingScript: beaconLock(sets).toHex(),
            satoshis: 1,
            outputDescription: 'Issuer beacon',
            basket: BEACON_BASKET,
            tags: ['countersign-beacon'],
          },
          ...(content
            ? [{ lockingScript: contentLock([...content.bytes]).toHex(), satoshis: 0, outputDescription: 'Item content' }]
            : []),
        ],
        options: { randomizeOutputs: false, noSend: true, acceptDelayedBroadcast: true },
      })
      const txid = created.txid?.toLowerCase() ?? ''
      const atomic = created.tx ? Array.from(created.tx) : []
      if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) throw new Error('Countersigned deploy was not signed')
      rememberBeefTree(atomic, txid)
      const { registerSignedSend, propagateSignedSend } = await import('../signedSendLifecycle')
      const handle = await registerSignedSend({ txid, atomicBeef: atomic, flow: 'countersign' })
      chart.send({ type: 'BROADCASTED', txid })
      const deployTx = Beef.fromBinary(atomic).findTxid(txid)?.tx
      const deploy = deployTx ? readCountersignDeploy(deployTx) : null
      if (!deploy) throw new Error('The signed deploy does not read back as a countersigned deploy')
      const state = readCountersignState()
      state.deploys[deploy.assetId] = toStoredDeploy(deploy)
      state.acceptor[deploy.assetId] = {
        assetId: deploy.assetId,
        accepted: [deploy.assetId],
        spent: {},
        requests: {},
        cancelled: [],
        beacon: `${txid}_1`,
        beaconAt: Date.now(),
        ...(quorum.quorum === 'shared' ? { shared: true as const } : {}),
      }
      writeCountersignState(state)
      // Transfers chain on this deploy, so miners see it first.
      await propagateSignedSend(handle).catch((err) => {
        console.warn('[countersign] deploy propagation queued', err instanceof Error ? err.message : String(err))
      })
      chart.send({ type: 'COMMITTED' })
      if (quorum.quorum === 'shared' && deployTx) {
        const invite: Wire = { v: 1, t: 'join', token: deploy.assetId, deploy: deployTx.toHex() }
        for (const cosigner of sets.issuer.keys.filter((k) => k !== self)) {
          await replyTo(active, cosigner, invite).catch((err) => {
            console.warn('[countersign] cosigner invite not sent', err instanceof Error ? err.message : String(err))
          })
        }
      }
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'countersign-issue',
        note: `Issued ${label} (countersigned ${kind})`,
        txid,
      })
      scheduleHistoryBackupPush('countersign')
      log('issue', startedAt)
      return {
        assetId: deploy.assetId,
        txid,
        kind,
        supply: supplyRaw,
        acceptor: active.identityKey.toLowerCase(),
        cosigners: sets.issuer,
        release: sets.release,
        releaseCustody: custody.custody,
      }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

// ── Acceptor ───────────────────────────────────────────────────────────────

function priorAcceptance(
  state: CountersignState,
  requestId: string,
): { record: AcceptorRecord; efHex: string; senderFunded: boolean } | null {
  for (const record of Object.values(state.acceptor)) {
    const hit = record.requests[requestId]
    if (hit) return { record, efHex: hit.efHex, senderFunded: hit.senderFunded === true }
  }
  return null
}

type SignedSpend = PriorSpend & { tx: Transaction }

const signedSpendCache = new Map<string, { tx: Transaction; inputs: Set<string>; plain: string[] }>()

function readSignedSpend(requestId: string, efHex: string): { tx: Transaction; inputs: Set<string>; plain: string[] } | null {
  const cached = signedSpendCache.get(requestId)
  if (cached) return cached
  try {
    const tx = Transaction.fromEF(Utils.toArray(efHex, 'hex'))
    const inputs = new Set(tx.inputs.map((_, vin) => `${sourceTxidOf(tx, vin)}_${tx.inputs[vin]!.sourceOutputIndex}`))
    const read = { tx, inputs, plain: plainInputsOf(tx) }
    signedSpendCache.set(requestId, read)
    return read
  } catch {
    return null
  }
}

/** Requests this acceptor signed that spend `outpoint` and are not proven dead. */
function signedSpendsOf(state: CountersignState, outpoint: string, except: string): SignedSpend[] {
  const spends = new Map<string, SignedSpend>()
  for (const record of Object.values(state.acceptor)) {
    for (const [requestId, entry] of Object.entries(record.requests)) {
      if (requestId === except || entry.dead || spends.has(requestId)) continue
      const read = readSignedSpend(requestId, entry.efHex)
      if (!read?.inputs.has(outpoint)) continue
      const vin = read.tx.inputs.findIndex(
        (input, i) => `${sourceTxidOf(read.tx, i)}_${input.sourceOutputIndex}` === outpoint,
      )
      spends.set(requestId, {
        requestId,
        plainInputs: read.plain,
        requesterFunded: entry.senderFunded === true || record.shared === true,
        ...(holderScopeOf(read.tx, vin) === SWAP_HOLDER_SCOPE ? { sale: true as const } : {}),
        tx: read.tx,
      })
    }
  }
  return [...spends.values()]
}

/**
 * True once a mined transaction other than the request itself spent one of
 * its plain inputs: the request can never confirm.
 */
async function signedSpendDead(active: ActiveWallet, request: Transaction): Promise<boolean> {
  const source = whatsOnChainBeaconSource(active.chain)
  const ownInputs = new Set(request.inputs.map((_, vin) => `${sourceTxidOf(request, vin)}_${request.inputs[vin]!.sourceOutputIndex}`))
  const ownOutputs = request.outputs.map((o) => `${o.satoshis}:${o.lockingScript?.toHex()}`).join('|')
  for (const outpoint of plainInputsOf(request)) {
    const [txid, vout] = outpoint.split('_')
    const spender = await source.spentBy(txid!, Number(vout))
    if (typeof spender !== 'string') continue
    const spending = await source.tx(spender)
    if (!spending) continue
    const itself =
      spending.inputs.length === ownInputs.size &&
      spending.inputs.every((input) => ownInputs.has(`${String(input.sourceTXID).toLowerCase()}_${input.sourceOutputIndex}`)) &&
      spending.outputs.map((o) => `${o.satoshis}:${o.lockingScript?.toHex()}`).join('|') === ownOutputs
    if (itself) return false
    if ((await source.blockTime(spender)) != null) return true
  }
  return false
}

/**
 * The asset inputs of `tx` that an earlier signed request still holds, each
 * with that request's id. An earlier sale, or a request that conflicts with
 * this one on a plain input, never blocks it (at most one of them confirms); a
 * requester-funded one blocks until proven dead, which is written back.
 */
async function heldInputs(
  active: ActiveWallet,
  state: CountersignState,
  tx: Transaction,
  deploys: Map<string, CountersignDeploy>,
  requestId: string,
): Promise<Map<string, string>> {
  const startedAt = Date.now()
  const held = new Map<string, string>()
  const died: string[] = []
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const asset = assetOfInput(tx, vin, deploys)
    if (!asset) continue
    const { maybeDead, final } = blockingPriorSpends(signedSpendsOf(state, asset.outpoint, requestId), tx)
    if (final[0]) {
      held.set(asset.outpoint, final[0].requestId)
      continue
    }
    for (const spend of maybeDead as SignedSpend[]) {
      if (died.includes(spend.requestId)) continue
      if (await signedSpendDead(active, spend.tx).catch(() => false)) {
        died.push(spend.requestId)
        continue
      }
      held.set(asset.outpoint, spend.requestId)
      break
    }
  }
  if (died.length) {
    for (const record of Object.values(state.acceptor)) {
      for (const requestId of died) {
        const entry = record.requests[requestId]
        if (!entry) continue
        entry.dead = true
        for (const [outpoint, by] of Object.entries(record.spent)) {
          if (by !== requestId) continue
          delete record.spent[outpoint]
          if (!record.shared && !record.accepted.includes(outpoint)) record.accepted.push(outpoint)
        }
      }
    }
    writeCountersignState(state)
    console.info(`[countersign] freed ${died.length} reservation(s) whose request a mined spend voided`)
  }
  log('reservations', startedAt)
  return held
}

/** The asset inputs of `tx` this acceptor answers for and has accepted, by record or by proof. */
async function acceptedInputs(
  active: ActiveWallet,
  tx: Transaction,
  deploys: Map<string, CountersignDeploy>,
  state: CountersignState,
  answersFor: (assetId: string) => boolean,
): Promise<Set<string>> {
  const accepted = new Set<string>()
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const asset = assetOfInput(tx, vin, deploys)
    if (!asset) break
    if (answersFor(asset.assetId) && (await inputAccepted(active, asset.outpoint, asset.assetId, state))) {
      accepted.add(asset.outpoint)
    }
  }
  return accepted
}

/**
 * Accept once: check the request, add a fee input, countersign every asset
 * input on the issuer branch, and record it in one durable write before
 * anything leaves this wallet. Callers hold the spend lease.
 */
async function acceptRequest(
  active: ActiveWallet,
  request: HolderRequest,
): Promise<Decision> {
  const startedAt = Date.now()
  const state = readCountersignState()
  const prior = priorAcceptance(state, request.requestId)
  if (prior) {
    const tx = Transaction.fromEF(Utils.toArray(prior.efHex, 'hex'))
    return { kind: 'accepted', tx, efHex: prior.efHex }
  }
  if (Object.values(state.acceptor).some((r) => r.cancelled.includes(request.requestId))) {
    return { kind: 'refused', reason: 'policy', detail: 'cancelled' }
  }
  const deploys = deployMap(state)
  let marked = false
  for (const record of Object.values(state.acceptor)) {
    const ended = endedReason(record, state.deploys[record.assetId])
    if (ended && !record.ended) {
      record.ended = ended
      marked = true
      console.warn(`[countersign] ${record.assetId.slice(0, 12)} ${ended}: this issuer no longer countersigns it`)
    }
  }
  if (marked) writeCountersignState(state)
  const proven = provenRecipients(active, request)
  if (!proven.ok) {
    console.warn(`[countersign] acceptor refuse recipient — ${proven.detail}`)
    return { kind: 'refused', reason: 'recipient', detail: proven.detail }
  }
  const answersFor = (assetId: string) => Boolean(state.acceptor[assetId] && !state.acceptor[assetId]!.ended)
  const accepted = await acceptedInputs(active, request.tx, deploys, state, answersFor)
  const held = await heldInputs(active, state, request.tx, deploys, request.requestId)
  const check = checkAcceptRequest({
    tx: request.tx,
    deploys,
    answersFor,
    accepted,
    reservedBy: (outpoint) => held.get(outpoint),
    requestId: request.requestId,
    recipients: proven.recipients,
  })
  if (!check.ok) {
    console.warn(`[countersign] acceptor refuse ${check.reason} — ${check.detail}`)
    return { kind: 'refused', reason: check.reason, detail: check.detail }
  }
  const tx = request.tx
  const holders = tx.inputs.map((input) => readHolderUnlock(input.unlockingScript)!)
  const tokenInputs = tx.inputs.length
  const coins = await fundWithFeeCoins(active, tx, state, 1)
  const root = rootKeyOf(active)
  for (let vin = 0; vin < tokenInputs; vin++) {
    tx.inputs[vin]!.unlockingScript = countersignedUnlock({
      countersignatures: [signInput(tx, vin, root, COUNTERSIGN_SCOPE)],
      branch: 'issuer',
      holderSignature: holders[vin]!.signature,
      holderPublicKey: holders[vin]!.publicKey,
    })
  }
  await signFeeInputs(active, tx, coins, tokenInputs)
  for (let vin = 0; vin < tokenInputs; vin++) {
    if (!inputScriptValid(tx, vin)) throw new Error(`Countersigned input ${vin} does not verify`)
  }
  const txid = String(tx.id('hex')).toLowerCase()
  const efHex = Utils.toHex(tx.toEF())
  for (const assetId of check.assetIds) {
    const record = state.acceptor[assetId]!
    const spentHere = Array.from({ length: tokenInputs }, (_, vin) => assetOfInput(tx, vin, deploys))
      .filter((asset) => asset?.assetId === assetId)
      .map((asset) => asset!.outpoint)
    record.accepted = record.accepted.filter((outpoint) => !spentHere.includes(outpoint))
    for (const outpoint of spentHere) record.spent[outpoint] = request.requestId
    tx.outputs.forEach((output, vout) => {
      const read = output.lockingScript ? readCountersigned(output.lockingScript) : null
      if (read?.assetId === assetId) record.accepted.push(`${txid}_${vout}`)
    })
    record.requests[request.requestId] = { txid, efHex, at: Date.now() }
  }
  writeCountersignState(state)
  await relinquishFeeCoins(active, coins)
  console.info(`[countersign] accepted ${request.requestId.slice(0, 12)} → ${txid.slice(0, 12)}`)
  log('accept', startedAt)
  return { kind: 'accepted', tx, efHex, atomic: await atomicBeefFor(active, tx, state) }
}

/** The leading asset inputs of a request; the holder's fee inputs follow them. */
function assetInputCount(tx: Transaction, deploys: Map<string, CountersignDeploy>): number {
  let count = 0
  while (count < tx.inputs.length && assetOfInput(tx, count, deploys)) count++
  return count
}

/**
 * An acceptor accepts an output it has no record of when the transaction
 * that wrote it spent every asset input on the issuer branch with valid
 * countersignatures and resolves: a cosigner of a shared set, which a quorum
 * may outvote, and any acceptor after a trade, whose final txid only the
 * requester learns. The deploy output is accepted by definition.
 */
async function inputAccepted(
  active: ActiveWallet,
  outpoint: string,
  assetId: string,
  state: CountersignState,
): Promise<boolean> {
  if (outpoint === assetId || state.acceptor[assetId]?.accepted.includes(outpoint)) return true
  const [txid, vout] = outpoint.split('_')
  const parent = await fullTx(active, txid!, state)
  if (!parent) return false
  for (const input of parent.inputs) {
    if (input.sourceTransaction) continue
    const source = await fullTx(active, String(input.sourceTXID ?? ''), state)
    if (!source) return false
    input.sourceTransaction = source
  }
  let spentAssets = 0
  for (let vin = 0; vin < parent.inputs.length; vin++) {
    const source = sourceOutputOf(parent, vin)
    if (!source || !readCountersigned(source.lockingScript)) continue
    spentAssets++
    if (unlockBranch(parent.inputs[vin]!.unlockingScript) !== 'issuer' || !inputScriptValid(parent, vin)) return false
  }
  const written = parent.outputs[Number(vout)]?.lockingScript
  const read = written ? readCountersigned(written) : null
  return spentAssets > 0 && read?.assetId === assetId && resolveCountersignTransfer(parent, deployMap(state)).ok
}

/**
 * Countersign a transaction its requester funded and will broadcast: a
 * quorum request to one cosigner of a shared set, or a trade (`swap`) to any
 * acceptor. Check it, reserve its asset inputs and countersign each of them,
 * in one durable write before the signatures leave this wallet. Every
 * acceptor signs the same transaction, and a request answered before gets
 * the same signatures again (RFC 6979). Callers hold the spend lease.
 */
async function cosignRequest(
  active: ActiveWallet,
  request: HolderRequest,
  opts: { swap?: boolean } = {},
): Promise<Decision> {
  const startedAt = Date.now()
  const state = readCountersignState()
  const deploys = deployMap(state)
  const root = rootKeyOf(active)
  const countersign = (tx: Transaction) =>
    Array.from({ length: assetInputCount(tx, deploys) }, (_, vin) => signInput(tx, vin, root, COUNTERSIGN_SCOPE))
  const prior = priorAcceptance(state, request.requestId)
  if (prior && (prior.record.shared || prior.senderFunded)) {
    return { kind: 'cosigned', signatures: countersign(Transaction.fromEF(Utils.toArray(prior.efHex, 'hex'))) }
  }
  if (Object.values(state.acceptor).some((r) => r.cancelled.includes(request.requestId))) {
    return { kind: 'refused', reason: 'policy', detail: 'cancelled' }
  }
  const tx = request.tx
  const proven = provenRecipients(active, request)
  const answersFor = (assetId: string) => {
    const record = state.acceptor[assetId]
    return Boolean(record && !record.ended && (record.shared || opts.swap))
  }
  const accepted = await acceptedInputs(active, tx, deploys, state, answersFor)
  const held = await heldInputs(active, state, tx, deploys, request.requestId)
  const check: AcceptCheck = proven.ok
    ? checkAcceptRequest({
        tx,
        deploys,
        answersFor,
        accepted,
        reservedBy: (outpoint) => held.get(outpoint),
        requestId: request.requestId,
        recipients: proven.recipients,
        holderFunded: true,
        ...(opts.swap ? { swap: true } : {}),
      })
    : { ok: false, reason: 'recipient', detail: proven.detail }
  if (!check.ok) {
    // A refusal is final: the holder's cancel proof counts on it never turning into a signature.
    for (let vin = 0; vin < tx.inputs.length; vin++) {
      const record = state.acceptor[assetOfInput(tx, vin, deploys)?.assetId ?? '']
      if (record?.shared && !record.cancelled.includes(request.requestId)) record.cancelled.push(request.requestId)
    }
    writeCountersignState(state)
    console.warn(`[countersign] cosigner refuse ${check.reason} — ${check.detail}`)
    return { kind: 'refused', reason: check.reason, detail: check.detail }
  }
  const signatures = countersign(tx)
  const efHex = Utils.toHex(tx.toEF())
  const txid = String(tx.id('hex')).toLowerCase()
  for (let vin = 0; vin < signatures.length; vin++) {
    const asset = assetOfInput(tx, vin, deploys)!
    const record = state.acceptor[asset.assetId]!
    record.accepted = record.accepted.filter((outpoint) => outpoint !== asset.outpoint)
    record.spent[asset.outpoint] = request.requestId
    record.requests[request.requestId] = { txid, efHex, at: Date.now(), ...(opts.swap ? { senderFunded: true as const } : {}) }
  }
  writeCountersignState(state)
  console.info(`[countersign] cosigned ${opts.swap ? 'trade ' : ''}${request.requestId.slice(0, 12)} (${signatures.length} inputs)`)
  log('cosign', startedAt)
  return { kind: 'cosigned', signatures }
}

/**
 * The holder's side of a quorum: keep each cosigner's answer on the open
 * request, verified against it. Returns the countersigned transaction once
 * `threshold` cosigners signed, `refused` once too many refused to reach it,
 * and null while it can still go either way.
 */
function applyQuorumAnswer(
  outgoing: OutgoingRequest,
  cosigner: string,
  answer: Extract<Decision, { kind: 'cosigned' | 'refused' }>,
): Extract<Decision, { kind: 'accepted' | 'refused' }> | null {
  const set = outgoing.cosigners
  if (!set?.keys.includes(cosigner) || outgoing.state !== 'open') return null
  const request = Transaction.fromEF(Utils.toArray(outgoing.efHex, 'hex'))
  if (answer.kind === 'cosigned') {
    const valid =
      answer.signatures.length === outgoing.inputs.length &&
      answer.signatures.every((signature, vin) => countersignatureValid(request, vin, cosigner, signature))
    if (!valid) {
      console.warn(`[countersign] cosigner ${cosigner.slice(0, 12)} sent signatures that do not verify`)
      return null
    }
    outgoing.countersigs = { ...outgoing.countersigs, [cosigner]: answer.signatures.map((s) => Utils.toHex(s)) }
  } else {
    if (!answer.signed) return null
    outgoing.refusals = { ...outgoing.refusals, [cosigner]: answer.signed }
  }
  const signedBy = new Map(Object.entries(outgoing.countersigs ?? {}))
  if (signedBy.size >= set.threshold) {
    const tx = Transaction.fromEF(Utils.toArray(outgoing.efHex, 'hex'))
    for (let vin = 0; vin < outgoing.inputs.length; vin++) {
      const holder = readHolderUnlock(tx.inputs[vin]!.unlockingScript)!
      const perInput = new Map([...signedBy].map(([key, sigs]) => [key, Utils.toArray(sigs[vin]!, 'hex')]))
      tx.inputs[vin]!.unlockingScript = countersignedUnlock({
        countersignatures: quorumSignatures(set, perInput)!,
        branch: 'issuer',
        holderSignature: holder.signature,
        holderPublicKey: holder.publicKey,
      })
      if (!inputScriptValid(tx, vin)) throw new Error(`Quorum input ${vin} does not verify`)
    }
    return { kind: 'accepted', tx, efHex: Utils.toHex(tx.toEF()) }
  }
  const refusals = Object.values(outgoing.refusals ?? {})
  if (set.keys.length - refusals.length < set.threshold) {
    const reasons = new Set(refusals.map((r) => r.reason))
    outgoing.cancelPending = Object.keys(outgoing.countersigs ?? {})
    return { kind: 'refused', reason: reasons.size === 1 ? [...reasons][0]! : 'quorum' }
  }
  return null
}

/** A cosigner drops what it reserved for a request no quorum can sign, and never signs it later. */
function freeQuorumReservations(state: CountersignState, requestId: string): void {
  for (const record of Object.values(state.acceptor)) {
    if (!record.shared) continue
    let held = false
    for (const [outpoint, by] of Object.entries(record.spent)) {
      if (by !== requestId) continue
      delete record.spent[outpoint]
      held = true
    }
    if (held || record.requests[requestId]) {
      delete record.requests[requestId]
      if (!record.cancelled.includes(requestId)) record.cancelled.push(requestId)
    }
  }
}

/** More than n − m cosigners' signed refusals: no quorum can ever sign the request. */
async function quorumImpossible(
  set: KeySet,
  token: string,
  request: string,
  refusals: Record<string, SignedRefusal>,
): Promise<boolean> {
  let proven = 0
  for (const [key, refusal] of Object.entries(refusals)) {
    if (!set.keys.includes(key)) continue
    const preimage =
      refusal.t === 'cancelled'
        ? decisionPreimage('cancelled', token, request)
        : decisionPreimage('refused', token, request, refusal.reason)
    if (await decisionSignedBy(key, preimage, refusal.signature)) proven++
  }
  return set.keys.length - proven < set.threshold
}

/**
 * Tell the cosigners that signed a refused quorum, with the refusals as
 * proof, so they free the inputs they reserved for it. Pending names stay
 * on the request until each confirms; the serve loop retries them.
 */
async function sendQuorumCancels(active: ActiveWallet, outgoing: OutgoingRequest): Promise<void> {
  const self = active.identityKey.toLowerCase()
  const pending = (outgoing.cancelPending ?? []).filter((k) => k !== self)
  if (pending.length === 0) return
  const { sendSealedToPeerBox } = await import('../messageTransport')
  const wire: Wire = {
    v: 1,
    t: 'cancel',
    token: outgoing.assetId,
    request: outgoing.requestId,
    refusals: outgoing.refusals ?? {},
  }
  for (const cosigner of pending) {
    await sendSealedToPeerBox(active.rootKeyHex, cosigner, COUNTERSIGN_BOX, JSON.stringify(wire)).catch((err) => {
      console.warn('[countersign] quorum cancel not sent', cosigner.slice(0, 12), err instanceof Error ? err.message : String(err))
    })
  }
}

/**
 * Ask every other cosigner and collect answers until a quorum signs, too
 * many refuse, or the wait runs out. Answers are kept on the open request,
 * so a late quorum completes it from the box (`settleOutgoing`).
 */
async function requestQuorum(
  active: ActiveWallet,
  outgoing: OutgoingRequest,
  wireFor: (cosigner: string) => Promise<Extract<Wire, { t: 'request' }>>,
  own: Decision | null,
): Promise<Decision> {
  const self = active.identityKey.toLowerCase()
  const set = outgoing.cosigners!
  const persist = () => {
    const next = readCountersignState()
    next.outgoing[outgoing.requestId] = outgoing
    writeCountersignState(next)
  }
  if (own && (own.kind === 'cosigned' || own.kind === 'refused')) {
    const answer =
      own.kind === 'refused'
        ? {
            ...own,
            signed: {
              t: 'refused' as const,
              reason: own.reason,
              signature: await signDecision(active, decisionPreimage('refused', outgoing.assetId, outgoing.requestId, own.reason)),
            },
          }
        : own
    const done = applyQuorumAnswer(outgoing, self, answer)
    persist()
    if (done) return done
  }
  const { sendSealedToPeerBox, listSealedOwnBox, acknowledgeOwnBox } = await import('../messageTransport')
  const others = set.keys.filter((k) => k !== self)
  let sent = 0
  for (const cosigner of others) {
    try {
      await sendSealedToPeerBox(active.rootKeyHex, cosigner, COUNTERSIGN_BOX, JSON.stringify(await wireFor(cosigner)))
      sent += 1
    } catch (err) {
      console.warn('[countersign] request send failed', cosigner.slice(0, 12), err instanceof Error ? err.message : String(err))
    }
  }
  if (sent === 0) return { kind: 'silent' }
  awaiting.add(outgoing.requestId)
  try {
    const deadline = Date.now() + REMOTE_ACCEPT_WAIT_MS
    while (Date.now() < deadline) {
      const messages = (await listSealedOwnBox(active.rootKeyHex, COUNTERSIGN_BOX)) ?? []
      for (const m of messages) {
        const reply = parseWire(m.plaintext)
        if (!reply || !('request' in reply) || reply.request !== outgoing.requestId || !others.includes(m.sender)) continue
        const answer = await decisionFromReply(reply, m.sender)
        await acknowledgeOwnBox(active.rootKeyHex, COUNTERSIGN_BOX, [m.messageId]).catch(() => {})
        if (answer?.kind !== 'cosigned' && answer?.kind !== 'refused') continue
        const done = applyQuorumAnswer(outgoing, m.sender, answer)
        persist()
        if (done) return done
      }
      await new Promise((resolve) => setTimeout(resolve, REMOTE_POLL_MS))
    }
    return { kind: 'silent' }
  } finally {
    awaiting.delete(outgoing.requestId)
  }
}

// ── Release phase ──────────────────────────────────────────────────────────

/**
 * Follow the asset's beacon chain from where this wallet last stopped and
 * store the phase. A collection member follows its collection's beacon.
 */
async function refreshPhase(active: ActiveWallet, assetId: string): Promise<CountersignPhase | null> {
  const startedAt = Date.now()
  const state = readCountersignState()
  const deploy = await deployFor(active, assetId, state)
  const beaconId = deploy?.fields.col ?? assetId
  const beaconDeploy = beaconId === assetId ? deploy : await deployFor(active, beaconId, state)
  if (!deploy || !beaconDeploy) return null
  const source = whatsOnChainBeaconSource(active.chain)
  const known = state.phases[beaconId]?.view
  const view = await readBeaconChain({ assetId: beaconId, sets: beaconDeploy.sets, source, ...(known ? { known } : {}) })
  const phase = beaconPhase(view, await source.tipTime(), beaconDeploy.fields.sil)
  const next = readCountersignState()
  for (const id of new Set([assetId, beaconId])) {
    next.deploys[id] ??= state.deploys[id]!
    next.phases[id] = { view, phase, checkedAt: Date.now() }
  }
  const record = next.acceptor[assetId]
  if (record && phase.phase !== 'live' && !record.ended) {
    record.ended = phase.phase === 'released' ? 'released' : phase.why
  }
  writeCountersignState(next)
  console.info(`[countersign] ${assetId.slice(0, 12)} phase ${phase.phase}`)
  log('beacon chain', startedAt)
  return phase
}

/**
 * After a release the holder countersigns its own signed transfer with the
 * disclosed keys on the release branch and funds the fee from its own coins.
 */
async function countersignReleased(
  active: ActiveWallet,
  tx: Transaction,
  keysHex: string[],
  deploy: CountersignDeploy,
  state: CountersignState,
): Promise<Extract<Decision, { kind: 'accepted' }>> {
  const startedAt = Date.now()
  const keys = disclosedReleaseKeys(keysHex, deploy.sets.release)
  if (!keys) refuse('invalid-acceptance', 'The published release keys do not match this asset. Nothing was sent.')
  const holders = tx.inputs.map((input) => readHolderUnlock(input.unlockingScript))
  if (holders.some((h) => !h)) throw new Error('A released transfer needs the holder signature on every input')
  const tokenInputs = tx.inputs.length
  const coins = await fundWithFeeCoins(active, tx, state, keys.length)
  for (let vin = 0; vin < tokenInputs; vin++) {
    tx.inputs[vin]!.unlockingScript = countersignedUnlock({
      countersignatures: keys.map((key) => signInput(tx, vin, key, COUNTERSIGN_SCOPE)),
      branch: 'release',
      holderSignature: holders[vin]!.signature,
      holderPublicKey: holders[vin]!.publicKey,
    })
  }
  await signFeeInputs(active, tx, coins, tokenInputs)
  for (let vin = 0; vin < tokenInputs; vin++) {
    if (!inputScriptValid(tx, vin)) throw new Error(`Released input ${vin} does not verify`)
  }
  await relinquishFeeCoins(active, coins)
  log('release countersign', startedAt)
  return { kind: 'accepted', tx, efHex: Utils.toHex(tx.toEF()), atomic: await atomicBeefFor(active, tx, state) }
}

const minedCheckedAt = new Map<string, number>()

/** A release-branch transfer is credited only once mined; the chain is asked at most once a minute per txid. */
async function minedYet(active: ActiveWallet, txid: string): Promise<boolean> {
  const last = minedCheckedAt.get(txid) ?? 0
  if (Date.now() - last < MINED_CHECK_MS) return false
  minedCheckedAt.set(txid, Date.now())
  const time = await whatsOnChainBeaconSource(active.chain).blockTime(txid)
  if (time != null) minedCheckedAt.delete(txid)
  return time != null
}

// ── Transfer ───────────────────────────────────────────────────────────────

const awaiting = new Set<string>()

async function requestRemoteAcceptance(
  active: ActiveWallet,
  acceptors: string[],
  wireFor: (acceptor: string) => Promise<Extract<Wire, { t: 'request' }>>,
  requestId: string,
): Promise<Decision> {
  const { sendSealedToPeerBox, listSealedOwnBox, acknowledgeOwnBox } = await import('../messageTransport')
  let sent = 0
  for (const acceptor of acceptors) {
    try {
      await sendSealedToPeerBox(active.rootKeyHex, acceptor, COUNTERSIGN_BOX, JSON.stringify(await wireFor(acceptor)))
      sent += 1
    } catch (err) {
      console.warn('[countersign] request send failed', acceptor.slice(0, 12), err instanceof Error ? err.message : String(err))
    }
  }
  if (sent === 0) return { kind: 'silent' }
  awaiting.add(requestId)
  try {
    const deadline = Date.now() + REMOTE_ACCEPT_WAIT_MS
    while (Date.now() < deadline) {
      const messages = (await listSealedOwnBox(active.rootKeyHex, COUNTERSIGN_BOX)) ?? []
      for (const m of messages) {
        const reply = parseWire(m.plaintext)
        if (!reply || !('request' in reply) || reply.request !== requestId || !acceptors.includes(m.sender)) continue
        const decision = await decisionFromReply(reply, m.sender)
        if (!decision) continue
        await acknowledgeOwnBox(active.rootKeyHex, COUNTERSIGN_BOX, [m.messageId]).catch(() => {})
        return decision
      }
      await new Promise((resolve) => setTimeout(resolve, REMOTE_POLL_MS))
    }
    return { kind: 'silent' }
  } finally {
    awaiting.delete(requestId)
  }
}

async function decisionFromReply(reply: Wire, sender: string): Promise<Decision | null> {
  if (reply.t === 'accepted') {
    try {
      const efBytes = Utils.toArray(reply.ef, 'base64')
      const atomic = reply.beef ? atomicBeefForSubject(Utils.toArray(reply.beef, 'base64'), String(Transaction.fromEF(efBytes).id('hex'))) : undefined
      return { kind: 'accepted', tx: Transaction.fromEF(efBytes), efHex: Utils.toHex(efBytes), ...(atomic ? { atomic } : {}) }
    } catch {
      return null
    }
  }
  if (reply.t === 'cosigned') {
    if (!Array.isArray(reply.signatures) || !reply.signatures.every((s) => typeof s === 'string' && /^[0-9a-f]+$/i.test(s))) return null
    return { kind: 'cosigned', signatures: reply.signatures.map((s) => Utils.toArray(s, 'hex')) }
  }
  if (reply.t === 'refused') {
    const ok = await decisionSignedBy(sender, decisionPreimage('refused', reply.token, reply.request, reply.reason), reply.signature)
    return ok ? { kind: 'refused', reason: reply.reason, signed: { t: 'refused', reason: reply.reason, signature: reply.signature } } : null
  }
  if (reply.t === 'cancelled') {
    const ok = await decisionSignedBy(sender, decisionPreimage('cancelled', reply.token, reply.request), reply.signature)
    return ok
      ? { kind: 'refused', reason: 'policy', detail: 'cancelled', signed: { t: 'cancelled', reason: 'policy', signature: reply.signature } }
      : null
  }
  return null
}

/**
 * The accepted transaction is the request plus only the acceptor's inputs
 * (none on the quorum path, where the holder funded it), and it resolves.
 */
function acceptanceMatches(request: Transaction, accepted: Transaction, deploys: Map<string, CountersignDeploy>): boolean {
  if (accepted.outputs.length !== request.outputs.length || accepted.inputs.length < request.inputs.length) return false
  const sameOutputs = request.outputs.every(
    (o, i) => accepted.outputs[i]?.satoshis === o.satoshis && accepted.outputs[i]?.lockingScript?.toHex() === o.lockingScript?.toHex(),
  )
  const sameInputs = request.inputs.every((input, i) => {
    const other = accepted.inputs[i]
    return (
      String(other?.sourceTXID).toLowerCase() === String(input.sourceTXID ?? input.sourceTransaction?.id('hex')).toLowerCase() &&
      other?.sourceOutputIndex === input.sourceOutputIndex
    )
  })
  return sameOutputs && sameInputs && resolveCountersignTransfer(accepted, deploys).ok
}

export type CountersignTransferResult = {
  assetId: string
  txid: string
  requestId: string
  amount: string
  recipient: string
  acceptedBy: 'local' | 'remote' | 'quorum' | 'released'
}

/**
 * Transfer units of a countersigned asset. The holder signs; the issuer
 * countersigns or refuses, and a refusal or silence leaves no transaction.
 * Once the asset is released the holder countersigns with the published keys.
 */
export async function transferCountersignedAsset(args: {
  assetId?: unknown
  amount?: unknown
  recipient?: unknown
}): Promise<CountersignTransferResult> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const state = readCountersignState()
    const assetId = normalizeTokenId(String(args.assetId ?? ''))
    const deploy = assetId ? await deployFor(active, assetId, state) : null
    const holdings = deploy && assetId ? await listCountersignedHoldings(active, assetId) : []
    const reserved = new Set(
      Object.values(state.outgoing)
        // Cosigners that signed an open quorum request keep its inputs reserved until it completes or is cancelled.
        .filter((r) => r.state === 'open' && (r.cosigners != null || Date.now() - r.at < OPEN_REQUEST_RESERVE_MS))
        .flatMap((r) => r.inputs),
    )
    const free = holdings.filter((h) => !reserved.has(underscore(h.outpoint)))
    const path = chooseCountersignTransferPath({
      deploy,
      identityKey: active.identityKey,
      recipient: args.recipient,
      amount: args.amount,
      held: free.reduce((sum, h) => sum + h.amount, 0n),
      ...(assetId && state.phases[assetId] ? { phase: state.phases[assetId]!.phase } : {}),
    })
    const chart = createActor(countersignMachine).start()
    chart.send({ type: 'TRANSFER', path })
    try {
      if (path.path === 'refuse') refuse(path.reason, path.message)
      const selected: CountersignHolding[] = []
      let covered = 0n
      for (const holding of [...free].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))) {
        if (covered >= path.amount) break
        selected.push(holding)
        covered += holding.amount
      }
      const tx = new Transaction()
      for (const holding of selected) {
        const [txid, vout] = holding.outpoint.split('.')
        const parent = await fullTx(active, txid!, state)
        if (!parent) throw new Error(`The source of ${holding.outpoint} is not available`)
        tx.addInput({
          sourceTransaction: parent,
          sourceTXID: txid!,
          sourceOutputIndex: Number(vout),
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff,
        })
      }
      const self = active.identityKey.toLowerCase()
      const root = rootKeyOf(active)
      const remittance = planHolderRemittance([
        { vout: 0, identityKey: path.recipient },
        ...(covered > path.amount ? [{ vout: 1, identityKey: self }] : []),
      ])
      const amounts = [path.amount, covered - path.amount]
      for (const output of remittance.outputs) {
        tx.addOutput({
          lockingScript: countersignedLock({
            assetId: path.assetId,
            amount: amounts[output.vout]!,
            holderPkhHex: holderPkhFor(root, path.assetId, remittance.prefix, output),
            sets: deploy!.sets,
          }),
          satoshis: 1,
        })
      }
      if (path.path === 'quorum') {
        // A cosigner's refusal of a request is final, so each attempt must be a new request. Every
        // sequence is final, which disables nLockTime: a past height only makes the bytes unique.
        tx.lockTime = Math.floor(Math.random() * 400_000)
      }
      selected.forEach((holding, vin) => {
        const key = holderKeyOf(active, holding)
        tx.inputs[vin]!.unlockingScript = holderUnlock(signInput(tx, vin, key, HOLDER_SCOPE), key.toPublicKey().toString())
      })
      // A quorum signs one fixed transaction, so the holder pays its fee.
      const feeCoins =
        path.path === 'quorum' ? await fundWithFeeCoins(active, tx, state, path.cosigners.threshold) : []
      if (feeCoins.length) await signFeeInputs(active, tx, feeCoins, selected.length)
      const efBytes = tx.toEF()
      const requestId = requestIdOf(efBytes)
      const ownRecipients = () => recipientEntries(root, path.assetId, remittance, self)
      chart.send({ type: 'SIGNED', requestId })
      const outgoing: OutgoingRequest = {
        requestId,
        assetId: path.assetId,
        efHex: Utils.toHex(efBytes),
        recipient: path.recipient,
        amount: path.amount.toString(),
        acceptors:
          path.path === 'remote-acceptor'
            ? path.acceptors
            : path.path === 'local-acceptor'
              ? [active.identityKey.toLowerCase()]
              : path.path === 'quorum'
                ? path.cosigners.keys
                : [],
        inputs: selected.map((h) => underscore(h.outpoint)),
        remittance,
        state: 'open',
        at: Date.now(),
        ...(path.path === 'quorum' ? { cosigners: path.cosigners, feeCoins: feeCoins.map(feeCoinKey) } : {}),
      }
      state.outgoing[requestId] = outgoing
      writeCountersignState(state)

      let ancestors: Promise<string | null> | null = null
      const requestWire = async (acceptor: string): Promise<Extract<Wire, { t: 'request' }>> => {
        const { MESSAGEBOX_BODY_MAX } = await import('../messageTransport')
        const ef = Utils.toBase64(efBytes)
        ancestors ??= atomicBeefFor(active, Transaction.fromEF(efBytes), readCountersignState())
          .then((bytes) => Utils.toBase64(bytes))
          .catch(() => null)
        const beef = await ancestors
        const recipients = await recipientEntries(root, path.assetId, remittance, acceptor)
        // Sealing grows the body, so the optional ancestors get what half the box cap leaves.
        const fits = beef != null && ef.length + beef.length + JSON.stringify(recipients).length < MESSAGEBOX_BODY_MAX / 2
        return { v: 1, t: 'request', token: path.assetId, ef, recipients, ...(fits ? { beef } : {}) }
      }
      let released = path.path === 'released'
      let decision: Decision =
        path.path === 'released'
          ? await countersignReleased(active, Transaction.fromEF(efBytes), path.keys, deploy!, state)
          : path.path === 'local-acceptor'
            ? await acceptRequest(active, { tx: Transaction.fromEF(efBytes), recipients: await ownRecipients(), requestId, prover: self })
            : path.path === 'quorum'
              ? await requestQuorum(
                  active,
                  outgoing,
                  requestWire,
                  path.selfCosigns
                    ? await cosignRequest(active, { tx: Transaction.fromEF(efBytes), recipients: await ownRecipients(), requestId, prover: self })
                    : null,
                )
              : await requestRemoteAcceptance(active, path.acceptors, requestWire, requestId)
      // A silent or retired issuer: the beacon chain says whether the release keys are out.
      if (
        (path.path === 'remote-acceptor' || path.path === 'quorum') &&
        (decision.kind === 'silent' || (decision.kind === 'refused' && decision.reason === 'not_acceptor'))
      ) {
        const phase = await refreshPhase(active, path.assetId).catch((err) => {
          console.warn('[countersign] beacon chain unread', err instanceof Error ? err.message : String(err))
          return null
        })
        if (phase?.phase === 'released') {
          // The holder signatures cover only their own input, so the asset inputs move to a release-funded spend.
          const assetOnly = Transaction.fromEF(efBytes)
          assetOnly.inputs = assetOnly.inputs.slice(0, selected.length)
          outgoing.efHex = Utils.toHex(assetOnly.toEF())
          delete outgoing.feeCoins
          delete outgoing.cosigners
          decision = await countersignReleased(active, assetOnly, phase.keys, deploy!, readCountersignState())
          released = true
        }
      }
      if (decision.kind === 'silent' || decision.kind === 'cosigned') {
        chart.send({ type: 'SILENT', error: 'acceptor-silent' })
        refuse(
          'acceptor-silent',
          path.path === 'quorum'
            ? `Fewer than ${path.cosigners.threshold} of ${path.cosigners.keys.length} cosigners have answered yet. Nothing was sent; the request stays open and completes when enough of them are back.`
            : 'The issuer has not answered yet. Nothing was sent; the request stays open and is answered when the issuer is back.',
        )
      }
      if (decision.kind === 'refused') {
        const next = readCountersignState()
        const refused: OutgoingRequest = { ...outgoing, state: 'refused', reason: decision.reason }
        if (refused.cancelPending?.includes(active.identityKey.toLowerCase())) {
          freeQuorumReservations(next, requestId)
          refused.cancelPending = refused.cancelPending.filter((k) => k !== active.identityKey.toLowerCase())
        }
        next.outgoing[requestId] = refused
        writeCountersignState(next)
        await sendQuorumCancels(active, refused)
        chart.send({ type: 'REFUSED', error: decision.reason })
        refuse('acceptor-refused', `${ACCEPT_REFUSAL_COPY[decision.reason]} Nothing was sent.`, decision.reason)
      }
      const filed = await completeAcceptedTransfer(active, outgoing, decision, chart, released)
      log('transfer', startedAt)
      return {
        ...filed,
        acceptedBy: released ? 'released' : path.path === 'local-acceptor' ? 'local' : path.path === 'quorum' ? 'quorum' : 'remote',
      }
    } catch (err) {
      chart.send({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      chart.stop()
    }
  }, undefined, { promote: false })
}

/** Register the countersigned transfer, file what pays us, deliver to the recipient. */
async function completeAcceptedTransfer(
  active: ActiveWallet,
  outgoing: OutgoingRequest,
  decision: Extract<Decision, { kind: 'accepted' }>,
  chart?: { send: (event: { type: 'ACCEPTED' | 'BROADCASTED'; txid: string } | { type: 'COMMITTED' }) => void },
  released = false,
): Promise<Omit<CountersignTransferResult, 'acceptedBy'>> {
  const state = readCountersignState()
  const deploys = deployMap(state)
  const request = Transaction.fromEF(Utils.toArray(outgoing.efHex, 'hex'))
  const accepted = decision.tx
  if (!acceptanceMatches(request, accepted, deploys)) {
    refuse('invalid-acceptance', 'The countersigned transaction is not this transfer. Nothing was filed.')
  }
  const txid = String(accepted.id('hex')).toLowerCase()
  chart?.send({ type: 'ACCEPTED', txid })
  let atomic = decision.atomic?.length ? decision.atomic : await atomicBeefFor(active, accepted, state)
  atomic = atomicBeefForSubject(atomic, txid) ?? atomic
  rememberBeefTree(atomic, txid)
  const { registerSignedSend, startSignedSendPropagation } = await import('../signedSendLifecycle')
  startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'countersign' }))
  chart?.send({ type: 'BROADCASTED', txid })
  const deploy = deploys.get(outgoing.assetId)!
  await fileResolvedOutputs(active, txid, atomic, accepted, deploys, deploy, heldHashes(active, accepted, ownRemittances(active, outgoing.remittance)))
  for (const outpoint of outgoing.inputs) {
    await active.wallet
      .relinquishOutput({ basket: countersignedSchemeFor(deploy.kind), output: outpoint.replace('_', '.') })
      .catch(() => {})
  }
  for (const coin of outgoing.feeCoins ?? []) {
    await active.wallet.relinquishOutput({ basket: FEE_BASKET, output: coin }).catch(() => {})
  }
  if (outgoing.recipient !== active.identityKey.toLowerCase()) {
    const outputs = outgoing.remittance ? deliveryOutputsFor(outgoing.remittance, outgoing.recipient) : []
    void deliverTransfer(active, outgoing.recipient, outgoing.assetId, accepted, atomic, {
      senderIdentityKey: active.identityKey.toLowerCase(),
      outputs,
    }).catch(() => {})
  }
  const next = readCountersignState()
  next.outgoing[outgoing.requestId] = { ...outgoing, state: 'accepted', txid }
  writeCountersignState(next)
  chart?.send({ type: 'COMMITTED' })
  const label = deploy.kind === 'item' ? deploy.fields.name ?? 'item' : `${outgoing.amount} ${deploy.fields.sym ?? 'units'}`
  recordAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'event',
    sats: 0,
    method: 'countersign-transfer',
    note: `Sent ${label} (${released ? 'released asset' : 'issuer accepted'})`,
    txid,
  })
  scheduleHistoryBackupPush('countersign')
  return { assetId: outgoing.assetId, txid, requestId: outgoing.requestId, amount: outgoing.amount, recipient: outgoing.recipient }
}

async function fileResolvedOutputs(
  active: ActiveWallet,
  txid: string,
  atomic: number[],
  tx: Transaction,
  deploys: Map<string, CountersignDeploy>,
  deploy: CountersignDeploy,
  held: ReadonlyMap<string, ColorRemittance | null>,
  /** Plain outputs of the same transaction this wallet keeps (a trade's offer token). */
  extra: ReadonlyArray<{ outputIndex: number; basket: string; tags: string[]; customInstructions?: string }> = [],
  /** More tags on this wallet's asset outputs, by output index. */
  extraTags: ReadonlyMap<number, string[]> = new Map(),
): Promise<number> {
  const resolved = resolveCountersignTransfer(tx, deploys, new Set(held.keys()))
  if (!resolved.ok || resolved.mine.length === 0) return 0
  const { withRestoredInternalizeStatus } = await import('../peerIngestHelpers')
  type Insertion = {
    outputIndex: number
    protocol: 'basket insertion'
    insertionRemittance: { basket: string; tags: string[]; customInstructions?: string }
  }
  const outputs: Insertion[] = resolved.mine.map((m) => ({
    outputIndex: m.vout,
    protocol: 'basket insertion',
    insertionRemittance: {
      basket: countersignedSchemeFor(deploys.get(m.assetId)!.kind),
      tags: [...countersignedTags(m.assetId, deploys.get(m.assetId)!, m.amount), ...(extraTags.get(m.vout) ?? [])],
      customInstructions: countersignedInstructions(
        m.assetId,
        deploys.get(m.assetId)!,
        m.amount,
        held.get(readCountersigned(tx.outputs[m.vout]!.lockingScript!)!.holderPkhHex),
      ),
    },
  }))
  for (const e of extra) {
    outputs.push({
      outputIndex: e.outputIndex,
      protocol: 'basket insertion',
      insertionRemittance: {
        basket: e.basket,
        tags: e.tags,
        ...(e.customInstructions ? { customInstructions: e.customInstructions } : {}),
      },
    })
  }
  await withRestoredInternalizeStatus(txid, () =>
    active.wallet.internalizeAction({
      tx: atomic,
      description: `Receive ${deploy.fields.sym ?? deploy.fields.name ?? 'asset'} (countersigned)`.slice(0, 50),
      labels: [LABEL],
      outputs,
    }),
  )
  return resolved.mine.length
}

async function deliverTransfer(
  active: ActiveWallet,
  recipient: string,
  assetId: string,
  tx: Transaction,
  atomic: number[],
  remittance: { senderIdentityKey: string; outputs: DeliveryOutput[] },
): Promise<void> {
  const { sendSealedToPeerBox, MESSAGEBOX_BODY_MAX } = await import('../messageTransport')
  const ef = Utils.toBase64(tx.toEF())
  const beef = Utils.toBase64(atomic)
  // A first-time recipient reads the key sets from the deploy; sealing grows
  // the body, so only half the box cap is spent on the optional parts.
  const deployHex = (await fullTx(active, assetId.slice(0, 64), readCountersignState()))?.toHex()
  const budget = MESSAGEBOX_BODY_MAX / 2
  const wire: Wire = {
    v: 1,
    t: 'transfer',
    token: assetId,
    ef,
    ...(remittance.outputs.length ? { senderIdentityKey: remittance.senderIdentityKey, outputs: remittance.outputs } : {}),
    ...(ef.length + beef.length < budget ? { beef } : {}),
    ...(deployHex && ef.length + beef.length + deployHex.length < budget ? { deploy: deployHex } : {}),
  }
  await sendSealedToPeerBox(active.rootKeyHex, recipient, COUNTERSIGN_BOX, JSON.stringify(wire))
}

// ── Trades ─────────────────────────────────────────────────────────────────

export type CountersignTradeResult = {
  /** The completed unlocking script of each asset input, by vin; also set on the transaction. */
  unlocks: UnlockingScript[]
  branch: CountersignBranch
  acceptedBy: 'local' | 'remote' | 'quorum' | 'released'
}

type Collected =
  | { kind: 'signed'; byKey: Map<string, number[][]> }
  | { kind: 'refused'; reason: AcceptRefusal }
  | { kind: 'silent' }

/**
 * Ask the countersigners of one fixed trade and wait until `set.threshold`
 * of them signed every asset input, too many refused, or the wait ran out.
 * `own` is this wallet's answer when it is one of them.
 */
async function collectCountersignatures(
  active: ActiveWallet,
  tx: Transaction,
  assetVins: number,
  set: KeySet,
  wireFor: (acceptor: string) => Promise<Extract<Wire, { t: 'request' }>>,
  requestId: string,
  own: Decision | null,
): Promise<Collected> {
  const self = active.identityKey.toLowerCase()
  const byKey = new Map<string, number[][]>()
  const refusedBy = new Map<string, AcceptRefusal>()
  const take = (key: string, answer: Decision): Collected | null => {
    if (answer.kind === 'cosigned') {
      const valid =
        answer.signatures.length === assetVins &&
        answer.signatures.every((signature, vin) => countersignatureValid(tx, vin, key, signature))
      if (valid) byKey.set(key, answer.signatures)
      else console.warn(`[countersign] ${key.slice(0, 12)} sent trade signatures that do not verify`)
    } else if (answer.kind === 'refused') {
      refusedBy.set(key, answer.reason)
    }
    if (byKey.size >= set.threshold) return { kind: 'signed', byKey }
    if (set.keys.length - refusedBy.size < set.threshold) {
      const reasons = new Set(refusedBy.values())
      return { kind: 'refused', reason: reasons.size === 1 ? [...reasons][0]! : 'quorum' }
    }
    return null
  }
  if (own) {
    const done = take(self, own)
    if (done) return done
  }
  const others = set.keys.filter((k) => k !== self)
  const { sendSealedToPeerBox, listSealedOwnBox, acknowledgeOwnBox } = await import('../messageTransport')
  let sent = 0
  for (const acceptor of others) {
    try {
      await sendSealedToPeerBox(active.rootKeyHex, acceptor, COUNTERSIGN_BOX, JSON.stringify(await wireFor(acceptor)))
      sent += 1
    } catch (err) {
      console.warn('[countersign] trade request send failed', acceptor.slice(0, 12), err instanceof Error ? err.message : String(err))
    }
  }
  if (sent === 0) return { kind: 'silent' }
  awaiting.add(requestId)
  try {
    const deadline = Date.now() + REMOTE_ACCEPT_WAIT_MS
    while (Date.now() < deadline) {
      const messages = (await listSealedOwnBox(active.rootKeyHex, COUNTERSIGN_BOX)) ?? []
      for (const m of messages) {
        const reply = parseWire(m.plaintext)
        if (!reply || !('request' in reply) || reply.request !== requestId || !others.includes(m.sender)) continue
        const answer = await decisionFromReply(reply, m.sender)
        await acknowledgeOwnBox(active.rootKeyHex, COUNTERSIGN_BOX, [m.messageId]).catch(() => {})
        if (!answer) continue
        const done = take(m.sender, answer)
        if (done) return done
      }
      await new Promise((resolve) => setTimeout(resolve, REMOTE_POLL_MS))
    }
    return { kind: 'silent' }
  } finally {
    awaiting.delete(requestId)
  }
}

function countersignaturesNeeded(path: CountersignSwapPath, deploy: CountersignDeploy): number {
  if (path.path === 'quorum') return path.cosigners.threshold
  if (path.path === 'released') return deploy.sets.release.threshold
  return 1
}

/**
 * Have the asset inputs of one fixed trade countersigned. Every asset input
 * comes first and carries its holder's `<sig> <pubkey>`; every input carries
 * its source. Whoever completes the trade asks (seller at list or cancel,
 * buyer at purchase): this wallet signs in process when it is the issuer,
 * the issuer or m of n cosigners answer peer to peer otherwise, and the
 * disclosed release keys sign once the asset is released. The requester
 * broadcasts. Callers hold the spend lease.
 */
export async function countersignTrade(args: {
  tx: Transaction
  assetId: string
  /** Who holds each asset output, proven to every acceptor by linkage. */
  remittance: HolderRemittance
}): Promise<CountersignTradeResult> {
  const startedAt = Date.now()
  const active = requireActive()
  const state = readCountersignState()
  const assetId = normalizeTokenId(args.assetId) ?? ''
  const deploy = assetId ? await deployFor(active, assetId, state) : null
  writeCountersignState(state)
  const deploys = deployMap(state)
  const { tx } = args
  const assetVins = assetInputCount(tx, deploys)
  const spendsOne = Array.from({ length: assetVins }, (_, vin) => assetOfInput(tx, vin, deploys)?.assetId).every(
    (id) => id === assetId,
  )
  if (!deploy || assetVins === 0 || !spendsOne) {
    refuse('bad-asset-args', 'A countersigned trade spends outputs of one known asset, before any other input.')
  }
  const holders = Array.from({ length: assetVins }, (_, vin) => readHolderUnlock(tx.inputs[vin]!.unlockingScript))
  if (holders.some((h) => !h)) refuse('bad-asset-args', 'Every asset input of a trade carries its holder signature.')
  const path = chooseCountersignSwapPath({
    deploy,
    identityKey: active.identityKey,
    ...(state.phases[assetId] ? { phase: state.phases[assetId]!.phase } : {}),
  })
  if (path.path === 'refuse') refuse(path.reason, path.message)
  const self = active.identityKey.toLowerCase()
  const root = rootKeyOf(active)
  const efBytes = tx.toEF()
  const requestId = requestIdOf(efBytes)
  let ancestors: Promise<string | null> | null = null
  const wireFor = async (acceptor: string): Promise<Extract<Wire, { t: 'request' }>> => {
    const { MESSAGEBOX_BODY_MAX } = await import('../messageTransport')
    const ef = Utils.toBase64(efBytes)
    ancestors ??= atomicBeefFor(active, Transaction.fromEF(efBytes), readCountersignState())
      .then((bytes) => Utils.toBase64(bytes))
      .catch(() => null)
    const beef = await ancestors
    const recipients = await recipientEntries(root, assetId, args.remittance, acceptor)
    const fits = beef != null && ef.length + beef.length + JSON.stringify(recipients).length < MESSAGEBOX_BODY_MAX / 2
    return { v: 1, t: 'request', token: assetId, ef, recipients, funding: 'sender', ...(fits ? { beef } : {}) }
  }
  const releaseSignatures = (keysHex: string[]): number[][][] => {
    const keys = disclosedReleaseKeys(keysHex, deploy!.sets.release)
    if (!keys) refuse('invalid-acceptance', 'The published release keys do not match this asset. Nothing was sent.')
    return Array.from({ length: assetVins }, (_, vin) => keys.map((key) => signInput(tx, vin, key, COUNTERSIGN_SCOPE)))
  }
  let branch: CountersignBranch = 'issuer'
  let acceptedBy: CountersignTradeResult['acceptedBy'] = 'released'
  let perVin: number[][][]
  if (path.path === 'released') {
    branch = 'release'
    perVin = releaseSignatures(path.keys)
  } else {
    const set: KeySet =
      path.path === 'quorum'
        ? path.cosigners
        : { threshold: 1, keys: path.path === 'local-acceptor' ? [self] : path.acceptors }
    const selfSigns = path.path === 'local-acceptor' || (path.path === 'quorum' && path.selfCosigns)
    const own = selfSigns
      ? await cosignRequest(
          active,
          { tx: Transaction.fromEF(efBytes), recipients: await recipientEntries(root, assetId, args.remittance, self), requestId, prover: self },
          { swap: true },
        )
      : null
    let answer = await collectCountersignatures(active, tx, assetVins, set, wireFor, requestId, own)
    let released: string[] | null = null
    if (
      path.path !== 'local-acceptor' &&
      (answer.kind === 'silent' || (answer.kind === 'refused' && answer.reason === 'not_acceptor'))
    ) {
      const phase = await refreshPhase(active, assetId).catch((err) => {
        console.warn('[countersign] beacon chain unread', err instanceof Error ? err.message : String(err))
        return null
      })
      if (phase?.phase === 'released') released = phase.keys
    }
    if (released) {
      branch = 'release'
      perVin = releaseSignatures(released)
    } else {
      if (answer.kind === 'silent') {
        refuse(
          'acceptor-silent',
          path.path === 'quorum'
            ? `Fewer than ${set.threshold} of ${set.keys.length} cosigners answered. Nothing was sent.`
            : 'The issuer has not answered. Nothing was sent.',
        )
      }
      if (answer.kind === 'refused') {
        refuse('acceptor-refused', `${ACCEPT_REFUSAL_COPY[answer.reason]} Nothing was sent.`, answer.reason)
      }
      answer = answer as Extract<Collected, { kind: 'signed' }>
      const byKey = answer.byKey
      perVin = Array.from({ length: assetVins }, (_, vin) =>
        quorumSignatures(set, new Map([...byKey].map(([key, sigs]) => [key, sigs[vin]!])))!,
      )
      acceptedBy = path.path === 'local-acceptor' ? 'local' : path.path === 'quorum' ? 'quorum' : 'remote'
    }
  }
  const unlocks = perVin.map((countersignatures, vin) => {
    const unlock = countersignedUnlock({
      countersignatures,
      branch,
      holderSignature: holders[vin]!.signature,
      holderPublicKey: holders[vin]!.publicKey,
    })
    tx.inputs[vin]!.unlockingScript = unlock
    if (!inputScriptValid(tx, vin)) throw new Error(`Countersigned trade input ${vin} does not verify`)
    return unlock
  })
  console.info(`[countersign] trade ${requestId.slice(0, 12)} countersigned (${acceptedBy}, ${assetVins} inputs)`)
  log('trade countersign', startedAt)
  return { unlocks, branch, acceptedBy }
}

/** One output of a trade this wallet funds: units held under a fresh `p color` child, or a plain output. */
export type TradeOutput =
  | { kind: 'asset'; amount: bigint; identityKey: string; tags?: string[] }
  | {
      kind: 'plain'
      lockingScript: string
      satoshis: number
      /** Filed with the asset outputs when this wallet keeps it (an offer token). */
      file?: { basket: string; tags: string[]; customInstructions?: string }
    }

/** A plain input this wallet signs ALL once the fee coins are in (an offer token). */
export type TradePlainInput = {
  outpoint: string
  sourceTransaction: Transaction
  sign: (tx: Transaction, vin: number) => Promise<UnlockingScript>
  /** The basket the toolbox files it in, told once the trade is out. */
  basket?: string
}

export type FundedTradeResult = {
  txid: string
  atomic: number[]
  tx: Transaction
  remittance: HolderRemittance
  acceptedBy: CountersignTradeResult['acceptedBy']
}

/**
 * Build, fund, countersign and broadcast a trade this wallet pays for: a
 * market listing (asset + offer token) or its cancel. Fee coins fund it so
 * the bytes are fixed before anyone countersigns, and a retry after an
 * unanswered attempt spends the same fee coins, which lets an acceptor that
 * did sign the first attempt sign the second. Callers hold the spend lease.
 */
export async function runFundedCountersignedTrade(args: {
  assetId: string
  holdings: CountersignHolding[]
  plainInputs?: TradePlainInput[]
  outputs: TradeOutput[]
  description: string
  flow: TransactionFlow
  /** Chart hooks: signed and recorded, countersigned, handed to the miners. */
  progress?: { staged?: (requestId: string) => void; countersigned?: () => void; broadcast?: (txid: string) => void }
}): Promise<FundedTradeResult> {
  const startedAt = Date.now()
  const active = requireActive()
  const state = readCountersignState()
  const assetId = normalizeTokenId(args.assetId) ?? ''
  const deploy = assetId ? await deployFor(active, assetId, state) : null
  if (!deploy) refuse('unknown-asset', 'This wallet has no deploy body for that asset.')
  if (args.holdings.length === 0 || args.holdings.some((h) => h.assetId !== assetId)) {
    refuse('bad-asset-args', 'A trade spends held outputs of the asset it names.')
  }
  const path = chooseCountersignSwapPath({
    deploy,
    identityKey: active.identityKey,
    ...(state.phases[assetId] ? { phase: state.phases[assetId]!.phase } : {}),
  })
  if (path.path === 'refuse') refuse(path.reason, path.message)
  const root = rootKeyOf(active)
  const tx = new Transaction()
  for (const holding of args.holdings) {
    const [txid, vout] = holding.outpoint.replace('_', '.').split('.')
    const parent = await fullTx(active, txid!, state)
    if (!parent) throw new Error(`The source of ${holding.outpoint} is not available`)
    tx.addInput({ sourceTransaction: parent, sourceTXID: txid!, sourceOutputIndex: Number(vout), unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  }
  for (const input of args.plainInputs ?? []) {
    const [txid, vout] = underscore(input.outpoint).split('_')
    tx.addInput({ sourceTransaction: input.sourceTransaction, sourceTXID: txid!, sourceOutputIndex: Number(vout), unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  }
  const remittance = planHolderRemittance(
    args.outputs.flatMap((output, vout) => (output.kind === 'asset' ? [{ vout, identityKey: output.identityKey }] : [])),
  )
  args.outputs.forEach((output, vout) => {
    if (output.kind === 'plain') {
      tx.addOutput({ lockingScript: LockingScript.fromHex(output.lockingScript), satoshis: output.satoshis })
      return
    }
    tx.addOutput({
      lockingScript: countersignedLock({
        assetId,
        amount: output.amount,
        holderPkhHex: holderPkhFor(root, assetId, remittance.prefix, remittance.outputs.find((o) => o.vout === vout)!),
        sets: deploy!.sets,
      }),
      satoshis: 1,
    })
  })
  // A refusal by a shared cosigner is final per request, so each attempt is new bytes.
  tx.lockTime = Math.floor(Math.random() * 400_000)
  const inputs = args.holdings.map((h) => underscore(h.outpoint))
  const prefer = Object.values(state.swaps)
    .filter((s) => s.state === 'abandoned' && s.inputs.some((i) => inputs.includes(i)))
    .flatMap((s) => s.feeCoins)
  const coins = await fundWithFeeCoins(active, tx, state, countersignaturesNeeded(path, deploy!), prefer)
  args.holdings.forEach((holding, vin) => {
    const key = holderKeyOf(active, holding)
    tx.inputs[vin]!.unlockingScript = holderUnlock(signInput(tx, vin, key, HOLDER_SCOPE), key.toPublicKey().toString())
  })
  const plainFrom = args.holdings.length
  for (const [i, input] of (args.plainInputs ?? []).entries()) {
    tx.inputs[plainFrom + i]!.unlockingScript = await input.sign(tx, plainFrom + i)
  }
  await signFeeInputs(active, tx, coins, plainFrom + (args.plainInputs?.length ?? 0))
  const requestId = requestIdOf(tx.toEF())
  state.swaps[requestId] = { requestId, assetId, inputs, feeCoins: coins.map(feeCoinKey), state: 'open', at: Date.now() }
  writeCountersignState(state)
  args.progress?.staged?.(requestId)
  let trade: CountersignTradeResult
  try {
    trade = await countersignTrade({ tx, assetId, remittance })
  } catch (err) {
    const next = readCountersignState()
    if (next.swaps[requestId]) next.swaps[requestId]!.state = 'abandoned'
    writeCountersignState(next)
    throw err
  }
  args.progress?.countersigned?.()
  const txid = String(tx.id('hex')).toLowerCase()
  const atomic = await atomicBeefFor(active, tx, readCountersignState())
  rememberBeefTree(atomic, txid)
  const { registerSignedSend, startSignedSendPropagation } = await import('../signedSendLifecycle')
  startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: args.flow }))
  args.progress?.broadcast?.(txid)
  const filed = readCountersignState()
  const deploys = deployMap(filed)
  const extra = args.outputs.flatMap((output, vout) =>
    output.kind === 'plain' && output.file ? [{ outputIndex: vout, ...output.file }] : [],
  )
  const extraTags = new Map(
    args.outputs.flatMap((output, vout) => (output.kind === 'asset' && output.tags?.length ? [[vout, output.tags] as const] : [])),
  )
  await fileResolvedOutputs(
    active,
    txid,
    atomic,
    tx,
    deploys,
    deploy!,
    heldHashes(active, tx, ownRemittances(active, remittance)),
    extra,
    extraTags,
  )
  for (const outpoint of inputs) {
    await active.wallet
      .relinquishOutput({ basket: countersignedSchemeFor(deploy!.kind), output: outpoint.replace('_', '.') })
      .catch(() => {})
  }
  for (const input of args.plainInputs ?? []) {
    if (!input.basket) continue
    await active.wallet.relinquishOutput({ basket: input.basket, output: underscore(input.outpoint).replace('_', '.') }).catch(() => {})
  }
  await relinquishFeeCoins(active, coins)
  const spentCoins = new Set(coins.map(feeCoinKey))
  for (const swap of Object.values(filed.swaps)) {
    if (swap.requestId === requestId || (swap.state === 'abandoned' && swap.feeCoins.some((c) => spentCoins.has(c)))) {
      swap.state = 'done'
    }
  }
  writeCountersignState(filed)
  scheduleHistoryBackupPush('countersign')
  log(`trade ${args.description}`, startedAt)
  return { txid, atomic, tx, remittance, acceptedBy: trade.acceptedBy }
}

/** A held countersigned output by outpoint, with its deploy, or null when this wallet does not hold it. */
export async function countersignedHoldingAt(
  active: ActiveWallet,
  outpoint: string,
): Promise<{ holding: CountersignHolding; deploy: CountersignDeploy; profile: CountersignedScheme } | null> {
  const target = underscore(outpoint)
  const holding = (await listCountersignedHoldings(active, undefined, { includeListed: true })).find(
    (h) => underscore(h.outpoint) === target,
  )
  if (!holding) return null
  const state = readCountersignState()
  const deploy = await deployFor(active, holding.assetId, state)
  if (!deploy) return null
  writeCountersignState(state)
  return { holding, deploy, profile: countersignedSchemeFor(deploy.kind) }
}

/** The deploy of a countersigned asset, read and kept, or null. */
export async function countersignedDeploy(active: ActiveWallet, assetId: string, bodyHex?: string): Promise<CountersignDeploy | null> {
  const state = readCountersignState()
  const id = normalizeTokenId(assetId)
  const deploy = id ? await deployFor(active, id, state, bodyHex) : null
  if (deploy) writeCountersignState(state)
  return deploy
}

/** The holder key of output `vout` of a trade this wallet planned. */
export function tradeHolderKey(active: ActiveWallet, assetId: string, remittance: HolderRemittance, vout: number): PrivateKey {
  const output = remittance.outputs.find((o) => o.vout === vout)
  if (!output) throw new Error(`Output ${vout} has no holder in this trade`)
  return holderPrivateKey(rootKeyOf(active), assetId, {
    derivationPrefix: remittance.prefix,
    derivationSuffix: output.derivationSuffix,
    senderIdentityKey: active.identityKey.toLowerCase(),
  })
}

/**
 * The output a buyer writes for units it receives in a trade: a countersigned
 * lock to a fresh `p color` child, and its csft / csnft filing.
 */
export function planCountersignedReceive(
  active: ActiveWallet,
  deploy: CountersignDeploy,
  vout: number,
  amount: bigint,
): { lockingScript: string; remittance: HolderRemittance; basket: CountersignedScheme; tags: string[]; customInstructions: string } {
  const self = active.identityKey.toLowerCase()
  const remittance = planHolderRemittance([{ vout, identityKey: self }])
  const output = remittance.outputs[0]!
  const lockingScript = countersignedLock({
    assetId: deploy.assetId,
    amount,
    holderPkhHex: holderPkhFor(rootKeyOf(active), deploy.assetId, remittance.prefix, output),
    sets: deploy.sets,
  }).toHex()
  return {
    lockingScript,
    remittance,
    basket: countersignedSchemeFor(deploy.kind),
    tags: countersignedTags(deploy.assetId, deploy, amount),
    customInstructions: countersignedInstructions(deploy.assetId, deploy, amount, {
      derivationPrefix: remittance.prefix,
      derivationSuffix: output.derivationSuffix,
      senderIdentityKey: self,
    }),
  }
}

// ── Box ────────────────────────────────────────────────────────────────────

function parseWire(plaintext: string | null): Wire | null {
  if (!plaintext) return null
  try {
    const msg = JSON.parse(plaintext) as Wire
    return msg && msg.v === 1 && typeof msg.t === 'string' && typeof msg.token === 'string' ? msg : null
  } catch {
    return null
  }
}

async function replyTo(active: ActiveWallet, to: string, wire: Wire): Promise<void> {
  const { sendSealedToPeerBox } = await import('../messageTransport')
  await sendSealedToPeerBox(active.rootKeyHex, to, COUNTERSIGN_BOX, JSON.stringify(wire))
}

async function answerRequest(active: ActiveWallet, sender: string, wire: Extract<Wire, { t: 'request' }>): Promise<void> {
  let efBytes: number[]
  let tx: Transaction
  try {
    efBytes = Utils.toArray(wire.ef, 'base64')
    tx = Transaction.fromEF(efBytes)
  } catch {
    return
  }
  const requestId = requestIdOf(efBytes)
  if (wire.beef) {
    try {
      rememberBeefTree(Utils.toArray(wire.beef, 'base64'), String(tx.id('hex')).toLowerCase())
    } catch {
      // Ancestors are a shortcut; inputAccepted fetches what it lacks.
    }
  }
  const recipients = readRecipientEntries(wire.recipients)
  const state = readCountersignState()
  const asset = assetOfInput(tx, 0, deployMap(state))
  const shared = asset ? state.acceptor[asset.assetId]?.shared === true : false
  const swap = wire.funding === 'sender'
  const holderRequest = { tx, recipients, requestId, prover: sender }
  const decision = await runExclusiveSpend(
    () =>
      swap || shared
        ? cosignRequest(active, holderRequest, swap ? { swap: true } : {})
        : acceptRequest(active, holderRequest),
    undefined,
    { promote: false },
  )
  if (decision.kind === 'cosigned') {
    await replyTo(active, sender, {
      v: 1,
      t: 'cosigned',
      token: wire.token,
      request: requestId,
      signatures: decision.signatures.map((s) => Utils.toHex(s)),
    })
    return
  }
  if (decision.kind === 'accepted') {
    const state = readCountersignState()
    const atomic = decision.atomic ?? (await atomicBeefFor(active, decision.tx, state))
    const txid = String(decision.tx.id('hex')).toLowerCase()
    if (!decision.atomic) rememberBeefTree(atomic, txid)
    const { registerSignedSend, startSignedSendPropagation } = await import('../signedSendLifecycle')
    if (decision.atomic) startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'countersign' }))
    await replyTo(active, sender, { v: 1, t: 'accepted', token: wire.token, request: requestId, ef: Utils.toBase64(Utils.toArray(decision.efHex, 'hex')), beef: Utils.toBase64(atomic) })
    for (const who of new Set(recipients.map((r) => r.identityKey))) {
      if (who === sender) continue
      const outputs = deliveryOutputsFromEntries(recipients, who)
      void deliverTransfer(active, who, wire.token, decision.tx, atomic, { senderIdentityKey: sender, outputs }).catch(() => {})
    }
    return
  }
  if (decision.kind === 'refused') {
    const signature = await signDecision(active, decisionPreimage('refused', wire.token, requestId, decision.reason))
    await replyTo(active, sender, { v: 1, t: 'refused', token: wire.token, request: requestId, reason: decision.reason, signature })
  }
}

async function answerCancel(active: ActiveWallet, sender: string, wire: Extract<Wire, { t: 'cancel' }>): Promise<void> {
  const state = readCountersignState()
  const prior = priorAcceptance(state, wire.request)
  const deploy = state.deploys[wire.token]
  if (state.acceptor[wire.token]?.shared && deploy) {
    // A cosigner's signature may already be part of a quorum, so only proof that none can form frees its reservation.
    const proven = wire.refusals && (await quorumImpossible(deploy.sets.issuer, wire.token, wire.request, wire.refusals))
    if (!proven && prior) {
      const signed = Transaction.fromEF(Utils.toArray(prior.efHex, 'hex'))
      const root = rootKeyOf(active)
      const signatures = Array.from({ length: assetInputCount(signed, deployMap(state)) }, (_, vin) =>
        Utils.toHex(signInput(signed, vin, root, COUNTERSIGN_SCOPE)),
      )
      await replyTo(active, sender, { v: 1, t: 'cosigned', token: wire.token, request: wire.request, signatures })
      return
    }
    freeQuorumReservations(state, wire.request)
    const record = state.acceptor[wire.token]!
    if (!record.cancelled.includes(wire.request)) record.cancelled.push(wire.request)
    writeCountersignState(state)
    const signature = await signDecision(active, decisionPreimage('cancelled', wire.token, wire.request))
    await replyTo(active, sender, { v: 1, t: 'cancelled', token: wire.token, request: wire.request, signature })
    return
  }
  if (prior) {
    await replyTo(active, sender, { v: 1, t: 'accepted', token: wire.token, request: wire.request, ef: Utils.toBase64(Utils.toArray(prior.efHex, 'hex')) })
    return
  }
  const record = state.acceptor[wire.token]
  if (!record) return
  if (!record.cancelled.includes(wire.request)) record.cancelled.push(wire.request)
  writeCountersignState(state)
  const signature = await signDecision(active, decisionPreimage('cancelled', wire.token, wire.request))
  await replyTo(active, sender, { v: 1, t: 'cancelled', token: wire.token, request: wire.request, signature })
}

/** Resolve a delivered transfer offline and file the outputs that pay us. */
async function ingestTransfer(active: ActiveWallet, wire: Extract<Wire, { t: 'transfer' }>): Promise<'filed' | 'invalid' | 'retry'> {
  let tx: Transaction
  try {
    tx = Transaction.fromEF(Utils.toArray(wire.ef, 'base64'))
  } catch {
    return 'invalid'
  }
  const state = readCountersignState()
  const deploy = await deployFor(active, wire.token, state, wire.deploy)
  if (!deploy) return 'retry'
  writeCountersignState(state)
  const deploys = deployMap(state)
  const held = heldHashes(active, tx, readDeliveryRemittance({ senderIdentityKey: wire.senderIdentityKey, outputs: wire.outputs }))
  const resolved = resolveCountersignTransfer(tx, deploys, new Set(held.keys()))
  if (!resolved.ok) {
    console.warn(`[countersign] transfer refused ${resolved.reason} — ${resolved.detail}`)
    return 'invalid'
  }
  if (resolved.mine.length === 0) return 'invalid'
  const txid = String(tx.id('hex')).toLowerCase()
  const holdings = await listCountersignedHoldings(active, wire.token)
  if (holdings.some((h) => h.outpoint.startsWith(txid))) return 'filed'
  // Accept-once ends at release: the holder could countersign another spend, so only mining is final.
  const releasedSpend =
    tx.inputs.some((input) => unlockBranch(input.unlockingScript) === 'release') ||
    resolved.assetIds.some((id) => state.phases[id]?.phase.phase === 'released')
  // A quorum transfer is funded by its sender, who could void it by double spending a fee input.
  const quorumSpend = resolved.assetIds.some((id) => isQuorum(deploys.get(id)!.sets.issuer))
  if ((releasedSpend || quorumSpend) && !(await minedYet(active, txid))) return 'retry'
  let atomic = wire.beef ? atomicBeefForSubject(Utils.toArray(wire.beef, 'base64'), txid) : undefined
  atomic ??= await atomicBeefFor(active, tx, state)
  try {
    rememberBeefTree(atomic, txid)
    await fileResolvedOutputs(active, txid, atomic, tx, deploys, deploy, held)
  } catch (err) {
    console.warn('[countersign] transfer filing deferred', err instanceof Error ? err.message : String(err))
    return 'retry'
  }
  const amount = resolved.mine.reduce((sum, m) => sum + m.amount, 0n)
  recordAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'event',
    sats: 0,
    method: 'countersign-receive',
    note: `Received ${deploy.kind === 'item' ? deploy.fields.name ?? 'item' : `${amount} ${deploy.fields.sym ?? 'units'}`} (${releasedSpend ? 'released asset, mined' : quorumSpend ? 'cosigners accepted, mined' : 'issuer accepted'})`,
    txid,
  })
  return 'filed'
}

async function settleOutgoing(active: ActiveWallet, sender: string, wire: Wire): Promise<void> {
  if (!('request' in wire)) return
  const state = readCountersignState()
  const outgoing = state.outgoing[wire.request]
  if (!outgoing || !outgoing.acceptors.includes(sender)) return
  const decision = await decisionFromReply(wire, sender)
  if (!decision || decision.kind === 'silent') return
  if (outgoing.cosigners) {
    if (outgoing.state === 'refused' && wire.t === 'cancelled' && decision.kind === 'refused') {
      state.outgoing[wire.request] = { ...outgoing, cancelPending: (outgoing.cancelPending ?? []).filter((k) => k !== sender) }
      writeCountersignState(state)
      return
    }
    if (outgoing.state !== 'open' || decision.kind === 'accepted') return
    const done = applyQuorumAnswer(outgoing, sender, decision)
    if (done?.kind === 'refused') {
      outgoing.state = 'refused'
      outgoing.reason = done.reason
      const self = active.identityKey.toLowerCase()
      if (outgoing.cancelPending?.includes(self)) {
        freeQuorumReservations(state, outgoing.requestId)
        outgoing.cancelPending = outgoing.cancelPending.filter((k) => k !== self)
      }
    }
    state.outgoing[wire.request] = outgoing
    writeCountersignState(state)
    if (done?.kind === 'refused') await sendQuorumCancels(active, outgoing)
    if (done?.kind === 'accepted') {
      await runExclusiveSpend(() => completeAcceptedTransfer(active, outgoing, done), undefined, { promote: false })
    }
    return
  }
  if (outgoing.state !== 'open') return
  if (decision.kind === 'cosigned') return
  if (decision.kind === 'refused') {
    state.outgoing[wire.request] = { ...outgoing, state: decision.detail === 'cancelled' ? 'cancelled' : 'refused', reason: decision.reason }
    writeCountersignState(state)
    return
  }
  await runExclusiveSpend(() => completeAcceptedTransfer(active, outgoing, decision), undefined, { promote: false })
}

const quorumSentAt = new Map<string, number>()

/**
 * An open quorum request is asked again of the cosigners that have not
 * answered, and a refused one's cancel of those that signed, every
 * `QUORUM_RESEND_MS`, so a cosigner offline at the first send still settles it.
 */
async function resendQuorumWork(active: ActiveWallet): Promise<void> {
  const self = active.identityKey.toLowerCase()
  for (const outgoing of Object.values(readCountersignState().outgoing)) {
    if (!outgoing.cosigners || Date.now() - (quorumSentAt.get(outgoing.requestId) ?? outgoing.at) < QUORUM_RESEND_MS) continue
    if (outgoing.state === 'open') {
      quorumSentAt.set(outgoing.requestId, Date.now())
      const answered = new Set([...Object.keys(outgoing.countersigs ?? {}), ...Object.keys(outgoing.refusals ?? {}), self])
      const ef = Utils.toBase64(Utils.toArray(outgoing.efHex, 'hex'))
      for (const cosigner of outgoing.cosigners.keys.filter((k) => !answered.has(k))) {
        const recipients = outgoing.remittance
          ? await recipientEntries(rootKeyOf(active), outgoing.assetId, outgoing.remittance, cosigner)
          : [{ vout: 0, identityKey: outgoing.recipient }]
        await replyTo(active, cosigner, { v: 1, t: 'request', token: outgoing.assetId, ef, recipients }).catch(() => {})
      }
    } else if (outgoing.state === 'refused' && outgoing.cancelPending?.length) {
      quorumSentAt.set(outgoing.requestId, Date.now())
      await sendQuorumCancels(active, outgoing)
    }
  }
}

let boxPolledAt = 0
let serving = false

/**
 * Serve box `countersign`: answer requests for assets this wallet issued,
 * settle decisions for requests that outlived their wait, and file delivered
 * transfers. A delivery is acknowledged only once filed or proven invalid.
 */
export async function serveCountersignBox(opts?: { force?: boolean }): Promise<void> {
  const active = currentActive()
  if (!active || serving) return
  // An account another device holds never answers or acknowledges its boxes.
  if (activeAccountSpendRefusal(active)) return
  const state = readCountersignState()
  const busy =
    Object.values(state.acceptor).some((r) => !r.ended) || Object.values(state.outgoing).some((r) => r.state === 'open')
  const now = Date.now()
  if (!opts?.force && now - boxPolledAt < (busy ? BOX_ACTIVE_POLL_MS : BOX_IDLE_POLL_MS)) return
  boxPolledAt = now
  serving = true
  try {
    const { listSealedOwnBox, acknowledgeOwnBox } = await import('../messageTransport')
    const messages = await listSealedOwnBox(active.rootKeyHex, COUNTERSIGN_BOX)
    if (!messages) return
    const acks: string[] = []
    for (const m of messages) {
      const wire = parseWire(m.plaintext)
      if (!wire) {
        if (m.messageId) acks.push(m.messageId)
        continue
      }
      try {
        if (wire.t === 'request') {
          await answerRequest(active, m.sender, wire)
          acks.push(m.messageId)
        } else if (wire.t === 'cancel') {
          await answerCancel(active, m.sender, wire)
          acks.push(m.messageId)
        } else if (wire.t === 'transfer') {
          const fate = await ingestTransfer(active, wire)
          if (fate !== 'retry') acks.push(m.messageId)
        } else if (wire.t === 'join') {
          await receiveInvite(active, m.sender, wire)
          acks.push(m.messageId)
        } else if (wire.t === 'beacon-sign') {
          await answerBeaconSign(active, m.sender, wire)
          acks.push(m.messageId)
        } else if (wire.t === 'beacon-signed') {
          await collectBeaconSignature(active, m.sender, wire)
          acks.push(m.messageId)
        } else if (!awaiting.has(wire.request)) {
          await settleOutgoing(active, m.sender, wire)
          acks.push(m.messageId)
        }
      } catch (err) {
        console.warn(`[countersign] box ${wire.t} failed`, err instanceof Error ? err.message : String(err))
      }
    }
    if (acks.length) await acknowledgeOwnBox(active.rootKeyHex, COUNTERSIGN_BOX, acks).catch(() => {})
    await resendQuorumWork(active).catch((err) => {
      console.warn('[countersign] quorum resend deferred', err instanceof Error ? err.message : String(err))
    })
    await refreshDueBeacons(active).catch((err) => {
      console.warn('[countersign] beacon refresh deferred', err instanceof Error ? err.message : String(err))
    })
  } finally {
    serving = false
  }
}

// ── Beacon ─────────────────────────────────────────────────────────────────

/**
 * Spend a beacon: fee coins fund it, `unlock` signs input 0 once every input
 * is in place, and it goes through the signed-send lifecycle.
 */
async function spendBeacon(
  active: ActiveWallet,
  state: CountersignState,
  args: {
    beacon: string
    parent: Transaction
    outputs: Array<{ lockingScript: ReturnType<typeof beaconLock>; satoshis: number }>
    signatures: number
    unlock: (tx: Transaction) => UnlockingScript
  },
): Promise<{ txid: string; tx: Transaction }> {
  const [beaconTxid, beaconVout] = args.beacon.split('_')
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: args.parent,
    sourceTXID: beaconTxid!,
    sourceOutputIndex: Number(beaconVout),
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  })
  for (const output of args.outputs) tx.addOutput(output)
  const coins = await fundWithFeeCoins(active, tx, state, args.signatures)
  tx.inputs[0]!.unlockingScript = args.unlock(tx)
  await signFeeInputs(active, tx, coins, 1)
  if (!inputScriptValid(tx, 0)) throw new Error('The beacon spend does not verify')
  const txid = String(tx.id('hex')).toLowerCase()
  const atomic = await atomicBeefFor(active, tx, state)
  rememberBeefTree(atomic, txid)
  await relinquishFeeCoins(active, coins)
  await active.wallet.relinquishOutput({ basket: BEACON_BASKET, output: `${beaconTxid}.${beaconVout}` }).catch(() => {})
  const { registerSignedSend, startSignedSendPropagation } = await import('../signedSendLifecycle')
  startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'countersign' }))
  return { txid, tx }
}

/**
 * Re-spend each beacon on the issuer branch at least every half silence
 * period. An issuer whose last refresh is older than the silence period has
 * lapsed for good and stops instead.
 */
async function refreshDueBeacons(active: ActiveWallet): Promise<void> {
  const state = readCountersignState()
  const self = active.identityKey.toLowerCase()
  const due = Object.values(state.acceptor).filter((record) => {
    const deploy = state.deploys[record.assetId]
    if (!deploy || record.ended) return false
    const sil = deploy.fields.sil * 1000
    if (!record.shared) return Date.now() - record.beaconAt > sil / 2
    if (record.beaconProposal) return Date.now() - record.beaconProposal.at > BEACON_PROPOSAL_RESEND_MS
    // Cosigners take turns by key order, so one proposal usually goes out per period.
    const turn = Math.max(0, deploy.sets.issuer.keys.indexOf(self))
    return Date.now() - record.beaconAt > sil / 2 + (turn * sil) / (4 * deploy.sets.issuer.keys.length)
  })
  for (const record of due.filter((r) => r.shared)) {
    await proposeSharedBeacon(active, record.assetId)
  }
  for (const record of due.filter((r) => !r.shared)) {
    await runExclusiveSpend(async () => {
      const deploy = state.deploys[record.assetId]!
      const lapsed = endedReason(record, deploy)
      if (lapsed) {
        const next = readCountersignState()
        if (next.acceptor[record.assetId]) next.acceptor[record.assetId]!.ended = lapsed
        writeCountersignState(next)
        console.warn(`[countersign] beacon ${record.assetId.slice(0, 12)} lapsed: this issuer stops countersigning`)
        return
      }
      const parent = await fullTx(active, record.beacon.slice(0, 64), state)
      if (!parent) throw new Error('The beacon body is not available')
      const root = rootKeyOf(active)
      const { txid, tx } = await spendBeacon(active, state, {
        beacon: record.beacon,
        parent,
        outputs: [{ lockingScript: beaconLock(deploy.sets), satoshis: 1 }],
        signatures: 1,
        unlock: (t) => beaconUnlock([signInput(t, 0, root, COUNTERSIGN_SCOPE)], 'issuer'),
      })
      const next = readCountersignState()
      const current = next.acceptor[record.assetId]
      if (!current) return
      current.beacon = `${txid}_0`
      current.beaconTxHex = tx.toHex()
      current.beaconAt = Date.now()
      writeCountersignState(next)
      console.info(`[countersign] beacon ${record.assetId.slice(0, 12)} refreshed → ${txid.slice(0, 12)}`)
    }, undefined, { promote: false })
  }
}

/**
 * A cosigner whose turn came proposes the next beacon: it funds the refresh,
 * signs input 0 and asks the other cosigners for theirs; the box completes
 * it (`collectBeaconSignature`). The chain is read first: a beacon another
 * cosigner already moved, or an asset no longer live, needs no proposal. A
 * proposal still short of a quorum is re-sent.
 */
async function proposeSharedBeacon(active: ActiveWallet, assetId: string): Promise<void> {
  const phase = await refreshPhase(active, assetId)
  if (!phase || phase.phase !== 'live') return
  const state = readCountersignState()
  const record = state.acceptor[assetId]
  const deploy = state.deploys[assetId]
  if (!record || !deploy) return
  const chainBeacon = state.phases[assetId]?.view.steps.at(-1)
  if (chainBeacon && chainBeacon.outpoint !== record.beacon) {
    record.beacon = chainBeacon.outpoint
    delete record.beaconTxHex
    record.beaconAt = chainBeacon.blockTime != null ? chainBeacon.blockTime * 1000 : Date.now()
    delete record.beaconProposal
    writeCountersignState(state)
    console.info(`[countersign] beacon ${assetId.slice(0, 12)} moved by another cosigner`)
    return
  }
  let proposal = record.beaconProposal
  if (!proposal) {
    proposal = await runExclusiveSpend(async () => {
      const startedAt = Date.now()
      const parent = await fullTx(active, record.beacon.slice(0, 64), state)
      if (!parent) throw new Error('The beacon body is not available')
      const [beaconTxid, beaconVout] = record.beacon.split('_')
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: parent,
        sourceTXID: beaconTxid!,
        sourceOutputIndex: Number(beaconVout),
        unlockingScript: new UnlockingScript(),
        sequence: 0xffffffff,
      })
      tx.addOutput({ lockingScript: beaconLock(deploy.sets), satoshis: 1 })
      const coins = await fundWithFeeCoins(active, tx, state, deploy.sets.issuer.threshold)
      await signFeeInputs(active, tx, coins, 1)
      const efHex = Utils.toHex(tx.toEF())
      const next: BeaconProposal = {
        proposal: requestIdOf(tx.toEF()),
        efHex,
        feeCoins: coins.map(feeCoinKey),
        signatures: { [active.identityKey.toLowerCase()]: Utils.toHex(signInput(tx, 0, rootKeyOf(active), COUNTERSIGN_SCOPE)) },
        at: Date.now(),
      }
      const latest = readCountersignState()
      if (latest.acceptor[assetId]) latest.acceptor[assetId]!.beaconProposal = next
      writeCountersignState(latest)
      log('beacon proposal', startedAt)
      return next
    }, undefined, { promote: false })
  } else {
    proposal.at = Date.now()
    writeCountersignState(state)
  }
  const wire: Wire = { v: 1, t: 'beacon-sign', token: assetId, ef: Utils.toBase64(Utils.toArray(proposal.efHex, 'hex')) }
  for (const cosigner of deploy.sets.issuer.keys.filter((k) => !proposal.signatures[k])) {
    await replyTo(active, cosigner, wire).catch((err) => {
      console.warn('[countersign] beacon proposal not sent', cosigner.slice(0, 12), err instanceof Error ? err.message : String(err))
    })
  }
}

/**
 * Sign another cosigner's beacon refresh: input 0 spends a beacon of this
 * asset and the only output is the next beacon. Signing two refreshes of one
 * beacon is harmless (one is mined), so there is no once-only rule; the
 * cosigner just stops proposing its own for now.
 */
async function answerBeaconSign(active: ActiveWallet, sender: string, wire: Extract<Wire, { t: 'beacon-sign' }>): Promise<void> {
  const state = readCountersignState()
  const record = state.acceptor[wire.token]
  const deploy = state.deploys[wire.token]
  if (!record?.shared || record.ended || !deploy || !deploy.sets.issuer.keys.includes(sender)) return
  let efBytes: number[]
  let tx: Transaction
  try {
    efBytes = Utils.toArray(wire.ef, 'base64')
    tx = Transaction.fromEF(efBytes)
  } catch {
    return
  }
  const lock = beaconLock(deploy.sets).toHex()
  const source = sourceOutputOf(tx, 0)
  const shaped =
    source?.lockingScript.toHex() === lock &&
    tx.outputs.length === 1 &&
    tx.outputs[0]!.satoshis === 1 &&
    tx.outputs[0]!.lockingScript?.toHex() === lock
  if (!shaped) {
    console.warn(`[countersign] beacon proposal from ${sender.slice(0, 12)} is not a refresh; not signed`)
    return
  }
  record.beaconAt = Math.max(record.beaconAt, Date.now())
  writeCountersignState(state)
  await replyTo(active, sender, {
    v: 1,
    t: 'beacon-signed',
    token: wire.token,
    proposal: requestIdOf(efBytes),
    signature: Utils.toHex(signInput(tx, 0, rootKeyOf(active), COUNTERSIGN_SCOPE)),
  })
}

/** Keep a cosigner's beacon signature; at the threshold, broadcast the refresh. */
async function collectBeaconSignature(active: ActiveWallet, sender: string, wire: Extract<Wire, { t: 'beacon-signed' }>): Promise<void> {
  const state = readCountersignState()
  const record = state.acceptor[wire.token]
  const deploy = state.deploys[wire.token]
  const proposal = record?.beaconProposal
  if (!record || !deploy || !proposal || proposal.proposal !== wire.proposal || !deploy.sets.issuer.keys.includes(sender)) return
  const tx = Transaction.fromEF(Utils.toArray(proposal.efHex, 'hex'))
  const signature = typeof wire.signature === 'string' ? Utils.toArray(wire.signature, 'hex') : []
  if (!countersignatureValid(tx, 0, sender, signature)) {
    console.warn(`[countersign] beacon signature from ${sender.slice(0, 12)} does not verify`)
    return
  }
  proposal.signatures[sender] = wire.signature
  const byKey = new Map(Object.entries(proposal.signatures).map(([key, sig]) => [key, Utils.toArray(sig, 'hex')]))
  const signatures = quorumSignatures(deploy.sets.issuer, byKey)
  if (!signatures) {
    writeCountersignState(state)
    return
  }
  await runExclusiveSpend(async () => {
    tx.inputs[0]!.unlockingScript = beaconUnlock(signatures, 'issuer')
    if (!inputScriptValid(tx, 0)) throw new Error('The beacon refresh does not verify')
    const txid = String(tx.id('hex')).toLowerCase()
    const atomic = await atomicBeefFor(active, tx, state)
    rememberBeefTree(atomic, txid)
    const { registerSignedSend, startSignedSendPropagation } = await import('../signedSendLifecycle')
    startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'countersign' }))
    for (const coin of proposal.feeCoins) {
      await active.wallet.relinquishOutput({ basket: FEE_BASKET, output: coin }).catch(() => {})
    }
    await active.wallet.relinquishOutput({ basket: BEACON_BASKET, output: record.beacon.replace('_', '.') }).catch(() => {})
    const next = readCountersignState()
    const current = next.acceptor[wire.token]
    if (current) {
      current.beacon = `${txid}_0`
      current.beaconTxHex = tx.toHex()
      current.beaconAt = Date.now()
      delete current.beaconProposal
    }
    writeCountersignState(next)
    console.info(`[countersign] beacon ${wire.token.slice(0, 12)} refreshed by quorum → ${txid.slice(0, 12)}`)
  }, undefined, { promote: false })
}

export type CountersignEndResult = {
  assetId: string
  /** Null when a cosigner of a shared issuer set withdraws: nothing goes on chain. */
  txid: string | null
  phase: 'ended' | 'released'
}

/** Spend `beacon` on the release branch, publishing the release keys this wallet holds. */
async function publishRelease(
  active: ActiveWallet,
  state: CountersignState,
  deploy: CountersignDeploy,
  beacon: string,
  parent: Transaction,
  keys: PrivateKey[],
): Promise<string> {
  const { txid } = await spendBeacon(active, state, {
    beacon,
    parent,
    outputs: [{ lockingScript: releaseDisclosureLock(deploy.assetId, keys), satoshis: 0 }],
    signatures: keys.length,
    unlock: (t) => beaconUnlock(keys.map((key) => signInput(t, 0, key, COUNTERSIGN_SCOPE)), 'release'),
  })
  const next = readCountersignState()
  next.deploys[deploy.assetId] ??= toStoredDeploy(deploy)
  const steps = next.phases[deploy.assetId]?.view.steps ?? [{ outpoint: beacon }]
  const keysHex = keys.map((key) => key.toHex())
  next.phases[deploy.assetId] = {
    view: { steps, release: { txid, keys: keysHex } },
    phase: { phase: 'released', txid, keys: keysHex },
    checkedAt: Date.now(),
  }
  const record = next.acceptor[deploy.assetId]
  if (record) record.ended = 'released'
  writeCountersignState(next)
  recordAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'event',
    sats: 0,
    method: 'countersign-release',
    note: `Released ${deploy.fields.sym ?? deploy.fields.name ?? 'asset'}: holders move it on their own signature`,
    txid,
  })
  scheduleHistoryBackupPush('countersign')
  console.info(`[countersign] ${deploy.assetId.slice(0, 12)} released → ${txid.slice(0, 12)}`)
  return txid
}

/**
 * The issuer stops accepting an asset for good. When this wallet also holds
 * the release keys it publishes them in the same step; otherwise it writes the
 * final beacon and a retire marker for the custodians to release.
 */
export async function retireCountersignedAsset(args: { assetId?: unknown }): Promise<CountersignEndResult> {
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const active = requireActive()
    const state = readCountersignState()
    const assetId = normalizeTokenId(String(args.assetId ?? ''))
    const record = assetId ? state.acceptor[assetId] : undefined
    const deploy = assetId ? deployMap(state).get(assetId) : undefined
    if (!assetId || !record || !deploy) refuse('not-issuer', 'This wallet did not issue that asset.')
    if (record.ended) refuse('asset-ended', `This asset has already ${record.ended === 'released' ? 'been released' : record.ended}.`)
    if (deploy.fields.col) refuse('bad-asset-args', 'A collection member retires with its collection.')
    if (record.shared) {
      // One cosigner cannot end a shared asset: it stops signing, and the asset ends once too few remain to refresh the beacon.
      record.ended = 'retired'
      delete record.beaconProposal
      writeCountersignState(state)
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'event',
        sats: 0,
        method: 'countersign-retire',
        note: `Stopped cosigning ${deploy.fields.sym ?? deploy.fields.name ?? 'asset'}`,
      })
      scheduleHistoryBackupPush('countersign')
      log('withdraw', startedAt)
      return { assetId, txid: null, phase: 'ended' as const }
    }
    const parent = await fullTx(active, record.beacon.slice(0, 64), state)
    if (!parent) throw new Error('The beacon body is not available')
    const held = releaseKeysHeld(active, deploy.sets.release)
    if (held) {
      const txid = await publishRelease(active, state, deploy, record.beacon, parent, held)
      log('retire', startedAt)
      return { assetId, txid, phase: 'released' as const }
    }
    const root = rootKeyOf(active)
    const { txid, tx } = await spendBeacon(active, state, {
      beacon: record.beacon,
      parent,
      outputs: [
        { lockingScript: beaconLock(deploy.sets), satoshis: 1 },
        { lockingScript: retireMarkerLock(assetId), satoshis: 0 },
      ],
      signatures: 1,
      unlock: (t) => beaconUnlock([signInput(t, 0, root, COUNTERSIGN_SCOPE)], 'issuer'),
    })
    const next = readCountersignState()
    const current = next.acceptor[assetId]!
    current.ended = 'retired'
    current.beacon = `${txid}_0`
    current.beaconTxHex = tx.toHex()
    current.beaconAt = Date.now()
    writeCountersignState(next)
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'event',
      sats: 0,
      method: 'countersign-retire',
      note: `Retired ${deploy.fields.sym ?? deploy.fields.name ?? 'asset'}: waiting for its custodians to release it`,
      txid,
    })
    scheduleHistoryBackupPush('countersign')
    log('retire', startedAt)
    return { assetId, txid, phase: 'ended' as const }
  }, undefined, { promote: false })
}

/**
 * A custodian publishes the release keys this wallet holds for an asset whose
 * issuer retired or lapsed. A live asset is never released, except by its own
 * issuer, for whom releasing is retiring.
 */
export async function releaseCountersignedAsset(args: { assetId?: unknown }): Promise<CountersignEndResult> {
  const active = requireActive()
  const assetId = normalizeTokenId(String(args.assetId ?? ''))
  if (!assetId) refuse('bad-asset-args', 'assetId must be an asset id (txid_vout).')
  const state = readCountersignState()
  const deploy = await deployFor(active, assetId, state)
  if (!deploy) refuse('unknown-asset', 'This wallet has no deploy body for that asset.')
  writeCountersignState(state)
  const held = releaseKeysHeld(active, deploy.sets.release)
  if (!held) refuse('not-custodian', 'This wallet holds no release key for that asset.')
  const own = state.acceptor[assetId]
  if (own && !own.ended && own.shared) {
    refuse(
      'asset-live',
      'Other cosigners still accept this asset. Retire stops this wallet cosigning; release keys go out only once the quorum stops refreshing the beacon.',
    )
  }
  if (own && !own.ended) return retireCountersignedAsset({ assetId })
  const phase = await refreshPhase(active, assetId)
  if (!phase) refuse('phase-unknown', 'The beacon chain could not be read. Try again shortly.')
  if (phase.phase === 'released') return { assetId, txid: phase.txid, phase: 'released' }
  if (phase.phase === 'live') {
    refuse('asset-live', 'The issuer is still live. Release keys are published only after it retires or its beacon lapses.')
  }
  return runExclusiveSpend(async () => {
    const startedAt = Date.now()
    const current = readCountersignState()
    const beacon = current.phases[assetId]?.view.steps.at(-1)?.outpoint
    const parent = beacon ? await fullTx(active, beacon.slice(0, 64), current) : null
    if (!beacon || !parent) throw new Error('The final beacon body is not available')
    const txid = await publishRelease(active, current, deploy, beacon, parent, held)
    log('release', startedAt)
    return { assetId, txid, phase: 'released' as const }
  }, undefined, { promote: false })
}

/** Keep an issuer's invitation to cosign; the deploy must name this wallet in a shared issuer set. */
async function receiveInvite(active: ActiveWallet, sender: string, wire: Extract<Wire, { t: 'join' }>): Promise<void> {
  const state = readCountersignState()
  const deploy = await deployFor(active, wire.token, state, wire.deploy)
  const self = active.identityKey.toLowerCase()
  const issuer = deploy?.sets.issuer
  if (!deploy || !issuer || !isQuorum(issuer) || !issuer.keys.includes(self) || !issuer.keys.includes(sender)) return
  if (!state.acceptor[wire.token]) state.invites[wire.token] = { assetId: wire.token, from: sender, at: Date.now() }
  writeCountersignState(state)
  console.info(`[countersign] invited to cosign ${wire.token.slice(0, 12)} by ${sender.slice(0, 12)}`)
}

/**
 * Become one of an asset's cosigners. The deploy must name this wallet in a
 * shared issuer set; from now on it answers transfer requests and beacon
 * proposals for the asset, and accepts outputs by proof (`inputAccepted`).
 */
export async function joinCountersignedAsset(args: { assetId?: unknown }): Promise<{
  assetId: string
  cosigners: KeySet
  joined: 'joined' | 'already'
}> {
  const active = requireActive()
  const assetId = normalizeTokenId(String(args.assetId ?? ''))
  if (!assetId) refuse('bad-asset-args', 'assetId must be an asset id (txid_vout).')
  const state = readCountersignState()
  const deploy = await deployFor(active, assetId, state)
  if (!deploy) refuse('unknown-asset', 'This wallet has no deploy body for that asset.')
  const self = active.identityKey.toLowerCase()
  if (!isQuorum(deploy.sets.issuer) || !deploy.sets.issuer.keys.includes(self)) {
    refuse('not-cosigner', 'That asset does not name this wallet as one of its cosigners.')
  }
  if (state.acceptor[assetId]) {
    if (state.acceptor[assetId]!.ended) refuse('asset-ended', 'This wallet stopped cosigning that asset.')
    return { assetId, cosigners: deploy.sets.issuer, joined: 'already' }
  }
  state.acceptor[assetId] = {
    assetId,
    accepted: [],
    spent: {},
    requests: {},
    cancelled: [],
    beacon: `${assetId.slice(0, 64)}_1`,
    beaconAt: Date.now(),
    shared: true,
  }
  delete state.invites[assetId]
  writeCountersignState(state)
  recordAppActivity({
    origin: WALLET_ACTIVITY_ORIGIN,
    kind: 'event',
    sats: 0,
    method: 'countersign-join',
    note: `Cosigning ${deploy.fields.sym ?? deploy.fields.name ?? 'asset'} (${deploy.sets.issuer.threshold} of ${deploy.sets.issuer.keys.length})`,
  })
  scheduleHistoryBackupPush('countersign')
  return { assetId, cosigners: deploy.sets.issuer, joined: 'joined' }
}

/** Assets this wallet issued or knows, with what it holds of each. */
export async function listCountersignedAssets(): Promise<{
  assets: Array<{
    assetId: string
    kind: 'token' | 'item'
    sym?: string
    name?: string
    supply: string
    held: string
    issuer: boolean
    acceptors: string[]
    /** The issuer set: how many of which cosigners countersign a transfer. */
    cosigners: KeySet
    phase: CountersignPhase['phase'] | 'unknown'
  }>
  /** Assets whose issuer named this wallet a cosigner; `joinCountersignedAsset` accepts. */
  invites: Array<{ assetId: string; from: string; at: number; cosigners: KeySet; sym?: string; name?: string }>
  /** This wallet's custodian key, for an issuer that names it in a release set. */
  releaseKey: string
}> {
  const active = requireActive()
  const state = readCountersignState()
  const holdings = await listCountersignedHoldings(active)
  const held = new Map<string, bigint>()
  for (const h of holdings) held.set(h.assetId, (held.get(h.assetId) ?? 0n) + h.amount)
  return {
    assets: Object.values(state.deploys).map((d) => ({
      assetId: d.assetId,
      kind: d.kind,
      ...(d.fields.sym ? { sym: d.fields.sym } : {}),
      ...(d.fields.name ? { name: d.fields.name } : {}),
      supply: d.supply,
      held: (held.get(d.assetId) ?? 0n).toString(),
      issuer: Boolean(state.acceptor[d.assetId]),
      acceptors: d.sets.issuer.keys,
      cosigners: d.sets.issuer,
      phase: state.acceptor[d.assetId]?.ended
        ? state.acceptor[d.assetId]!.ended === 'released'
          ? 'released'
          : 'ended'
        : state.phases[d.assetId]?.phase.phase ?? (state.acceptor[d.assetId] ? 'live' : 'unknown'),
    })),
    invites: Object.values(state.invites).flatMap((invite) => {
      const d = state.deploys[invite.assetId]
      if (!d || state.acceptor[invite.assetId]) return []
      return [{
        ...invite,
        cosigners: d.sets.issuer,
        ...(d.fields.sym ? { sym: d.fields.sym } : {}),
        ...(d.fields.name ? { name: d.fields.name } : {}),
      }]
    }),
    releaseKey: ownReleaseKey(active).toPublicKey().toString(),
  }
}
