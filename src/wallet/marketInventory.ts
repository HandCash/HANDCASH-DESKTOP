import type { WalletInterface } from '@bsv/sdk'
import { buildBsv21CustomInstructions, bsv21Tags } from './bsv21'
import { getCachedCollectables, listOutputsWithTimeout } from './collectables'
import type { ActiveWallet } from './session'
import type { Collectable } from './collectables'
import { getCachedFungibles } from './fungibles'
import { authenticityFromProvenCache, getProvenVerdict } from './provenCache'
import { toDottedOutpoint, toUnderscoreOutpoint } from './outpointFormat'
import {
  getWalletCoordinatorSnapshot,
  shouldYieldChainIngestToSpend,
} from './walletCoordinator'
import { yieldToUi } from './yieldToUi'

const MARKET_LIST_TIMEOUT_MS = 20_000
const MARKET_VERDICT_CHUNK = 64

function normalizeOutpoint(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const dotted = toDottedOutpoint(raw)
  return /^[0-9a-f]{64}\.(0|[1-9]\d*)$/.test(dotted) ? dotted : null
}

function originTag(origin: string): string {
  return toUnderscoreOutpoint(origin)
}

function collectableToListOutput(item: Collectable): Record<string, unknown> {
  const origin = originTag(item.origin)
  const tags: string[] = [`origin:${origin}`, `name:${item.name}`]
  if (item.app) tags.push(`app:${item.app}`)
  if (item.collectionId) tags.push(`collection:${item.collectionId}`)
  return {
    outpoint: item.outpoint,
    satoshis: item.satoshis,
    tags,
    ...(item.lockingScript ? { lockingScript: item.lockingScript } : {}),
    customInstructions: JSON.stringify({
      origin,
      name: item.name,
      ...(item.app ? { app: item.app } : {}),
      ...(item.collectionId ? { collectionId: item.collectionId } : {}),
      ...(item.content ? { content: item.content } : {}),
    }),
  }
}

function cachedItemBasketOutputs(): { outputs: unknown[]; totalOutputs: number } {
  const outputs = getCachedCollectables().map(collectableToListOutput)
  return { outputs, totalOutputs: outputs.length }
}

function cachedTokenBasketOutputs(): { outputs: unknown[]; totalOutputs: number } {
  const outputs = getCachedFungibles().map((token) => {
    const tokenId = originTag(token.tokenId)
    return {
      outpoint: token.outpoint,
      satoshis: 1,
      tags: bsv21Tags({
        tokenId,
        amt: token.amt,
        sym: token.sym,
        ...(token.icon ? { icon: token.icon } : {}),
        op: 'transfer',
      }),
      customInstructions: buildBsv21CustomInstructions({
        tokenId,
        amt: token.amt,
        op: 'transfer',
        sym: token.sym,
        ...(token.icon ? { icon: token.icon } : {}),
      }),
    }
  })
  return { outputs, totalOutputs: outputs.length }
}

function cachedMarketListOutputs(basket: unknown): { outputs: unknown[]; totalOutputs: number } | null {
  if (basket === '1sat') return cachedItemBasketOutputs()
  if (basket === 'bsv21') return cachedTokenBasketOutputs()
  return null
}

function walletBusyForMarketRead(): boolean {
  const coord = getWalletCoordinatorSnapshot()
  return (
    coord.chainIngest === 'active' ||
    coord.spend === 'active' ||
    shouldYieldChainIngestToSpend()
  )
}

type ListOutputsArgs = Parameters<WalletInterface['listOutputs']>[0]
type ListOutputsResult = Awaited<ReturnType<WalletInterface['listOutputs']>>

/**
 * Market inventory reads must not wedge behind a multi-minute toolbox basket
 * scan. Serve the durable paint immediately when we have it; live reads only on
 * cold start so items-market inventory loads while the wallet is sending.
 */
