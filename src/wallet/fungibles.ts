/**
 * BSV-21 fungibles in basket `bsv21` (BRC-163 draft) — Collect, not currency.
 *
 * Balance is summed from live tips' inscription `amt` (indexer + remittance).
 * Tip authenticity is local; issuer mint policy is trusted. Never included in
 * fetchBalanceSats / Pay.
 */

import { getActiveWallet, type ActiveWallet } from './session'
import type { Chain } from './vault'
import {
  aggregateFungibles,
  buildBsv21CustomInstructions,
  BSV21_BASKET,
  bsv21Tags,
  cosignFromRemittance,
  detectCosignFromLockingScript,
  formatFungibleAmount,
  isBalanceBearingOp,
  issuerFromRemittance,
  issuerFromSigmaLockingScript,
  normalizeTokenId,
  parseBsv21CustomInstructions,
  parseBsv21Json,
  shortTokenLabel,
  tokenIdForListedTip,
  tokenIdFromBsv21Tags,
  type Bsv21ImportItem,
  type Bsv21Op,
  type Bsv21Utxo,
  type FungibleToken,
} from './bsv21'
import { durableGetItem, durableSetItem } from './durableStorage'
import { formatHandCashHandle } from './handleFormat'
import {
  beginOneSatImport,
  markOneSatImportFailed,
  markOneSatImported,
  releaseOneSatImport,
} from './oneSatImportGuard'
import { getTokenIconDataUrl } from './tokenIconCache'
import { cacheTokenIconFromBeef, resolveTokenIconDataUrl } from './tokenIconResolve'
import { yieldToUi } from './yieldToUi'
import { stampBrc164Id } from './itemAccess'
import { isItemSent } from './sentItemGuard'

export type { FungibleToken, Bsv21Utxo, Bsv21ImportItem }
export { formatFungibleAmount, BSV21_BASKET }

type Listener = (tokens: FungibleToken[]) => void

const LIST_CACHE_KEY = 'handcash.fungibles.list.v1'
const LIST_TIMEOUT_MS = 20_000

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
    return parsed.items.filter(isFungibleShape).map((t) => ({
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
        })),
      }),
    )
  } catch {
    // Cache is an optimisation.
  }
}

function setFungiblesCache(items: FungibleToken[]): void {
  cached = items
  hydrated = true
  persistDurableList(items)
  notify()
}

// Paint last session's tokens immediately — same pattern as collectables.
{
  const durable = loadDurableList()
  if (durable.length > 0) {
    cached = durable
    hydrated = true
  }
}

function notify() {
  for (const cb of listeners) cb(cached)
}

