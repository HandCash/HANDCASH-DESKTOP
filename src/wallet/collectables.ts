/**
 * Collectables = tips this device still holds as 1-sat UTXOs on its receive
 * address, surfaced through BRC-100 basket `1sat`.
 *
 * Basket rows alone are not ownership — they outlive a spend until something
 * releases them. The list is therefore basket tips ∩ live address 1-sat UTXOs.
 * Recursive inscription content (HTML/JS that loads other inscriptions) is still
 * a 1sat tip — same basket, same customInstructions remittance, same BRC-39
 * historyReplica. No second basket.
 */
import {
  Beef,
  P2PKH,
  PrivateKey,
  type SignableTransaction,
  type Transaction,
} from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  noteOutboundSendComplete,
  noteOutboundSendPending,
  failOutboundSendPending,
  reconcilePendingActivityWithHeldItems,
} from './appActivity'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from './pendingSend'
import {
  contentUrlForOrigin,
  resolveInscriptionAtOrigin,
  resolveInscriptionPreferringOrigin,
  type CollectableTrait,
  type ResolvedInscription,
} from './oneSatImport'
import { isBsv21Mime } from './bsv21'
import { resolvePaymentRecipient } from './friends'
import { assertOnlineForPayment } from './paymentPolicy'
import { runExclusiveSpend } from './spendGuard'
import { stampBrc164Id } from './itemAccess'
import { clearPaymentProgress, setPaymentProgress } from './paymentProgress'
import {
  clearAwaitingVerification,
  clearVerificationProgress,
  noteAwaitingVerification,
  peekPreferredCollectableVerification,
  preferCollectableVerification,
  setVerificationProgress,
  settleStaleAwaitingVerification,
  takePreferredCollectableVerification,
} from './verificationProgress'
import { announceItemVerified, announceItemsReceived } from './itemArrivalToast'
import { playWalletSound } from './soundService'
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  buildMergedInputBeef,
  getBeefForTxidCached,
  rememberBeefBinary,
  rememberBeefTree,
} from './beefCache'
import {
  buildCollectableCustomInstructions,
  extendProvenanceV2,
  parseProvenanceV2,
  rememberProvenanceRemittance,
  rememberProvenLineage,
  REMITTANCE_MAX_BEEF_BYTES,
  tryBuildProvenanceForSend,
  verifyProvenanceForHeldTip,
} from './oneSatProvenance'
import {
  authenticityResultToVerdict,
  type AuthenticityResult,
} from './oneSatAuthenticity'
import { scriptPaysAddress } from './ordinalOwnership'
import { resolveDerivativeContent } from './derivativeContentResolve'
import {
  liveOneSatKeys,
  outpointKey,
  partitionByLiveUtxos,
  OWNERSHIP_SETTLE_GRACE_MS,
  isOwnershipUnjudged,
} from './collectableOwnership'
import { ownershipFate } from './collectableOwnershipFate'
import {
  chooseSendPath,
  classifyTipKind,
  isCovenantLockedScript,
  normalizeLockingScriptHex,
  resolveTipLockingScriptHex,
} from './collectableTipKind'
import { collectableSendMachine } from './collectableSendMachine'
import {
  isSilentSenderBroadcast,
  maySenderBroadcast,
  mustDeliverToPeer,
  itemSendMachine,
} from './itemSendMachine'
import { chooseItemSettlePath, isPeerDeliverSettle } from './itemSettlePath'
import { createActor } from 'xstate'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { scanLegacyAddress } from './legacyScan'
import {
  isItemSent,
  markItemsSent,
  forgetItemsSent,
  type SentItemSettle,
} from './sentItemGuard'
import { yieldToUi } from './yieldToUi'
import {
  clearGenesisFailure,
  getProvenVerdict,
  rememberGenesisAttempt,
  rememberGenesisFailure,
  rememberProvenVerdict,
  shouldAttemptGenesis,
  authenticityFromProvenCache,
  type AuthenticityTier,
} from './provenCache'
import { listRecentActivity } from './appActivity'
import {
  describeGenesisWalk,
  proveGenesisLineage,
  walkGenesisLineage,
  type GenesisWalkOutcome,
} from './oneSatGenesisProof'
import { getWalletCoordinatorSnapshot } from './walletCoordinator'
import {
  getResolvedInscription,
  isThinResolution,
  PENDING_RETRY_MS,
  rememberResolvedInscription,
  rememberUnresolved,
  rememberUpgradeAttempt,
  RESOLVE_RETRY_MS,
  shouldResolveInscription,
  shouldUpgradeResolution,
} from './inscriptionCache'
import {
  durableGetItem,
  durableRemoveItem,
  durableSetItem,
} from './durableStorage'
import {
  isAlreadySpentInputError,
  hideSpentOutpoints,
} from './staleOutputRelease'
import type { Chain } from './vault'

export type { CollectableTrait }

export type Collectable = {
  /** Wallet outpoint `txid.vout` */
  outpoint: string
  /** Inscription origin `txid_vout` (child token identity for derivatives). */
  origin: string
  /**
   * Shared media outpoint for derivative / reference tips (Kit Kat pattern).
   * When set, UI loads `/content/<content>` instead of the child origin body.
   */
  content?: string
  name: string
  app?: string
  imageUrl: string
  satoshis: number
  mimeType?: string
  type?: string
  subType?: string
  collectionId?: string
  traits: CollectableTrait[]
  extras: CollectableTrait[]
  /** Complete BRC-150 tip→origin proof verified. */
  proven: boolean
  /** Exact proof tier used for this verdict. */
  authenticity: AuthenticityTier
  /** True when tip locking script is a stuck covenant (cannot be spent). */
  covenantLocked?: boolean
}

type CollectablesListener = (items: Collectable[]) => void

const LIST_CACHE_KEY = 'handcash.collectables.list.v1'
const SEEDED_ITEMS_KEY = 'handcash.collectables.seeded.v1'
/** Keep startup JSON bounded; the live basket is paged from IndexedDB. */
const DURABLE_LIST_LIMIT = 1_000
/** One page is small enough to paint without retaining an 800k-row wallet. */
const LIST_PAGE_SIZE = 1_000

/**
 * Toolbox 2.10 reports `outputs.length` (not offset + length) for a partial
 * page. Infer the terminal total from our own cursor; full pages get the real
 * count from Toolbox's count query.
 */
export function inferCollectableOutputTotal(args: {
  offset: number
  pageLength: number
  pageLimit: number
  reportedTotal: number | undefined
}): number {
  const reached = args.offset + args.pageLength
  if (args.pageLength < args.pageLimit) return reached
  const reported = Number.isFinite(args.reportedTotal)
    ? Math.max(0, Math.trunc(args.reportedTotal!))
    : reached
  return Math.max(reached, reported)
}

let cachedCollectables: Collectable[] = []
/** True after at least one successful list (even if empty), or a durable hit. */
let collectablesHydrated = false
const collectablesListeners = new Set<CollectablesListener>()
let listedOutputCursor = 0
let listedOutputTotal = 0

/**
 * Address UTXO scan is the ownership oracle. Cache it briefly so Collect and
 * chain ingest do not double-fetch the same tip set in one tick.
 */
const LIVE_ONE_SAT_TTL_MS = 20_000
let cachedLiveOneSats: { at: number; keys: Set<string> } | null = null
/** All address UTXOs — same TTL as one-sats. */
let cachedLiveAllOutpoints: { at: number; keys: Set<string> } | null = null

/** Feed a fresh address scan into the ownership filter (chain ingest). */
export function rememberLiveOneSatOutpoints(
  utxos: Array<{ outpoint: string; satoshis: number }>,
): void {
  const at = Date.now()
  cachedLiveOneSats = { at, keys: liveOneSatKeys(utxos) }
  cachedLiveAllOutpoints = {
    at,
    keys: new Set(utxos.map((u) => outpointKey(u.outpoint))),
  }
}

/** Drop a cached address scan so the next list re-checks the chain. */
export function invalidateLiveOneSatOutpoints(): void {
  cachedLiveOneSats = null
  cachedLiveAllOutpoints = null
}

function isCollectableShape(value: unknown): value is Collectable {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return (
    typeof o.outpoint === 'string' &&
    typeof o.origin === 'string' &&
    typeof o.name === 'string' &&
    typeof o.imageUrl === 'string' &&
    typeof o.satoshis === 'number'
  )
}

