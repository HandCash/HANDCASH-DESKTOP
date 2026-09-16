/**
 * Tokens list: basket `bsv21` BRC-162 value tips, aggregated by deploy outpoint.
 * Never included in fetchBalanceSats / Pay.
 */

import { getActiveWallet, type ActiveWallet } from '../session'
import type { Chain } from '../vault'
import {
  buildBsv21CustomInstructions,
  BSV21_BASKET,
  bsv21Tags,
  cosignFromRemittance,
  detectCosignFromLockingScript,
  formatFungibleAmount,
  issuerFromRemittance,
  issuerFromSigmaLockingScript,
  normalizeTokenId,
  parseBsv21CustomInstructions,
  parseBsv21Json,
  shortTokenLabel,
  type Bsv21ImportItem,
  type Bsv21Op,
  type Bsv21Utxo,
  type FungibleToken,
} from './types'
import { tipFromBsv21Script } from './sendPlan'
import { chooseFungibleChainFate } from './fungibleChainFate'
import { durableGetItem, durableRemoveItem, durableSetItem } from '../durableStorage'
import { accountLocalKey } from '../accountLocalKeys'
import {
  beginOneSatImport,
  markOneSatImportFailed,
  markOneSatImported,
  releaseOneSatImport,
} from '../oneSatImportGuard'
import { getTokenIconDataUrl } from './icons/cache'
import {
  cacheTokenIconFromBeef,
  resolveBsv21IconDataUrl,
  resolveTokenIconDataUrl,
} from './icons/resolve'
import { yieldToUi } from '../yieldToUi'
import { stampBrc164Id } from '../itemAccess'
import { isItemSent, markItemsConsumed } from '../sentItemGuard'
import { attachMarketListingToToken } from './marketView'
import { parseOrdEnvelope } from '../ordinalOwnership'
import { restoreUnspentAssetOutpoint } from '../staleOutputRelease'

export type { FungibleToken, Bsv21Utxo, Bsv21ImportItem }
export { formatFungibleAmount, BSV21_BASKET }

type Listener = (tokens: FungibleToken[]) => void

const LIST_CACHE_KEY_BASE = 'handcash.tokens.list.v1'

function listCacheKey(): string {
  return accountLocalKey(LIST_CACHE_KEY_BASE)
}

let cached: FungibleToken[] = []
let hydrated = false
let listInFlight: Promise<FungibleToken[]> | null = null
/** Bumped on vault-account rebind so in-flight lists cannot rewrite the new account. */
let fungiblesAccountEpoch = 0
const listeners = new Set<Listener>()
/** One local locking-script proof read per held tip; callers join the same work. */
const encodingProofInFlight = new Map<string, Promise<void>>()

function isFungibleShape(x: unknown): x is FungibleToken {
  if (!x || typeof x !== 'object') return false
  const t = x as FungibleToken
  return (
    typeof t.tokenId === 'string' &&
    typeof t.sym === 'string' &&
    typeof t.amt === 'string' &&
    typeof t.outpoint === 'string' &&
    typeof t.utxoCount === 'number'
  )
}

/**
 * Rows cached by builds before the BSV-21 rename spell the binary fields
 * `colour*`. Reading them under the current names keeps an upgraded install
 * from painting held BRC-162 tokens as read-only legacy (burn only) until the
 * next live basket read lands — which may be deferred while the wallet is busy.
 */
export function migrateCachedFungibleFields(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const { colourSupply, colourMaxSupply, colourProvenanceOk, ...row } =
    raw as Record<string, unknown>
  const migrated = { ...row }
  if (
    migrated.binarySupply == null &&
    (colourSupply === 'locked' || colourSupply === 'open')
  ) {
    migrated.binarySupply = colourSupply
  }
  if (
    migrated.encoding == null &&
    (migrated.binarySupply === 'locked' || migrated.binarySupply === 'open')
  ) {
    migrated.encoding = 'brc162'
  }
  if (migrated.maxSupply == null && typeof colourMaxSupply === 'number') {
    migrated.maxSupply = colourMaxSupply
  }
  if (migrated.provenanceOk == null && typeof colourProvenanceOk === 'boolean') {
    migrated.provenanceOk = colourProvenanceOk
  }
  return migrated
}

/**
 * v2 is the first payload whose `encoding` is only ever written from a decoded
 * locking script. v1 writers inferred `legacy-json` from a missing binary
 * field, which pinned freshly minted BRC-162 tokens as burn-only legacy. Drop
 * those stamps on read so the live basket decode can classify them again.
 */
const LIST_CACHE_VERSION = 2

function dropUnprovenLegacyStamp(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const row = raw as Record<string, unknown>
  if (row.encoding !== 'legacy-json') return row
  const { encoding: _dropped, ...rest } = row
  return rest
}

function loadDurableList(): FungibleToken[] {
  try {
    const raw = durableGetItem(listCacheKey())
    if (!raw) return []
    const parsed = JSON.parse(raw) as { items?: unknown; v?: unknown }
    if (!Array.isArray(parsed?.items)) return []
    const trusted = parsed.v === LIST_CACHE_VERSION
    return parsed.items
      .map((row) => (trusted ? row : dropUnprovenLegacyStamp(row)))
      .map(migrateCachedFungibleFields)
      .filter(isFungibleShape)
      .filter((t) => !leftoverCollectableSym(t.sym))
      .map((t) => ({
      ...t,
      dec: Number.isFinite(t.dec) ? t.dec : 0,
      spendKind:
        t.spendKind === 'cosigned' || t.spendKind === 'mixed' ? t.spendKind : 'plain',
      // A row written before `seenAt` existed is old, not new — 0 keeps it
      // eligible for the unconfirmed verdict instead of restarting its grace
      // period on every launch.
      seenAt: t.seenAt ?? 0,
    }))
  } catch {
    return []
  }
}

