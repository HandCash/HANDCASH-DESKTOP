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
  Utils,
  type SignableTransaction,
  type Transaction,
} from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  contentUrlForOrigin,
  discoverHardenedTipsFromBeacons,
  resolveInscriptionAtOrigin,
  resolveInscriptionPreferringOrigin,
  type CollectableTrait,
  type ResolvedInscription,
} from './oneSatImport'
import { resolvePaymentAddress } from './friends'
import { assertOnlineForPayment } from './paymentPolicy'
import { prepareSpendHeal, runExclusiveSpend } from './spendGuard'
import {
  clearPaymentProgress,
  setPaymentProgress,
} from './paymentProgress'
import {
  clearAwaitingVerification,
  clearVerificationProgress,
  noteAwaitingVerification,
  peekPreferredCollectableVerification,
  preferCollectableVerification,
  setVerificationProgress,
  takePreferredCollectableVerification,
} from './verificationProgress'
import { announceItemVerified } from './itemArrivalToast'
import { scheduleHistoryBackupPush } from './deviceSync'
import { buildMergedInputBeef, getBeefForTxidCached, rememberBeefBinary } from './beefCache'
import {
  buildCollectableCustomInstructions,
  extendProvenanceV2,
  parseProvenanceV2,
  rememberProvenanceRemittance,
  tryBuildProvenanceForSend,
  verifyProvenanceForHeldTip,
} from './oneSatProvenance'
import {
  authenticityResultToVerdict,
  type AuthenticityResult,
} from './oneSatAuthenticity'
import {
  GENESIS_PARENT_LATCH,
  LATCH_DUST_SATS,
  LATCH_SCHEMA_VERSION,
  LATCH_TAG,
  ONE_SAT_LATCH_BASKET,
  RELATIVE_TIP,
  buildLatchStateScript,
  isLatchedSendEnabled,
  latchOutputTags,
  resolveLatchTipClaim,
  toUnderscoreOutpoint,
  type LatchListing,
} from './oneSatLatch'
import {
  canUseHardenedLatch,
  isHardenedCovenantLockingScript,
  parseHardenedTipInstructions,
} from './oneSatHardenedReceive'
import { scriptPaysAddress } from './ordinalOwnership'
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
  proofHintsFromTipTx,
} from './collectableTipKind'
import { collectableSendMachine } from './collectableSendMachine'
import { softLatchSendMachine } from './softLatchSendMachine'
import { createActor } from 'xstate'
import { scanLegacyAddress } from './legacyScan'
import { isItemSent, markItemsSent } from './sentItemGuard'
import { yieldToUi } from './yieldToUi'
import {
  getProvenVerdict,
  rememberGenesisAttempt,
  rememberProvenVerdict,
  shouldAttemptGenesis,
  authenticityFromProvenCache,
  type AuthenticityTier,
} from './provenCache'
import { listRecentActivity } from './appActivity'
import { proveGenesisLineage, type GenesisProof } from './oneSatGenesisProof'
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
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'
import { isAlreadySpentInputError, releaseStaleSpendableOutputs } from './staleOutputRelease'
import type { Chain } from './vault'

export type { CollectableTrait }

export type Collectable = {
  /** Wallet outpoint `txid.vout` */
  outpoint: string
  /** Inscription origin `txid_vout` */
  origin: string
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
  /** Hardened BRC-156 or complete BRC-150 proof verified. */
  proven: boolean
  /** Exact proof tier used for this verdict. */
  authenticity: AuthenticityTier
}

type CollectablesListener = (items: Collectable[]) => void

const LIST_CACHE_KEY = 'handcash.collectables.list.v1'

let cachedCollectables: Collectable[] = []
/** True after at least one successful list (even if empty), or a durable hit. */
let collectablesHydrated = false
const collectablesListeners = new Set<CollectablesListener>()

/**
 * Address UTXO scan is the ownership oracle. Cache it briefly so Collect and
 * chain ingest do not double-fetch the same tip set in one tick.
 */
const LIVE_ONE_SAT_TTL_MS = 20_000
let cachedLiveOneSats: { at: number; keys: Set<string> } | null = null

/** Feed a fresh address scan into the ownership filter (chain ingest). */
export function rememberLiveOneSatOutpoints(
  utxos: Array<{ outpoint: string; satoshis: number }>,
): void {
  cachedLiveOneSats = { at: Date.now(), keys: liveOneSatKeys(utxos) }
}