/** Identity the cached list was written for, when the payload records one. */
function durableListIdentity(): string | null {
  try {
    const raw = durableGetItem(LIST_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { identityKey?: unknown }
    return typeof parsed?.identityKey === 'string' ? parsed.identityKey : null
  } catch {
    return null
  }
}

function loadDurableList(): Collectable[] {
  try {
    const raw = durableGetItem(LIST_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { items?: unknown }
    if (!Array.isArray(parsed?.items)) return []
    return parsed.items.filter(isCollectableShape).map((item) => {
      // Verdict store outranks a stale list-cache badge from last session.
      const fromProven = authenticityFromProvenCache(item.outpoint)
      // Legacy caches may still carry `brc156` — read it forward as BRC-150.
      const rawAuth = item.authenticity as string
      const cachedAuth: AuthenticityTier =
        rawAuth === 'brc150' || rawAuth === 'brc156' ? 'brc150' : 'unproven'
      const authenticity = fromProven.proven
        ? fromProven.authenticity
        : cachedAuth
      return {
        ...item,
        traits: Array.isArray(item.traits) ? item.traits : [],
        extras: Array.isArray(item.extras) ? item.extras : [],
        proven: authenticity === 'brc150',
        authenticity,
      }
    })
  } catch {
    return []
  }
}

function persistDurableList(items: Collectable[]): void {
  try {
    const bounded = items.slice(0, DURABLE_LIST_LIMIT)
    durableSetItem(
      LIST_CACHE_KEY,
      JSON.stringify({
        at: Date.now(),
        identityKey: getActiveWallet()?.identityKey ?? null,
        items: bounded.map((item) => ({
          outpoint: item.outpoint,
          origin: item.origin,
          ...(item.content ? { content: item.content } : {}),
          name: item.name,
          app: item.app,
          imageUrl: item.imageUrl,
          satoshis: item.satoshis,
          mimeType: item.mimeType,
          type: item.type,
          subType: item.subType,
          collectionId: item.collectionId,
          traits: item.traits,
          extras: item.extras,
          proven: item.proven,
          authenticity: item.authenticity,
        })),
      }),
    )
  } catch {
    // Cache is an optimisation.
  }
}

// Paint last session's inventory immediately — do not wait on listOutputs.
{
  const durable = loadDurableList().filter((item) => !isItemSent(item.outpoint))
  if (durable.length > 0) {
    cachedCollectables = durable
    collectablesHydrated = true
  }
}

function notifyCollectables(items: Collectable[]) {
  for (const listener of collectablesListeners) listener(items)
}

/** createAction files the new tip before sign/broadcast finishes — suppress. */
let pauseCollectableArrivalToasts = 0
const skipArrivalToast = new Set<string>()
/** Tips a failed send just touched — do not ghost-relinquish them. */
const ghostDropProtectUntil = new Map<string, number>()
const GHOST_DROP_PROTECT_MS = 15 * 60_000

function protectTipsFromGhostDrop(outpoints: string[]): void {
  const until = Date.now() + GHOST_DROP_PROTECT_MS
  for (const raw of outpoints) {
    const op = outpointKey(raw)
    if (op) ghostDropProtectUntil.set(op, until)
  }
}

function isProtectedFromGhostDrop(outpoint: string): boolean {
  const op = outpointKey(outpoint)
  const until = ghostDropProtectUntil.get(op)
  if (!until) return false
  if (Date.now() > until) {
    ghostDropProtectUntil.delete(op)
    return false
  }
  return true
}

function setCollectablesCache(
  items: Collectable[],
  options: { announceArrivals?: boolean } = {},
) {
  const prev = new Set(
    cachedCollectables.map((i) => normalizeOutpoint(i.outpoint)),
  )
  const arrived = items
    .map((i) => normalizeOutpoint(i.outpoint))
    .filter((op) => !prev.has(op) && !skipArrivalToast.has(op))
  for (const op of [...skipArrivalToast]) {
    if (items.some((i) => normalizeOutpoint(i.outpoint) === op)) {
      skipArrivalToast.delete(op)
    }
  }
  cachedCollectables = items
  collectablesHydrated = true
  persistDurableList(items)
  // Activity Verifying… must not disagree with Collect. Held tips are ingested;
  // proven tips must not keep a pending Activity spinner.
  reconcilePendingActivityWithHeldItems(
    items.map((i) => ({
      outpoint: i.outpoint,
      proven: i.proven,
      name: i.name,
      origin: i.origin,
    })),
  )
  for (const item of items) {
    if (item.proven) clearAwaitingVerification(item.outpoint)
  }
  notifyCollectables(items)
  // Toast / chime / OS banner only once the card is on the list. Ingest used
  // to announce first; self-send then showed "Item received" on an empty grid.
  // Durable dedupe in announceItemsReceived skips unlock rediscovery.
  if (arrived.length === 0 || options.announceArrivals === false) return
  if (pauseCollectableArrivalToasts > 0) return
  void yieldToUi().then(() => {
    announceItemsReceived(arrived)
    try {
      playWalletSound('receive')
      document.dispatchEvent(
        new CustomEvent('handcash:receive', {
          detail: {
            title: arrived.length === 1 ? 'Item received' : 'Items received',
            body:
              arrived.length === 1
                ? 'A collectable landed in your wallet'
                : `${arrived.length} collectables landed in your wallet`,
          },
        }),
      )
    } catch {
      // Node tests / no DOM
    }
  })
}

export function clearCollectablesCache(): void {
  cachedCollectables = []
  collectablesHydrated = false
  listedOutputCursor = 0
  listedOutputTotal = 0
  cachedLiveOneSats = null
  cachedLiveAllOutpoints = null
  firstSeenAt.clear()
  seededItems.clear()
  loadedSeedIdentity = null
  durableRemoveItem(LIST_CACHE_KEY)
  durableRemoveItem(SEEDED_ITEMS_KEY)
  notifyCollectables([])
}

/**
 * localState was rebuilt under us (recompose, or a newer BRC-39 soft pull).
 *
 * The cached list is **stale, not known-empty**. Emptying it made a cold unlock
 * paint "Looking for collectables…" on a wallet that already held items, so the
 * rows stay on screen while the basket is re-read and replaced in place. Only a
 * cache written for a different identity is dropped — those items are not ours.
 */
export async function relistCollectablesAfterLocalStateReplace(): Promise<void> {
  const identityKey = getActiveWallet()?.identityKey ?? null
  const cachedFor = durableListIdentity()
  if (identityKey && cachedFor && cachedFor !== identityKey) {
    clearCollectablesCache()
  } else {
    invalidateLiveOneSatOutpoints()
  }
  try {
    await listCollectables()
  } catch (err) {
    console.warn('[collectables] re-list after localState replace failed', err)
  }
}

export function getCachedCollectables(): Collectable[] {
  return cachedCollectables.slice()
}

export function getCollectablePageStatus(): {
  loadedOutputs: number
  totalOutputs: number
  hasMore: boolean
} {
  return {
    loadedOutputs: listedOutputCursor,
    totalOutputs: listedOutputTotal,
    hasMore: listedOutputCursor < listedOutputTotal,
  }
}

export function areCollectablesHydrated(): boolean {
  return collectablesHydrated
}

export function subscribeCollectables(
  listener: CollectablesListener,
): () => void {
  collectablesListeners.add(listener)
  listener(getCachedCollectables())
  return () => {
    collectablesListeners.delete(listener)
  }
}

export function normalizeOutpoint(outpoint: string): string {
  return outpoint.includes('_') ? outpoint.replace(/_(\d+)$/, '.$1') : outpoint
}

export function shortOrigin(origin: string): string {
  const underscored = origin.includes('.')
    ? origin.replace(/\.(\d+)$/, '_$1')
    : origin
  const [txid, vout] = underscored.split('_')
  if (!txid) return origin
  return `${txid.slice(0, 8)}…_${vout ?? '?'}`
}

function tagValue(
  tags: string[] | undefined,
  prefix: string,
): string | undefined {
  if (!tags) return undefined
  const hit = tags.find((t) => t.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

function parseOrigin(
  raw: string | undefined,
  fallbackOutpoint: string,
): string {
  const source = raw?.trim() || fallbackOutpoint
  return source.includes('.') ? source.replace(/\.(\d+)$/, '_$1') : source
}

function parseCustom(raw: string | undefined): {
  origin?: string
  name?: string
  app?: string
  collectionId?: string
  content?: string
  provenance?: unknown
} {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const content =
      typeof o.content === 'string'
        ? o.content
        : typeof o.media === 'string'
        ? o.media
        : undefined
    return {
      origin: typeof o.origin === 'string' ? o.origin : undefined,
      name: typeof o.name === 'string' ? o.name : undefined,
      app: typeof o.app === 'string' ? o.app : undefined,
      collectionId:
        typeof o.collectionId === 'string' ? o.collectionId : undefined,
      content,
      provenance: o.provenance,
    }
  } catch {
    return {}
  }
}

function toCollectable(
  o: {
    outpoint: string
    satoshis: number
    tags?: string[]
    customInstructions?: string
    lockingScript?: string
  },
  chain: Chain,
  resolved?: Partial<ResolvedInscription> | null,
): Collectable {
  const custom = parseCustom(o.customInstructions)
  // List paints from tags + cached verdicts. Full BEEF verify runs automatically
  // Provenance verdict comes from durable cache; detail view verifies on demand.
  const verdict = getProvenVerdict(normalizeOutpoint(o.outpoint))
  const authenticity: AuthenticityTier = verdict?.tier ?? 'unproven'
  const proven = authenticity === 'brc150'
  const claimed = tagValue(o.tags, 'origin:') ?? custom.origin
  // An indexer walk that came back with real inscription content knows the
  // lineage; a remittance origin is only the sender's claim, and a wrong one
  // paints a 404 image forever.
  const trustWalk = !isThinResolution(resolved)
  const origin = parseOrigin(
    // A lineage proof outranks both: it is the only origin this wallet verified.
    verdict?.origin ??
      (trustWalk ? resolved?.origin ?? claimed : claimed ?? resolved?.origin),
    o.outpoint,
  )
  // Tags are not display text: @bsv/sdk validateTag lowercases them, so a
  // `name:` / `app:` tag is only a flattened search key. Prefer the resolution
  // cache and remittance, which keep the original casing.
  const name =
    resolved?.name ??
    custom.name ??
    tagValue(o.tags, 'name:') ??
    shortOrigin(origin)
  const app = resolved?.app ?? custom.app ?? tagValue(o.tags, 'app:')
  const content =
    resolveDerivativeContent({
      claimed:
        custom.content ??
        tagValue(o.tags, 'content:') ??
        (resolved as { content?: string } | null | undefined)?.content,
    }) ?? undefined
  const mediaOrigin = content ?? origin
  return {
    outpoint: normalizeOutpoint(o.outpoint),
    origin,
    ...(content ? { content } : {}),
    name: name.trim() || shortOrigin(origin),
    app,
    imageUrl: contentUrlForOrigin(mediaOrigin, chain),
    satoshis: o.satoshis,
    mimeType: resolved?.mimeType,
    type: resolved?.type,
    subType: resolved?.subType,
    collectionId: resolved?.collectionId,
    traits: resolved?.traits ?? [],
    extras: resolved?.extras ?? [],
    proven,
    authenticity,
    covenantLocked: isCovenantLockedScript(o.lockingScript),
  }
}

/**
 * An origin has exactly one live tip. Stray 1-sat outputs from the same
 * transfer resolve to the tip's origin through the indexer walk and would
 * otherwise list as duplicates. Keep the best candidate: proven remittance
 * first, then sender-supplied metadata, then lowest vout.
 */
/**
 * One ordinal, one card — keeping the tip the wallet holds now.
 *
 * A satoshi cannot sit in two outputs, so two listed tips sharing an origin means
 * one of them is basket residue the live-UTXO review has not judged yet. Which is
 * which is a question about time, not about metadata: the tip seen most recently
 * is the transfer that just landed. Ranking by metadata first is how a freshly
 * received item disappeared behind a richer-looking stale sibling as soon as
 * lineage proofs started giving both of them the same, correct origin.
 */
export function dedupeByOrigin(
  items: Collectable[],
  seenAtFor: (outpoint: string) => number = () => 0,
): Collectable[] {
  const rank = (c: Collectable): number => {
    let score = 0
    if (c.proven) score += 4
    if (c.name && c.name !== shortOrigin(c.origin)) score += 2
    if (c.app) score += 1
    return score
  }
  const vout = (c: Collectable): number => {
    const n = Number(c.outpoint.split('.')[1])
    return Number.isInteger(n) ? n : Number.MAX_SAFE_INTEGER
  }
  const seenAt = (c: Collectable): number => seenAtFor(c.outpoint)

  const best = new Map<string, Collectable>()
  const order: string[] = []
  for (const item of items) {
    const key = item.origin.toLowerCase()
    const prior = best.get(key)
    if (!prior) {
      best.set(key, item)
      order.push(key)
      continue
    }
    const better =
      seenAt(item) !== seenAt(prior)
        ? seenAt(item) > seenAt(prior)
        : rank(item) > rank(prior) ||
          (rank(item) === rank(prior) && vout(item) < vout(prior))
    if (better) best.set(key, item)
  }
  return order.map((key) => best.get(key)!)
}

type ItemOutput = {
  outpoint: string
  satoshis: number
  tags?: string[]
  lockingScript?: string
}

/** Kept so a late resolution can rebuild the list without re-listing outputs. */
let lastItemOutputs: ItemOutput[] = []
let lastItemChain: Chain = 'main'
let resolvingOrigins = false

/** One address scan in flight at a time — Collect and ingest share the answer. */
let liveScan: Promise<void> | null = null

function refreshLiveOneSatKeys(wallet: ActiveWallet): void {
  if (liveScan != null) return
  liveScan = scanLegacyAddress(wallet)
    .then((scan) => {
      rememberLiveOneSatOutpoints(scan.utxos)
      // The rows on screen were filtered against a stale set (or none) — list
      // again now that the chain has answered, so ghosts leave without a tap.
      void listCollectables(wallet)
    })
    .catch((err) => {
      console.warn(
        '[collectables] address UTXO scan failed — keeping basket list',
        err,
      )
    })
    .finally(() => {
      liveScan = null
    })
}

/** Await a fresh address UTXO set (send path — missing-inputs is worse than waiting). */
async function awaitLiveOutpoints(wallet: ActiveWallet): Promise<{
  oneSats: Set<string>
  all: Set<string>
} | null> {
  if (
    cachedLiveOneSats != null &&
    cachedLiveAllOutpoints != null &&
    Date.now() - cachedLiveOneSats.at < LIVE_ONE_SAT_TTL_MS
  ) {
    return {
      oneSats: cachedLiveOneSats.keys,
      all: cachedLiveAllOutpoints.keys,
    }
  }
  try {
    const scan = await scanLegacyAddress(wallet)
    rememberLiveOneSatOutpoints(scan.utxos)
    if (!cachedLiveOneSats || !cachedLiveAllOutpoints) return null
    return {
      oneSats: cachedLiveOneSats.keys,
      all: cachedLiveAllOutpoints.keys,
    }
  } catch (err) {
    console.warn('[collectables] live UTXO await failed', err)
    if (!cachedLiveOneSats || !cachedLiveAllOutpoints) return null
    return {
      oneSats: cachedLiveOneSats.keys,
      all: cachedLiveAllOutpoints.keys,
    }
  }
}

/**
 * Chain-authoritative retry gate for an item tip.
 *
 * The basket may still mark a signed/noSend input as spent while its transaction
 * remains unbroadcast. A fresh address scan answers the question that matters:
 * whether this wallet's original 1-sat output is still an unspent candidate.
 */
export async function isCollectableOutpointSpendable(
  outpoint: string,
  active: ActiveWallet | null = getActiveWallet(),
): Promise<boolean | null> {
  if (!active) return null
  const live = await awaitLiveOutpoints(active)
  if (!live) return null
  return live.oneSats.has(outpointKey(normalizeOutpoint(outpoint)))
}

/**
 * The live 1-sat set, but only if we already have it.
 *
 * Opening Collect must never wait on the network. A provider that is being
 * throttled answers in tens of seconds, and awaiting it here put that delay
 * between the tap and the grid. The basket rows paint immediately against
 * whatever we last learned, and the scan lands as a second render.
 */
function resolveLiveOneSatKeys(
  wallet: ActiveWallet,
): { at: number; keys: Set<string> } | null {
  const fresh =
    cachedLiveOneSats != null &&
    Date.now() - cachedLiveOneSats.at < LIVE_ONE_SAT_TTL_MS
  if (!fresh) refreshLiveOneSatKeys(wallet)
  return cachedLiveOneSats
}

/**
 * When each tip was first seen in the basket.
 *
 * A scan can only testify about the address as it was when it ran. Judging a
 * tip that arrived after it would hide the very item the user is waiting for —
 * an import lands, the basket has it, and a minutes-old scan does not.
 */
const firstSeenAt = new Map<string, number>()

/**
 * Tips this wallet knows it holds before `listOutputs` will admit it.
 *
 * `buildItems` rebuilds the grid purely from the basket read, so seeding a card
 * into the cache is not enough on its own: the very next list erases it. A tip
 * created by our own `createAction` is not a guess — we hold it — so it is
 * carried into each rebuild until the basket returns it and the real row takes
 * over. Bounded by {@link SEEDED_ITEM_TTL_MS} and dropped the moment the tip is
 * spent, so a row can never outlive the truth.
 */
const seededItems = new Map<string, ItemOutput>()

/**
 * How long a locally seeded tip is carried before the basket must confirm it.
 *
 * Toolbox can keep an internalized, unmined item out of `listOutputs` for longer
 * than five minutes. The wallet already accepted custody before a seed is
 * created, so keep that fact across renderer restarts and allow the monitor a
 * full half hour to settle. Sent tips still leave immediately.
 */
const SEEDED_ITEM_TTL_MS = 30 * 60_000
let loadedSeedIdentity: string | null = null

type DurableSeed = {
  outpoint: string
  satoshis: number
  tags?: string[]
  seenAt: number
}

function persistSeededItems(identityKey: string): void {
  const items: DurableSeed[] = []
  for (const [key, output] of seededItems) {
    items.push({
      outpoint: output.outpoint,
      satoshis: output.satoshis,
      ...(output.tags ? { tags: output.tags } : {}),
      seenAt: firstSeenAt.get(key) ?? Date.now(),
    })
  }
  durableSetItem(
    SEEDED_ITEMS_KEY,
    JSON.stringify({ identityKey, items }),
  )
}

/** Restore only seeds created by this identity; another wallet's tips are never ours. */
function hydrateSeededItems(identityKey: string): void {
  if (loadedSeedIdentity === identityKey) return
  seededItems.clear()
  loadedSeedIdentity = identityKey
  try {
    const raw = durableGetItem(SEEDED_ITEMS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as {
      identityKey?: unknown
      items?: unknown
    }
    if (parsed.identityKey !== identityKey || !Array.isArray(parsed.items)) {
      return
    }
    const now = Date.now()
    for (const candidate of parsed.items) {
      if (!candidate || typeof candidate !== 'object') continue
      const seed = candidate as Partial<DurableSeed>
      if (
        typeof seed.outpoint !== 'string' ||
        typeof seed.satoshis !== 'number' ||
        typeof seed.seenAt !== 'number' ||
        now - seed.seenAt >= SEEDED_ITEM_TTL_MS ||
        isItemSent(seed.outpoint)
      ) {
        continue
      }
      const output: ItemOutput = {
        outpoint: normalizeOutpoint(seed.outpoint),
        satoshis: seed.satoshis,
        ...(Array.isArray(seed.tags)
          ? { tags: seed.tags.filter((tag): tag is string => typeof tag === 'string') }
          : {}),
      }
      const key = outpointKey(output.outpoint)
      seededItems.set(key, output)
      firstSeenAt.set(key, seed.seenAt)
    }
    if (seededItems.size > 0) {
      console.info(
        `[collectables] restored ${seededItems.size} pending received item seed(s)`,
      )
    }
    persistSeededItems(identityKey)
  } catch {
    durableRemoveItem(SEEDED_ITEMS_KEY)
  }
}

/** Seeded rows the basket has not returned yet, minus anything already spent. */
function pendingSeededItems(
  outputs: ItemOutput[],
  now: number,
  identityKey: string,
): ItemOutput[] {
  hydrateSeededItems(identityKey)
  if (seededItems.size === 0) return []
  const listed = new Set(outputs.map((o) => outpointKey(o.outpoint)))
  const pending: ItemOutput[] = []
  let changed = false
  for (const [key, output] of seededItems) {
    const seenAt = firstSeenAt.get(key) ?? 0
    if (listed.has(key) || isItemSent(output.outpoint)) {
      seededItems.delete(key)
      changed = true
      continue
    }
    if (now - seenAt >= SEEDED_ITEM_TTL_MS) {
      seededItems.delete(key)
      changed = true
      continue
    }
    pending.push(output)
  }
  if (changed) persistSeededItems(identityKey)
  return pending
}

/**
 * Paint a tip the wallet just took custody of, before `listOutputs` catches up.
 *
 * Whether it arrived by `internalizeAction` or by a send to our own handle, the
 * basket read and the address scan behind it take seconds; until they land,
 * Activity shows the arrival against a Collect grid that is missing the card.
 * Seeding also routes the arrival through `setCollectablesCache`, which is the
 * one place allowed to announce it — that is what starts the Verifying… spinner
 * on both the card and the Activity row.
 *
 * A tip that turns out not to be ours is dropped by the ownership pass; nothing
 * is guessed at here.
 */
export function noteIngestedItem(args: {
  outpoint: string
  chain: Chain
  origin?: string | null
  name?: string | null
}): void {
  const target = normalizeOutpoint(args.outpoint)
  if (!target || isItemSent(target)) return
  const key = outpointKey(target)
  const origin = args.origin?.trim()
  const name = args.name?.trim()
  const tags = [
    'ordinal',
    ...(origin ? [`origin:${origin.replace(/_(\d+)$/, '.$1')}`] : []),
    ...(name ? [`name:${name}`] : []),
  ]
  const output: ItemOutput = { outpoint: target, satoshis: 1, tags }
  const identityKey = getActiveWallet()?.identityKey
  if (identityKey) hydrateSeededItems(identityKey)
  // Judged against the scan that ran before this tip existed, it would look
  // missing — record when we first held it so ownership grace applies.
  if (!firstSeenAt.has(key)) firstSeenAt.set(key, Date.now())
  seededItems.set(key, output)
  if (identityKey) persistSeededItems(identityKey)
  if (cachedCollectables.some((c) => outpointKey(c.outpoint) === key)) return
  // A send to our own handle leaves the outgoing tip on the list until the next
  // ownership pass; without this the same collectable shows twice until then.
  setCollectablesCache(
    dedupeByOrigin(
      [
        toCollectable(output, args.chain, getResolvedInscription(target)),
        ...cachedCollectables,
      ],
      (outpoint) => firstSeenAt.get(outpointKey(outpoint)) ?? 0,
    ),
  )
}

function isListableItem(o: ItemOutput): boolean {
  // Tips are exactly 1 satoshi. Misfiled funds must not list.
  if ((o.satoshis ?? 1) !== 1) return false
  // A tip we already spent lingers in the basket until a review runs.
  if (isItemSent(o.outpoint)) return false
  // BSV-21 fungibles belong under Collect → Tokens (basket bsv21), not NFT cards.
  const resolved = getResolvedInscription(normalizeOutpoint(o.outpoint))
  if (isBsv21Mime(resolved?.mimeType)) return false
  if (o.tags?.includes('bsv21')) return false
  return true
}

/** True when the item carries its own origin tag — P2P HandCash sends set this. */
function hasLocalOrigin(o: ItemOutput): boolean {
  return !!tagValue(o.tags, 'origin:')
}

/**
 * True when GorillaPool has something left to tell us.
 *
 * Only tips with no origin tag qualify. A P2P tip names its origin in remittance
 * tags, so asking the indexer would be pure latency.
 */
function needsIndexerResolve(o: ItemOutput): boolean {
  return !hasLocalOrigin(o)
}

function buildItems(outputs: ItemOutput[], chain: Chain): Collectable[] {
  const items: Collectable[] = []
  for (const o of outputs) {
    if (!isListableItem(o)) continue
    items.push(
      toCollectable(
        o,
        chain,
        getResolvedInscription(normalizeOutpoint(o.outpoint)),
      ),
    )
  }
  return dedupeByOrigin(
    items,
    (outpoint) => firstSeenAt.get(outpointKey(outpoint)) ?? 0,
  )
}

/**
 * Walks per pass for tips that already show something.
 *
 * An upgrade repairs a card that is merely wrong, not one that is missing, so it
 * must never cost the list a burst of requests. Unrepaired tips come back on the
 * next pass.
 */
const UPGRADE_BUDGET = 3

/**
 * Fill in origins for tips remittance could not verify, and repair the ones it
 * verified wrongly.
 *
 * Runs after the list is already on screen. A tip whose origin claim the indexer
 * cannot back with an inscription is indistinguishable on screen from a tip with
 * no origin at all — broken image, sender's flattened name — and it is what a
 * send passes on, so it gets one walk per retry window too.
 */
async function resolveUnknownOrigins(): Promise<void> {
  if (resolvingOrigins) return
  const listable = lastItemOutputs.filter(isListableItem)
  const pending = listable.filter(
    (o) =>
      needsIndexerResolve(o) &&
      shouldResolveInscription(normalizeOutpoint(o.outpoint)),
  )
  // Thin cards need an upgrade whether remittance named them or lineage did —
  // both paths can land an origin with no traits, and that is what "came in
  // unverified with no traits" looks like until the indexer fills the rest.
  // A proven origin is already known: looking it up is one request, so retry
  // those on the pending cadence rather than the ten-minute dust backoff.
  const upgrades = listable
    .filter((o) => {
      const outpoint = normalizeOutpoint(o.outpoint)
      const retry = getProvenVerdict(outpoint)?.origin
        ? PENDING_RETRY_MS
        : RESOLVE_RETRY_MS
      return shouldUpgradeResolution(outpoint, Date.now(), retry)
    })
    .slice(0, UPGRADE_BUDGET)
  if (pending.length === 0 && upgrades.length === 0) return

  resolvingOrigins = true
  try {
    let changed = false
    const preferred = peekPreferredCollectableVerification()
    const orderedPending = preferred
      ? [
          ...pending.filter((o) => normalizeOutpoint(o.outpoint) === preferred),
          ...pending.filter((o) => normalizeOutpoint(o.outpoint) !== preferred),
        ]
      : pending
    const orderedUpgrades = preferred
      ? [
          ...upgrades.filter(
            (o) => normalizeOutpoint(o.outpoint) === preferred,
          ),
          ...upgrades.filter(
            (o) => normalizeOutpoint(o.outpoint) !== preferred,
          ),
        ]
      : upgrades
    for (const o of orderedPending) {
      const outpoint = normalizeOutpoint(o.outpoint)
      setVerificationProgress(
        'identifying',
        outpoint,
        'Looking up this item with the indexer',
      )
      const walked = await walkInscription(outpoint)
      if (walked) {
        rememberResolvedInscription(outpoint, walked)
        changed = true
      } else {
        rememberUnresolved(outpoint)
      }
      clearVerificationProgress(outpoint)
    }
    for (const o of orderedUpgrades) {
      const outpoint = normalizeOutpoint(o.outpoint)
      rememberUpgradeAttempt(outpoint)
      setVerificationProgress(
        'identifying',
        outpoint,
        'Fetching name and traits from the indexer',
      )
      const walked = await walkInscription(outpoint)
      // Only a richer answer may replace what the card already shows; a second
      // thin one would just overwrite the sender's name with another guess.
      if (walked && !isThinResolution(walked)) {
        rememberResolvedInscription(outpoint, walked)
        changed = true
      }
      clearVerificationProgress(outpoint)
    }
    if (changed)
      setCollectablesCache(buildItems(lastItemOutputs, lastItemChain))
  } finally {
    resolvingOrigins = false
    clearVerificationProgress()
  }
}

/**
 * Lineage walks allowed inside {@link GENESIS_WALK_WINDOW_MS}.
 *
 * A walk costs a fetch per hop, so an inventory of imported ordinals must earn
 * its badges gradually rather than opening the Collect page into a few hundred
 * requests.
 */
const GENESIS_WALK_BUDGET = 8
/**
 * The budget refills instead of being spent once per session.
 *
 * A hard per-session cap meant an outage stranded the inventory: with no chain
 * service reachable, eight walks failed on the network, the budget was gone,
 * and every remaining tip sat unverified until the app was restarted. A rolling
 * window bounds the request rate just as well and heals on its own.
 */
const GENESIS_WALK_WINDOW_MS = 10 * 60_000
/** Activity rows scanned for tips this wallet no longer holds. */
const ACTIVITY_REPAIR_DEPTH = 50
let genesisWalkTimes: number[] = []
let provingGenesis = false

function genesisWalkBudgetSpent(now = Date.now()): boolean {
  genesisWalkTimes = genesisWalkTimes.filter(
    (at) => now - at < GENESIS_WALK_WINDOW_MS,
  )
  return genesisWalkTimes.length >= GENESIS_WALK_BUDGET
}

function noteGenesisWalk(now = Date.now()): void {
  genesisWalkTimes.push(now)
}

/**
 * Earn BRC-150 for held tips that arrived without a proof.
 *
 * Runs behind the painted list, one tip at a time. Proving a tip also settles
 * its origin — which is the only origin here that was verified rather than
 * claimed.
 */
async function proveHeldGenesis(
  wallet: ActiveWallet,
  ownRead: Promise<Collectable[]> | null,
): Promise<void> {
  const settleAwaitingOutsideQueue = (queued: Set<string>) => {
    settleStaleAwaitingVerification((outpoint) => queued.has(outpoint))
  }

  if (provingGenesis) return
  if (genesisWalkBudgetSpent()) {
    // Budget spent for now — drop spinners so cards show Unverified, not forever Verifying.
    settleAwaitingOutsideQueue(new Set())
    return
  }
  // A walk is never worth competing with a payment for the network.
  if (getWalletCoordinatorSnapshot().spend === 'active') return

  const held = lastItemOutputs
    .filter(isListableItem)
    .map((o) => normalizeOutpoint(o.outpoint))
  // A tip already sent on is gone from the basket, but the transfer that sent it
  // is still on screen in Activity, wearing whatever wrong origin it was recorded
  // with. Its lineage is chain data, so being spent does not make it unprovable.
  const inActivity = [
    ...new Set(
      listRecentActivity(ACTIVITY_REPAIR_DEPTH)
        .map((entry) => entry.item?.outpoint)
        .filter((outpoint): outpoint is string => !!outpoint)
        .map(normalizeOutpoint),
    ),
  ].filter((outpoint) => !held.includes(outpoint))
  const preferred = takePreferredCollectableVerification()
  const candidates = [...held, ...inActivity].filter((outpoint) =>
    shouldAttemptGenesis(outpoint),
  )
  if (
    preferred &&
    shouldAttemptGenesis(preferred) &&
    !candidates.includes(preferred)
  ) {
    candidates.unshift(preferred)
  } else if (preferred && candidates.includes(preferred)) {
    candidates.splice(candidates.indexOf(preferred), 1)
    candidates.unshift(preferred)
  }
  if (candidates.length === 0) {
    // Cooldown / already attempted — stop spinning on Unverified cards.
    settleAwaitingOutsideQueue(new Set())
    return
  }

  provingGenesis = true
  const queued = new Set(candidates)
  try {
    for (const outpoint of candidates) {
      if (genesisWalkBudgetSpent()) break
      if (getWalletCoordinatorSnapshot().spend === 'active') break
      // A basket read newer than the one that spawned us is somebody looking at
      // the panel right now. That read has its own timeout, and a walk fetching
      // through it is how the list ends up timing out instead of painting.
      // Exception: the tip the user opened in details — finish that walk.
      if (outpoint !== preferred && listInFlight && listInFlight !== ownRead) {
        break
      }
      setVerificationProgress(
        'verifying',
        outpoint,
        'Proving tip-to-origin lineage (BRC-150)',
      )
      let outcome: GenesisWalkOutcome = {
        kind: 'unavailable',
        reason: 'walk did not run',
        hops: 0,
      }
      let aborted = false
      try {
        outcome = await walkGenesisLineage({
          tipOutpoint: outpoint,
          // Take the assembled BEEF when it could actually travel, so the next
          // send has remittance to attach instead of omitting it.
          serializeIfUnder: REMITTANCE_MAX_BEEF_BYTES,
          // Yield per hop for the same reason: each one is a round trip, and the
          // UI shares this thread.
          getBeef: async (txid) => {
            await yieldToUi()
            return await getBeefForTxidCached(wallet, txid)
          },
          // Abandoning mid-walk costs one retry; finishing it while somebody is
          // waiting on the panel costs a `listOutputs` timeout. Never abort the
          // tip the user is staring at on the details panel.
          shouldStop: () => {
            if (outpoint === preferred) return false
            if (listInFlight && listInFlight !== ownRead) {
              aborted = true
              return true
            }
            return false
          },
        })
      } catch (err) {
        outcome = {
          kind: 'unavailable',
          reason: err instanceof Error ? err.message : String(err),
          hops: 0,
        }
      }
      // Only pin the attempt after a conclusive result. A transient network miss
      // must not burn the 24h budget and leave a just-received tip "Unverified"
      // until tomorrow. Aborted walks also must not burn the session budget —
      // opening details mid-walk used to exhaust the budget and strand the tip.
      if (outcome.kind !== 'proven') {
        // Say which tip and why. Without this every failure looked the same in
        // the log, so "stuck on the network" and "not a provable item" were
        // indistinguishable to anyone reading it.
        if (aborted || outcome.kind === 'aborted') {
          console.info(
            `[brc-150] walk deferred ${outpoint} — ${describeGenesisWalk(outcome)}`,
          )
        } else if (outcome.kind === 'invalid') {
          console.warn(
            `[brc-150] unprovable ${outpoint} — ${describeGenesisWalk(outcome)}`,
          )
        } else {
          console.info(
            `[brc-150] walk incomplete ${outpoint} — ${describeGenesisWalk(outcome)}`,
          )
        }
        rememberGenesisFailure(
          outpoint,
          outcome.kind,
          describeGenesisWalk(outcome),
        )
        clearVerificationProgress(outpoint)
        if (!aborted && outcome.kind !== 'aborted') {
          // Conclusive miss — drop the receive spinner so we are not stuck on
          // "Verifying…" forever with no chance to look unverified + retry later.
          clearAwaitingVerification(outpoint)
          queued.delete(outpoint)
          noteGenesisWalk()
          // Chain data says this item cannot be proven. Re-walking it every
          // session spends the whole budget on a known answer and starves the
          // tips that could still earn a badge.
          //
          // A tip that already holds its badge is here only to recover the path
          // a send would pass on. It loses nothing by waiting out the backfill
          // window, and letting it retry on every list would starve the same
          // tips for the same reason.
          if (
            outcome.kind === 'invalid' ||
            getProvenVerdict(outpoint)?.tier === 'brc150'
          ) {
            rememberGenesisAttempt(outpoint)
          }
        }
        continue
      }
      const proof = outcome.proof
      noteGenesisWalk()
      rememberGenesisAttempt(outpoint)
      clearGenesisFailure(outpoint)
      queued.delete(outpoint)

      console.info(
        `[brc-150] proved ${outpoint} back to ${proof.origin} in ${proof.hops} hop(s)`,
      )
      rememberProvenVerdict(outpoint, {
        tier: 'brc150',
        origin: proof.origin,
        path: proof.path,
        verifiedAt: Date.now(),
      })
      // Keep the lineage this walk just paid for. Without it a send finds no
      // tip-local path, omits remittance, and the receiver repeats the whole
      // walk — which is why a self-send took a minute to verify something this
      // wallet had already proven. With it, the send is O(1) and so is theirs.
      if (
        rememberProvenLineage({
          tipOutpoint: outpoint,
          origin: proof.origin,
          path: proof.path,
          beef: proof.beef,
        })
      ) {
        console.info(`[brc-150] remittance kept for ${outpoint} — sends reuse it`)
      }
      // Spinner stays via awaitingVerify until announceItemVerified clears it.
      setVerificationProgress(
        'verifying',
        outpoint,
        'Fetching name and traits for the proven origin',
      )
      await adoptProvenOrigin(outpoint, proof.origin, wallet.chain)
      await yieldToUi()
      setCollectablesCache(buildItems(lastItemOutputs, lastItemChain))
      await yieldToUi()
      // Toast + drop spinner in one beat — no idle gap before the checkmark.
      announceItemVerified(outpoint, 'BRC-150 lineage proven')
      clearVerificationProgress(outpoint)
      await yieldToUi()
    }
  } finally {
    provingGenesis = false
    clearVerificationProgress()
    // Tips left in the queue were aborted / budget-cut — keep their spinner only
    // if we still plan to retry (shouldAttemptGenesis). Everything else → Unverified.
    settleStaleAwaitingVerification(
      (outpoint) => queued.has(outpoint) && shouldAttemptGenesis(outpoint),
    )
  }
}

/**
 * Ask the wallet to verify this tip next, and start a walk if one is not already
 * running. Used by the item details panel so opening an unverified collectable
 * surfaces "Verifying…" instead of a dead "Unverified" badge.
 */
export function requestCollectableVerification(outpoint: string): void {
  const target = normalizeOutpoint(outpoint)
  preferCollectableVerification(target)
  const verdict = getProvenVerdict(target)
  // Already proven — nothing to walk.
  if (verdict?.tier === 'brc150') {
    clearAwaitingVerification(target)
    clearVerificationProgress(target)
    return
  }
  const cached = getCachedCollectables().find(
    (c) => normalizeOutpoint(c.outpoint) === target,
  )
  noteAwaitingVerification(target)
  setVerificationProgress(
    'verifying',
    target,
    'Proving tip-to-origin lineage (BRC-150)',
  )
  if (cached?.origin) {
    void verifyItemAuthenticity(target, cached.origin)
      .then((result) => {
        applyAuthenticityResult(target, result)
        if (result.proven) return
        // Remittance / listOutputs miss must not leave Verifying forever — fall
        // through to a tip-to-origin walk when the session still has budget.
        if (!shouldAttemptGenesis(target) || provingGenesis) {
          clearAwaitingVerification(target)
          clearVerificationProgress(target)
          return
        }
        const wallet = getActiveWallet()
        if (!wallet) {
          clearAwaitingVerification(target)
          clearVerificationProgress(target)
          return
        }
        void proveHeldGenesis(wallet, listInFlight)
      })
      .catch(() => {
        clearAwaitingVerification(target)
        clearVerificationProgress(target)
      })
    return
  }
  if (!shouldAttemptGenesis(target)) {
    clearAwaitingVerification(target)
    clearVerificationProgress(target)
    return
  }
  if (provingGenesis) return
  const wallet = getActiveWallet()
  if (!wallet) {
    clearAwaitingVerification(target)
    clearVerificationProgress(target)
    return
  }
  void proveHeldGenesis(wallet, listInFlight)
}

/**
 * Adopt a proven origin without emptying the card.
 *
 * A name and traits cached against an origin the sender got wrong describe some
 * other item, so they cannot be kept. Blanking them is just as wrong: the panel
 * then shows a nameless, traitless item until the upgrade pass happens to run.
 * Ask the indexer about the origin we just proved instead.
 */
function originKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(\d+)$/, '_$1')
}

async function adoptProvenOrigin(
  outpoint: string,
  origin: string,
  chain: Chain,
): Promise<void> {
  const point = originKey(origin)
  const existing = getResolvedInscription(outpoint)
  const sameOrigin = !!existing && originKey(existing.origin) === point
  // A thin hit that already names the right origin still needs the indexer —
  // that is exactly the "verified but no traits" card. Only a rich match may
  // skip the fetch.
  if (sameOrigin && !isThinResolution(existing)) {
    rememberResolvedInscription(outpoint, { ...existing, origin: point })
    return
  }
  const resolved = await resolveInscriptionAtOrigin(point, chain)
  const rich = resolved && !isThinResolution(resolved) ? resolved : null
  const keep = sameOrigin ? existing : null
  const merged = {
    ...(rich ?? keep ?? { traits: [], extras: [] }),
    origin: point,
    ...(resolved?.name || keep?.name
      ? { name: resolved?.name || keep?.name }
      : {}),
    ...(resolved?.app || keep?.app ? { app: resolved?.app || keep?.app } : {}),
    ...(resolved?.mimeType || keep?.mimeType
      ? { mimeType: resolved?.mimeType || keep?.mimeType }
      : {}),
    traits: rich?.traits?.length
      ? rich.traits
      : resolved?.traits?.length
      ? resolved.traits
      : keep?.traits ?? [],
    extras: rich?.extras?.length
      ? rich.extras
      : resolved?.extras?.length
      ? resolved.extras
      : keep?.extras ?? [],
  }
  rememberResolvedInscription(outpoint, merged)
  // Seed the origin key so later prefer-origin lookups do not re-fetch empty.
  if (originKey(outpoint) !== point) {
    rememberResolvedInscription(point, merged)
  }
}

/**
 * Resolve inscription metadata for a held tip.
 *
 * Prefer a known origin over walking the tip backwards. Fresh transfers are
 * often missing from the indexer for hours (the tip 404s) while the inscription
 * origin has been indexed for months — asking about the tip first is how a
 * BRC-150 card keeps its image (built from the origin content URL) but shows a
 * truncated outpoint and empty traits.
 */
async function walkInscription(
  outpoint: string,
): Promise<ResolvedInscription | null> {
  // The item's own origin claim (remittance `customInstructions` / `origin:`
  // tag) is a known origin too. Old BRC-156 tips 404 on the indexer and sit too
  // deep for the tip-graph walk to reach, but their origin — carried in the
  // purged latch and re-recorded on the held output — is indexed and answers in
  // one request. Only trust a claim that is not just the tip fallback.
  const key = normalizeOutpoint(outpoint)
  const cachedOrigin = getCachedCollectables().find(
    (c) => normalizeOutpoint(c.outpoint) === key,
  )?.origin
  const claimedOrigin =
    cachedOrigin && normalizeOutpoint(cachedOrigin) !== key
      ? cachedOrigin
      : undefined
  const knownOrigin =
    getProvenVerdict(outpoint)?.origin ??
    getResolvedInscription(outpoint)?.origin ??
    claimedOrigin
  try {
    return await resolveInscriptionPreferringOrigin(
      outpoint,
      lastItemChain,
      knownOrigin,
    )
  } catch {
    return null
  }
}

let listInFlight: Promise<Collectable[]> | null = null
let listMoreInFlight: Promise<Collectable[]> | null = null

/**
 * Ceiling on one basket read.
 *
 * `listOutputs` has no timeout of its own, and callers share the in-flight
 * promise. A storage host that accepts the socket and never answers therefore
 * wedges every later list *and* every details open for the life of the process.
 */
const LIST_TIMEOUT_MS = 20_000

/**
 * Verify one tip's authenticity (BRC-150 only) and remember the verdict.
 *
 * Order: remittance (incl. parent remittance) → lineage walk → unproven.
 * Scoped to a single outpoint so remittance BEEF never loads for a whole basket.
 */
export async function verifyItemAuthenticity(
  outpoint: string,
  originTag: string,
  active?: ActiveWallet | null,
): Promise<AuthenticityResult> {
  const target = normalizeOutpoint(outpoint)
  const cached = getProvenVerdict(target)
  if (cached?.tier === 'brc150') {
    return {
      tier: 'brc150',
      proven: true,
      reason: null,
      originScriptHash: cached.originScriptHash,
    }
  }

  const wallet = active ?? getActiveWallet()
  const tag = originTag.trim().replace(/_(\d+)$/, '.$1')
  if (!wallet || !tag) {
    return {
      tier: 'unproven',
      proven: false,
      reason: !wallet ? 'Wallet locked' : 'Origin missing',
    }
  }

  try {
    const listed = await wallet.wallet.listOutputs({
      basket: '1sat',
      tags: [`origin:${tag}`],
      tagQueryMode: 'all',
      limit: 10,
      includeCustomInstructions: true,
      include: 'locking scripts',
      seekPermission: false,
    })
    const match = (listed.outputs ?? []).find(
      (o) => normalizeOutpoint(o.outpoint) === target,
    )
    if (!match) {
      return {
        tier: 'unproven',
        proven: false,
        reason: 'Collectable output not found',
      }
    }

    await yieldToUi()

    const custom = parseCustom(match.customInstructions)
    const provenance = custom.provenance
    let authenticity: AuthenticityResult = {
      tier: 'unproven',
      proven: false,
      reason: 'No valid BRC-150 authenticity proof',
    }
    let provenOrigin: string | undefined
    // How this tip was proven, not merely that it was. Recorded with the verdict
    // so a later send can pass the proof on instead of omitting it.
    let provenPath: string[] | undefined

    if (provenance != null) {
      const remittance = await verifyProvenanceForHeldTip({
        provenance,
        heldOutpoint: target,
        getBeef: (txid) => getBeefForTxidCached(wallet, txid),
      })
      if (remittance.proven) {
        authenticity = { tier: 'brc150', proven: true, reason: null }
        provenPath = remittance.path
        provenOrigin =
          remittance.origin ??
          (typeof provenance === 'object' &&
          provenance &&
          typeof (provenance as { origin?: unknown }).origin === 'string'
            ? (provenance as { origin: string }).origin
            : undefined) ??
          custom.origin ??
          tag
        console.info(
          `[brc-150] remittance verified ${target.slice(0, 14)}… → ${String(
            provenOrigin,
          ).slice(0, 18)}…`,
        )
      }
    }

    if (!authenticity.proven) {
      const proof = await proveGenesisLineage({
        tipOutpoint: target,
        getBeef: (txid) => getBeefForTxidCached(wallet, txid),
      }).catch((err) => {
        console.warn('[brc-150] lineage walk failed', target, err)
        return null
      })
      if (proof) {
        provenOrigin = proof.origin
        provenPath = proof.path
        authenticity = { tier: 'brc150', proven: true, reason: null }
        console.info(
          `[brc-150] lineage proved ${target.slice(0, 14)}… in ${
            proof.hops
          } hop(s)`,
        )
      }
    }

    if (!provenOrigin && authenticity.proven) {
      provenOrigin = custom.origin ?? tag
    }

    rememberProvenVerdict(target, {
      ...authenticityResultToVerdict(authenticity),
      ...(provenOrigin ? { origin: originKey(provenOrigin) } : {}),
      ...(provenPath ? { path: provenPath } : {}),
    })
    if (provenOrigin) {
      await adoptProvenOrigin(target, provenOrigin, wallet.chain)
      setCollectablesCache(buildItems(lastItemOutputs, lastItemChain))
    }
    if (authenticity.proven) {
      await yieldToUi()
      announceItemVerified(target, 'BRC-150 tip-to-origin proven')
    }
    return authenticity
  } catch (err) {
    console.warn('[collectables] authenticity check failed', err)
    return {
      tier: 'unproven',
      proven: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

function applyAuthenticityResult(
  outpoint: string,
  result: AuthenticityResult,
): void {
  const target = normalizeOutpoint(outpoint)
  // Durable provenCache is the only authenticity SSoT. Never paint Unverified
  // over an existing proven tier. Product badge is always BRC-150.
  const verdict = getProvenVerdict(target)
  if (verdict?.tier === 'brc150') {
    if (result.proven) clearAwaitingVerification(target)
    if (
      !cachedCollectables.some(
        (c) =>
          c.outpoint === target &&
          (c.proven !== true || c.authenticity !== 'brc150'),
      )
    ) {
      return
    }
    setCollectablesCache(
      cachedCollectables.map((c) =>
        c.outpoint === target
          ? { ...c, proven: true, authenticity: 'brc150' }
          : c,
      ),
    )
    return
  }
  if (!result.proven) return
  clearAwaitingVerification(target)
  const painted = getProvenVerdict(target)
  if (painted?.tier !== 'brc150') return
  if (
    !cachedCollectables.some(
      (c) =>
        c.outpoint === target &&
        (c.proven !== true || c.authenticity !== 'brc150'),
    )
  ) {
    return
  }
  setCollectablesCache(
    cachedCollectables.map((c) =>
      c.outpoint === target
        ? { ...c, proven: true, authenticity: 'brc150' }
        : c,
    ),
  )
}

/**
 * Every visit to the Collect panel lists the basket, so flipping through the nav
 * bar would otherwise stack identical `listOutputs` queries. Callers all share the
 * one session wallet, so joining the in-flight read is the same answer.
 */
export function listCollectables(
  active?: ActiveWallet | null,
): Promise<Collectable[]> {
  if (listInFlight) return listInFlight
  const run = listCollectablesNow(active, false)
  listInFlight = run
  void run
    .catch(() => {})
    .then(() => {
      if (listInFlight === run) listInFlight = null
    })
  return run
}

/**
 * Append the next-oldest wallet page. The normal refresh intentionally resets
 * to the newest page so an 800k-output wallet never enters renderer memory in
 * one operation.
 */
export function loadMoreCollectables(
  active?: ActiveWallet | null,
): Promise<Collectable[]> {
  if (listMoreInFlight) return listMoreInFlight
  if (listedOutputCursor >= listedOutputTotal && collectablesHydrated) {
    return Promise.resolve(getCachedCollectables())
  }
  const run = listCollectablesNow(active, true)
  listMoreInFlight = run
  void run
    .catch(() => {})
    .then(() => {
      if (listMoreInFlight === run) listMoreInFlight = null
    })
  return run
}

async function listCollectablesNow(
  active?: ActiveWallet | null,
  append = false,
): Promise<Collectable[]> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) return getCachedCollectables()

  let outputs: ItemOutput[] = []
  const pageOffset = append ? listedOutputCursor : 0

  try {
    const result = await Promise.race([
      wallet.wallet.listOutputs({
        basket: '1sat',
        limit: LIST_PAGE_SIZE,
        // Negative offsets are newest-first. Keep a raw-output cursor because
        // sent/non-item rows may be filtered after the wallet page returns.
        offset: -(pageOffset + 1),
        includeTags: true,
        // Locking scripts are small and let us spare covenant tips from
        // address-scan ghosting. Never pull customInstructions for a whole
        // basket: remittance BEEF (~400k chars each) crashed phones.
        includeCustomInstructions: false,
        include: 'locking scripts',
        seekPermission: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('listOutputs timed out')),
          LIST_TIMEOUT_MS,
        ),
      ),
    ])
    const page = (result.outputs ?? []).map((o) => {
      const lockingScript = normalizeLockingScriptHex(
        (o as { lockingScript?: unknown }).lockingScript,
      )
      return {
        outpoint: o.outpoint,
        satoshis: o.satoshis ?? 1,
        tags: o.tags,
        lockingScript: lockingScript || undefined,
      }
    })
    listedOutputTotal = inferCollectableOutputTotal({
      offset: pageOffset,
      pageLength: result.outputs?.length ?? 0,
      pageLimit: LIST_PAGE_SIZE,
      reportedTotal: result.totalOutputs,
    })
    listedOutputCursor = Math.min(
      listedOutputTotal,
      pageOffset + (result.outputs?.length ?? 0),
    )
    if (append) {
      const byOutpoint = new Map<string, ItemOutput>()
      for (const output of [...lastItemOutputs, ...page]) {
        byOutpoint.set(outpointKey(output.outpoint), output)
      }
      outputs = [...byOutpoint.values()]
    } else {
      outputs = page
    }
  } catch (err) {
    console.warn('[collectables] listOutputs failed', err)
    // Keep prior cache — do not hydrate as empty on transient failures.
    return getCachedCollectables()
  }

  const seenNow = Date.now()
  for (const o of outputs) {
    const key = outpointKey(o.outpoint)
    if (!firstSeenAt.has(key)) firstSeenAt.set(key, seenNow)
  }

  // A tip we minted to ourselves is in hand before the basket will list it.
  // Rebuilding from the read alone is what dropped the card on a send to your
  // own handle: the spent tip leaves, the replacement is not listed yet, and
  // Collect comes back one card short until a later scan.
  outputs = [
    ...outputs,
    ...pendingSeededItems(outputs, seenNow, wallet.identityKey),
  ]

  // Basket rows are necessary but not sufficient. Ownership fate is exhaustive:
  // keepLive | graceHold | keepCovenant | ghostDrop — only ghostDrop relinquish.
  // Covenant tips never appear on the P2PKH address scan (only their beacon does).
  // A full address-indexer scan defeats paging for huge wallets. Their local
  // basket is reconciled by scheduled chain ingest; use an already-cached scan
  // when one exists, but do not start another 800k-row network read here.
  const live =
    listedOutputTotal > 10_000 ? cachedLiveOneSats : resolveLiveOneSatKeys(wallet)
  if (live) {
    // Do not un-hide sent tips just because a lagging address scan still lists
    // them. That put a just-sent NFT back in Collect so the user sent it twice.
    // Failed sends already call forgetItemsSent; healGhostSentItems restores
    // hides whose spend txid is proven absent from the chain.
    const { owned, spentOrMissing } = partitionByLiveUtxos(outputs, live.keys)
    const keptMissing: ItemOutput[] = []
    const ghosts: ItemOutput[] = []
    for (const o of spentOrMissing) {
      if ((o.satoshis ?? 1) !== 1) continue
      const unjudged = isOwnershipUnjudged({
        firstSeenAt: firstSeenAt.get(outpointKey(o.outpoint)) ?? seenNow,
        liveAt: live.at,
        now: seenNow,
        graceMs: OWNERSHIP_SETTLE_GRACE_MS,
      })
      const verdict = getProvenVerdict(normalizeOutpoint(o.outpoint))
      const lockHex = o.lockingScript?.trim() ? o.lockingScript : null
      const paysOurAddress =
        lockHex != null ? scriptPaysAddress(lockHex, wallet.address) : null
      const fate = ownershipFate({
        tipKind: classifyTipKind(o.lockingScript),
        inLiveSet: false,
        unjudged,
        provenTier: verdict?.tier ?? null,
        paysOurAddress,
      })
      if (fate === 'ghostDrop' && !isProtectedFromGhostDrop(o.outpoint))
        ghosts.push(o)
      else keptMissing.push(o)
    }
    if (ghosts.length > 0) {
      console.info(
        `[collectables] dropping ${ghosts.length} tip(s) not in the address UTXO set`,
        ghosts.map((g) => outpointKey(g.outpoint)),
      )
      void relinquishSpentOutputs(
        wallet,
        ghosts.map((g) => ({
          outpoint: normalizeOutpoint(g.outpoint),
          basket: '1sat',
        })),
      )
    }
    outputs = [...owned, ...keptMissing]
  } else {
    // Address scan not ready (often right after send invalidates the cache).
    // Still refuse to paint soft tips locked to someone else — remittance basket
    // rows must not toast as receives.
    const kept: ItemOutput[] = []
    const ghosts: ItemOutput[] = []
    for (const o of outputs) {
      if ((o.satoshis ?? 1) !== 1) {
        kept.push(o)
        continue
      }
      const lockHex = o.lockingScript?.trim() ? o.lockingScript : null
      const paysOurAddress =
        lockHex != null ? scriptPaysAddress(lockHex, wallet.address) : null
      const tipKind = classifyTipKind(o.lockingScript)
      if (paysOurAddress === false && tipKind.kind !== 'covenantLocked') {
        ghosts.push(o)
      } else {
        kept.push(o)
      }
    }
    if (ghosts.length > 0) {
      console.info(
        `[collectables] dropping ${ghosts.length} outbound tip(s) before address scan`,
        ghosts.map((g) => outpointKey(g.outpoint)),
      )
      void relinquishSpentOutputs(
        wallet,
        ghosts.map((g) => ({
          outpoint: normalizeOutpoint(g.outpoint),
          basket: '1sat',
        })),
      )
    }
    outputs = kept
  }

  lastItemOutputs = outputs
  lastItemChain = wallet.chain

  // Everything the list renders (name, app, image) comes from the output itself
  // or the resolution cache, so paint now and let authenticity + indexer catch up.
  const deduped = buildItems(outputs, wallet.chain)
  setCollectablesCache(deduped, { announceArrivals: !append })
  // Identity first, then authenticity — a lineage walk is the expensive one and
  // must never delay getting a name and an image onto the card.
  const ownRead = listInFlight
  void resolveUnknownOrigins().then(() => proveHeldGenesis(wallet, ownRead))
  return deduped
}

export async function getCollectable(
  outpoint: string,
  active?: ActiveWallet | null,
): Promise<Collectable | null> {
  const target = normalizeOutpoint(outpoint)
  const wallet = active ?? getActiveWallet()

  // Details still reconcile against live UTXOs, but a tip we already hold paints
  // from cache first. Awaiting the list put the whole basket read — shared with
  // the background poll, so often already in flight — between the tap and the
  // panel. Subscribers get the reconciled answer when it lands.
  let item = cachedCollectables.find((i) => i.outpoint === target) ?? null
  if (item) {
    void listCollectables(active).catch(() => {})
  } else {
    const listed = await listCollectables(active)
    item = listed.find((i) => i.outpoint === target) ?? null
  }
  if (!item || !wallet) return item

  // Details: traits/mime come from the indexer. Prefer origin over tip — a
  // fresh self-send tip often 404s for hours while the inscription origin has
  // been indexed for months. Always fill empty traits, even on proven tips.
  try {
    const [txid, voutStr] = item.outpoint.split('.')
    const vout = Number(voutStr)
    if (txid && Number.isInteger(vout)) {
      const cachedResolved = getResolvedInscription(target)
      const thin = !cachedResolved || isThinResolution(cachedResolved)
      const shouldAskIndexer =
        item.traits.length === 0 &&
        thin &&
        (shouldResolveInscription(target) ||
          shouldUpgradeResolution(target) ||
          !!item.origin)
      const knownOrigin =
        getProvenVerdict(target)?.origin ??
        cachedResolved?.origin ??
        item.origin
      const resolved =
        cachedResolved && !thin
          ? cachedResolved
          : shouldAskIndexer
          ? await resolveInscriptionPreferringOrigin(
              target,
              wallet.chain,
              knownOrigin,
            ).catch(() => cachedResolved)
          : cachedResolved
      if (resolved) {
        rememberResolvedInscription(target, resolved)
        const content =
          resolveDerivativeContent({
            claimed: resolved.content ?? item.content,
          }) ?? item.content
        const mediaOrigin = content ?? (resolved.origin || item.origin)
        item = {
          ...item,
          origin: resolved.origin || item.origin,
          ...(content ? { content } : {}),
          name: resolved.name?.trim() || item.name,
          app: resolved.app ?? item.app,
          mimeType: resolved.mimeType ?? item.mimeType,
          type: resolved.type ?? item.type,
          subType: resolved.subType ?? item.subType,
          collectionId: resolved.collectionId ?? item.collectionId,
          traits: resolved.traits.length ? resolved.traits : item.traits,
          extras: resolved.extras.length ? resolved.extras : item.extras,
          imageUrl: contentUrlForOrigin(mediaOrigin, wallet.chain),
        }
        setCollectablesCache(
          cachedCollectables.map((c) => (c.outpoint === target ? item! : c)),
        )
      }
    }
  } catch (err) {
    console.warn('[collectables] detail enrich failed', err)
  }

  const proven = getProvenVerdict(target)
  // BRC-150 is not final for hardened tips — verifyItemAuthenticity upgrades
  // when the tip locking script / remittance says covenant.
  if (!proven || proven.tier === 'brc150') {
    void verifyItemAuthenticity(target, item.origin, wallet)
      .then((result) => {
        applyAuthenticityResult(target, result)
        if (!result.proven) clearAwaitingVerification(target)
      })
      .catch(() => {
        clearAwaitingVerification(target)
      })
  } else {
    clearAwaitingVerification(target)
  }

  return item
}

function formatSendError(err: unknown): Error {
  if (err instanceof Error) {
    const name = err.name || ''
    const msg = err.message || String(err)
    if (name === 'AbortError' || /^AbortError$/i.test(msg)) {
      return new Error(
        'Signing was interrupted (wallet storage busy). Wait a second and send again.',
      )
    }
    if (
      name.includes('INSUFFICIENT_FUNDS') ||
      /insufficient.?funds/i.test(msg)
    ) {
      return new Error(
        'Not enough BSV to cover the network fee for this transfer',
      )
    }
    // Must not match `unlockingScript` — that is a signing fault, not a bad recipient.
    if (
      /invalid.*(address|identity key)/i.test(msg) ||
      /outputs\[\d+]\.lockingScript/i.test(msg)
    ) {
      return new Error('Invalid recipient address or identity key')
    }
    if (/no longer spendable/i.test(msg)) {
      return new Error(
        'A previous send left this item’s tip stuck. Recovered it — tap Send again.',
      )
    }
    if (
      /not reserved by an active action batch/i.test(msg) ||
      /reserved by an active action batch/i.test(msg)
    ) {
      return new Error(
        'A previous send is still holding this item. Cleared it — tap Send again.',
      )
    }
    if (
      /missing its source transaction/i.test(msg) ||
      /could not load the transaction that holds/i.test(msg) ||
      /must have a sourcetransaction/i.test(msg)
    ) {
      return new Error(
        'Can’t find the transaction that holds this item yet. Wait a moment after receiving it, then Send again.',
      )
    }
    if (/is not iterable/i.test(msg)) {
      return new Error('Missing script')
    }
    if (/doublespend/i.test(msg)) {
      return new Error('Already spent')
    }
    return err
  }
  return new Error(String(err))
}

/**
 * Ordinals reach basket `1sat` locked to this device's root-key address — both the
 * migration sweep and peer transfers pay `addressFromIdentityKey`. Anything else
 * cannot be unlocked here, so say so instead of failing inside the signer.
 *
 * An inscribed tip keeps its `ord` envelope alongside the P2PKH branch, so match
 * the branch rather than the whole script.
 */
function assertOrdinalIsDeviceLocked(
  lockingScript: unknown,
  wallet: ActiveWallet,
): void {
  const hex = normalizeLockingScriptHex(lockingScript)
  if (!hex) return
  // Covenant-locked tips cannot be soft-spent; send refuses and UI offers abandon.
  if (isCovenantLockedScript(hex)) return
  if (!scriptPaysAddress(hex, wallet.address)) {
    throw new Error(
      'This collectable is locked to a key this device cannot sign. Restore the wallet that received it, then send again.',
    )
  }
}

/**
 * BEEF covering every outpoint this send spends.
 *
 * `buildSignableTransaction` reads each user input's source transaction out of
 * the BEEF we pass, so every spent input has to be in it — otherwise the toolbox
 * fails with "Every signableTransaction input must have a sourceTransaction".
 * Fetches run in parallel and share a session cache with provenance / settle /
 * origin lookups so a send never pays twice for the same mined body.
 */
async function buildInputBeefForSpends(
  wallet: ActiveWallet,
  outpoints: string[],
): Promise<number[]> {
  return buildMergedInputBeef(wallet, outpoints, normalizeOutpoint)
}

/**
 * BRC-100 only auto-signs the wallet's own BRC-29 change, so the ordinal tip
 * input comes back as a signable transaction for us to unlock with the root key.
 *
 * Covenant-locked tips MUST NOT use the P2PKH unlock template.
 */
function atomicBeefFromWalletResult(result: unknown): number[] | undefined {
  if (!result || typeof result !== 'object') return undefined
  const raw = (result as { tx?: unknown }).tx
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    return raw as number[]
  }
  if (raw instanceof Uint8Array) return Array.from(raw)
  return undefined
}

async function signOrdinalTransfer(args: {
  wallet: ActiveWallet
  signable: SignableTransaction
  /** Tip outpoint(s) we must unlock. */
  outpoints: string[]
}): Promise<{ txid: string; atomicBeef: number[] }> {
  const targets = new Map<string, number>()
  for (const op of args.outpoints) {
    const [txidIn, voutRaw] = normalizeOutpoint(op).split('.')
    targets.set(`${txidIn?.toLowerCase()}.${Number(voutRaw)}`, Number(voutRaw))
  }

  rememberBeefTree(
    Array.isArray(args.signable.tx)
      ? args.signable.tx
      : Array.from(args.signable.tx),
  )
  const beef = Beef.fromBinary(args.signable.tx)
  let unsigned: Transaction | undefined
  const vins: number[] = []
  for (const btx of beef.txs ?? []) {
    if (!btx.tx) continue
    for (let i = 0; i < btx.tx.inputs.length; i++) {
      const input = btx.tx.inputs[i]
      const key = `${String(input?.sourceTXID).toLowerCase()}.${
        input?.sourceOutputIndex
      }`
      if (targets.has(key)) {
        unsigned = btx.tx
        vins.push(i)
      }
    }
    if (unsigned && vins.length === targets.size) break
  }
  if (!unsigned || vins.length === 0) {
    throw new Error('Collectable input missing from the signable transaction')
  }

  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    if (!input.sourceTransaction && input.sourceTXID) {
      try {
        const extra = await getBeefForTxidCached(
          args.wallet,
          String(input.sourceTXID),
        )
        beef.mergeBeef(extra.toBinary())
        input.sourceTransaction = beef.findTxid(String(input.sourceTXID))?.tx
      } catch (err) {
        console.warn(
          '[collectables] source tx hydrate failed',
          input.sourceTXID,
          err,
        )
      }
    }
    const locking =
      input.sourceTransaction?.outputs[
        input.sourceOutputIndex
      ]?.lockingScript?.toHex()
    if (isCovenantLockedScript(locking)) {
      throw new Error(
        'This collectable is covenant-locked and cannot be spent with a P2PKH unlock. Abandon it instead.',
      )
    }
  }

  const rootKey = PrivateKey.fromHex(args.wallet.rootKeyHex)
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    // The sighash covers the source value, so read each value from its source
    // transaction instead of assuming one.
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    const satoshis =
      input.sourceTransaction?.outputs[input.sourceOutputIndex]?.satoshis
    if (typeof satoshis !== 'number') {
      throw new Error('Collectable input is missing its source transaction')
    }
    input.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(
      rootKey,
      satoshis,
    )
  }
  await unsigned.sign()
  for (const vin of vins) {
    const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
    if (!unlockingScript)
      throw new Error('Could not sign the collectable transfer')
    spends[vin] = { unlockingScript }
  }

  // noSend: toolbox must not TaskSendWaiting-broadcast. Settle chart owns who
  // posts — peerDeliver has no sender broadcast edge until DELIVER_FAILED.
  let signed
  try {
    signed = await args.wallet.wallet.signAction({
      reference: args.signable.reference,
      spends,
      options: {
        noSend: true,
      },
    })
  } catch (err) {
    const {
      isReviewActionsError,
      formatReviewActionsError,
      recoverFromReviewActions,
    } = await import('./actionReview')
    if (isReviewActionsError(err)) {
      await recoverFromReviewActions({
        err,
        reference: args.signable.reference,
        tipOutpoints: [...args.outpoints],
        active: args.wallet,
      })
      throw new Error(formatReviewActionsError(err))
    }
    throw err
  }

  const txid =
    typeof signed.txid === 'string' ? signed.txid.trim().toLowerCase() : ''
  if (!txid) throw new Error('Collectable transfer returned no txid')

  let atomicBeef = atomicBeefFromWalletResult(signed)
  if (!atomicBeef?.length) {
    const wrap = new Beef()
    wrap.mergeBeef(args.signable.tx)
    wrap.mergeTransaction(unsigned)
    wrap.atomicTxid = undefined
    try {
      atomicBeef = wrap.toBinaryAtomic(txid)
    } catch {
      atomicBeef = wrap.toBinary()
    }
  }
  if (!atomicBeef?.length) {
    throw new Error('Collectable transfer returned no signed BEEF')
  }
  rememberBeefTree(atomicBeef, txid)

  const {
    sendWithHasFailure,
    formatReviewActionsError,
    recoverFromReviewActions,
  } = await import('./actionReview')
  const sendWith = (signed as { sendWithResults?: Array<{ status?: string }> })
    .sendWithResults
  if (sendWithHasFailure(sendWith)) {
    await recoverFromReviewActions({
      err: {
        name: 'WERR_REVIEW_ACTIONS',
        sendWithResults: sendWith,
        txid,
        message: 'SendWith reported failure',
      },
      reference: args.signable.reference,
      tipOutpoints: [...args.outpoints],
      active: args.wallet,
    })
    throw new Error(
      formatReviewActionsError({
        sendWithResults: sendWith,
        reviewActionResults: [],
      }),
    )
  }

  return { txid, atomicBeef }
}