function persistDurableList(items: FungibleToken[]): void {
  try {
    durableSetItem(
      listCacheKey(),
      JSON.stringify({
        at: Date.now(),
        v: LIST_CACHE_VERSION,
        items: items.map((t) => ({
          tokenId: t.tokenId,
          sym: t.sym,
          amt: t.amt,
          dec: t.dec,
          utxoCount: t.utxoCount,
          outpoint: t.outpoint,
          spendKind: t.spendKind,
          ...(t.icon ? { icon: t.icon } : {}),
          ...(t.iconUrl ? { iconUrl: t.iconUrl } : {}),
          ...(t.cosign ? { cosign: t.cosign } : {}),
          ...(t.issuer ? { issuer: t.issuer } : {}),
          ...(t.issuerHandle ? { issuerHandle: t.issuerHandle } : {}),
          ...(t.issuerAttested != null ? { issuerAttested: t.issuerAttested } : {}),
          ...(t.tokenIds ? { tokenIds: t.tokenIds } : {}),
          ...(t.binarySupply ? { binarySupply: t.binarySupply } : {}),
          ...(t.encoding ? { encoding: t.encoding } : {}),
          ...(t.seenAt != null ? { seenAt: t.seenAt } : {}),
          ...(t.maxSupply != null ? { maxSupply: t.maxSupply } : {}),
          ...(t.provenanceOk != null ? { provenanceOk: t.provenanceOk } : {}),
        })),
      }),
    )
  } catch {
    // Cache is an optimisation.
  }
}

function fungibleProjectionChanged(
  left: FungibleToken[],
  right: FungibleToken[],
): boolean {
  return JSON.stringify(left) !== JSON.stringify(right)
}

function leftoverCollectableSym(sym: string | undefined): boolean {
  const s = (sym ?? '').trim()
  return s.startsWith('Pixel Foxes')
}

function cacheExtraLooksLikeFungible(t: FungibleToken): boolean {
  if (leftoverCollectableSym(t.sym)) return false
  const amt = Number(t.amt)
  return Number.isFinite(amt) && amt > 0
}

function setFungiblesCache(
  items: FungibleToken[],
  options: { forEpoch?: number } = {},
): void {
  if (
    options.forEpoch !== undefined &&
    options.forEpoch !== fungiblesAccountEpoch
  ) {
    return
  }
  const paintedAt = Date.now()
  cached = items
    .filter(cacheExtraLooksLikeFungible)
    .map(attachMarketListingToToken)
    // Stamp first paint so an unconfirmed mint can age out of the list.
    .map((token) => (token.seenAt == null ? { ...token, seenAt: paintedAt } : token))
  hydrated = true
  persistDurableList(cached)
  notify()
}

/** Recover settled receives written before immediate token painting existed. */
async function recoverReceivedTokensFromActivity(
  items: FungibleToken[],
): Promise<FungibleToken[]> {
  const { exportAllActivity } = await import('../appActivity')
  const activity = exportAllActivity()
  markItemsConsumed(
    activity
      .filter(
        (row) =>
          row.method === 'burn-token' &&
          row.status === 'complete' &&
          Boolean(row.txid) &&
          Boolean(row.item?.outpoint),
      )
      .map((row) => row.item!.outpoint!),
  )
  const enriched = [...items]
  const knownIndex = new Map(
    enriched.map((token, index) => [tokenKey(token), index]),
  )
  // Only enrich tokens we already hold. Inventing balances from Activity alone
  // resurrects spent/unheld tips as "Unattested" cards that vanish on burn.
  for (const row of activity) {
    const item = row.item
    if (
      row.kind !== 'earned' ||
      row.method !== 'receive-token' ||
      row.status === 'pending' ||
      row.status === 'failed' ||
      !item?.tokenId ||
      !item.amt ||
      !item.outpoint ||
      isItemSent(item.outpoint)
    ) {
      continue
    }
    const tokenId = normalizeTokenId(item.tokenId)
    if (!tokenId || !/^\d+$/.test(item.amt)) continue
    const existingIndex = knownIndex.get(tokenId)
    if (existingIndex == null) continue
    const existing = enriched[existingIndex]!
    const activityName = item.name?.trim()
    const recoveredSym =
      activityName && activityName !== 'Collectable' && activityName !== shortTokenLabel(tokenId)
        ? activityName
        : shortTokenLabel(tokenId)
    const currentIsFallback =
      !existing.sym.trim() ||
      existing.sym === shortTokenLabel(existing.tokenId) ||
      existing.sym === 'Collectable'
    enriched[existingIndex] = {
      ...existing,
      ...(currentIsFallback && recoveredSym !== shortTokenLabel(tokenId)
        ? { sym: recoveredSym, dec: item.dec ?? existing.dec }
        : {}),
      ...(!existing.icon && item.icon ? { icon: item.icon } : {}),
    }
  }
  return enriched
}

function tokenKey(t: Pick<FungibleToken, 'tokenId'>): string {
  return t.tokenId.trim().toLowerCase()
}

/** Live rows win. Keep cached BRC-162 tokens when listOutputs dropped them.
 * Drop a cache row whose tip was just sent/burned so the mint amt cannot linger. */

function isGenesisRow(t: Pick<FungibleToken, 'tokenId' | 'outpoint'>): boolean {
  const tokenId = tokenKey(t)
  const op = (t.outpoint ?? '').trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
  return Boolean(op) && op === tokenId
}