export async function listMarketBasketOutputs(
  wallet: WalletInterface,
  args: ListOutputsArgs,
): Promise<ListOutputsResult> {
  const basket =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { basket?: unknown }).basket
      : undefined

  const cached = cachedMarketListOutputs(basket)
  if (cached && cached.outputs.length > 0) {
    console.info(
      `[market-inventory] serving cached ${String(basket ?? 'basket')} (${cached.outputs.length} row(s))`,
    )
    if (!walletBusyForMarketRead()) {
      void refreshMarketBasketInBackground(wallet, args, basket)
    }
    return cached as ListOutputsResult
  }

  if (walletBusyForMarketRead()) {
    console.info(
      `[market-inventory] wallet busy — no cache for ${String(basket ?? 'basket')}`,
    )
  }

  try {
    return await listOutputsWithTimeout(
      wallet as ActiveWallet['wallet'],
      args,
      MARKET_LIST_TIMEOUT_MS,
    )
  } catch (err) {
    const fallback = cachedMarketListOutputs(basket)
    if (fallback && fallback.outputs.length > 0) {
      console.info(
        `[market-inventory] listOutputs ${err instanceof Error ? err.message : 'failed'} — serving cache (${fallback.outputs.length} row(s))`,
      )
      return fallback as ListOutputsResult
    }
    throw err
  }
}

async function refreshMarketBasketInBackground(
  wallet: WalletInterface,
  args: ListOutputsArgs,
  basket: unknown,
): Promise<void> {
  if (walletBusyForMarketRead()) return
  try {
    await listOutputsWithTimeout(
      wallet as ActiveWallet['wallet'],
      args,
      MARKET_LIST_TIMEOUT_MS,
    )
    console.info(
      `[market-inventory] background refresh ok for ${String(basket ?? 'basket')}`,
    )
  } catch (err) {
    console.info(
      `[market-inventory] background refresh skipped for ${String(basket ?? 'basket')}`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Market-only extension to BRC-100 listOutputs rows.
 *
 * The market must not infer authenticity from an `origin` tag or from unverified
 * remittance. Only the wallet's durable BRC-150 verdict may make an item
 * eligible for sale, and only the origin that verdict established may be bound
 * into a sale — `provenOrigin` is the origin the wallet walked to itself, so the
 * market never has to trust the `origin` an app or a sender wrote into metadata.
 *
 * Remittance is deliberately not part of this verdict. `customInstructions`
 * carries a proof blob only for tips that arrived through a BRC-150 send; a
 * minted or imported tip is just as genuine and rebuilds a publishable proof at
 * listing time. Requiring the blob here would hide almost every real item.
 */
function projectMarketOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const outpoint = normalizeOutpoint((raw as { outpoint?: unknown }).outpoint)
  const verdict = outpoint
    ? authenticityFromProvenCache(outpoint)
    : { authenticity: 'unproven' as const, proven: false }
  const proven = verdict.proven && verdict.authenticity === 'brc150'
  const provenOrigin = proven && outpoint ? getProvenVerdict(outpoint)?.origin : undefined
  return {
    ...raw,
    authenticity: verdict.authenticity,
    originVerified: proven,
    provenOrigin: provenOrigin ?? null,
  }
}

export function addMarketOriginVerdicts(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const body = result as { outputs?: unknown[] }
  if (!Array.isArray(body.outputs)) return result
  return {
    ...body,
    outputs: body.outputs.map(projectMarketOutput),
  }
}

/** Chunked projection so 700+ row market reads do not block the UI thread. */
export async function addMarketOriginVerdictsAsync(result: unknown): Promise<unknown> {
  if (!result || typeof result !== 'object') return result
  const body = result as { outputs?: unknown[] }
  if (!Array.isArray(body.outputs)) return result
  const outputs = body.outputs
  if (outputs.length <= MARKET_VERDICT_CHUNK) {
    return addMarketOriginVerdicts(result)
  }
  const projected: unknown[] = []
  for (let i = 0; i < outputs.length; i += MARKET_VERDICT_CHUNK) {
    if (i > 0) await yieldToUi()
    projected.push(
      ...outputs.slice(i, i + MARKET_VERDICT_CHUNK).map(projectMarketOutput),
    )
  }
  return { ...body, outputs: projected }
}
