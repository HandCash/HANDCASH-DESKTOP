/**
 * Collectables = outputs in BRC-100 basket `1sat`.
 * Recursive inscription content (HTML/JS that loads other inscriptions) is still a 1sat tip —
 * same basket, same customInstructions remittance, same BRC-39 historyReplica. No second basket.
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
  contentUrlForOrigin,
  resolveOneSatInscription,
  type CollectableTrait,
  type ResolvedInscription,
} from './oneSatImport'
import { resolvePaymentAddress } from './friends'
import { assertOnlineForPayment } from './paymentPolicy'
import { prepareSpendHeal, runExclusiveSpend } from './spendGuard'
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  buildCollectableCustomInstructions,
  tryBuildProvenanceForSend,
  verifyProvenance,
} from './oneSatProvenance'
import {
  GENESIS_PARENT_LATCH,
  LATCH_DUST_SATS,
  LATCH_TAG,
  ONE_SAT_LATCH_BASKET,
  RELATIVE_TIP,
  isLatchedSendEnabled,
  latchOutputTags,
  resolveLatchTipClaim,
  toUnderscoreOutpoint,
  type LatchListing,
} from './oneSatLatch'
import { scriptPaysAddress } from './ordinalOwnership'
import { isItemSent, markItemsSent } from './sentItemGuard'
import {
  hasProvenVerdict,
  isItemProven,
  rememberProvenVerdict,
} from './provenCache'
import {
  getResolvedInscription,
  rememberResolvedInscription,
  rememberUnresolved,
  shouldResolveInscription,
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
  /** BRC-150 provenance verified for this tip (false = claim / indexer only). */
  proven: boolean
}

type CollectablesListener = (items: Collectable[]) => void

const LIST_CACHE_KEY = 'handcash.collectables.list.v1'

let cachedCollectables: Collectable[] = []
/** True after at least one successful list (even if empty), or a durable hit. */
let collectablesHydrated = false
const collectablesListeners = new Set<CollectablesListener>()

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
    return parsed.items.filter(isCollectableShape).map((item) => ({
      ...item,
      traits: Array.isArray(item.traits) ? item.traits : [],
      extras: Array.isArray(item.extras) ? item.extras : [],
      proven: item.proven === true,
    }))
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
  cachedCollectables = items
  collectablesHydrated = true
  persistDurableList(items)
  notifyCollectables(items)
}

export function clearCollectablesCache(): void {
  cachedCollectables = []
  collectablesHydrated = false
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
  const origin = parseOrigin(
    tagValue(o.tags, 'origin:') ?? resolved?.origin,
    o.outpoint,
  )
  const name = tagValue(o.tags, 'name:') ?? resolved?.name ?? shortOrigin(origin)
  const app = tagValue(o.tags, 'app:') ?? resolved?.app
  // List paints from tags + cached verdicts. Full BEEF verify runs automatically
  // in the background after paint — see `scheduleAuthenticitySweep`.
  const proven = isItemProven(normalizeOutpoint(o.outpoint))
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
  }
}

/**
 * An origin has exactly one live tip. Stray 1-sat outputs from the same
 * transfer (e.g. an unmarked latch) resolve to the tip's origin through the
 * indexer walk and would otherwise list as duplicates. Keep the best candidate:
 * proven remittance first, then sender-supplied metadata, then lowest vout.
 */
function dedupeByOrigin(items: Collectable[]): Collectable[] {
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
      rank(item) > rank(prior) ||
      (rank(item) === rank(prior) && vout(item) < vout(prior))
    if (better) best.set(key, item)
  }
  return order.map((key) => best.get(key)!)
}

type ItemOutput = {
  outpoint: string
  satoshis: number
  tags?: string[]
}

/** Kept so a late resolution can rebuild the list without re-listing outputs. */
let lastItemOutputs: ItemOutput[] = []
let lastItemChain: Chain = 'main'
let resolvingOrigins = false

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
  return dedupeByOrigin(items)
}

/**
 * Fill in origins only for tips remittance could not verify.
 *
 * Runs after the list is already on screen. P2P items never enter this queue.
 */