export function mergeLiveFungibles(live: FungibleToken[], prior: FungibleToken[]): FungibleToken[] {
  const byId = new Map<string, FungibleToken>()
  const liveIds = new Set<string>()
  for (const t of prior) {
    if (t.outpoint && isItemSent(t.outpoint)) continue
    if (t.maxSupply != null && Number(t.amt) > t.maxSupply) continue
    byId.set(tokenKey(t), t)
  }
  for (const t of live) {
    if (t.outpoint && isItemSent(t.outpoint)) continue
    const k = tokenKey(t)
    liveIds.add(k)
    const priorRow = byId.get(k)
    const liveSymIsFallback =
      !t.sym.trim() || t.sym === shortTokenLabel(t.tokenId)
    const priorSymIsUseful =
      priorRow?.sym &&
      priorRow.sym !== shortTokenLabel(priorRow.tokenId)
    // Live listing already overlays leftovers and aggregates by origin.
    // amt comes from live. Never leftover+live across refreshes.
    byId.set(k, {
      ...t,
      ...(liveSymIsFallback && priorSymIsUseful
        ? { sym: priorRow.sym, dec: priorRow.dec }
        : {}),
      ...(priorRow && !t.icon && priorRow.icon ? { icon: priorRow.icon } : {}),
      ...(priorRow && !t.iconUrl && priorRow.iconUrl ? { iconUrl: priorRow.iconUrl } : {}),
      ...(priorRow && !t.issuer && priorRow.issuer ? { issuer: priorRow.issuer } : {}),
      ...(priorRow?.issuerAttested && !t.issuerAttested ? { issuerAttested: true } : {}),
      ...(priorRow && t.maxSupply == null && priorRow.maxSupply != null
        ? { maxSupply: priorRow.maxSupply }
        : {}),
    })
  }
  // Live listing is source of truth when it returned rows. An empty live list
  // is usually toolbox lag right after mint (or a flake) — keep prior paint,
  // especially genesis deploy+mint tips that would otherwise vanish until the
  // next listOutputs. When live is non-empty, drop genesis / legacy ghosts
  // absent from it; token tips may stay on partial flakes.
  for (const [k, t] of [...byId.entries()]) {
    if (liveIds.has(k)) continue
    if (live.length === 0) continue
    if (isGenesisRow(t)) {
      byId.delete(k)
      continue
    }
    if (t.binarySupply != null && cacheExtraLooksLikeFungible(t)) continue
    byId.delete(k)
  }
  const out = [...byId.values()]
  out.sort((a, b) => Number(b.amt) - Number(a.amt) || a.sym.localeCompare(b.sym))
  return out
}

export function rememberFungibleToken(token: FungibleToken): void {
  setFungiblesCache(mergeLiveFungibles([token], cached))
  if (!token.binarySupply && !token.encoding) {
    const wallet = getActiveWallet()
    if (wallet) void proveCachedFungibleEncoding(token.outpoint, wallet)
  }
}

export function forgetFungibleToken(tokenId: string): void {
  const k = tokenId.trim().toLowerCase()
  setFungiblesCache(cached.filter((t) => tokenKey(t) !== k))
}

export function paintFungibleAfterSpend(args: {
  tokenId: string
  remainingAmt: number | string | bigint
  outpoint?: string
  sym?: string
  dec?: number
  utxoCount?: number
  binarySupply?: FungibleToken['binarySupply']
  maxSupply?: number | null
  icon?: string
}): void {
  let remainingAmt: string
  try {
    const units = BigInt(args.remainingAmt)
    if (units <= 0n) {
      forgetFungibleToken(args.tokenId)
      return
    }
    remainingAmt = units.toString()
  } catch {
    forgetFungibleToken(args.tokenId)
    return
  }
  const prior = cached.find((t) => tokenKey(t) === args.tokenId.trim().toLowerCase())
  rememberFungibleToken({
    tokenId: args.tokenId,
    sym: args.sym || prior?.sym || 'Token',
    amt: remainingAmt,
    dec: args.dec ?? prior?.dec ?? 0,
    utxoCount: Math.max(1, Math.trunc(args.utxoCount ?? 1)),
    outpoint: args.outpoint || prior?.outpoint || args.tokenId,
    spendKind: 'plain',
    binarySupply: args.binarySupply ?? prior?.binarySupply,
    encoding:
      args.binarySupply != null
        ? 'brc162'
        : prior?.encoding,
    maxSupply: args.maxSupply ?? prior?.maxSupply ?? null,
    provenanceOk: prior?.provenanceOk ?? true,
    ...(args.icon || prior?.icon ? { icon: args.icon || prior?.icon } : {}),
    ...(prior?.iconUrl ? { iconUrl: prior.iconUrl } : {}),
    ...(prior?.issuer ? { issuer: prior.issuer } : {}),
    ...(prior?.issuerHandle ? { issuerHandle: prior.issuerHandle } : {}),
  })
}

/** Leftover remittance is a floor, not the full origin balance. */
export function leftoverFloorWouldClobber(
  prior: Pick<FungibleToken, 'amt' | 'utxoCount'> | undefined,
  floor: Pick<FungibleToken, 'amt' | 'utxoCount'>,
): boolean {
  if (!prior) return false
  const priorAmt = Number(prior.amt)
  const floorAmt = Number(floor.amt)
  if (Number.isFinite(priorAmt) && Number.isFinite(floorAmt) && priorAmt > floorAmt) {
    return true
  }
  return (prior.utxoCount ?? 0) > (floor.utxoCount ?? 1)
}

// Paint last session's tokens immediately — same pattern as collectables.
{
  const durable = loadDurableList()
  if (durable.length > 0) {
    cached = durable
    hydrated = true
  }
  const activityRepairBase = cached
  const bootEpoch = fungiblesAccountEpoch
  void recoverReceivedTokensFromActivity(activityRepairBase)
    .then((repaired) => {
      if (bootEpoch !== fungiblesAccountEpoch) return
      if (cached === activityRepairBase) {
        if (fungibleProjectionChanged(repaired, cached)) {
          setFungiblesCache(repaired, { forEpoch: bootEpoch })
        }
        return
      }
      const currentIds = new Set(cached.map(tokenKey))
      const additions = repaired.filter((token) => !currentIds.has(tokenKey(token)))
      if (additions.length > 0) {
        setFungiblesCache(mergeLiveFungibles(additions, cached), {
          forEpoch: bootEpoch,
        })
      }
    })
    .catch(() => {})
}

function notify() {
  for (const cb of listeners) cb(cached)
}

