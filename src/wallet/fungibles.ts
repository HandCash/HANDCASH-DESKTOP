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
import { formatHandCashHandle } from './handleFormat'
import { getTokenIconDataUrl } from './tokenIconCache'
import { cacheTokenIconFromBeef, resolveTokenIconDataUrl } from './tokenIconResolve'
import { yieldToUi } from './yieldToUi'

export type { FungibleToken, Bsv21Utxo, Bsv21ImportItem }
export { formatFungibleAmount, BSV21_BASKET }

type Listener = (tokens: FungibleToken[]) => void

let cached: FungibleToken[] = []
let hydrated = false
const listeners = new Set<Listener>()

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
    cached = [...cached]
    notify()
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
  }
}

/**
 * List live BSV-21 tips from basket `bsv21` and aggregate by token id.
 */
export async function listFungibles(
  active?: ActiveWallet | null,
): Promise<FungibleToken[]> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) {
    cached = []
    hydrated = true
    notify()
    return cached
  }

  try {
    await yieldToUi()
    const listed = await wallet.wallet.listOutputs({
      basket: BSV21_BASKET,
      limit: 1000,
      includeCustomInstructions: true,
      includeTags: true,
      include: 'locking scripts',
    })
    await yieldToUi()
    const selfKey = wallet.identityKey.toLowerCase()
    const utxos: Bsv21Utxo[] = []
    for (const row of listed.outputs ?? []) {
      const parsed = parseListedOutput(
        row as {
          outpoint?: string
          satoshis?: number
          tags?: string[]
          customInstructions?: string
          lockingScript?: string
        },
        selfKey,
      )
      if (parsed) utxos.push(parsed)
    }
    const selfHandle = wallet.handle
      ? formatHandCashHandle(wallet.handle.replace(/^[$@]/, ''), null)
      : ''
    const tokens = aggregateFungibles(utxos).map((t) => {
      const iconOrigin = utxos.find((u) => u.tokenId === t.tokenId)?.icon
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
    cached = tokens
    hydrated = true
    notify()
    // Fill missing icons from local/session BEEF (no HTTP content indexer).
    void hydrateMissingTokenIcons(wallet, tokens)
    return tokens
  } catch (err) {
    console.warn('[bsv21] listOutputs failed', err)
    hydrated = true
    notify()
    return cached
  }
}

export function getFungible(tokenId: string): FungibleToken | null {
  const id = normalizeTokenId(tokenId)
  if (!id) return null
  return cached.find((t) => t.tokenId === id) ?? null
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

  const byTxid = new Map<string, Bsv21ImportItem[]>()
  for (const item of items) {
    const list = byTxid.get(item.txid) ?? []
    list.push(item)
    byTxid.set(item.txid, list)
  }

  let imported = 0
  let failed = 0
  const errors: string[] = []
  const outpoints: string[] = []

  for (const [txid, group] of byTxid) {
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
            tags: bsv21Tags({
              tokenId: item.tokenId,
              amt: item.amt,
              sym: item.sym,
              cosign,
              // Only mirror a known issuer — never invent one on import.
              issuer: item.issuer,
            }),
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
      outpoints.push(...valid.map((i) => i.outpoint))
    } catch (err) {
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
