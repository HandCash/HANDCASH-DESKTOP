import { Beef, KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { createActor } from 'xstate'
import { countersignMachine } from '../../machines/countersignMachine'
import { recordAppActivity, WALLET_ACTIVITY_ORIGIN } from '../appActivity'
import { atomicBeefForSubject, getBeefForTxidCached, getLocalBeefForTxid, rememberBeefTree } from '../beefCache'
import { scheduleHistoryBackupPush } from '../deviceSync'
import { COUNTERSIGNED_SCHEMES, countersignedSchemeFor, stampBrc164Id } from '../itemAccess'
import type { ActiveWallet } from '../session'
import { getWalletRuntime } from '../walletRuntime'
import { runExclusiveSpend } from '../spendGuard'
import { activeAccountSpendRefusal } from '../vaultAccountHolding'
import { normalizeTokenId } from '../token/types'
import {
  ACCEPT_REFUSAL_COPY,
  chooseCountersignTransferPath,
  CountersignError,
  type CountersignRefuse,
} from './path'
import { beaconPhase, readBeaconChain, type CountersignPhase } from './beacon'
import { whatsOnChainBeaconSource } from './beaconSource'
import { encodeCountersignPayload, MIN_SILENCE_SECONDS, type CountersignDeployFields } from './payload'
import {
  checkAcceptRequest,
  readCountersignDeploy,
  resolveCountersignTransfer,
  type AcceptRefusal,
  type CountersignDeploy,
} from './resolve'
import {
  beaconLock,
  beaconUnlock,
  contentLock,
  COUNTERSIGN_SCOPE,
  countersignDeployLock,
  countersignedLock,
  countersignedUnlock,
  disclosedReleaseKeys,
  HOLDER_SCOPE,
  holderUnlock,
  inputScriptValid,
  pubkeyHashHex,
  readCountersigned,
  readHolderUnlock,
  releaseDisclosureLock,
  requestIdOf,
  retireMarkerLock,
  signInput,
  unlockBranch,
  type CountersignKeySets,
  type KeySet,
} from './script'
import {
  deployMap,
  readCountersignState,
  toStoredDeploy,
  writeCountersignState,
  type AcceptorRecord,
  type CountersignState,
  type OutgoingRequest,
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
/** An unanswered request holds its inputs back from new transfers this long; the acceptor still refuses a second spend. */
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

type Wire =
  | { v: 1; t: 'request'; token: string; ef: string; recipients: Array<{ vout: number; identityKey: string }> }
  | { v: 1; t: 'accepted'; token: string; request: string; ef: string; beef?: string }
  | { v: 1; t: 'refused'; token: string; request: string; reason: AcceptRefusal; signature: string }
  | { v: 1; t: 'cancel'; token: string; request: string }
  | { v: 1; t: 'cancelled'; token: string; request: string; signature: string }
  | { v: 1; t: 'transfer'; token: string; ef: string; beef?: string; deploy?: string }

type Decision =
  | { kind: 'accepted'; tx: Transaction; efHex: string; atomic?: number[] }
  | { kind: 'refused'; reason: AcceptRefusal; detail?: string }
  | { kind: 'silent' }

export type CountersignHolding = {
  outpoint: string
  assetId: string
  amount: bigint
  lockingScript: string
}

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

/** A 1-of-1 release set on this wallet's own release key, when the caller names no custodians. */
function defaultRelease(active: ActiveWallet): KeySet {
  return { threshold: 1, keys: [ownReleaseKey(active).toPublicKey().toString()] }
}

/** The release keys this wallet can sign with, when they meet the threshold. */
function releaseKeysHeld(active: ActiveWallet, release: KeySet): PrivateKey[] | null {
  return disclosedReleaseKeys([ownReleaseKey(active).toHex()], release)
}

/** An issuer whose last refresh is older than the silence period has lapsed, whatever it broadcasts next. */
function endedReason(record: AcceptorRecord, deploy: StoredDeploy | undefined): AcceptorRecord['ended'] {
  if (record.ended) return record.ended
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
): Promise<CountersignHolding[]> {
  const pages = await Promise.all(
    COUNTERSIGNED_SCHEMES.map((basket) =>
      active.wallet.listOutputs({ basket, include: 'locking scripts', includeTags: true, limit: 1000 }),
    ),
  )
  const mine = selfPkh(active)
  return pages.flatMap((page) => page.outputs ?? []).flatMap((o) => {
    if (o.spendable === false || !o.lockingScript) return []
    const read = readCountersigned(o.lockingScript)
    if (!read || read.holderPkhHex !== mine) return []
    const id = read.assetId ?? underscore(o.outpoint)
    if (assetId && id !== assetId) return []
    return [{ outpoint: o.outpoint.replace('_', '.'), assetId: id, amount: read.amount, lockingScript: o.lockingScript }]
  })
}

function countersignedTags(assetId: string | null, deploy: Pick<CountersignDeploy, 'kind'>, amount: bigint): string[] {
  const scheme = countersignedSchemeFor(deploy.kind)
  return stampBrc164Id([assetId ? `${scheme}:${assetId}` : `${scheme}:deploy`, `amt:${amount}`])
}

function countersignedInstructions(
  assetId: string | null,
  deploy: { kind: string; fields: Pick<CountersignDeployFields, 'sym' | 'dec' | 'name' | 'col'> },
  amount: bigint,
): string {
  return JSON.stringify({
    ...(assetId ? { id: assetId } : {}),
    kind: deploy.kind,
    amt: amount.toString(),
    ...(deploy.fields.sym ? { sym: deploy.fields.sym } : {}),
    ...(deploy.fields.dec != null ? { dec: deploy.fields.dec } : {}),
    ...(deploy.fields.name ? { name: deploy.fields.name } : {}),
    ...(deploy.fields.col ? { col: deploy.fields.col } : {}),
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

/** Fee coins summing to at least `need`, minting a batch when short. */
async function takeFeeCoins(active: ActiveWallet, need: number): Promise<FeeCoin[]> {
  const pick = (coins: FeeCoin[]) => {
    const chosen: FeeCoin[] = []
    let sum = 0
    for (const coin of [...coins].sort((a, b) => b.satoshis - a.satoshis)) {
      if (sum >= need) break
      chosen.push(coin)
      sum += coin.satoshis
    }
    return sum >= need ? chosen : null
  }
  const first = pick(await listFeeCoins(active, new Set()))
  if (first) return first
  await mintFeeCoins(active)
  const second = pick(await listFeeCoins(active, new Set()))
  if (!second) throw new Error('Countersign fee inputs are not available yet')
  return second
}

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
): Promise<FeeCoin[]> {
  let feeCount = 1
  let coins = await takeFeeCoins(active, acceptorNeed(tx, feeCount, countersigs))
  if (coins.length > feeCount) {
    feeCount = coins.length
    coins = await takeFeeCoins(active, acceptorNeed(tx, feeCount, countersigs))
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

function releaseFrom(arg: unknown): KeySet | null {
  if (!arg || typeof arg !== 'object') return null
  const raw = arg as { threshold?: unknown; keys?: unknown }
  const keys = Array.isArray(raw.keys) ? raw.keys.map((k) => String(k).trim().toLowerCase()) : []
  return { threshold: Number(raw.threshold), keys }
}

export type IssueCountersignedArgs = {
  kind?: unknown
  sym?: unknown
  name?: unknown
  supply?: unknown
  dec?: unknown
  icon?: MediaArg
  content?: MediaArg
  /** Custodians' release set `{ threshold, keys }`; defaults to this wallet's own release key. */
  release?: unknown
  silenceSeconds?: unknown
}

/**
 * Deploy a countersigned token or item. This wallet's identity key is the
 * issuer (1-of-1) and the first holder; output 1 is the first beacon and an
 * item's content is output 2. Countersigning suits assets whose value comes
 * from their issuer; the release set frees holders once the issuer is gone.
 */
export async function issueCountersignedAsset(args: IssueCountersignedArgs): Promise<{
  assetId: string
  txid: string
  kind: 'token' | 'item'
  supply: string
  acceptor: string
  release: KeySet
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
      const sets: CountersignKeySets = {
        issuer: { threshold: 1, keys: [active.identityKey.toLowerCase()] },
        release: releaseFrom(args.release) ?? defaultRelease(active),
      }
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
      let deployLock: string
      try {
        deployLock = countersignDeployLock({
          supply: BigInt(supplyRaw),
          payload,
          holderPkhHex: selfPkh(active),
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
            customInstructions: countersignedInstructions(null, shape, BigInt(supplyRaw)),
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
      }
      writeCountersignState(state)
      // Transfers chain on this deploy, so miners see it first.
      await propagateSignedSend(handle).catch((err) => {
        console.warn('[countersign] deploy propagation queued', err instanceof Error ? err.message : String(err))
      })
      chart.send({ type: 'COMMITTED' })
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
        release: sets.release,
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

function priorAcceptance(state: CountersignState, requestId: string): { record: AcceptorRecord; efHex: string } | null {
  for (const record of Object.values(state.acceptor)) {
    const hit = record.requests[requestId]
    if (hit) return { record, efHex: hit.efHex }
  }
  return null
}

/**
 * Accept once: check the request, add a fee input, countersign every asset
 * input on the issuer branch, and record it in one durable write before
 * anything leaves this wallet. Callers hold the spend lease.
 */
async function acceptRequest(
  active: ActiveWallet,
  request: { tx: Transaction; recipients: Array<{ vout: number; identityKey: string }>; requestId: string },
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
  const accepted = new Set(Object.values(state.acceptor).flatMap((r) => r.accepted))
  const spentBy = (outpoint: string) =>
    Object.values(state.acceptor).find((r) => r.spent[outpoint])?.spent[outpoint]
  const check = checkAcceptRequest({
    tx: request.tx,
    deploys,
    answersFor: (assetId) => Boolean(state.acceptor[assetId] && !state.acceptor[assetId]!.ended),
    accepted,
    reservedBy: spentBy,
    requestId: request.requestId,
    recipients: request.recipients,
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
    const spentHere = check.inputs.filter((outpoint) => record.accepted.includes(outpoint))
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
  wire: Extract<Wire, { t: 'request' }>,
  requestId: string,
): Promise<Decision> {
  const { sendSealedToPeerBox, listSealedOwnBox, acknowledgeOwnBox } = await import('../messageTransport')
  let sent = 0
  for (const acceptor of acceptors) {
    try {
      await sendSealedToPeerBox(active.rootKeyHex, acceptor, COUNTERSIGN_BOX, JSON.stringify(wire))
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
  if (reply.t === 'refused') {
    const ok = await decisionSignedBy(sender, decisionPreimage('refused', reply.token, reply.request, reply.reason), reply.signature)
    return ok ? { kind: 'refused', reason: reply.reason } : null
  }
  if (reply.t === 'cancelled') {
    const ok = await decisionSignedBy(sender, decisionPreimage('cancelled', reply.token, reply.request), reply.signature)
    return ok ? { kind: 'refused', reason: 'policy', detail: 'cancelled' } : null
  }
  return null
}

/** The accepted transaction is the request plus only the acceptor's inputs, and it resolves. */
function acceptanceMatches(request: Transaction, accepted: Transaction, deploys: Map<string, CountersignDeploy>, mine: string): boolean {
  if (accepted.outputs.length !== request.outputs.length || accepted.inputs.length <= request.inputs.length) return false
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
  return sameOutputs && sameInputs && resolveCountersignTransfer(accepted, deploys, mine).ok
}

export type CountersignTransferResult = {
  assetId: string
  txid: string
  requestId: string
  amount: string
  recipient: string
  acceptedBy: 'local' | 'remote' | 'released'
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
        .filter((r) => r.state === 'open' && Date.now() - r.at < OPEN_REQUEST_RESERVE_MS)
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
      tx.addOutput({
        lockingScript: countersignedLock({
          assetId: path.assetId,
          amount: path.amount,
          holderPkhHex: pubkeyHashHex(path.recipient),
          sets: deploy!.sets,
        }),
        satoshis: 1,
      })
      if (covered > path.amount) {
        tx.addOutput({
          lockingScript: countersignedLock({
            assetId: path.assetId,
            amount: covered - path.amount,
            holderPkhHex: selfPkh(active),
            sets: deploy!.sets,
          }),
          satoshis: 1,
        })
      }
      const root = rootKeyOf(active)
      const signatures = tx.inputs.map((_, vin) => signInput(tx, vin, root, HOLDER_SCOPE))
      signatures.forEach((signature, vin) => {
        tx.inputs[vin]!.unlockingScript = holderUnlock(signature, active.identityKey.toLowerCase())
      })
      const efBytes = tx.toEF()
      const requestId = requestIdOf(efBytes)
      const recipients = [{ vout: 0, identityKey: path.recipient }]
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
              : [],
        inputs: selected.map((h) => underscore(h.outpoint)),
        state: 'open',
        at: Date.now(),
      }
      state.outgoing[requestId] = outgoing
      writeCountersignState(state)

      let released = path.path === 'released'
      let decision: Decision =
        path.path === 'released'
          ? await countersignReleased(active, Transaction.fromEF(efBytes), path.keys, deploy!, state)
          : path.path === 'local-acceptor'
            ? await acceptRequest(active, { tx: Transaction.fromEF(efBytes), recipients, requestId })
            : await requestRemoteAcceptance(
                active,
                path.acceptors,
                { v: 1, t: 'request', token: path.assetId, ef: Utils.toBase64(efBytes), recipients },
                requestId,
              )
      // A silent or retired issuer: the beacon chain says whether the release keys are out.
      if (
        path.path === 'remote-acceptor' &&
        (decision.kind === 'silent' || (decision.kind === 'refused' && decision.reason === 'not_acceptor'))
      ) {
        const phase = await refreshPhase(active, path.assetId).catch((err) => {
          console.warn('[countersign] beacon chain unread', err instanceof Error ? err.message : String(err))
          return null
        })
        if (phase?.phase === 'released') {
          decision = await countersignReleased(active, Transaction.fromEF(efBytes), phase.keys, deploy!, readCountersignState())
          released = true
        }
      }
      if (decision.kind === 'silent') {
        chart.send({ type: 'SILENT', error: 'acceptor-silent' })
        refuse(
          'acceptor-silent',
          'The issuer has not answered yet. Nothing was sent; the request stays open and is answered when the issuer is back.',
        )
      }
      if (decision.kind === 'refused') {
        const next = readCountersignState()
        next.outgoing[requestId] = { ...outgoing, state: 'refused', reason: decision.reason }
        writeCountersignState(next)
        chart.send({ type: 'REFUSED', error: decision.reason })
        refuse('acceptor-refused', `${ACCEPT_REFUSAL_COPY[decision.reason]} Nothing was sent.`, decision.reason)
      }
      const filed = await completeAcceptedTransfer(active, outgoing, decision, chart, released)
      log('transfer', startedAt)
      return { ...filed, acceptedBy: released ? 'released' : path.path === 'local-acceptor' ? 'local' : 'remote' }
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
  if (!acceptanceMatches(request, accepted, deploys, selfPkh(active))) {
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
  await fileResolvedOutputs(active, txid, atomic, accepted, deploys, deploy)
  for (const outpoint of outgoing.inputs) {
    await active.wallet
      .relinquishOutput({ basket: countersignedSchemeFor(deploy.kind), output: outpoint.replace('_', '.') })
      .catch(() => {})
  }
  if (outgoing.recipient !== active.identityKey.toLowerCase()) {
    void deliverTransfer(active, outgoing.recipient, outgoing.assetId, accepted, atomic).catch(() => {})
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
): Promise<number> {
  const resolved = resolveCountersignTransfer(tx, deploys, selfPkh(active))
  if (!resolved.ok || resolved.mine.length === 0) return 0
  const { withRestoredInternalizeStatus } = await import('../peerIngestHelpers')
  await withRestoredInternalizeStatus(txid, () =>
    active.wallet.internalizeAction({
      tx: atomic,
      description: `Receive ${deploy.fields.sym ?? deploy.fields.name ?? 'asset'} (countersigned)`.slice(0, 50),
      labels: [LABEL],
      outputs: resolved.mine.map((m) => ({
        outputIndex: m.vout,
        protocol: 'basket insertion' as const,
        insertionRemittance: {
          basket: countersignedSchemeFor(deploys.get(m.assetId)!.kind),
          tags: countersignedTags(m.assetId, deploys.get(m.assetId)!, m.amount),
          customInstructions: countersignedInstructions(m.assetId, deploys.get(m.assetId)!, m.amount),
        },
      })),
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
    ...(ef.length + beef.length < budget ? { beef } : {}),
    ...(deployHex && ef.length + beef.length + deployHex.length < budget ? { deploy: deployHex } : {}),
  }
  await sendSealedToPeerBox(active.rootKeyHex, recipient, COUNTERSIGN_BOX, JSON.stringify(wire))
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
  const decision = await runExclusiveSpend(
    () => acceptRequest(active, { tx, recipients: Array.isArray(wire.recipients) ? wire.recipients : [], requestId }),
    undefined,
    { promote: false },
  )
  if (decision.kind === 'accepted') {
    const state = readCountersignState()
    const atomic = decision.atomic ?? (await atomicBeefFor(active, decision.tx, state))
    const txid = String(decision.tx.id('hex')).toLowerCase()
    if (!decision.atomic) rememberBeefTree(atomic, txid)
    const { registerSignedSend, startSignedSendPropagation } = await import('../signedSendLifecycle')
    if (decision.atomic) startSignedSendPropagation(await registerSignedSend({ txid, atomicBeef: atomic, flow: 'countersign' }))
    await replyTo(active, sender, { v: 1, t: 'accepted', token: wire.token, request: requestId, ef: Utils.toBase64(Utils.toArray(decision.efHex, 'hex')), beef: Utils.toBase64(atomic) })
    for (const r of wire.recipients ?? []) {
      if (r.identityKey !== sender) void deliverTransfer(active, r.identityKey, wire.token, decision.tx, atomic).catch(() => {})
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
  const resolved = resolveCountersignTransfer(tx, deploys, selfPkh(active))
  if (!resolved.ok) {
    console.warn(`[countersign] transfer refused ${resolved.reason} — ${resolved.detail}`)
    return 'invalid'
  }
  if (resolved.mine.length === 0) return 'invalid'
  const txid = String(tx.id('hex')).toLowerCase()
  const held = await listCountersignedHoldings(active, wire.token)
  if (held.some((h) => h.outpoint.startsWith(txid))) return 'filed'
  // Accept-once ends at release: the holder could countersign another spend, so only mining is final.
  const releasedSpend =
    tx.inputs.some((input) => unlockBranch(input.unlockingScript) === 'release') ||
    resolved.assetIds.some((id) => state.phases[id]?.phase.phase === 'released')
  if (releasedSpend && !(await minedYet(active, txid))) return 'retry'
  let atomic = wire.beef ? atomicBeefForSubject(Utils.toArray(wire.beef, 'base64'), txid) : undefined
  atomic ??= await atomicBeefFor(active, tx, state)
  try {
    rememberBeefTree(atomic, txid)
    await fileResolvedOutputs(active, txid, atomic, tx, deploys, deploy)
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
    note: `Received ${deploy.kind === 'item' ? deploy.fields.name ?? 'item' : `${amount} ${deploy.fields.sym ?? 'units'}`} (${releasedSpend ? 'released asset, mined' : 'issuer accepted'})`,
    txid,
  })
  return 'filed'
}

async function settleOutgoing(active: ActiveWallet, sender: string, wire: Wire): Promise<void> {
  if (!('request' in wire)) return
  const state = readCountersignState()
  const outgoing = state.outgoing[wire.request]
  if (!outgoing || outgoing.state !== 'open' || !outgoing.acceptors.includes(sender)) return
  const decision = await decisionFromReply(wire, sender)
  if (!decision || decision.kind === 'silent') return
  if (decision.kind === 'refused') {
    state.outgoing[wire.request] = { ...outgoing, state: decision.detail === 'cancelled' ? 'cancelled' : 'refused', reason: decision.reason }
    writeCountersignState(state)
    return
  }
  await runExclusiveSpend(() => completeAcceptedTransfer(active, outgoing, decision), undefined, { promote: false })
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
        } else if (!awaiting.has(wire.request)) {
          await settleOutgoing(active, m.sender, wire)
          acks.push(m.messageId)
        }
      } catch (err) {
        console.warn(`[countersign] box ${wire.t} failed`, err instanceof Error ? err.message : String(err))
      }
    }
    if (acks.length) await acknowledgeOwnBox(active.rootKeyHex, COUNTERSIGN_BOX, acks).catch(() => {})
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
  const due = Object.values(state.acceptor).filter((record) => {
    const deploy = state.deploys[record.assetId]
    return deploy && !record.ended && Date.now() - record.beaconAt > (deploy.fields.sil * 1000) / 2
  })
  for (const record of due) {
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

export type CountersignEndResult = {
  assetId: string
  txid: string
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
  if (state.acceptor[assetId] && !state.acceptor[assetId]!.ended) return retireCountersignedAsset({ assetId })
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
    phase: CountersignPhase['phase'] | 'unknown'
  }>
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
      phase: state.acceptor[d.assetId]?.ended
        ? state.acceptor[d.assetId]!.ended === 'released'
          ? 'released'
          : 'ended'
        : state.phases[d.assetId]?.phase.phase ?? (state.acceptor[d.assetId] ? 'live' : 'unknown'),
    })),
    releaseKey: ownReleaseKey(active).toPublicKey().toString(),
  }
}