async function recoverBsv21DeployMetadata(
  wallet: ActiveWallet,
  tokenId: string,
): Promise<{
  sym?: string
  dec?: number
  icon?: string
  iconUrl?: string
  issuer?: string
} | null> {
  const normalized = normalizeTokenId(tokenId)
  if (!normalized) return null
  const [txid, rawVout] = normalized.split('_')
  const vout = Number(rawVout)
  if (!txid || !Number.isInteger(vout) || vout < 0) return null
  const { getLocalBeefForTxid, rememberBeefTree } = await import('../beefCache')
  const beef = await getLocalBeefForTxid(wallet, txid)
  if (!beef) return null
  rememberBeefTree(beef.toBinary(), txid)
  const scriptHex = beef.findTxid(txid)?.tx?.outputs[vout]?.lockingScript?.toHex()
  const envelope = parseOrdEnvelope(scriptHex)
  if (!envelope?.body?.length) return null
  try {
    const payload = parseBsv21Json(
      JSON.parse(new TextDecoder().decode(envelope.body)),
    )
    const icon = payload?.icon
      ? normalizeTokenId(payload.icon) ?? undefined
      : undefined
    const iconUrl = icon
      ? cacheTokenIconFromBeef(icon, beef) ??
        (await resolveTokenIconDataUrl(icon, wallet))
      : undefined
    return {
      ...(payload?.sym ? { sym: payload.sym } : {}),
      ...(payload?.dec != null ? { dec: payload.dec } : {}),
      ...(icon ? { icon } : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(payload?.issuer ? { issuer: payload.issuer } : {}),
    }
  } catch {
    return null
  }
}

export async function hydrateCachedTokenIcons(
  wallet: ActiveWallet,
  tokens: FungibleToken[] = cached,
): Promise<void> {
  let changed = false
  for (let token of tokens) {
    if (token.iconUrl) continue
    if (!cacheExtraLooksLikeFungible(token)) continue
    const symIsFallback =
      !token.sym.trim() || token.sym === shortTokenLabel(token.tokenId)
    if (
      !token.binarySupply &&
      (!token.icon || symIsFallback || !token.issuer)
    ) {
      const metadata = await recoverBsv21DeployMetadata(wallet, token.tokenId)
      if (metadata) {
        const idx = cached.findIndex((t) => t.tokenId === token.tokenId)
        if (idx >= 0) {
          token = {
            ...cached[idx]!,
            ...metadata,
            sym: metadata.sym || cached[idx]!.sym,
          }
          cached[idx] = token
          changed = true
        }
      }
    }
    const url = token.binarySupply
      ? (await resolveBsv21IconDataUrl({
          origin: token.tokenId,
          icon: token.icon,
          wallet,
        })) ??
        (token.icon
          ? await resolveTokenIconDataUrl(token.icon, wallet)
          : undefined)
      : token.icon
        ? await resolveTokenIconDataUrl(token.icon, wallet)
        : undefined
    if (!url) continue
    const idx = cached.findIndex((t) => t.tokenId === token.tokenId)
    if (idx < 0) continue
    cached[idx] = { ...cached[idx]!, iconUrl: url }
    changed = true
  }
  if (changed) {
    setFungiblesCache([...cached])
  }
}

async function hydrateMissingTokenIcons(
  wallet: ActiveWallet,
  tokens: FungibleToken[],
): Promise<void> {
  await hydrateCachedTokenIcons(wallet, tokens)
}

/** Drop in-memory + durable token list so a wiped wallet cannot paint ghosts. */
export function clearFungiblesCache(options?: { notify?: boolean }): void {
  cached = []
  hydrated = false
  listInFlight = null
  durableRemoveItem(listCacheKey())
  if (options?.notify !== false) notify()
}

/** Swap Tokens inventory to the active vault account. */
export function rebindFungiblesForAccount(): void {
  fungiblesAccountEpoch += 1
  cached = []
  hydrated = false
  listInFlight = null
  const durable = loadDurableList()
  if (durable.length > 0) {
    cached = durable
    hydrated = true
  }
  notify()
  const run = listFungiblesNow(undefined)
  listInFlight = run
  void run
    .catch(() => {})
    .then(() => {
      if (listInFlight === run) listInFlight = null
    })
}

export function getCachedFungibles(): FungibleToken[] {
  return cached
}

function normalizedDottedOutpoint(raw: string): string | null {
  const dotted = raw.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  return /^[0-9a-f]{64}\.\d+$/.test(dotted) ? dotted : null
}

/** Pure locking-script verdict used by local proof and regression tests. */
export function fungibleEncodingFromLockingScript(
  row: Pick<FungibleToken, 'tokenId' | 'tokenIds' | 'outpoint'>,
  lockingScript: string,
  satoshis = 1,
): Pick<FungibleToken, 'binarySupply' | 'encoding'> | null {
  if (satoshis !== 1) return null
  const point = normalizedDottedOutpoint(row.outpoint)
  if (!point) return null
  const ids = new Set([row.tokenId, ...(row.tokenIds ?? [])])
  const binary = tipFromBsv21Script({
    outpoint: point,
    lockingScript,
    satoshis,
  })
  if (binary) {
    return ids.has(binary.tokenId)
      ? { binarySupply: 'locked', encoding: 'brc162' }
      : null
  }
  const envelope = parseOrdEnvelope(lockingScript)
  let payload: ReturnType<typeof parseBsv21Json> = null
  try {
    payload = envelope?.body?.length
      ? parseBsv21Json(JSON.parse(new TextDecoder().decode(envelope.body)))
      : null
  } catch {
    payload = null
  }
  if (!payload) return null
  const payloadId =
    payload.op === 'deploy+mint' || payload.op === 'deploy+auth'
      ? normalizeTokenId(point)
      : normalizeTokenId(payload.id ?? '')
  return payloadId && ids.has(payloadId) ? { encoding: 'legacy-json' } : null
}

/**
 * Token equivalent of BRC-150's local proof-first lifecycle.
 *
 * Encoding is a property of the held locking script, so the locally retained
 * transaction is sufficient proof; no indexer or full inventory list is
 * needed. The card paints immediately, then this upgrades its durable verdict.
 */
export function proveCachedFungibleEncoding(
  outpoint: string,
  active?: ActiveWallet | null,
): Promise<void> {
  const point = normalizedDottedOutpoint(outpoint)
  const wallet = active ?? getActiveWallet()
  if (!point || !wallet) return Promise.resolve()
  const existing = encodingProofInFlight.get(point)
  if (existing) return existing
  const epoch = fungiblesAccountEpoch
  const run = (async () => {
    await yieldToUi()
    const [txid, rawVout] = point.split('.')
    const vout = Number(rawVout)
    const { getLocalBeefForTxid } = await import('../beefCache')
    const beef = await getLocalBeefForTxid(wallet, txid!)
    const output = beef?.findTxid(txid!)?.tx?.outputs[vout]
    const lockingScript = output?.lockingScript?.toHex()
    if (!lockingScript || output?.satoshis !== 1) {
      scheduleEncodingProofRetry(point, wallet, epoch)
      return
    }

    const rowIndex = cached.findIndex(
      (row) => normalizedDottedOutpoint(row.outpoint) === point,
    )
    if (rowIndex < 0 || epoch !== fungiblesAccountEpoch) return
    const row = cached[rowIndex]!
    if (row.binarySupply || row.encoding) return

    const verdict = fungibleEncodingFromLockingScript(row, lockingScript, 1)
    if (!verdict) return
    encodingProofRetries.delete(point)
    const proven: FungibleToken = { ...row, ...verdict }
    if (epoch !== fungiblesAccountEpoch || !proven) return
    const next = [...cached]
    next[rowIndex] = proven
    setFungiblesCache(next, { forEpoch: epoch })
    console.info(
      `[bsv21] local encoding proof ${point} → ${proven.encoding}`,
    )
  })().finally(() => {
    encodingProofInFlight.delete(point)
  })
  encodingProofInFlight.set(point, run)
  return run
}

const encodingProofRetries = new Map<string, number>()
const ENCODING_PROOF_RETRY_MS = [250, 500, 1_000, 2_000, 4_000] as const

function scheduleEncodingProofRetry(
  point: string,
  wallet: ActiveWallet,
  epoch: number,
): void {
  const attempt = encodingProofRetries.get(point) ?? 0
  if (attempt >= ENCODING_PROOF_RETRY_MS.length) return
  encodingProofRetries.set(point, attempt + 1)
  setTimeout(() => {
    if (epoch !== fungiblesAccountEpoch) {
      encodingProofRetries.delete(point)
      return
    }
    const row = cached.find(
      (candidate) => normalizedDottedOutpoint(candidate.outpoint) === point,
    )
    if (!row || row.binarySupply || row.encoding) {
      encodingProofRetries.delete(point)
      return
    }
    void proveCachedFungibleEncoding(point, wallet)
  }, ENCODING_PROOF_RETRY_MS[attempt])
}

/** Prove unknown cached rows independently of the slower basket list. */
export async function proveCachedFungibleEncodings(
  active?: ActiveWallet | null,
): Promise<void> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) return
  const unknown = cached.filter((row) => !row.binarySupply && !row.encoding)
  for (const row of unknown) {
    await proveCachedFungibleEncoding(row.outpoint, wallet)
    await yieldToUi()
  }
}