/** Drop a cached address scan so the next list re-checks the chain. */
export function invalidateLiveOneSatOutpoints(): void {
  cachedLiveOneSats = null
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

function loadDurableList(): Collectable[] {
  try {
    const raw = durableGetItem(LIST_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { items?: unknown }
    if (!Array.isArray(parsed?.items)) return []
    return parsed.items.filter(isCollectableShape).map((item) => {
      // Verdict store outranks a stale list-cache badge from last session.
      const fromProven = authenticityFromProvenCache(item.outpoint)
      const authenticity = fromProven.proven
        ? fromProven.authenticity
        : item.authenticity === 'brc156' || item.authenticity === 'brc150'
          ? item.authenticity
          : 'unproven'
      return {
        ...item,
        traits: Array.isArray(item.traits) ? item.traits : [],
        extras: Array.isArray(item.extras) ? item.extras : [],
        proven: authenticity === 'brc156' || authenticity === 'brc150',
        authenticity,
      }
    })
  } catch {
    return []
  }
}

function persistDurableList(items: Collectable[]): void {
  try {
    durableSetItem(
      LIST_CACHE_KEY,
      JSON.stringify({
        at: Date.now(),
        items: items.map((item) => ({
          outpoint: item.outpoint,
          origin: item.origin,
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

function setCollectablesCache(items: Collectable[]) {
  const wasHydrated = collectablesHydrated
  const prev = new Set(
    cachedCollectables.map((i) => normalizeOutpoint(i.outpoint)),
  )
  const arrived = items
    .map((i) => normalizeOutpoint(i.outpoint))
    .filter((op) => !prev.has(op))
  cachedCollectables = items
  collectablesHydrated = true
  persistDurableList(items)
  notifyCollectables(items)
  // Toast as soon as a tip paints in the list — do not wait for chain-ingest
  // classify / media resolution to finish. Deduped in itemArrivalToast.
  if (wasHydrated && arrived.length > 0) {
    void import('./itemArrivalToast')
      .then(({ announceItemsReceived }) => announceItemsReceived(arrived))
      .catch(() => undefined)
  }
}

export function clearCollectablesCache(): void {
  cachedCollectables = []
  collectablesHydrated = false
  cachedLiveOneSats = null
  firstSeenAt.clear()
  durableRemoveItem(LIST_CACHE_KEY)
  notifyCollectables([])
}

export function getCachedCollectables(): Collectable[] {
  return cachedCollectables.slice()
}

export function areCollectablesHydrated(): boolean {
  return collectablesHydrated
}

export function subscribeCollectables(listener: CollectablesListener): () => void {
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
  const underscored = origin.includes('.') ? origin.replace(/\.(\d+)$/, '_$1') : origin
  const [txid, vout] = underscored.split('_')
  if (!txid) return origin
  return `${txid.slice(0, 8)}…_${vout ?? '?'}`
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  const hit = tags.find((t) => t.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

function parseOrigin(raw: string | undefined, fallbackOutpoint: string): string {
  const source = raw?.trim() || fallbackOutpoint
  return source.includes('.') ? source.replace(/\.(\d+)$/, '_$1') : source
}

function parseCustom(raw: string | undefined): {
  origin?: string
  name?: string
  app?: string
  provenance?: unknown
} {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      origin: typeof o.origin === 'string' ? o.origin : undefined,
      name: typeof o.name === 'string' ? o.name : undefined,
      app: typeof o.app === 'string' ? o.app : undefined,
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
  },
  chain: Chain,
  resolved?: Partial<ResolvedInscription> | null,
): Collectable {
  const custom = parseCustom(o.customInstructions)
  // List paints from tags + cached verdicts. Full BEEF verify runs automatically
  // Provenance verdict comes from durable cache; detail view verifies on demand.
  const verdict = getProvenVerdict(normalizeOutpoint(o.outpoint))
  // Product authenticity is BRC-150; legacy brc156 pins paint as brc150.
  const authenticity: AuthenticityTier =
    verdict?.tier === 'brc156' || verdict?.tier === 'brc150'
      ? 'brc150'
      : (verdict?.tier ?? 'unproven')
  const proven = authenticity === 'brc150'
  const claimed = tagValue(o.tags, 'origin:') ?? custom.origin
  // An indexer walk that came back with real inscription content knows the
  // lineage; a remittance origin is only the sender's claim, and a wrong one
  // paints a 404 image forever.
  const trustWalk = !isThinResolution(resolved)
  const origin = parseOrigin(
    // A lineage proof outranks both: it is the only origin this wallet verified.
    verdict?.origin ??
      (trustWalk ? (resolved?.origin ?? claimed) : (claimed ?? resolved?.origin)),
    o.outpoint,
  )
  // Tags are not display text: @bsv/sdk validateTag lowercases them, so a
  // `name:` / `app:` tag is only a flattened search key. Prefer the resolution
  // cache and remittance, which keep the original casing.
  const name =
    resolved?.name ?? custom.name ?? tagValue(o.tags, 'name:') ?? shortOrigin(origin)
  const app = resolved?.app ?? custom.app ?? tagValue(o.tags, 'app:')
  return {
    outpoint: normalizeOutpoint(o.outpoint),
    origin,
    name: name.trim() || shortOrigin(origin),
    app,
    imageUrl: contentUrlForOrigin(origin, chain),
    satoshis: o.satoshis,
    mimeType: resolved?.mimeType,
    type: resolved?.type,
    subType: resolved?.subType,
    collectionId: resolved?.collectionId,
    traits: resolved?.traits ?? [],
    extras: resolved?.extras ?? [],
    proven,
    authenticity,
  }
}

/**
 * An origin has exactly one live tip. Stray 1-sat outputs from the same
 * transfer (e.g. an unmarked latch) resolve to the tip's origin through the
 * indexer walk and would otherwise list as duplicates. Keep the best candidate:
 * proven remittance first, then sender-supplied metadata, then lowest vout.
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
    .then(async (scan) => {
      const hardened = await discoverHardenedTipsFromBeacons(scan.utxos, wallet.chain)
      rememberLiveOneSatOutpoints([...scan.utxos, ...hardened])
      // The rows on screen were filtered against a stale set (or none) — list
      // again now that the chain has answered, so ghosts leave without a tap.
      void listCollectables(wallet)
    })
    .catch((err) => {
      console.warn('[collectables] address UTXO scan failed — keeping basket list', err)
    })
    .finally(() => {
      liveScan = null
    })
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
    cachedLiveOneSats != null && Date.now() - cachedLiveOneSats.at < LIVE_ONE_SAT_TTL_MS
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

function isListableItem(o: ItemOutput): boolean {
  if (o.tags?.includes(LATCH_TAG)) return false
  // Tips are exactly 1 satoshi. Soft-latch dust or misfiled funds must not list.
  if ((o.satoshis ?? 1) !== 1) return false
  // A tip we already spent lingers in the basket until a review runs.
  if (isItemSent(o.outpoint)) return false
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
    items.push(toCollectable(o, chain, getResolvedInscription(normalizeOutpoint(o.outpoint))))
  }
  return dedupeByOrigin(items, (outpoint) => firstSeenAt.get(outpointKey(outpoint)) ?? 0)
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
    (o) => needsIndexerResolve(o) && shouldResolveInscription(normalizeOutpoint(o.outpoint)),
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
          ...upgrades.filter((o) => normalizeOutpoint(o.outpoint) === preferred),
          ...upgrades.filter((o) => normalizeOutpoint(o.outpoint) !== preferred),
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
    if (changed) setCollectablesCache(buildItems(lastItemOutputs, lastItemChain))
  } finally {
    resolvingOrigins = false
    clearVerificationProgress()
  }
}

/**
 * Lineage proofs attempted per session.
 *
 * A walk costs a fetch per hop, so an inventory of imported ordinals must earn
 * its badges over several sessions rather than opening the Collect page into a
 * few hundred requests.
 */
const GENESIS_SESSION_BUDGET = 8
/** Activity rows scanned for tips this wallet no longer holds. */
const ACTIVITY_REPAIR_DEPTH = 50
let genesisWalksThisSession = 0
let provingGenesis = false

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
  if (provingGenesis || genesisWalksThisSession >= GENESIS_SESSION_BUDGET) return
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
  if (preferred && shouldAttemptGenesis(preferred) && !candidates.includes(preferred)) {
    candidates.unshift(preferred)
  } else if (preferred && candidates.includes(preferred)) {
    candidates.splice(candidates.indexOf(preferred), 1)
    candidates.unshift(preferred)
  }
  if (candidates.length === 0) return

  provingGenesis = true
  try {
    for (const outpoint of candidates) {
      if (genesisWalksThisSession >= GENESIS_SESSION_BUDGET) break
      if (getWalletCoordinatorSnapshot().spend === 'active') break
      // A basket read newer than the one that spawned us is somebody looking at
      // the panel right now. That read has its own timeout, and a walk fetching
      // through it is how the list ends up timing out instead of painting.
      // Exception: the tip the user opened in details — finish that walk.
      if (
        outpoint !== preferred &&
        listInFlight &&
        listInFlight !== ownRead
      ) {
        break
      }
      setVerificationProgress(
        'verifying',
        outpoint,
        'Proving tip-to-origin lineage (BRC-150)',
      )
      let proof: GenesisProof | null = null
      let aborted = false
      try {
        proof = await proveGenesisLineage({
          tipOutpoint: outpoint,
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
        console.warn('[brc-150] lineage walk failed', outpoint, err)
      }
      // Only pin the attempt after a conclusive result. A transient network miss
      // must not burn the 24h budget and leave a just-received tip "Unverified"
      // until tomorrow. Aborted walks also must not burn the session budget —
      // opening details mid-walk used to exhaust the budget and strand the tip.
      if (!proof) {
        clearVerificationProgress(outpoint)
        if (!aborted) {
          // Conclusive miss — drop the receive spinner so we are not stuck on
          // "Verifying…" forever with no chance to look unverified + retry later.
          clearAwaitingVerification(outpoint)
          genesisWalksThisSession++
        }
        continue
      }
      genesisWalksThisSession++
      rememberGenesisAttempt(outpoint)

      console.info(
        `[brc-150] proved ${outpoint} back to ${proof.origin} in ${proof.hops} hop(s)`,
      )
      rememberProvenVerdict(outpoint, {
        tier: 'brc150',
        origin: proof.origin,
        verifiedAt: Date.now(),
      })
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
  if (verdict?.tier === 'brc156') {
    clearAwaitingVerification(target)
    clearVerificationProgress(target)
    return
  }
  // BRC-150 may still upgrade to BRC-156 when the tip is a hardened covenant.
  const cached = getCachedCollectables().find((c) => normalizeOutpoint(c.outpoint) === target)
  if (verdict?.tier === 'brc150') {
    const originForUpgrade = cached?.origin || verdict.origin
    if (originForUpgrade) {
      noteAwaitingVerification(target)
      setVerificationProgress('verifying', target, 'Verifying authenticity')
      void verifyItemAuthenticity(target, originForUpgrade).catch(() => undefined)
      return
    }
    clearAwaitingVerification(target)
    clearVerificationProgress(target)
    return
  }
  noteAwaitingVerification(target)
  const locking = lastItemOutputs.find(
    (o) => normalizeOutpoint(o.outpoint) === target,
  )?.lockingScript
  const hardened = Boolean(locking && isHardenedCovenantLockingScript(locking))
  setVerificationProgress(
    'verifying',
    target,
    hardened ? 'Verifying BRC-156 covenant' : 'Proving tip-to-origin lineage (BRC-150)',
  )
  if (cached?.origin) {
    void verifyItemAuthenticity(target, cached.origin).catch(() => undefined)
    return
  }
  if (!shouldAttemptGenesis(target)) return
  if (provingGenesis) return
  const wallet = getActiveWallet()
  if (!wallet) return
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
  return value.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
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
    ...(resolved?.name || keep?.name ? { name: resolved?.name || keep?.name } : {}),
    ...(resolved?.app || keep?.app ? { app: resolved?.app || keep?.app } : {}),
    ...(resolved?.mimeType || keep?.mimeType
      ? { mimeType: resolved?.mimeType || keep?.mimeType }
      : {}),
    traits:
      rich?.traits?.length
        ? rich.traits
        : resolved?.traits?.length
          ? resolved.traits
          : (keep?.traits ?? []),
    extras:
      rich?.extras?.length
        ? rich.extras
        : resolved?.extras?.length
          ? resolved.extras
          : (keep?.extras ?? []),
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
async function walkInscription(outpoint: string): Promise<ResolvedInscription | null> {
  const knownOrigin =
    getProvenVerdict(outpoint)?.origin ?? getResolvedInscription(outpoint)?.origin
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
 * Order: remittance (incl. parent soft-latch remittance) → lineage walk → unproven.
 * Scoped to a single outpoint so remittance BEEF never loads for a whole basket.
 */
export async function verifyItemAuthenticity(
  outpoint: string,
  originTag: string,
  active?: ActiveWallet | null,
): Promise<AuthenticityResult> {
  const target = normalizeOutpoint(outpoint)
  const cached = getProvenVerdict(target)
  if (cached?.tier === 'brc150' || cached?.tier === 'brc156') {
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
      return { tier: 'unproven', proven: false, reason: 'Collectable output not found' }
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

    if (provenance != null) {
      const remittance = await verifyProvenanceForHeldTip({
        provenance,
        heldOutpoint: target,
        getBeef: (txid) => getBeefForTxidCached(wallet, txid),
      })
      if (remittance.proven) {
        authenticity = { tier: 'brc150', proven: true, reason: null }
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
          `[brc-150] remittance verified ${target.slice(0, 14)}… → ${String(provenOrigin).slice(0, 18)}…`,
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
        authenticity = { tier: 'brc150', proven: true, reason: null }
        console.info(
          `[brc-150] lineage proved ${target.slice(0, 14)}… in ${proof.hops} hop(s)`,
        )
      }
    }

    if (!provenOrigin && authenticity.proven) {
      provenOrigin = custom.origin ?? tag
    }

    rememberProvenVerdict(target, {
      ...authenticityResultToVerdict(authenticity),
      ...(provenOrigin ? { origin: originKey(provenOrigin) } : {}),
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

function applyAuthenticityResult(outpoint: string, result: AuthenticityResult): void {
  const target = normalizeOutpoint(outpoint)
  // Durable provenCache is the only authenticity SSoT. Never paint Unverified
  // over an existing proven tier. Product badge is always BRC-150.
  const verdict = getProvenVerdict(target)
  if (verdict?.tier === 'brc150' || verdict?.tier === 'brc156') {
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
  if (painted?.tier !== 'brc150' && painted?.tier !== 'brc156') return
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
export function listCollectables(active?: ActiveWallet | null): Promise<Collectable[]> {
  if (listInFlight) return listInFlight
  const run = listCollectablesNow(active)
  listInFlight = run
  void run
    .catch(() => {})
    .then(() => {
      if (listInFlight === run) listInFlight = null
    })
  return run
}

async function listCollectablesNow(
  active?: ActiveWallet | null,
): Promise<Collectable[]> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) return getCachedCollectables()

  let outputs: ItemOutput[] = []

  try {
    const result = await Promise.race([
      wallet.wallet.listOutputs({
        basket: '1sat',
        limit: 1000,
        includeTags: true,
        // Locking scripts are small and let us spare BRC-156 covenant tips from
        // address-scan ghosting. Never pull customInstructions for a whole
        // basket: remittance BEEF (~400k chars each) crashed phones.
        includeCustomInstructions: false,
        include: 'locking scripts',
        seekPermission: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('listOutputs timed out')), LIST_TIMEOUT_MS),
      ),
    ])
    outputs = (result.outputs ?? []).map((o) => ({
      outpoint: o.outpoint,
      satoshis: o.satoshis ?? 1,
      tags: o.tags,
      lockingScript:
        typeof (o as { lockingScript?: unknown }).lockingScript === 'string'
          ? ((o as { lockingScript: string }).lockingScript)
          : undefined,
    }))
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

  // Basket rows are necessary but not sufficient. Ownership fate is exhaustive:
  // keepLive | graceHold | keepCovenant | ghostDrop — only ghostDrop relinquish.
  // Covenant tips never appear on the P2PKH address scan (only their beacon does).
  const live = resolveLiveOneSatKeys(wallet)
  if (live) {
    const { owned, spentOrMissing } = partitionByLiveUtxos(outputs, live.keys)
    const keptMissing: ItemOutput[] = []
    const ghosts: ItemOutput[] = []
    for (const o of spentOrMissing) {
      if ((o.satoshis ?? 1) !== 1 || o.tags?.includes(LATCH_TAG)) continue
      const unjudged = isOwnershipUnjudged({
        firstSeenAt: firstSeenAt.get(outpointKey(o.outpoint)) ?? seenNow,
        liveAt: live.at,
        now: seenNow,
        graceMs: OWNERSHIP_SETTLE_GRACE_MS,
      })
      const verdict = getProvenVerdict(normalizeOutpoint(o.outpoint))
      const fate = ownershipFate({
        tipKind: classifyTipKind(o.lockingScript),
        inLiveSet: false,
        unjudged,
        provenTier: verdict?.tier ?? null,
      })
      if (fate === 'ghostDrop') ghosts.push(o)
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
  }

  lastItemOutputs = outputs
  lastItemChain = wallet.chain

  // Everything the list renders (name, app, image) comes from the output itself
  // or the resolution cache, so paint now and let authenticity + indexer catch up.
  const deduped = buildItems(outputs, wallet.chain)
  setCollectablesCache(deduped)
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
        item = {
          ...item,
          origin: resolved.origin || item.origin,
          name: resolved.name?.trim() || item.name,
          app: resolved.app ?? item.app,
          mimeType: resolved.mimeType ?? item.mimeType,
          type: resolved.type ?? item.type,
          subType: resolved.subType ?? item.subType,
          collectionId: resolved.collectionId ?? item.collectionId,
          traits: resolved.traits.length ? resolved.traits : item.traits,
          extras: resolved.extras.length ? resolved.extras : item.extras,
          imageUrl: contentUrlForOrigin(resolved.origin || item.origin, wallet.chain),
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
      .then((result) => applyAuthenticityResult(target, result))
      .catch(() => {})
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
    if (name.includes('INSUFFICIENT_FUNDS') || /insufficient.?funds/i.test(msg)) {
      return new Error('Not enough BSV to cover the network fee for this transfer')
    }
    // Must not match `unlockingScript` — that is a signing fault, not a bad recipient.
    if (/invalid.*(address|identity key)/i.test(msg) || /outputs\[\d+]\.lockingScript/i.test(msg)) {
      return new Error('Invalid recipient address or identity key')
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
  lockingScript: string | undefined,
  wallet: ActiveWallet,
): void {
  if (!lockingScript) return
  // Hardened covenant tips are owned by the identity key, not a P2PKH template.
  if (isHardenedCovenantLockingScript(lockingScript)) return
  if (!scriptPaysAddress(lockingScript, wallet.address)) {
    throw new Error(
      'This collectable is locked to a key this device cannot sign. Restore the wallet that received it, then send again.',
    )
  }
}

/**
 * BEEF covering every outpoint this send spends.
 *
 * `buildSignableTransaction` reads each user input's source transaction out of
 * the BEEF we pass, so a tip and a latch from different transactions both have to
 * be in it — otherwise the toolbox fails with "Every signableTransaction input
 * must have a sourceTransaction". Fetches run in parallel and share a session
 * cache with provenance / settle / origin lookups so a send never pays twice for
 * the same mined body.
 */
async function buildInputBeefForSpends(
  wallet: ActiveWallet,
  outpoints: string[],
): Promise<number[]> {
  return buildMergedInputBeef(wallet, outpoints, normalizeOutpoint)
}

/**
 * BRC-100 only auto-signs the wallet's own BRC-29 change, so ordinal / latch
 * inputs come back as a signable transaction for us to unlock with the root key.
 *
 * Hardened covenant tips MUST NOT use the P2PKH unlock template.
 */
async function signOrdinalTransfer(args: {
  wallet: ActiveWallet
  signable: SignableTransaction
  /** Tip + optional latch outpoints we must unlock. */
  outpoints: string[]
}): Promise<string> {
  const targets = new Map<string, number>()
  for (const op of args.outpoints) {
    const [txidIn, voutRaw] = normalizeOutpoint(op).split('.')
    targets.set(`${txidIn?.toLowerCase()}.${Number(voutRaw)}`, Number(voutRaw))
  }

  const beef = Beef.fromBinary(args.signable.tx)
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
    throw new Error('Collectable input missing from the signable transaction')
  }

  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    const locking =
      input.sourceTransaction?.outputs[input.sourceOutputIndex]?.lockingScript?.toHex()
    if (isHardenedCovenantLockingScript(locking)) {
      throw new Error(
        'This collectable uses a hardened BRC-156 covenant and cannot be spent with a P2PKH unlock. Use the hardened Commit/Settle send path.',
      )
    }
  }

  const rootKey = PrivateKey.fromHex(args.wallet.rootKeyHex)
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    // The sighash covers the source value, and a latch is not 1 sat like the tip,
    // so read each value from its source transaction instead of assuming one.
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    const satoshis = input.sourceTransaction?.outputs[input.sourceOutputIndex]?.satoshis
    if (typeof satoshis !== 'number') {
      throw new Error('Collectable input is missing its source transaction')
    }
    input.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(rootKey, satoshis)
  }
  await unsigned.sign()
  for (const vin of vins) {
    const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Could not sign the collectable transfer')
    spends[vin] = { unlockingScript }
  }

  const signed = await args.wallet.wallet.signAction({
    reference: args.signable.reference,
    spends,
  })
  if (!signed.txid) throw new Error('Collectable transfer returned no txid')
  return signed.txid
}

/** Find the soft-latch UTXO paired with this tip (same origin, tip: tag match). */
async function findLatchForTip(
  wallet: ActiveWallet,
  tipOutpoint: string,
  origin: string,
): Promise<LatchListing | null> {
  const tip = toUnderscoreOutpoint(tipOutpoint)
  const originU = toUnderscoreOutpoint(origin)
  const originTag = originU.replace(/_(\d+)$/, '.$1')
  try {
    // Origin tag first — a full latch basket read is wasted work when the tip's
    // origin is already known (the usual case on send).
    const result = await wallet.wallet.listOutputs({
      basket: ONE_SAT_LATCH_BASKET,
      tags: [`origin:${originTag}`],
      tagQueryMode: 'all',
      limit: 40,
      includeTags: true,
      include: 'locking scripts',
      seekPermission: false,
    })
    for (const o of result.outputs ?? []) {
      const tags = o.tags ?? []
      if (!tags.includes(LATCH_TAG)) continue
      // Never pair a new send with a latch an earlier send already spent.
      if (isItemSent(o.outpoint)) continue
      const tagOrigin = tagValue(tags, 'origin:')
      if (tagOrigin && toUnderscoreOutpoint(tagOrigin) !== originU) continue
      const tipTag = tagValue(tags, 'tip:')
      if (!tipTag) continue
      const claimed = resolveLatchTipClaim(o.outpoint, tipTag)
      if (claimed !== tip) continue
      return {
        outpoint: normalizeOutpoint(o.outpoint),
        origin: originU,
        tip,
        satoshis: o.satoshis ?? LATCH_DUST_SATS,
        lockingScript: o.lockingScript,
      }
    }
  } catch (err) {
    console.warn('[collectables] latch list failed', err)
  }
  return null
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
      // Already marked spent by createAction — nothing left to release.
      console.warn('[collectables] relinquish after send skipped', spend.outpoint, err)
    }
  }
}

let hardenedModuleWarm: Promise<unknown> | null = null

/**
 * Pull the covenant bridge into memory ahead of a hardened send.
 *
 * The scrypt-ts contract is a large chunk kept out of the main bundle, and on a
 * phone parsing it costs real time — as does `loadArtifact` once the chunk is
 * present. Calling this while the user is still reading the confirm screen moves
 * both costs off the transfer itself.
 */
export function warmHardenedSend(recipientIdentityKey?: string | null): void {
  // Genesis is off, but covenant resend still needs the scrypt chunk.
  if (!canUseHardenedLatch({ publicKey: recipientIdentityKey })) {
    return
  }
  hardenedModuleWarm ??= import('./oneSatHardenedSend')
    .then(async (mod) => {
      // Artifact compile is sync and cheap once the chunk is parsed; do it now
      // so the first unlock does not pay for it on tap.
      const { loadBrc156CovenantArtifact } = await import('./oneSatHardenedLatch')
      loadBrc156CovenantArtifact()
      return mod
    })
    .catch(() => null)
}

/**
 * Transfer a basket `1sat` ordinal to a P2PKH address via BRC-100 createAction.
 *
 * Path selection is exhaustive via `chooseSendPath` + `collectableSendMachine`:
 * hardenedGenesis | hardenedResend | softLatch | refuse. There is no try/catch
 * fallthrough from hardened to soft-latch.
 *
 * Soft-latch (BRC-156): settle-style single tx spends tip (+ prior latch when
 * present) and creates recipient tip (vout 0) + latch (vout 1).
 *
 * Hardened (BRC-156 schema 2): Commit + Settle (+ 2-sat P2PKH beacon) via
 * noSend/sendWith when `chooseSendPath` returns a hardened path.
 */
export async function sendCollectable(args: {
  outpoint: string
  toAddress: string
  /** Enables hardened BRC-156; a bare address intentionally falls back to BRC-150. */
  recipientIdentityKey?: string | null
  name?: string
  origin?: string
  app?: string
}): Promise<{ txid: string }> {
  const outpoint = normalizeOutpoint(args.outpoint)
  // Before the spend FIFO — pill + inventory badge while waiting on sync.
  setPaymentProgress(
    'preparing',
    'Waiting to send the collectable',
    outpoint,
  )
  return runExclusiveSpend(async () => {
    try {
    assertOnlineForPayment()
    setPaymentProgress('preparing', undefined, outpoint)
    await prepareSpendHeal()
    const wallet = getActiveWallet()
    if (!wallet) throw new Error('Wallet locked')

  setPaymentProgress(
    'building',
    'Preparing the collectable for transfer',
    outpoint,
  )
  const to = resolvePaymentAddress(args.toAddress, wallet.chain)

  let lockingScript: string
  try {
    lockingScript = new P2PKH().lock(to).toHex()
  } catch {
    throw new Error('Invalid recipient address or identity key')
  }

  // Prefer the in-memory list for name/origin so the tip listOutputs can be a
  // tagged narrow query instead of a full-basket read of every held ordinal.
  const cachedItem = cachedCollectables.find((i) => i.outpoint === outpoint) ?? null
  const originGuess = parseOrigin(args.origin ?? cachedItem?.origin, outpoint)
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
  assertOrdinalIsDeviceLocked(match.lockingScript, wallet)

  const item = cachedItem ?? (await getCollectable(outpoint, wallet)) ?? null
  // Remittance identity must not come from tags — the SDK lowercases them, and
  // after the signing-speed path we paint the list from those flattened tags.
  // Resolution cache + tip remittance keep the case the recipient should see.
  const resolvedMeta = getResolvedInscription(outpoint)
  const tipCustom = parseCustom(match.customInstructions)
  const origin = parseOrigin(
    resolvedMeta?.origin ?? tipCustom.origin ?? args.origin ?? item?.origin,
    outpoint,
  )
  const name =
    (resolvedMeta?.name ?? tipCustom.name ?? args.name ?? item?.name ?? 'Collectable')
      .trim()
      .slice(0, 40) || 'Collectable'
  const app = resolvedMeta?.app ?? tipCustom.app ?? args.app ?? item?.app
  const tags = [
    'ordinal',
    `origin:${origin.replace(/_(\d+)$/, '.$1')}`,
    `name:${name.slice(0, 80)}`,
    ...(app ? [`app:${app.slice(0, 40)}`] : []),
  ]

  // Latch discovery and tip BEEF are independent — run them together so the
  // slower of the two dominates instead of their sum.
  const tipBeefPromise = buildInputBeefForSpends(wallet, [outpoint])
  const [priorLatch, tipBeefBin] = await Promise.all([
    isLatchedSendEnabled() ? findLatchForTip(wallet, outpoint, origin) : Promise.resolve(null),
    tipBeefPromise,
  ])
  if (priorLatch?.lockingScript) {
    assertOrdinalIsDeviceLocked(priorLatch.lockingScript, wallet)
  }
  const parentLatch = priorLatch
    ? toUnderscoreOutpoint(priorLatch.outpoint)
    : GENESIS_PARENT_LATCH

  rememberBeefBinary(outpoint.split('.')[0]!, tipBeefBin)

  let inputBEEF = tipBeefBin
  if (priorLatch) {
    const latchTxid = normalizeOutpoint(priorLatch.outpoint).split('.')[0]
    if (latchTxid && !Beef.fromBinary(tipBeefBin).findTxid(latchTxid)?.tx) {
      inputBEEF = await buildInputBeefForSpends(wallet, [
        outpoint,
        priorLatch.outpoint,
      ])
    }
  }
  const spendOutpoints = [outpoint, ...(priorLatch ? [priorLatch.outpoint] : [])]
  const knownTxids = [
    ...new Set(
      spendOutpoints
        .map((op) => normalizeOutpoint(op).split('.')[0])
        .filter((txid): txid is string => !!txid),
    ),
  ]

  // Self-send to our own P2PKH address still hardens: the address cannot be
  // reversed into a key, but it is ours, so the wallet's identity key is the
  // recipient.
  let recipientIdentityKey =
    typeof args.recipientIdentityKey === 'string' && args.recipientIdentityKey.trim()
      ? args.recipientIdentityKey.trim()
      : null
  if (!recipientIdentityKey && to === wallet.address && wallet.identityKey) {
    recipientIdentityKey = wallet.identityKey
  }

  const tipKind = classifyTipKind(match.lockingScript)
  const tipVerdict = getProvenVerdict(outpoint)
  const remittance = parseHardenedTipInstructions(match.customInstructions)
  const tipTxid = outpoint.split('.')[0]!
  const tipTx = Beef.fromBinary(inputBEEF).findTxid(tipTxid)?.tx
  const tipHints = proofHintsFromTipTx(tipTx)
  const sendPath = chooseSendPath({
    tipKind,
    provenTier: tipVerdict?.tier ?? null,
    recipientIdentityKey,
    latchOutpoint: priorLatch?.outpoint ?? null,
    tipCustomInstructions: match.customInstructions,
    remittanceProofOutpoint: remittance?.proofOutpoint,
    opReturnProofOutpoint: tipHints.opReturnProofOutpoint,
    commitDerivedProofOutpoint: tipHints.commitDerivedProofOutpoint,
  })

  const chart = createActor(collectableSendMachine).start()
  chart.send({ type: 'START', outpoint, sendPath })
  console.info(
    `[brc-156] send path=${sendPath.path}${
      sendPath.path === 'hardenedResend'
        ? ` proof=${sendPath.proofOutpoint} via ${sendPath.proofSource}`
        : sendPath.path === 'refuse'
          ? ` reason=${sendPath.reason}`
          : ''
    } tipKind=${tipKind.kind}`,
  )

  const finishSend = async (
    txid: string,
    opts?: { remittanceBuilt?: boolean },
  ): Promise<{ txid: string }> => {
    markItemsSent([
      { outpoint, txid },
      ...(priorLatch ? [{ outpoint: priorLatch.outpoint, txid }] : []),
    ])
    // Soft-latch remittance proves the spent tip; the new tip inherits that
    // proof on receive via verifyProvenanceForHeldTip. Pin BRC-150 for the
    // sender's new tip when we built remittance (self-pay / local cache).
    if (opts?.remittanceBuilt) {
      rememberProvenVerdict(`${txid.trim().toLowerCase()}.0`, {
        tier: 'brc150',
        origin: origin.replace(/\.(\d+)$/, '_$1').toLowerCase(),
        verifiedAt: Date.now(),
      })
    }
    invalidateLiveOneSatOutpoints()
    await relinquishSpentOutputs(wallet, [
      { outpoint, basket: '1sat' },
      ...(priorLatch
        ? [{ outpoint: priorLatch.outpoint, basket: ONE_SAT_LATCH_BASKET }]
        : []),
    ])
    setPaymentProgress('finishing')
    setCollectablesCache(cachedCollectables.filter((i) => i.outpoint !== outpoint))
    scheduleHistoryBackupPush('sendCollectable')
    void listCollectables(wallet).catch((err) => {
      console.warn('[collectables] post-send refresh failed', err)
    })
    chart.send({ type: 'SUCCESS', txid })
    chart.stop()
    return { txid }
  }

  const failSend = (err: unknown): never => {
    const formatted = formatSendError(err)
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

  if (sendPath.path === 'hardenedGenesis' || sendPath.path === 'hardenedResend') {
    if (!chart.getSnapshot().matches('hardened')) {
      return failSend(new Error('collectableSendMachine did not enter hardened'))
    }
    let originLockingScriptHex: string | undefined
    let legacyParentOutpoint: string | undefined
    if (sendPath.path === 'hardenedGenesis') {
      const tipTx = Beef.fromBinary(inputBEEF).findTxid(outpoint.split('.')[0]!)?.tx
      const parentIn = tipTx?.inputs[0]
      if (parentIn?.sourceTXID != null) {
        legacyParentOutpoint = `${String(parentIn.sourceTXID)}_${parentIn.sourceOutputIndex}`
      }
      const [originTxid, originVoutRaw] = origin.split(/[_.]/)
      const originVout = Number(originVoutRaw)
      if (originTxid && Number.isInteger(originVout)) {
        originLockingScriptHex = Beef.fromBinary(inputBEEF)
          .findTxid(originTxid)
          ?.tx?.outputs[originVout]?.lockingScript?.toHex()
      }
      if (
        !originLockingScriptHex &&
        originTxid &&
        Number.isInteger(originVout) &&
        wallet.services
      ) {
        try {
          const originBeef = await getBeefForTxidCached(wallet, originTxid)
          originLockingScriptHex = originBeef
            .findTxid(originTxid)
            ?.tx?.outputs[originVout]?.lockingScript?.toHex()
        } catch (err) {
          console.warn('[collectables] origin script fetch failed', err)
        }
      }
      if (!originLockingScriptHex) {
        const custom = parseCustom(match.customInstructions)
        const prov = custom.provenance as { beefB64?: string; path?: string[] } | undefined
        if (typeof prov?.beefB64 === 'string') {
          try {
            const bin = Utils.toArray(prov.beefB64, 'base64')
            const beef = Beef.fromBinary(bin)
            originLockingScriptHex = beef
              .findTxid(originTxid!)
              ?.tx?.outputs[originVout]?.lockingScript?.toHex()
          } catch {
            // sendHardenedCollectable will require the script.
          }
        }
      }
    }
    try {
      const { sendHardenedCollectable } = await import('./oneSatHardenedSend')
      setPaymentProgress(
        'broadcasting',
        'Signing and broadcasting the hardened transfer',
      )
      const result = await sendHardenedCollectable({
        wallet,
        outpoint,
        recipientIdentityKey: recipientIdentityKey!,
        toAddress: to,
        origin,
        name,
        app,
        mimeType: item?.mimeType,
        tipLockingScript: match.lockingScript,
        tipCustomInstructions: match.customInstructions,
        // Delayed proof comes from remittance / covenant link — never the
        // latch-basket beacon row. Pass the resolved outpoint for resend.
        priorProofOutpoint:
          sendPath.path === 'hardenedResend' ? sendPath.proofOutpoint : null,
        priorProofLockingScript: undefined,
        originLockingScriptHex,
        legacyParentOutpoint,
        inputBEEF,
        knownTxids,
        buildInputBeefForSpends,
        normalizeOutpoint,
        formatSendError,
        isAlreadySpentInputError,
        releaseStaleSpendableOutputs,
      })
      return await finishSend(result.txid)
    } catch (err) {
      if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
      return failSend(err)
    }
  }

  // softLatch path — machine is in softLatch; covenant never reaches here.
  if (!chart.getSnapshot().matches('softLatch')) {
    return failSend(new Error('collectableSendMachine did not enter softLatch'))
  }

  const softChart = createActor(softLatchSendMachine).start()
  softChart.send({ type: 'START', outpoint })

  const provenance = await tryBuildProvenanceForSend({
    tipOutpoint: outpoint,
    origin,
    wallet,
    contentType: item?.mimeType,
    parentLatch,
    inputBeef: inputBEEF,
    priorProvenance: tipCustom.provenance,
  })
  softChart.send({ type: 'BUILT' })

  const inputs = [
    {
      outpoint,
      inputDescription: '1sat collectable',
      unlockingScriptLength: 108,
    },
    ...(priorLatch
      ? [
          {
            outpoint: priorLatch.outpoint,
            inputDescription: '1sat latch',
            unlockingScriptLength: 108,
          },
        ]
      : []),
  ]

  let result: { txid?: string; signableTransaction?: SignableTransaction }
  try {
    setPaymentProgress(
      'broadcasting',
      'Signing and broadcasting the collectable',
    )
    result = await wallet.wallet.createAction({
      description: `Send ${name}`.slice(0, 50),
      labels: [
        '1sat',
        ...(isLatchedSendEnabled() ? ['1sat-latch'] : []),
        'handcash-send-collectable',
      ],
      inputBEEF,
      inputs,
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
            provenance,
          }),
        },
        ...(isLatchedSendEnabled()
          ? [
              {
                lockingScript,
                satoshis: LATCH_DUST_SATS,
                outputDescription: '1sat proof latch',
                basket: ONE_SAT_LATCH_BASKET,
                tags: latchOutputTags({ origin, tip: RELATIVE_TIP }),
                customInstructions: JSON.stringify({
                  schema: 1,
                  origin: toUnderscoreOutpoint(origin),
                  tip: RELATIVE_TIP,
                  parentLatch,
                }),
              },
              {
                lockingScript: buildLatchStateScript({
                  schema: LATCH_SCHEMA_VERSION,
                  origin,
                  tip: RELATIVE_TIP,
                  parentLatch,
                  name,
                  app,
                  mimeType: item?.mimeType,
                }),
                satoshis: 0,
                outputDescription: '1sat latch state',
              },
            ]
          : []),
      ],
      options: {
        trustSelf: 'known',
        ...(knownTxids.length > 0 ? { knownTxids } : {}),
        randomizeOutputs: false,
        acceptDelayedBroadcast: false,
        signAndProcess: true,
      },
    })
    softChart.send({ type: 'CREATED', txid: result.txid })
  } catch (err) {
    if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
    softChart.send({
      type: 'FAIL',
      error: err instanceof Error ? err.message : String(err),
    })
    softChart.stop()
    return failSend(err)
  }

  let txid = result.txid
  if (!txid) {
    if (!result.signableTransaction) {
      softChart.send({ type: 'FAIL', error: 'Send completed without txid' })
      softChart.stop()
      return failSend(new Error('Send completed without txid'))
    }
    if (!softChart.getSnapshot().matches('signing')) {
      softChart.stop()
      return failSend(new Error('softLatchSendMachine did not enter signing'))
    }
    try {
      setPaymentProgress('signing', 'Signing the collectable transfer')
      txid = await signOrdinalTransfer({
        wallet,
        signable: result.signableTransaction,
        outpoints: spendOutpoints,
      })
      softChart.send({ type: 'SIGNED', txid })
    } catch (err) {
      if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
      softChart.send({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
      softChart.stop()
      return failSend(err)
    }
  }

  softChart.stop()
  // Soft-latch remittance on the wire names the spent tip. Extend once the
  // settle txid is known so the next send reuses tip-named proof (no hydrate).
  if (txid && provenance && parseProvenanceV2(provenance)) {
    try {
      const tipBeef = await getBeefForTxidCached(wallet, txid)
      const extended = extendProvenanceV2({
        prior: provenance,
        heldOutpoint: `${txid.trim().toLowerCase()}_0`,
        tipBeef,
      })
      if (extended) rememberProvenanceRemittance(extended)
    } catch (err) {
      console.warn('[brc-150] post-send remittance extend failed', err)
    }
  }
  return await finishSend(txid, { remittanceBuilt: Boolean(provenance) })
} finally {
      clearPaymentProgress()
    }
  })
}