async function resolveUnknownOrigins(): Promise<void> {
  if (resolvingOrigins) return
  const pending = lastItemOutputs.filter(
    (o) =>
      isListableItem(o) &&
      needsIndexerResolve(o) &&
      shouldResolveInscription(normalizeOutpoint(o.outpoint)),
  )
  if (pending.length === 0) return

  resolvingOrigins = true
  try {
    let changed = false
    for (const o of pending) {
      const outpoint = normalizeOutpoint(o.outpoint)
      const [txid, voutStr] = outpoint.split('.')
      const vout = Number(voutStr)
      if (!txid || !Number.isInteger(vout)) continue
      let resolved: ResolvedInscription | null = null
      try {
        resolved = await resolveOneSatInscription(txid, vout, lastItemChain, 6)
      } catch {
        // keep fallbacks
      }
      if (resolved) {
        rememberResolvedInscription(outpoint, resolved)
        changed = true
      } else {
        rememberUnresolved(outpoint)
      }
    }
    if (changed) setCollectablesCache(buildItems(lastItemOutputs, lastItemChain))
  } finally {
    resolvingOrigins = false
  }
}

let listInFlight: Promise<Collectable[]> | null = null
let authenticitySweep: Promise<void> | null = null

/** Yield so BEEF parse/verify does not monopolise the UI thread. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 120 })
      return
    }
    setTimeout(resolve, 0)
  })
}

/**
 * Verify one tip's BRC-150 remittance and remember the verdict.
 *
 * Scoped to a single outpoint: remittance holds the BEEF (~400k chars) that
 * proves tip → origin. Never pull that for a whole basket at once.
 */
export async function verifyItemAuthenticity(
  outpoint: string,
  originTag: string,
  active?: ActiveWallet | null,
): Promise<boolean> {
  const target = normalizeOutpoint(outpoint)
  if (hasProvenVerdict(target)) return isItemProven(target)

  const wallet = active ?? getActiveWallet()
  const tag = originTag.trim().replace(/_(\d+)$/, '.$1')
  if (!wallet || !tag) return false

  try {
    const result = await wallet.wallet.listOutputs({
      basket: '1sat',
      tags: [`origin:${tag}`],
      tagQueryMode: 'all',
      limit: 10,
      includeCustomInstructions: true,
      seekPermission: false,
    })
    const match = (result.outputs ?? []).find(
      (o) => normalizeOutpoint(o.outpoint) === target,
    )
    if (!match) return false

    // BEEF parse + verifyValid is sync CPU on the main thread — yield first.
    await yieldToUi()
    const custom = parseCustom(match.customInstructions)
    const proven = verifyProvenance(custom.provenance, target).proven
    rememberProvenVerdict(target, proven)
    return proven
  } catch (err) {
    console.warn('[collectables] authenticity check failed', err)
    return false
  }
}

function applyProvenFlag(outpoint: string, proven: boolean): void {
  if (!proven) return
  const target = normalizeOutpoint(outpoint)
  if (!cachedCollectables.some((c) => c.outpoint === target && !c.proven)) return
  setCollectablesCache(
    cachedCollectables.map((c) =>
      c.outpoint === target ? { ...c, proven: true } : c,
    ),
  )
}

/**
 * Automatic authenticity: after the list paints, verify unverified tips one at a
 * time in the background. Same checks as before — just not on the critical path
 * and never with every remittance resident at once.
 */
function scheduleAuthenticitySweep(
  items: Collectable[],
  wallet: ActiveWallet,
): void {
  const pending = items.filter((i) => !hasProvenVerdict(i.outpoint))
  if (pending.length === 0) return

  const run = (async () => {
    // Wait out any prior sweep so two lists cannot race BEEF verifies.
    if (authenticitySweep) await authenticitySweep.catch(() => {})
    for (const item of pending) {
      if (getActiveWallet() !== wallet) return
      if (hasProvenVerdict(item.outpoint)) continue
      const proven = await verifyItemAuthenticity(item.outpoint, item.origin, wallet)
      applyProvenFlag(item.outpoint, proven)
      await yieldToUi()
    }
  })()

  authenticitySweep = run.finally(() => {
    if (authenticitySweep === run) authenticitySweep = null
  })
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
    const result = await wallet.wallet.listOutputs({
      basket: '1sat',
      limit: 1000,
      includeTags: true,
      // Never for a whole basket: remittance carries BEEF (~400k chars each), and
      // pulling every item's copy into the renderer is what crashed phones once a
      // wallet held real ordinals. Tags carry everything the list renders.
      includeCustomInstructions: false,
      seekPermission: false,
    })
    outputs = (result.outputs ?? []).map((o) => ({
      outpoint: o.outpoint,
      satoshis: o.satoshis ?? 1,
      tags: o.tags,
    }))
  } catch (err) {
    console.warn('[collectables] listOutputs failed', err)
    // Keep prior cache — do not hydrate as empty on transient failures.
    return getCachedCollectables()
  }

  lastItemOutputs = outputs
  lastItemChain = wallet.chain

  // Everything the list renders (name, app, image) comes from the output itself
  // or the resolution cache, so paint now and let authenticity + indexer catch up.
  const deduped = buildItems(outputs, wallet.chain)
  setCollectablesCache(deduped)
  scheduleAuthenticitySweep(deduped, wallet)
  void resolveUnknownOrigins()
  return deduped
}

