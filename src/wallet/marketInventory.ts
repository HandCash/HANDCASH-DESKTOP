import type { WalletInterface } from '@bsv/sdk'
import { buildBsv21CustomInstructions, bsv21Tags } from './bsv21'
import { getCachedCollectables, listOutputsWithTimeout } from './collectables'
import type { Collectable } from './collectables'
import { getCachedFungibles } from './fungibles'
import { authenticityFromProvenCache, getProvenVerdict } from './provenCache'
import {
  getWalletCoordinatorSnapshot,
  shouldYieldChainIngestToSpend,
} from './walletCoordinator'

const MARKET_LIST_TIMEOUT_MS = 20_000

function normalizeOutpoint(value: unknown): string | null {
  const raw = String(value ?? '').trim().toLowerCase()
  const match = /^([0-9a-f]{64})[._](0|[1-9]\d*)$/.exec(raw)
  return match ? `${match[1]}.${match[2]}` : null
}

function originTag(origin: string): string {
  return origin.includes('.') ? origin.replace(/\.(\d+)$/, '_$1') : origin
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
 * scan. Serve the durable paint when the wallet is busy, and cap live reads so
 * the BRC-100 bridge answer arrives before its 120s HTTP timeout.
 */
export async function listMarketBasketOutputs(
  wallet: WalletInterface,
  args: ListOutputsArgs,
): Promise<ListOutputsResult> {
  const basket =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { basket?: unknown }).basket
      : undefined

  if (walletBusyForMarketRead()) {
    const cached = cachedMarketListOutputs(basket)
    if (cached && cached.outputs.length > 0) {
      console.info(
        `[market-inventory] wallet busy — serving cached ${String(basket ?? 'basket')} (${cached.outputs.length} row(s))`,
      )
      return cached as ListOutputsResult
    }
  }

  try {
    return await listOutputsWithTimeout(wallet, args, MARKET_LIST_TIMEOUT_MS)
  } catch (err) {
    const cached = cachedMarketListOutputs(basket)
    if (cached && cached.outputs.length > 0) {
      console.info(
        `[market-inventory] listOutputs ${err instanceof Error ? err.message : 'failed'} — serving cache (${cached.outputs.length} row(s))`,
      )
      return cached as ListOutputsResult
    }
    throw err
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
export function addMarketOriginVerdicts(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const body = result as { outputs?: unknown[] }
  if (!Array.isArray(body.outputs)) return result
  return {
    ...body,
    outputs: body.outputs.map((raw) => {
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
    }),
  }
}