export function areFungiblesHydrated(): boolean {
  return hydrated
}

export function subscribeFungibles(cb: Listener): () => void {
  listeners.add(cb)
  cb(cached)
  return () => {
    listeners.delete(cb)
  }
}

function parseListedOutput(
  raw: {
    outpoint?: string
    satoshis?: number
    tags?: string[]
    customInstructions?: string
    lockingScript?: string
  },
  selfIdentityKey?: string,
): Bsv21Utxo | null {
  const outpoint = (raw.outpoint ?? '').trim().toLowerCase()
  if (!outpoint) return null
  if (!raw.lockingScript) return null
  const from162 = tipFromBsv21Script({
    outpoint,
    lockingScript: raw.lockingScript,
    satoshis: raw.satoshis,
    customInstructions: raw.customInstructions,
    tags: raw.tags,
  })
  const ci = parseBsv21CustomInstructions(raw.customInstructions)
  const legacyTokenId =
    ci?.op === 'deploy+mint' || ci?.op === 'deploy+auth'
      ? normalizeTokenId(outpoint)
      : normalizeTokenId(ci?.id ?? '')
  if (!from162 && (!ci?.amt || !legacyTokenId)) return null
  const tokenId = from162?.tokenId ?? legacyTokenId!
  const amount = from162?.amt ?? BigInt(ci!.amt!)
  if (amount <= 0n) return null
  const op = from162
    ? ((from162.tokenId === from162.outpoint
        ? 'deploy+mint'
        : 'transfer') as Bsv21Op)
    : ci!.op
  const cosign = cosignFromRemittance({
    customInstructions: raw.customInstructions,
    tags: raw.tags,
  })
  let issuer = issuerFromRemittance({
    customInstructions: raw.customInstructions,
    tags: raw.tags,
  })
  let issuerAttested = false
  const candidates = [issuer, selfIdentityKey].filter(Boolean) as string[]
  const sigma = issuerFromSigmaLockingScript(raw.lockingScript, candidates)
  if (sigma.issuer) {
    issuer = sigma.issuer
    issuerAttested = true
  } else if (issuer && sigma.address) {
    issuerAttested = true
  }
  return {
    outpoint,
    tokenId,
    amt: amount.toString(),
    op,
    dec: ci?.dec ?? 0,
    satoshis: 1,
    ...(ci?.sym ? { sym: ci.sym } : {}),
    ...(ci?.icon ? { icon: ci.icon } : {}),
    lockingScript: raw.lockingScript,
    ...(cosign ? { cosign } : {}),
    ...(issuer ? { issuer } : {}),
    ...(issuerAttested ? { issuerAttested: true } : {}),
    encoding: from162 ? 'brc162' : 'legacy-json',
    ...(from162 ? { binarySupply: 'locked' as const } : {}),
  }
}

