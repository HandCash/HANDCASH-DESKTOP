/**
 * Tokens list: basket `bsv21` BRC-162 value tips, aggregated by deploy outpoint.
 * 1sat-ft leftovers are not painted as tokens.
 * Never included in fetchBalanceSats / Pay.
 */

import { getActiveWallet, type ActiveWallet } from './session'
import type { Chain } from './vault'
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
} from './bsv21'
import { tipFromBsv21Script } from './bsv21Send'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  beginOneSatImport,
  markOneSatImportFailed,
  markOneSatImported,
  releaseOneSatImport,
} from './oneSatImportGuard'
import { getTokenIconDataUrl } from './tokenIconCache'
import { cacheTokenIconFromBeef, resolveOnesatFtIconDataUrl, resolveTokenIconDataUrl } from './tokenIconResolve'
import { yieldToUi } from './yieldToUi'
import { stampBrc164Id } from './itemAccess'
import { isItemSent } from './sentItemGuard'

export type { FungibleToken, Bsv21Utxo, Bsv21ImportItem }
export { formatFungibleAmount, BSV21_BASKET }

type Listener = (tokens: FungibleToken[]) => void

const LIST_CACHE_KEY = 'handcash.fungibles.list.v1'

let cached: FungibleToken[] = []
let hydrated = false
let listInFlight: Promise<FungibleToken[]> | null = null
const listeners = new Set<Listener>()

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

function loadDurableList(): FungibleToken[] {
  try {
    const raw = durableGetItem(LIST_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { items?: unknown }
    if (!Array.isArray(parsed?.items)) return []
    return parsed.items
      .filter(isFungibleShape)
      .filter((t) => !leftoverCollectableSym(t.sym))
      .map((t) => ({
      ...t,
      dec: Number.isFinite(t.dec) ? t.dec : 0,
      spendKind:
        t.spendKind === 'cosigned' || t.spendKind === 'mixed' ? t.spendKind : 'plain',
    }))
  } catch {
    return []
  }
}

function persistDurableList(items: FungibleToken[]): void {
  try {
    durableSetItem(
      LIST_CACHE_KEY,
      JSON.stringify({
        at: Date.now(),
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
          ...(t.colourSupply ? { colourSupply: t.colourSupply } : {}),
          ...(t.colourMaxSupply != null ? { colourMaxSupply: t.colourMaxSupply } : {}),
          ...(t.colourProvenanceOk != null ? { colourProvenanceOk: t.colourProvenanceOk } : {}),
        })),
      }),
    )
  } catch {
    // Cache is an optimisation.
  }
}

function leftoverCollectableSym(sym: string | undefined): boolean {
  const s = (sym ?? '').trim()
  return s === 'Collectable' || s.startsWith('Pixel Foxes')
}

function cacheExtraLooksLikeFungible(t: FungibleToken): boolean {
  if (leftoverCollectableSym(t.sym)) return false
  const amt = Number(t.amt)
  return Number.isFinite(amt) && amt > 0
}

function setFungiblesCache(items: FungibleToken[]): void {
  cached = items.filter(cacheExtraLooksLikeFungible)
  hydrated = true
  persistDurableList(cached)
  notify()
}

function tokenKey(t: Pick<FungibleToken, 'tokenId'>): string {
  return t.tokenId.trim().toLowerCase()
}