/**
 * Drop what a send just spent from its basket.
 *
 * `reviewSpendableOutputs` is throttled and paused right after legacy sweeps, so
 * relying on it alone leaves a sent tip listed here (and on a parity device) long
 * after it moved — the item then appears to be in two wallets at once.
 */
async function relinquishSpentOutputs(
  wallet: ActiveWallet,
  spends: Array<{ outpoint: string; basket: string }>,
): Promise<void> {
  for (const spend of spends) {
    try {
      await wallet.wallet.relinquishOutput({
        basket: spend.basket,
        output: normalizeOutpoint(spend.outpoint),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/must exist and be unique/i.test(msg)) continue
      // Already marked spent by createAction — nothing left to release.
      console.warn(
        '[collectables] relinquish after send skipped',
        spend.outpoint,
        err,
      )
    }
  }
}

/**
 * Drop a stuck covenant tip from local inventory.
 *
 * Does not spend on-chain — covenant tips cannot be spent. Relinquishes the
 * basket row, marks sent/abandoned, and clears the collectables cache entry.
 */
export async function abandonCollectable(outpointRaw: string): Promise<void> {
  const outpoint = normalizeOutpoint(outpointRaw)
  const wallet = getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const held = await wallet.wallet.listOutputs({
    basket: '1sat',
    limit: 1000,
    includeTags: true,
    includeCustomInstructions: true,
    include: 'locking scripts',
    seekPermission: false,
  })
  const match = (held.outputs ?? []).find(
    (o) => normalizeOutpoint(o.outpoint) === outpoint,
  )
  if (!match) throw new Error('Collectable is no longer in this wallet')

  console.info(
    `[collectables] abandon tip=${outpoint} tipKind=${
      classifyTipKind(match.lockingScript).kind
    }`,
  )

  markItemsSent([{ outpoint, txid: `abandon:${outpoint}` }])

  await relinquishSpentOutputs(wallet, [{ outpoint, basket: '1sat' }])

  invalidateLiveOneSatOutpoints()
  setCollectablesCache(
    cachedCollectables.filter((i) => i.outpoint !== outpoint),
  )
  scheduleHistoryBackupPush('abandonCollectable')
  void listCollectables(wallet).catch((err) => {
    console.warn('[collectables] post-abandon refresh failed', err)
  })
}

/**
 * Transfer a basket `1sat` ordinal to a P2PKH address via BRC-100 createAction.
 *
 * Path selection is exhaustive via `chooseSendPath` + `collectableSendMachine`:
 * p2pkhSend | refuse. Covenant-locked tips refuse (use {@link abandonCollectable}).
 *
 * A single `createAction` spends the 1-sat tip and creates the recipient tip
 * (vout 0) with BRC-150 remittance in customInstructions. No latch output.
 */
export async function sendCollectable(args: {
  outpoint: string
  toAddress: string
  /** Optional recipient identity (friends / peerpay); the send does not require it. */
  recipientIdentityKey?: string | null
  /** Optional friend label for the activity row. */
  friendLabel?: string | null
  name?: string
  origin?: string
  app?: string
}): Promise<{ txid: string }> {
  const outpoint = normalizeOutpoint(args.outpoint)
  const cachedEarly =
    cachedCollectables.find((i) => i.outpoint === outpoint) ?? null
  const earlyName =
    (args.name ?? cachedEarly?.name ?? 'Collectable').trim().slice(0, 40) ||
    'Collectable'
  const earlyOrigin = parseOrigin(args.origin ?? cachedEarly?.origin, outpoint)
  const earlyItem = {
    name: earlyName,
    origin: earlyOrigin,
    outpoint,
    ...(cachedEarly?.imageUrl ? { imageUrl: cachedEarly.imageUrl } : {}),
    ...(args.app ?? cachedEarly?.app
      ? { app: args.app ?? cachedEarly?.app }
      : {}),
  }
  // Before the spend FIFO — pill + inventory badge while waiting on sync.
  setPaymentProgress('preparing', 'Waiting to send the collectable', outpoint)
  const outboundPending = beginPendingSend({
    to: args.toAddress,
    sats: 1,
    friendLabel: args.friendLabel ?? null,
  })
  noteOutboundSendPending({
    pendingId: outboundPending.id,
    sats: 1,
    to: args.toAddress,
    friendLabel: args.friendLabel ?? null,
    recipientIdentityKey: args.recipientIdentityKey ?? null,
    item: earlyItem,
  })

  try {
    return await runExclusiveSpend(
      async () => {
        try {
          pauseCollectableArrivalToasts++
          assertOnlineForPayment()
          const wallet = getActiveWallet()
          if (!wallet) throw new Error('Wallet locked')
          {
            const { abortReservedActionBatches } = await import(
              './actionReview'
            )
            await abortReservedActionBatches(wallet)
          }
          // Tip is already in the 1sat basket. Fee UTXOs live in managed change —
          // createAction fails closed if they aren't. Do not await balance() here
          // (that contended with sync and made "Waiting to send" feel stuck).

          setPaymentProgress(
            'building',
            'Preparing the collectable for transfer',
            outpoint,
          )
          const to = await resolvePaymentRecipient(args.toAddress, wallet.chain)

          let lockingScript: string
          try {
            lockingScript = new P2PKH().lock(to).toHex()
          } catch {
            throw new Error('Invalid recipient address or identity key')
          }

          // Prefer the in-memory list for name/origin so the tip listOutputs can be a
          // tagged narrow query instead of a full-basket read of every held ordinal.
          const cachedItem =
            cachedCollectables.find((i) => i.outpoint === outpoint) ?? null
          const originGuess = parseOrigin(
            args.origin ?? cachedItem?.origin,
            outpoint,
          )
          const originTag = originGuess.replace(/_(\d+)$/, '.$1')

          const held = await wallet.wallet.listOutputs({
            basket: '1sat',
            tags: [`origin:${originTag}`],
            tagQueryMode: 'all',
            limit: 20,
            includeTags: true,
            // Locking script and satoshis are all this needs; remittance BEEF for every
            // held item would be tens of megabytes on a full wallet.
            includeCustomInstructions: true,
            include: 'locking scripts',
            seekPermission: false,
          })
          let match = (held.outputs ?? []).find(
            (o) => normalizeOutpoint(o.outpoint) === outpoint,
          )
          // Origin tag can miss after a migrate / rename; one broader pass is enough.
          if (!match) {
            const wide = await wallet.wallet.listOutputs({
              basket: '1sat',
              limit: 1000,
              includeTags: true,
              includeCustomInstructions: true,
              include: 'locking scripts',
              seekPermission: false,
            })
            match = (wide.outputs ?? []).find(
              (o) => normalizeOutpoint(o.outpoint) === outpoint,
            )
          }
          if (!match) throw new Error('Collectable is no longer in this wallet')
          if ((match.satoshis ?? 1) !== 1) {
            throw new Error('Collectable UTXO is not a 1-sat ordinal')
          }

          const item =
            cachedItem ?? (await getCollectable(outpoint, wallet)) ?? null
          // Remittance identity must not come from tags — the SDK lowercases them, and
          // after the signing-speed path we paint the list from those flattened tags.
          // Resolution cache + tip remittance keep the case the recipient should see.
          const resolvedMeta = getResolvedInscription(outpoint)
          const tipCustom = parseCustom(match.customInstructions)
          const origin = parseOrigin(
            resolvedMeta?.origin ??
              tipCustom.origin ??
              args.origin ??
              item?.origin,
            outpoint,
          )
          const name =
            (
              resolvedMeta?.name ??
              tipCustom.name ??
              args.name ??
              item?.name ??
              'Collectable'
            )
              .trim()
              .slice(0, 40) || 'Collectable'
          const app =
            resolvedMeta?.app ?? tipCustom.app ?? args.app ?? item?.app
          const collectionId =
            resolvedMeta?.collectionId ??
            tipCustom.collectionId ??
            item?.collectionId

          // Derivative / Kit Kat: forward shared media outpoint peer-to-peer.
          let content =
            item?.content ??
            resolveDerivativeContent({
              claimed: tipCustom.content ?? tagValue(match.tags, 'content:'),
            })
          if (!content) {
            try {
              const originParts = origin.replace(/\.(\d+)$/, '_$1').split('_')
              const originTxid = originParts[0]?.toLowerCase()
              const originVout = Number(originParts[1])
              if (originTxid?.length === 64 && Number.isInteger(originVout)) {
                const originBeef = await getBeefForTxidCached(
                  wallet,
                  originTxid,
                )
                const scriptHex =
                  originBeef
                    .findTxid(originTxid)
                    ?.tx?.outputs?.[originVout]?.lockingScript?.toHex() ?? null
                content = resolveDerivativeContent({
                  originScriptHex: scriptHex,
                })
              }
            } catch (err) {
              console.warn(
                '[collectables] derivative content resolve skipped',
                err,
              )
            }
          }

          const tags = stampBrc164Id([
            'ordinal',
            `origin:${origin.replace(/_(\d+)$/, '.$1')}`,
            `name:${name.slice(0, 80)}`,
            ...(app ? [`app:${app.slice(0, 40)}`] : []),
            ...(collectionId
              ? [`collection:${collectionId.slice(0, 80)}`]
              : []),
            ...(content
              ? [`content:${content.replace(/_(\d+)$/, '.$1')}`]
              : []),
          ])

          const tipBeefPromise = buildInputBeefForSpends(wallet, [outpoint])
          const [tipBeefBin, live] = await Promise.all([
            tipBeefPromise,
            awaitLiveOutpoints(wallet),
          ])

          if (live && !live.oneSats.has(outpointKey(outpoint))) {
            markItemsSent([{ outpoint, txid: `spent-on-chain:${outpoint}` }])
            void listCollectables(wallet).catch(() => {})
            throw new Error(
              'This collectable is no longer unspent on your address (already sent). Inventory refreshed.',
            )
          }

          // listOutputs often omits lockingScript (toolbox skips scriptOffset===0).
          // Classify from the tip BEEF we already need for the send.
          const tipLockingScript = resolveTipLockingScriptHex({
            listed: match.lockingScript,
            beefBin: tipBeefBin,
            outpoint,
          })
          if (
            !normalizeLockingScriptHex(match.lockingScript) &&
            tipLockingScript
          ) {
            console.info(
              `[collectables] tip locking script recovered from BEEF (${tipLockingScript.length} hex chars)`,
            )
          }
          assertOrdinalIsDeviceLocked(tipLockingScript, wallet)

          rememberBeefBinary(outpoint.split('.')[0]!, tipBeefBin)

          const inputBEEF = tipBeefBin
          const spendOutpoints = [outpoint]
          const knownTxids = [
            ...new Set(
              spendOutpoints
                .map((op) => normalizeOutpoint(op).split('.')[0])
                .filter((txid): txid is string => !!txid),
            ),
          ]

          const settlePath = chooseItemSettlePath({
            paysOurAddress: scriptPaysAddress(lockingScript, wallet.address),
            recipientIdentityKey: args.recipientIdentityKey,
          })
          const tipKind = classifyTipKind(tipLockingScript)
          const provenTier = getProvenVerdict(outpoint)?.tier ?? null
          const sendPath = chooseSendPath({
            tipKind,
            provenTier,
          })

          const activityItem = {
            name,
            origin,
            outpoint,
            ...(item?.imageUrl ? { imageUrl: item.imageUrl } : {}),
            ...(app ? { app } : {}),
          }
          noteOutboundSendPending({
            pendingId: outboundPending.id,
            sats: 1,
            to,
            friendLabel: args.friendLabel ?? null,
            recipientIdentityKey: args.recipientIdentityKey ?? null,
            item: activityItem,
          })

          const chart = createActor(collectableSendMachine).start()
          chart.send({ type: 'START', outpoint, sendPath })
          console.info(
            `[collectables] send path=${sendPath.path}${
              sendPath.path === 'refuse' ? ` reason=${sendPath.reason}` : ''
            } settle=${settlePath.settle} tipKind=${tipKind.kind} proven=${
              provenTier ?? 'none'
            } scriptChars=${tipLockingScript.length}`,
          )

          const finishSend = async (
            txid: string,
            opts?: { remittanceBuilt?: boolean },
          ): Promise<{ txid: string }> => {
            // Record activity as soon as the txid exists — before relinquish / list /
            // progress clear — so the feed updates while Working is still showing.
            completePendingSend(outboundPending.id, txid)
            noteOutboundSendComplete({
              pendingId: outboundPending.id,
              txid,
              sats: 1,
              to,
              friendLabel: args.friendLabel ?? null,
              recipientIdentityKey: args.recipientIdentityKey ?? null,
              item: activityItem,
            })
            clearPendingSend(outboundPending.id)
            const tx = txid.trim().toLowerCase()
            const newTip = `${tx}.0`
            // createAction files the recipient tip in *this* wallet's `1sat` basket.
            // That is remittance metadata for the sender, not ownership — unless the
            // lock pays us (true self-receive).
            const selfReceive = scriptPaysAddress(lockingScript, wallet.address)
            // Hide spent tip + outbound remittance tip immediately. Post-send we
            // invalidate the live address scan; without a fresh scan, ownership fate is
            // skipped and the filed tip would toast "Item received" on the sender.
            // The settle path rides along: on peerDeliver the payee broadcasts, so the
            // ghost heal must not read an early 404 as a send that never happened.
            const settle: SentItemSettle = isPeerDeliverSettle(settlePath)
              ? 'peerDeliver'
              : 'senderBroadcast'
            markItemsSent([
              { outpoint, txid, settle },
              ...(!selfReceive ? [{ outpoint: newTip, txid, settle }] : []),
            ])
            invalidateLiveOneSatOutpoints()
            await relinquishSpentOutputs(wallet, [{ outpoint, basket: '1sat' }])
            if (!selfReceive) {
              await relinquishSpentOutputs(wallet, [
                { outpoint: newTip, basket: '1sat' },
              ])
            } else if (opts?.remittanceBuilt) {
              // Remittance proves the spent tip; pin BRC-150 on the tip we still hold
              // (self-pay) so receive can show authenticity verified.
              rememberProvenVerdict(newTip, {
                tier: 'brc150',
                origin: origin.replace(/\.(\d+)$/, '_$1').toLowerCase(),
                verifiedAt: Date.now(),
              })
            }
            if (selfReceive) {
              skipArrivalToast.add(normalizeOutpoint(newTip))
            }
            setPaymentProgress('finishing')
            setCollectablesCache(
              cachedCollectables.filter((i) => i.outpoint !== outpoint),
            )
            if (selfReceive) {
              // The line above drops the tip we spent; the one we now hold is a
              // different outpoint the basket has not listed yet, and the live
              // scan was invalidated a few lines up. Seed it so Collect keeps
              // the card instead of coming back one short, and announce before
              // the list read rather than a second behind it, so the card and
              // its Verifying… spinner appear together.
              noteIngestedItem({
                outpoint: newTip,
                chain: wallet.chain,
                origin,
                name,
              })
              announceItemsReceived([newTip])
              try {
                playWalletSound('receive')
                document.dispatchEvent(
                  new CustomEvent('handcash:receive', {
                    detail: {
                      title: 'Item received',
                      body: 'A collectable landed in your wallet',
                    },
                  }),
                )
              } catch {
                // Node tests / no DOM
              }
            }
            scheduleHistoryBackupPush('sendCollectable')
            await listCollectables(wallet).catch((err) => {
              console.warn('[collectables] post-send refresh failed', err)
            })
            chart.send({ type: 'SUCCESS', txid })
            chart.stop()
            return { txid }
          }

          const failSend = (err: unknown): never => {
            clearPendingSend(outboundPending.id)
            const formatted = formatSendError(err)
            failOutboundSendPending({
              pendingId: outboundPending.id,
              reason: formatted.message,
            })
            protectTipsFromGhostDrop([outpoint])
            forgetItemsSent([outpoint])
            console.error('[collectables] send failed', formatted.message, err)
            chart.send({ type: 'FAIL', error: formatted.message })
            chart.stop()
            void import('./logShip')
              .then((m) => m.shipAppLogsAuto('send-failure'))
              .catch(() => {})
            throw formatted
          }

          if (sendPath.path === 'refuse') {
            return failSend(new Error(sendPath.reason))
          }

          // p2pkhSend path — machine is in p2pkhSend; covenant never reaches here.
          if (!chart.getSnapshot().matches('p2pkhSend')) {
            return failSend(
              new Error('collectableSendMachine did not enter p2pkhSend'),
            )
          }

          const itemChart = createActor(itemSendMachine).start()
          itemChart.send({ type: 'START', outpoint, settlePath })

          setPaymentProgress(
            'building',
            'Preparing authenticity proof',
            outpoint,
          )
          const provenance = await tryBuildProvenanceForSend({
            tipOutpoint: outpoint,
            origin,
            wallet,
            contentType: item?.mimeType,
            inputBeef: inputBEEF,
            priorProvenance: tipCustom.provenance,
          })
          itemChart.send({ type: 'BUILT' })

          const recoverSendFailure = async (
            err: unknown,
            reference?: string | null,
          ): Promise<Error> => {
            const {
              isReviewActionsError,
              formatReviewActionsError,
              recoverFromReviewActions,
            } = await import('./actionReview')
            if (isAlreadySpentInputError(err)) await hideSpentOutpoints(spendOutpoints)
            await recoverFromReviewActions({
              err,
              reference,
              tipOutpoints: spendOutpoints,
              active: wallet,
            })
            if (isReviewActionsError(err))
              return new Error(formatReviewActionsError(err))
            return err instanceof Error ? err : new Error(String(err))
          }

          const itemInputs = () => [
            {
              outpoint,
              inputDescription: '1sat collectable',
              unlockingScriptLength: 108,
            },
          ]

          let result:
            | Awaited<ReturnType<ActiveWallet['wallet']['createAction']>>
            | undefined
          let txid = ''
          let atomicBeef: number[] | undefined
          let attemptedBatchAbort = false
          for (;;) {
            try {
              setPaymentProgress(
                'signing',
                'Signing the collectable for the recipient',
                outpoint,
              )
              console.info('[collectables] createAction start')
              result = await wallet.wallet.createAction({
                description: `Send ${name}`.slice(0, 50),
                labels: ['1sat', 'handcash-send-collectable'],
                inputBEEF,
                inputs: itemInputs(),
                outputs: [
                  {
                    lockingScript,
                    satoshis: 1,
                    outputDescription: 'Collectable transfer',
                    basket: '1sat',
                    tags,
                    customInstructions: buildCollectableCustomInstructions({
                      origin,
                      name,
                      app,
                      ...(collectionId ? { collectionId } : {}),
                      ...(content ? { content } : {}),
                      provenance,
                    }),
                  },
                ],
                options: {
                  trustSelf: 'known',
                  ...(knownTxids.length > 0 ? { knownTxids } : {}),
                  randomizeOutputs: false,
                  signAndProcess: true,
                  noSend: true,
                },
              })
              rememberBeefTree(
                atomicBeefFromWalletResult(result) ??
                  (result.signableTransaction?.tx
                    ? Array.from(result.signableTransaction.tx)
                    : undefined),
                typeof result.txid === 'string' ? result.txid : undefined,
              )
              itemChart.send({ type: 'CREATED', txid: result.txid })
              console.info(
                `[collectables] createAction done txid=${
                  result.txid ?? 'signable'
                }`,
              )
            } catch (err) {
              const { isReservedActionBatchError, abortReservedActionBatches } =
                await import('./actionReview')
              if (!attemptedBatchAbort && isReservedActionBatchError(err)) {
                attemptedBatchAbort = true
                await abortReservedActionBatches(wallet)
                continue
              }
              const formatted = await recoverSendFailure(err)
              itemChart.send({ type: 'FAIL', error: formatted.message })
              itemChart.stop()
              return failSend(formatted)
            }

            if (!result) {
              itemChart.stop()
              return failSend(
                new Error('Send completed without createAction result'),
              )
            }
            txid = result.txid ?? ''
            if (txid) {
              atomicBeef = atomicBeefFromWalletResult(result)
              break
            }
            if (!result.signableTransaction) {
              itemChart.send({
                type: 'FAIL',
                error: 'Send completed without txid',
              })
              itemChart.stop()
              return failSend(new Error('Send completed without txid'))
            }
            if (!itemChart.getSnapshot().matches('signing')) {
              itemChart.stop()
              return failSend(
                new Error('itemSendMachine did not enter signing'),
              )
            }
            try {
              setPaymentProgress('signing', 'Signing the collectable transfer')
              const signed = await signOrdinalTransfer({
                wallet,
                signable: result.signableTransaction,
                outpoints: spendOutpoints,
              })
              txid = signed.txid
              atomicBeef = signed.atomicBeef
              itemChart.send({ type: 'SIGNED', txid })
              break
            } catch (err) {
              const formatted = await recoverSendFailure(
                err,
                result.signableTransaction?.reference,
              )
              itemChart.send({ type: 'FAIL', error: formatted.message })
              itemChart.stop()
              return failSend(formatted)
            }
          }

          if (!txid) {
            itemChart.stop()
            return failSend(new Error('Send completed without txid'))
          }
          if (!atomicBeef?.length) {
            itemChart.stop()
            return failSend(new Error('Send completed without signed BEEF'))
          }
          rememberBeefTree(atomicBeef, txid)
          try {
            await wallet.wallet.actionBatch.abort()
          } catch {
            /* unused funding reservations only */
          }

          const settleSnap = itemChart.getSnapshot()
          try {
            if (mustDeliverToPeer(settleSnap)) {
              if (settlePath.settle !== 'peerDeliver') {
                itemChart.stop()
                return failSend(
                  new Error('itemSendMachine peerDeliver without settle path'),
                )
              }
              setPaymentProgress(
                'finishing',
                'Delivering item to recipient',
                outpoint,
              )
              const { notifyPeerItemIncoming } = await import(
                './messageTransport'
              )
              const { listFriends } = await import('./friends')
              const friend = listFriends().find(
                (f) =>
                  f.identityKey.toLowerCase() ===
                  settlePath.recipientIdentityKey.toLowerCase(),
              )
              const delivered = await notifyPeerItemIncoming({
                recipientIdentityKey: settlePath.recipientIdentityKey,
                rootKeyHex: wallet.rootKeyHex,
                senderIdentityKey: wallet.identityKey,
                messagebox: friend?.messagebox,
                txid,
                itemName: name,
                atomicBeef,
              })
              console.info(
                `[collectables] peerDeliver box=${delivered.delivered} beefInBox=${delivered.beefInBox}`,
              )
              if (delivered.delivered === 'cloud') {
                itemChart.send({ type: 'DELIVERED' })
              } else {
                itemChart.send({ type: 'DELIVER_FAILED' })
              }
              if (!maySenderBroadcast(itemChart.getSnapshot())) {
                itemChart.stop()
                return failSend(
                  new Error('itemSendMachine refused sender broadcast'),
                )
              }
              const silent = isSilentSenderBroadcast(itemChart.getSnapshot())
              if (!silent) {
                setPaymentProgress(
                  'broadcasting',
                  'Inbox unreachable — submitting on chain',
                  outpoint,
                )
              }
              const ok = await broadcastAtomicBeef(txid, atomicBeef)
              if (silent) {
                itemChart.send({ type: ok ? 'BROADCASTED' : 'SKIPPED' })
              } else if (!ok) {
                itemChart.stop()
                return failSend(
                  new Error(
                    'Not sent',
                  ),
                )
              } else {
                itemChart.send({ type: 'BROADCASTED' })
              }
            } else if (maySenderBroadcast(settleSnap)) {
              setPaymentProgress(
                'broadcasting',
                settleSnap.matches('selfReceive')
                  ? 'Broadcasting item back to this wallet'
                  : 'Broadcasting the collectable',
                outpoint,
              )
              const ok = await broadcastAtomicBeef(txid, atomicBeef)
              if (!ok) {
                itemChart.stop()
                return failSend(
                  new Error(
                    'Not sent',
                  ),
                )
              }
              itemChart.send({ type: 'BROADCASTED' })
            } else {
              itemChart.stop()
              return failSend(
                new Error('itemSendMachine has no legal settle phase'),
              )
            }
          } catch (err) {
            itemChart.send({
              type: 'FAIL',
              error: err instanceof Error ? err.message : String(err),
            })
            itemChart.stop()
            return failSend(err)
          }

          if (!itemChart.getSnapshot().matches('done')) {
            itemChart.stop()
            return failSend(new Error('itemSendMachine did not reach done'))
          }
          itemChart.stop()
          // Remittance on the wire names the spent tip. Extend once the settle txid is
          // known so the next send reuses tip-named proof (no hydrate).
          if (txid && provenance && parseProvenanceV2(provenance)) {
            try {
              const tipBeef = await getBeefForTxidCached(wallet, txid)
              const extended = await extendProvenanceV2({
                prior: provenance,
                heldOutpoint: `${txid.trim().toLowerCase()}_0`,
                tipBeef,
                getBeef: (hop) => getBeefForTxidCached(wallet, hop),
              })
              if (extended) {
                rememberProvenanceRemittance(extended)
                // The extended path is the durable half of that reuse: the
                // remittance above dies with the session, and a restart would
                // otherwise leave this tip proven but unable to say how.
                rememberProvenVerdict(extended.tip, {
                  tier: 'brc150',
                  origin: extended.origin,
                  path: extended.path,
                  verifiedAt: Date.now(),
                })
              }
            } catch (err) {
              console.warn('[brc-150] post-send remittance extend failed', err)
            }
          }
          return await finishSend(txid, {
            remittanceBuilt: Boolean(provenance),
          })
        } finally {
          pauseCollectableArrivalToasts = Math.max(
            0,
            pauseCollectableArrivalToasts - 1,
          )
          clearPaymentProgress()
        }
      },
      () => setPaymentProgress('preparing', undefined, outpoint),
    )
  } catch (err) {
    clearPendingSend(outboundPending.id)
    failOutboundSendPending({
      pendingId: outboundPending.id,
      reason: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