/**
 * Every Collect visit lists `bsv21` alongside `1sat`. Coalesce identical reads
 * (same pattern as collectables) so nav flips do not stack listOutputs.
 */
export function listFungibles(active?: ActiveWallet | null): Promise<FungibleToken[]> {
  if (listInFlight) return listInFlight
  const run = listFungiblesNow(active)
  listInFlight = run
  void run
    .catch(() => {})
    .then(() => {
      if (listInFlight === run) listInFlight = null
    })
  return run
}

/** Existence answers for cards the basket did not return — one probe per tx. */
const chainPresenceCache = new Map<string, { at: number; onChain: boolean | null }>()
const CHAIN_PRESENCE_TTL_MS = 5 * 60_000

async function tipIsOnChain(
  txid: string,
  chain: Chain,
): Promise<boolean | null> {
  const hit = chainPresenceCache.get(txid)
  if (hit && Date.now() - hit.at < CHAIN_PRESENCE_TTL_MS) return hit.onChain
  try {
    const { txExistsOnChain } = await import('../legacyScan')
    const onChain = await txExistsOnChain(txid, chain)
    chainPresenceCache.set(txid, { at: Date.now(), onChain })
    return onChain
  } catch {
    return null
  }
}

/**
 * Stop painting a mint that never reached the chain.
 *
 * A `deploy+mint` whose transaction no provider has ever seen, and which the
 * basket does not hold, is not an asset — offering it Send or Burn is a promise
 * the wallet cannot keep. Every other absence keeps its card.
 */
async function dropUnconfirmedFungibles(
  rows: FungibleToken[],
  wallet: ActiveWallet,
  args: { liveRows: FungibleToken[]; liveReadUsable: boolean },
): Promise<FungibleToken[]> {
  const prior = rows.filter((t) => !leftoverCollectableSym(t.sym))
  const liveOutpoints = new Set(
    args.liveRows
      .map((row) => normalizedDottedOutpoint(row.outpoint))
      .filter((point): point is string => Boolean(point)),
  )
  const kept: FungibleToken[] = []
  const now = Date.now()
  for (const row of prior) {
    const point = normalizedDottedOutpoint(row.outpoint)
    const inLiveBasket = point == null || liveOutpoints.has(point)
    const preliminary = chooseFungibleChainFate({
      inLiveBasket,
      liveReadUsable: args.liveReadUsable,
      onChain: null,
      ageMs: now - (row.seenAt ?? 0),
    })
    // Only pay for a lookup when absence would otherwise retire the card.
    if (preliminary.kind !== 'unconfirmed') {
      kept.push(row)
      continue
    }
    const fate = chooseFungibleChainFate({
      inLiveBasket,
      liveReadUsable: args.liveReadUsable,
      onChain: await tipIsOnChain(point!.split('.')[0]!, wallet.chain),
      ageMs: now - (row.seenAt ?? 0),
    })
    if (fate.kind !== 'unconfirmed') {
      kept.push(row)
      continue
    }
    console.info(
      `[bsv21] retiring unconfirmed card ${point} — ${fate.reason}`,
    )
  }
  return kept
}

/**
 * List live BSV-21 tips from basket `bsv21` and aggregate by token id.
 */
async function listFungiblesNow(
  active?: ActiveWallet | null,
): Promise<FungibleToken[]> {
  const epoch = fungiblesAccountEpoch
  const wallet = active ?? getActiveWallet()
  // Locked / no session: keep last durable paint (mirrors collectables).
  if (!wallet) return getCachedFungibles()
  // Same policy as BRC-150 items: paint the durable card first, prove from
  // local transaction bytes in the background, and let the live list reconcile.
  void proveCachedFungibleEncodings(wallet)
  const beforeRepair = getCachedFungibles()
  const repaired = await recoverReceivedTokensFromActivity(beforeRepair)
  if (epoch !== fungiblesAccountEpoch) return getCachedFungibles()
  if (fungibleProjectionChanged(repaired, beforeRepair)) {
    setFungiblesCache(repaired, { forEpoch: epoch })
    if (repaired.length > beforeRepair.length) {
      void import('../healMisfiledBsv21').then(({ healMisfiledBsv21 }) =>
        healMisfiledBsv21(wallet),
      )
    }
  }

  const {
    getSpendPriorityDepth,
    getWalletCoordinatorSnapshot,
    shouldYieldChainIngestToSpend,
  } = await import('../walletCoordinator')
  const coord = getWalletCoordinatorSnapshot()
  const cachedRows = getCachedFungibles()
  const cacheNeedsWireClassification = cachedRows.some(
    (row) => row.binarySupply == null && row.encoding == null,
  )
  if (
    cachedRows.length > 0 &&
    !cacheNeedsWireClassification &&
    (coord.chainIngest === 'active' ||
      coord.spend === 'active' ||
      shouldYieldChainIngestToSpend() ||
      getSpendPriorityDepth() > 0)
  ) {
    console.info(
      `[bsv21] deferring listOutputs — wallet busy, using ${cachedRows.length} cached token(s)`,
    )
    return cachedRows
  }

  try {
    await yieldToUi()
    let liveRows: FungibleToken[] = []
    let liveReadUsable = true
    try {
      const { listBsv21BinaryTokens } = await import('./listTips')
      liveRows = await listBsv21BinaryTokens(wallet)
    } catch (err) {
      liveReadUsable = false
      console.warn('[bsv21] list failed', err)
    }
    if (epoch !== fungiblesAccountEpoch) return getCachedFungibles()
    // Live BRC-162 rows win over stale JSON BSV-21 rows.
    const prior = await dropUnconfirmedFungibles(cached, wallet, {
      liveRows,
      liveReadUsable,
    })
    const merged = mergeLiveFungibles(liveRows, prior)
    setFungiblesCache(merged, { forEpoch: epoch })
    // Fill missing icons from local/session BEEF (no HTTP content indexer).
    void hydrateMissingTokenIcons(wallet, merged)
    return merged
  } catch (err) {
    console.warn('[bsv21] list failed', err)
    // Keep prior cache — do not hydrate as empty on transient failures.
    return getCachedFungibles()
  }
}