/** Live rows win. Keep cached colour tokens listOutputs dropped (WOC 429).
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
    if (t.colourMaxSupply != null && Number(t.amt) > t.colourMaxSupply) continue
    byId.set(tokenKey(t), t)
  }
  for (const t of live) {
    if (t.outpoint && isItemSent(t.outpoint)) continue
    const k = tokenKey(t)
    liveIds.add(k)
    const priorRow = byId.get(k)
    // Live listing already overlays leftovers and aggregates by origin.
    // amt comes from live. Never leftover+live across refreshes.
    byId.set(k, {
      ...t,
      ...(priorRow && !t.icon && priorRow.icon ? { icon: priorRow.icon } : {}),
      ...(priorRow && !t.iconUrl && priorRow.iconUrl ? { iconUrl: priorRow.iconUrl } : {}),
      ...(priorRow && t.colourMaxSupply == null && priorRow.colourMaxSupply != null
        ? { colourMaxSupply: priorRow.colourMaxSupply }
        : {}),
    })
  }
  // Live listing is source of truth. Never keep a cache extra whose tip is
  // the genesis (tokenId == outpoint) when it is spent or absent from live.
  for (const [k, t] of [...byId.entries()]) {
    if (liveIds.has(k)) continue
    if (isGenesisRow(t)) {
      byId.delete(k)
      continue
    }
    if (!cacheExtraLooksLikeFungible(t)) byId.delete(k)
  }
  const out = [...byId.values()]
  out.sort((a, b) => Number(b.amt) - Number(a.amt) || a.sym.localeCompare(b.sym))
  return out
}

export function rememberFungibleToken(token: FungibleToken): void {
  setFungiblesCache(mergeLiveFungibles([token], cached))
}

export function forgetFungibleToken(tokenId: string): void {
  const k = tokenId.trim().toLowerCase()
  setFungiblesCache(cached.filter((t) => tokenKey(t) !== k))
}

export function paintFungibleAfterSpend(args: {
  tokenId: string
  remainingAmt: number
  outpoint?: string
  sym?: string
  colourSupply?: FungibleToken['colourSupply']
  colourMaxSupply?: number | null
  icon?: string
}): void {
  if (!Number.isFinite(args.remainingAmt) || args.remainingAmt <= 0) {
    forgetFungibleToken(args.tokenId)
    return
  }
  const prior = cached.find((t) => tokenKey(t) === args.tokenId.trim().toLowerCase())
  rememberFungibleToken({
    tokenId: args.tokenId,
    sym: args.sym || prior?.sym || 'Token',
    amt: String(args.remainingAmt),
    dec: 0,
    utxoCount: 1,
    outpoint: args.outpoint || prior?.outpoint || args.tokenId,
    spendKind: 'plain',
    colourSupply: args.colourSupply ?? prior?.colourSupply,
    colourMaxSupply: args.colourMaxSupply ?? prior?.colourMaxSupply ?? null,
    colourProvenanceOk: prior?.colourProvenanceOk ?? true,
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
  // 1sat-ft leftover remittance is not painted as Tokens.
}

function notify() {
  for (const cb of listeners) cb(cached)
}

export async function hydrateCachedTokenIcons(
  wallet: ActiveWallet,
  tokens: FungibleToken[] = cached,
): Promise<void> {
  let changed = false
  for (const token of tokens) {
    if (token.iconUrl) continue
    if (!cacheExtraLooksLikeFungible(token)) continue
    const url = token.colourSupply
      ? token.icon
        ? await resolveTokenIconDataUrl(token.icon, wallet)
        : undefined
      : (await resolveOnesatFtIconDataUrl({
          origin: token.tokenId,
          icon: token.icon,
          tipOutpoint: token.outpoint,
          wallet,
        })) ??
        (token.icon ? await resolveTokenIconDataUrl(token.icon, wallet) : undefined)
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

export function getCachedFungibles(): FungibleToken[] {
  return cached
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
  if (!from162) return null
  const ci = parseBsv21CustomInstructions(raw.customInstructions)
  const op = (from162.tokenId === from162.outpoint ? 'deploy+mint' : 'transfer') as Bsv21Op
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
    outpoint: from162.outpoint,
    tokenId: from162.tokenId,
    amt: from162.amt.toString(),
    op,
    dec: ci?.dec ?? 0,
    satoshis: 1,
    ...(ci?.sym ? { sym: ci.sym } : {}),
    ...(ci?.icon ? { icon: ci.icon } : {}),
    lockingScript: raw.lockingScript,
    ...(cosign ? { cosign } : {}),
    ...(issuer ? { issuer } : {}),
    ...(issuerAttested ? { issuerAttested: true } : {}),
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

/**
 * List live BSV-21 tips from basket `bsv21` and aggregate by token id.
 */
async function listFungiblesNow(
  active?: ActiveWallet | null,
): Promise<FungibleToken[]> {
  const wallet = active ?? getActiveWallet()
  // Locked / no session: keep last durable paint (mirrors collectables).
  if (!wallet) return getCachedFungibles()

  try {
    await yieldToUi()
    let liveRows: FungibleToken[] = []
    try {
      const { listBsv21BinaryTokens } = await import('./colourListing')
      liveRows = await listBsv21BinaryTokens(wallet)
    } catch (err) {
      console.warn('[bsv21] list failed', err)
    }
    // Do not paint 1sat-ft leftovers as tokens.
    // Live 162 (colourSupply set) wins over stale JSON BSV-21 rows.
    const prior = cached.filter((t) => !leftoverCollectableSym(t.sym))
    const merged = mergeLiveFungibles(liveRows, prior)
    setFungiblesCache(merged)
    // Fill missing icons from local/session BEEF (no HTTP content indexer).
    void hydrateMissingTokenIcons(wallet, merged)
    return merged
  } catch (err) {
    console.warn('[1sat-ft] list failed', err)
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
    if (!wanted.has(tip.tokenId)) continue
    if ((tip.satoshis ?? 1) !== 1) continue
    tips.push(tip)
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
      const { shouldYieldChainIngestToSpend } = await import('./walletCoordinator')
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
      const { getBeefForTxidCached } = await import('./beefCache')
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