export async function getCollectable(
  outpoint: string,
  active?: ActiveWallet | null,
): Promise<Collectable | null> {
  const target = normalizeOutpoint(outpoint)
  const wallet = active ?? getActiveWallet()
  const cached = cachedCollectables.find((i) => i.outpoint === target)
  let item = cached ?? (await listCollectables(active)).find((i) => i.outpoint === target) ?? null
  if (!item || !wallet) return item

  // Details: traits/mime come from the indexer only when remittance left them
  // blank. Authenticity is already sweeping in the background after list.
  try {
    const [txid, voutStr] = item.outpoint.split('.')
    const vout = Number(voutStr)
    if (txid && Number.isInteger(vout)) {
      const cachedResolved = getResolvedInscription(target)
      const shouldAskIndexer =
        !item.proven &&
        !cachedResolved &&
        shouldResolveInscription(target) &&
        item.traits.length === 0
      const resolved =
        cachedResolved ??
        (shouldAskIndexer
          ? await resolveOneSatInscription(txid, vout, wallet.chain, 6)
          : null)
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

  return item
}

function formatSendError(err: unknown): Error {
  if (err instanceof Error) {
    const name = err.name || ''
    const msg = err.message || String(err)
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
 * must have a sourceTransaction". The raw source is also what gives the signer the
 * real locking script and satoshi value for each input.
 */
async function buildInputBeefForSpends(
  wallet: ActiveWallet,
  outpoints: string[],
): Promise<number[]> {
  if (!wallet.services?.getBeefForTxid) {
    throw new Error('Cannot prove the collectable input offline. Try again when connected.')
  }

  const txids = [
    ...new Set(
      outpoints
        .map((op) => normalizeOutpoint(op).split('.')[0]?.toLowerCase())
        .filter((txid): txid is string => !!txid),
    ),
  ]

  const merged = new Beef()
  for (const txid of txids) {
    try {
      const beef = await wallet.services.getBeefForTxid(txid)
      merged.mergeBeef(beef.toBinary())
    } catch (err) {
      console.warn('[collectables] inputBEEF fetch failed', txid, err)
    }
  }

  const missing = txids.filter((txid) => merged.findTxid(txid)?.tx == null)
  if (missing.length > 0) {
    throw new Error(
      'Could not load the transaction that holds this collectable. Refresh, then send again.',
    )
  }

  return merged.toBinary()
}

/**
 * BRC-100 only auto-signs the wallet's own BRC-29 change, so ordinal / latch
 * inputs come back as a signable transaction for us to unlock with the root key.
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
  try {
    const result = await wallet.wallet.listOutputs({
      basket: ONE_SAT_LATCH_BASKET,
      limit: 1000,
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

/**
 * Transfer a basket `1sat` ordinal to a P2PKH address via BRC-100 createAction.
 *
 * Soft-latch (BRC-153): settle-style single tx spends tip (+ prior latch when
 * present) and creates recipient tip (vout 0) + latch (vout 1). Authenticity is
 * BRC-150 v2 remittance on the tip (not structural v3). Ordinal sat stays on
 * output 0 (`randomizeOutputs: false`). Fees are funded from the default change
 * basket.
 */
export async function sendCollectable(args: {
  outpoint: string
  toAddress: string
  name?: string
  origin?: string
  app?: string
}): Promise<{ txid: string }> {
  return runExclusiveSpend(async () => {
    assertOnlineForPayment()
    await prepareSpendHeal()
    const wallet = getActiveWallet()
    if (!wallet) throw new Error('Wallet locked')

  const outpoint = normalizeOutpoint(args.outpoint)
  const to = resolvePaymentAddress(args.toAddress, wallet.chain)

  let lockingScript: string
  try {
    lockingScript = new P2PKH().lock(to).toHex()
  } catch {
    throw new Error('Invalid recipient address or identity key')
  }

  const held = await wallet.wallet.listOutputs({
    basket: '1sat',
    limit: 1000,
    includeTags: true,
    // Locking script and satoshis are all this needs; remittance BEEF for every
    // held item would be tens of megabytes on a full wallet.
    includeCustomInstructions: false,
    include: 'locking scripts',
    seekPermission: false,
  })
  const match = (held.outputs ?? []).find(
    (o) => normalizeOutpoint(o.outpoint) === outpoint,
  )
  if (!match) throw new Error('Collectable is no longer in this wallet')
  if ((match.satoshis ?? 1) !== 1) {
    throw new Error('Collectable UTXO is not a 1-sat ordinal')
  }
  assertOrdinalIsDeviceLocked(match.lockingScript, wallet)

  const item = (await getCollectable(outpoint, wallet)) ?? null
  const origin = parseOrigin(args.origin ?? item?.origin, outpoint)
  const name =
    (args.name ?? item?.name ?? 'Collectable').trim().slice(0, 40) || 'Collectable'
  const app = args.app ?? item?.app
  const originTag = origin.replace(/_(\d+)$/, '.$1')
  const tags = [
    'ordinal',
    `origin:${originTag}`,
    `name:${name.slice(0, 80)}`,
    ...(app ? [`app:${app.slice(0, 40)}`] : []),
  ]

  const priorLatch = isLatchedSendEnabled()
    ? await findLatchForTip(wallet, outpoint, origin)
    : null
  if (priorLatch?.lockingScript) {
    assertOrdinalIsDeviceLocked(priorLatch.lockingScript, wallet)
  }
  const parentLatch = priorLatch
    ? toUnderscoreOutpoint(priorLatch.outpoint)
    : GENESIS_PARENT_LATCH

  const spendOutpoints = [outpoint, ...(priorLatch ? [priorLatch.outpoint] : [])]
  const inputBEEF = await buildInputBeefForSpends(wallet, spendOutpoints)
  const knownTxids = [
    ...new Set(
      spendOutpoints
        .map((op) => normalizeOutpoint(op).split('.')[0])
        .filter((txid): txid is string => !!txid),
    ),
  ]

  const provenance = await tryBuildProvenanceForSend({
    tipOutpoint: outpoint,
    origin,
    wallet,
    contentType: item?.mimeType,
    parentLatch,
  })

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
        // Soft-latch: P2PKH dust (>1 sat) so address scanners still find it, but
        // receivers never confuse it with a tip (tips are always exactly 1 sat).
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
  } catch (err) {
    // A rejected input is proof this basket is stale; clear it so a retry works.
    if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
    throw formatSendError(err)
  }

  let txid = result.txid
  if (!txid) {
    if (!result.signableTransaction) throw new Error('Send completed without txid')
    try {
      txid = await signOrdinalTransfer({
        wallet,
        signable: result.signableTransaction,
        outpoints: spendOutpoints,
      })
    } catch (err) {
      if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
      throw formatSendError(err)
    }
  }

  // Hide before relinquishing: relinquish is best-effort, and the basket keeps
  // listing a spent tip until a spendable review runs.
  markItemsSent([
    { outpoint, txid },
    ...(priorLatch ? [{ outpoint: priorLatch.outpoint, txid }] : []),
  ])

  await relinquishSpentOutputs(wallet, [
    { outpoint, basket: '1sat' },
    ...(priorLatch ? [{ outpoint: priorLatch.outpoint, basket: ONE_SAT_LATCH_BASKET }] : []),
  ])

  setCollectablesCache(cachedCollectables.filter((i) => i.outpoint !== outpoint))
  scheduleHistoryBackupPush('sendCollectable')
  void listCollectables(wallet).catch((err) => {
    console.warn('[collectables] post-send refresh failed', err)
  })
  return { txid }
  })
}