export function getFungible(tokenId: string): FungibleToken | null {
  const id = normalizeTokenId(tokenId) ?? tokenId.trim().toLowerCase()
  return (
    cached.find((t) => t.tokenId === id || t.tokenIds?.includes(id)) ?? null
  )
}

/**
 * Recover a painted legacy tip when toolbox has not projected its `bsv21`
 * basket row yet. The cached card identifies the exact held outpoint; the
 * locally retained BEEF supplies the authoritative script and JSON amount.
 */
async function recoverCachedLegacyTips(
  active: ActiveWallet,
  wanted: Set<string>,
): Promise<Bsv21Utxo[]> {
  const recovered: Bsv21Utxo[] = []
  const { getLocalBeefForTxid } = await import('../beefCache')
  for (const token of cached) {
    const tokenId = normalizeTokenId(token.tokenId)
    if (!tokenId || !wanted.has(tokenId) || isItemSent(token.outpoint)) continue
    const point = token.outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
    const match = /^([0-9a-f]{64})\.(\d+)$/.exec(point)
    if (!match) continue
    const txid = match[1]!
    const vout = Number(match[2])
    try {
      // A failed/aborted spend can leave this asset row locally retired. Never
      // feed a display-cache outpoint back into createAction unless a live UTXO
      // source proves it still exists and the toolbox row is restored first.
      if (!(await restoreUnspentAssetOutpoint(active, point))) continue
      const beef = await getLocalBeefForTxid(active, txid)
      const output = beef?.findTxid(txid)?.tx?.outputs[vout]
      const lockingScript = output?.lockingScript?.toHex()
      if (!lockingScript || (output?.satoshis ?? 1) !== 1) continue
      const envelope = parseOrdEnvelope(lockingScript)
      const payload = envelope?.body?.length
        ? parseBsv21Json(JSON.parse(new TextDecoder().decode(envelope.body)))
        : null
      const amount = payload?.amt ?? token.amt
      const payloadTokenId = payload
        ? payload.op === 'deploy+mint' || payload.op === 'deploy+auth'
          ? normalizeTokenId(point)
          : normalizeTokenId(payload.id ?? '')
        : tokenId
      if (payloadTokenId !== tokenId || BigInt(amount) <= 0n) continue
      recovered.push({
        outpoint: point,
        tokenId,
        amt: amount,
        op: payload?.op ?? 'transfer',
        dec: payload?.dec ?? token.dec,
        satoshis: 1,
        // Only the decoded inscription proves legacy JSON here.
        ...(payload ? { encoding: 'legacy-json' as const } : {}),
        ...(payload?.sym || token.sym ? { sym: payload?.sym || token.sym } : {}),
        ...(payload?.icon || token.icon ? { icon: payload?.icon || token.icon } : {}),
        lockingScript,
      })
      console.info(`[bsv21] recovered cached legacy tip ${point} for spend`)
    } catch {
      // The normal basket path remains authoritative when local BEEF is absent.
    }
  }
  return recovered
}

/**
 * Live tips for one or more token ids — used by wallet-native send to pick
 * inputs. Includes locking scripts so cosign classification can fail closed.
 */
export async function listFungibleTips(
  active: ActiveWallet,
  opts: { tokenIds: string[] },
): Promise<Bsv21Utxo[]> {
  const wanted = new Set(
    opts.tokenIds
      .map((id) => normalizeTokenId(id) ?? id.trim().toLowerCase())
      .filter(Boolean),
  )
  if (wanted.size === 0) return []
  const listed = await active.wallet.listOutputs({
    basket: BSV21_BASKET,
    limit: 1000,
    includeCustomInstructions: true,
    includeTags: true,
    include: 'locking scripts',
    seekPermission: false,
  })
  const tips: Bsv21Utxo[] = []
  for (const row of listed.outputs ?? []) {
    const outpoint = (row as { outpoint?: string }).outpoint
    if (outpoint && isItemSent(outpoint)) continue
    const tip = parseListedOutput(
      row as {
        outpoint?: string
        satoshis?: number
        tags?: string[]
        customInstructions?: string
        lockingScript?: string
      },
      active.identityKey,
    )
    if (!tip) continue
    const hasBsv162Script = Boolean(
      tipFromBsv21Script({
        outpoint: tip.outpoint,
        lockingScript: tip.lockingScript,
        satoshis: tip.satoshis,
        customInstructions: row.customInstructions,
        tags: row.tags,
      }),
    )
    const matchesHeldLegacyCard = cached.some(
      (token) =>
        tokenKey(token) === tip.tokenId &&
        token.outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1') ===
          tip.outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1'),
    )
    // JSON remittance is metadata, not token proof. Permit old P2PKH tips only
    // when the exact outpoint is already a held inventory card; arbitrary
    // basket tags must not become spend inputs.
    if (!hasBsv162Script && !matchesHeldLegacyCard) continue
    if (!wanted.has(tip.tokenId)) continue
    if ((tip.satoshis ?? 1) !== 1) continue
    tips.push(tip)
  }
  if (tips.length === 0) {
    tips.push(...(await recoverCachedLegacyTips(active, wanted)))
  }
  return tips
}