async function hydrateMissingTokenIcons(
  wallet: ActiveWallet,
  tokens: FungibleToken[],
): Promise<void> {
  let changed = false
  for (const token of tokens) {
    const icon = token.icon
    if (!icon || token.iconUrl) continue
    const url = await resolveTokenIconDataUrl(icon, wallet)
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

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      const v = tag.slice(prefix.length).trim()
      if (v) return v
    }
  }
  return undefined
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
  const fromCi = parseBsv21CustomInstructions(raw.customInstructions)
  const amt = fromCi?.amt ?? tagValue(raw.tags, 'amt:')
  const op = (fromCi?.op ?? tagValue(raw.tags, 'op:') ?? 'transfer') as Bsv21Op
  // deploy+mint has no id field — tip outpoint is the token id (BRC-161).
  // Tag form is `bsv21:<tokenId>` (not `id:` — reserved for per-output identity).
  const tokenId = tokenIdForListedTip({
    outpoint,
    op,
    id: fromCi?.id,
    idTag: tokenIdFromBsv21Tags(raw.tags),
  })
  if (!tokenId || !amt || !isBalanceBearingOp(op)) return null
  const sym = fromCi?.sym ?? tagValue(raw.tags, 'sym:')
  const icon = fromCi?.icon
  const dec = fromCi?.dec ?? 0
  const cosign = cosignFromRemittance({
    customInstructions: raw.customInstructions,
    tags: raw.tags,
  })
  let issuer = issuerFromRemittance({
    customInstructions: raw.customInstructions,
    tags: raw.tags,
  })
  let issuerAttested = false
  if (raw.lockingScript) {
    const candidates = [issuer, selfIdentityKey].filter(Boolean) as string[]
    const sigma = issuerFromSigmaLockingScript(raw.lockingScript, candidates)
    if (sigma.issuer) {
      issuer = sigma.issuer
      issuerAttested = true
    } else if (issuer && sigma.address) {
      // Remittance issuer present; Sigma address seen on script.
      issuerAttested = true
    }
  }
  return {
    outpoint,
    tokenId,
    amt,
    op,
    ...(sym ? { sym } : {}),
    ...(icon ? { icon } : {}),
    dec,
    satoshis: raw.satoshis === 1 ? 1 : (raw.satoshis ?? 1),
    ...(cosign ? { cosign } : {}),
    ...(issuer ? { issuer } : {}),
    ...(issuerAttested ? { issuerAttested: true } : {}),
    ...(raw.lockingScript ? { lockingScript: raw.lockingScript } : {}),
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
    const listed = await Promise.race([
      wallet.wallet.listOutputs({
        basket: BSV21_BASKET,
        limit: 1000,
        includeCustomInstructions: true,
        includeTags: true,
        include: 'locking scripts',
        seekPermission: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('listOutputs timed out')), LIST_TIMEOUT_MS),
      ),
    ])
    await yieldToUi()
    const selfKey = wallet.identityKey.toLowerCase()
    const utxos: Bsv21Utxo[] = []
    /** Metadata from any tip (incl. deploy+auth / auth) keyed by token id. */
    const metaById = new Map<
      string,
      { sym?: string; icon?: string; dec?: number; issuer?: string }
    >()
    for (const row of listed.outputs ?? []) {
      const raw = row as {
        outpoint?: string
        satoshis?: number
        tags?: string[]
        customInstructions?: string
        lockingScript?: string
      }
      if (raw.outpoint && isItemSent(raw.outpoint)) continue
      const fromCi = parseBsv21CustomInstructions(raw.customInstructions)
      let loose: {
        op?: string
        sym?: string
        icon?: string
        id?: string
        dec?: number
        issuer?: string
      } = {}
      if (raw.customInstructions) {
        try {
          const o = JSON.parse(raw.customInstructions) as Record<string, unknown>
          if (typeof o.op === 'string') loose.op = o.op.trim().toLowerCase()
          if (typeof o.sym === 'string' && o.sym.trim()) loose.sym = o.sym.trim()
          if (typeof o.icon === 'string') {
            loose.icon = normalizeTokenId(o.icon) ?? undefined
          }
          if (typeof o.id === 'string') {
            loose.id = normalizeTokenId(o.id) ?? undefined
          }
          if (typeof o.dec === 'string' && /^\d{1,2}$/.test(o.dec)) {
            loose.dec = Number(o.dec)
          } else if (typeof o.dec === 'number' && Number.isInteger(o.dec)) {
            loose.dec = o.dec
          }
          if (typeof o.issuer === 'string') {
            loose.issuer =
              issuerFromRemittance({ customInstructions: raw.customInstructions }) ??
              undefined
          }
        } catch {
          // ignore
        }
      }
      const op = (fromCi?.op ?? loose.op ?? tagValue(raw.tags, 'op:') ?? '') as string
      const tipId = tokenIdForListedTip({
        outpoint: (raw.outpoint ?? '').trim().toLowerCase(),
        op,
        id: fromCi?.id ?? loose.id,
        idTag: tokenIdFromBsv21Tags(raw.tags),
      })
      if (tipId) {
        const prev = metaById.get(tipId) ?? {}
        const sym =
          fromCi?.sym ?? loose.sym ?? tagValue(raw.tags, 'sym:') ?? prev.sym
        const icon = fromCi?.icon ?? loose.icon ?? prev.icon
        const dec = fromCi?.dec ?? loose.dec ?? prev.dec
        const issuer =
          issuerFromRemittance({
            customInstructions: raw.customInstructions,
            tags: raw.tags,
          }) ??
          loose.issuer ??
          prev.issuer
        metaById.set(tipId, {
          ...(sym ? { sym } : {}),
          ...(icon ? { icon } : {}),
          ...(dec != null ? { dec } : {}),
          ...(issuer ? { issuer } : {}),
        })
      }
      const parsed = parseListedOutput(raw, selfKey)
      if (parsed) utxos.push(parsed)
    }
    for (const u of utxos) {
      const meta = metaById.get(u.tokenId)
      if (!meta) continue
      if (!u.sym && meta.sym) u.sym = meta.sym
      if (!u.icon && meta.icon) u.icon = meta.icon
      if (u.dec === 0 && meta.dec != null && meta.dec > 0) u.dec = meta.dec
      if (!u.issuer && meta.issuer) u.issuer = meta.issuer
    }
    const selfHandle = wallet.handle
      ? formatHandCashHandle(wallet.handle.replace(/^[$@]/, ''), null)
      : ''
    const tokens = aggregateFungibles(utxos).map((t) => {
      const iconOrigin =
        t.icon ??
        utxos.find((u) => u.tokenId === t.tokenId)?.icon ??
        metaById.get(t.tokenId)?.icon
      const issuerHandle =
        t.issuer && t.issuer === selfKey && selfHandle ? selfHandle : undefined
      const iconUrl = iconOrigin ? getTokenIconDataUrl(iconOrigin) : undefined
      return {
        ...t,
        sym: t.sym || shortTokenLabel(t.tokenId),
        ...(iconUrl ? { iconUrl } : {}),
        ...(iconOrigin ? { icon: iconOrigin } : {}),
        ...(issuerHandle ? { issuerHandle } : {}),
      }
    })
    setFungiblesCache(tokens)
    // Fill missing icons from local/session BEEF (no HTTP content indexer).
    void hydrateMissingTokenIcons(wallet, tokens)
    return tokens
  } catch (err) {
    console.warn('[bsv21] listOutputs failed', err)
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

  for (const [txid, group] of byTxid) {
    const groupOps = group.map((g) => g.outpoint)
    try {
      if (!wallet.services?.getBeefForTxid) {
        throw new Error('Wallet services unavailable for BEEF fetch')
      }
      await yieldToUi()
      const beef = await wallet.services.getBeefForTxid(txid)
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