/** Build a display row from an import candidate (before basket read). */
export function fungibleFromImport(
  item: Bsv21ImportItem,
  _chain: Chain = 'main',
): FungibleToken {
  const iconUrl = item.icon ? getTokenIconDataUrl(item.icon) : undefined
  return {
    tokenId: item.tokenId,
    sym: item.sym || shortTokenLabel(item.tokenId),
    amt: item.amt,
    dec: item.dec ?? 0,
    utxoCount: 1,
    outpoint: item.outpoint,
    spendKind: item.cosign ? 'cosigned' : 'plain',
    ...(item.cosign ? { cosign: item.cosign } : {}),
    ...(item.issuer ? { issuer: item.issuer } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    // Without this a BRC-162 mint/receive paints as read-only legacy (burn
    // only) until a live basket decode lands, which Refresh may defer.
    ...(item.binarySupply ? { binarySupply: item.binarySupply } : {}),
    // Only a decoded locking script may classify the wire format. A mint whose
    // script was not available yet stays unknown so the live basket read can
    // name it — absence must never paint a fresh 162 mint as burn-only legacy.
    ...(item.encoding ? { encoding: item.encoding } : {}),
  }
}

/**
 * Internalize BSV-21 tips into basket `bsv21`.
 * Same 1-sat gate as collectables — amount lives in the inscription, not satoshis.
 */
export async function importBsv21Tokens(
  items: Bsv21ImportItem[],
  active?: ActiveWallet | null,
): Promise<{ imported: number; failed: number; errors: string[]; outpoints: string[] }> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')
  if (items.length === 0) {
    return { imported: 0, failed: 0, errors: [], outpoints: [] }
  }

  // Same import guard as 1sat — without mark, every chain poll re-internalizes.
  const claimed = beginOneSatImport(items.map((i) => i.outpoint))
  const claimedSet = new Set(claimed)
  const work = items.filter((i) =>
    claimedSet.has(i.outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')),
  )
  if (work.length === 0) {
    return { imported: 0, failed: 0, errors: [], outpoints: [] }
  }

  const byTxid = new Map<string, Bsv21ImportItem[]>()
  for (const item of work) {
    const list = byTxid.get(item.txid) ?? []
    list.push(item)
    byTxid.set(item.txid, list)
  }

  let imported = 0
  let failed = 0
  const errors: string[] = []
  const outpoints: string[] = []

  let deferRemaining = false
  for (const [txid, group] of byTxid) {
    const groupOps = group.map((g) => g.outpoint)
    if (deferRemaining) {
      releaseOneSatImport(groupOps)
      continue
    }
    try {
      // A token send must not wait behind legacy BSV-21 beef / chaintracks.
      const { shouldYieldChainIngestToSpend } = await import('../walletCoordinator')
      if (shouldYieldChainIngestToSpend()) {
        console.info(
          `[bsv21] deferring tip imports — send is waiting (${groupOps.length}+)`,
        )
        releaseOneSatImport(groupOps)
        deferRemaining = true
        continue
      }
      await yieldToUi()
      // Prefer the session BEEF cache (8s cap). Raw chaintracks getBeefForTxid
      // has no deadline and was wedging Refresh behind Babbage timeouts.
      const { getBeefForTxidCached } = await import('../beefCache')
      const beef = await getBeefForTxidCached(wallet, txid, { needProof: true })
      await yieldToUi()
      const atomic = beef.toBinaryAtomic(txid)
      const sourceTx = beef.findAtomicTransaction(txid)
      const valid = group.filter((item) => {
        const sats = sourceTx?.outputs?.[item.vout]?.satoshis
        if (typeof sats === 'number' && sats !== 1) {
          console.warn(
            `[bsv21] refusing to internalize ${item.outpoint} — output is not 1 satoshi`,
          )
          return false
        }
        return Boolean(parseBsv21Json({
          p: 'bsv-20',
          op: item.op,
          id: item.tokenId,
          amt: item.amt,
          ...(item.sym ? { sym: item.sym } : {}),
          ...(item.dec != null ? { dec: String(item.dec) } : {}),
        }) || item.op === 'deploy+mint')
      })
      const skipped = group.filter((item) => !valid.includes(item))
      if (skipped.length > 0) {
        releaseOneSatImport(skipped.map((i) => i.outpoint))
        failed += skipped.length
      }
      if (valid.length === 0) continue

      const remittanceOutputs = valid.map((item) => {
        const scriptHex = sourceTx?.outputs?.[item.vout]?.lockingScript?.toHex?.()
        const cosign =
          item.cosign ??
          detectCosignFromLockingScript(scriptHex) ??
          undefined
        if (cosign) {
          console.info(
            `[bsv21] tip ${item.outpoint} cosigned pubkey=${cosign.pubkey.slice(0, 16)}…`,
          )
        }
        if (item.icon) {
          // Decode from tip BEEF when the icon tx is already present; else local services.
          cacheTokenIconFromBeef(item.icon, beef)
          void resolveTokenIconDataUrl(item.icon, wallet)
        }
        return {
          outputIndex: item.vout,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: BSV21_BASKET,
            tags: stampBrc164Id(
              bsv21Tags({
                tokenId: item.tokenId,
                amt: item.amt,
                sym: item.sym,
                cosign,
                // Only mirror a known issuer — never invent one on import.
                issuer: item.issuer,
                op: item.op === 'deploy+mint' ? 'deploy+mint' : 'transfer',
              }),
            ),
            customInstructions: buildBsv21CustomInstructions({
              tokenId: item.tokenId,
              amt: item.amt,
              op: item.op === 'deploy+mint' ? 'deploy+mint' : 'transfer',
              sym: item.sym,
              icon: item.icon,
              dec: item.dec,
              cosign,
              issuer: item.issuer,
            }),
          },
        }
      })

      await yieldToUi()
      await wallet.wallet.internalizeAction({
        tx: atomic,
        description: 'Import BSV-21 token',
        labels: [BSV21_BASKET, 'migration'],
        outputs: remittanceOutputs,
        seekPermission: false,
      })
      await yieldToUi()

      imported += valid.length
      const ops = valid.map((i) => i.outpoint)
      outpoints.push(...ops)
      markOneSatImported(ops)
    } catch (err) {
      markOneSatImportFailed(groupOps)
      failed += group.length
      const msg = err instanceof Error ? err.message : String(err)
      for (const item of group) {
        errors.push(`${item.outpoint}: ${msg}`)
      }
      console.warn('[bsv21] internalize failed', txid, err)
    }
  }

  if (imported > 0) {
    void listFungibles(wallet).catch(() => {})
  }
  return { imported, failed, errors, outpoints }
}
