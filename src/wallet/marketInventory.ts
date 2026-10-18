import type { WalletInterface } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { authenticityFromProvenCache, getProvenVerdict } from './provenCache'
import { toDottedOutpoint } from './outpointFormat'
import { heldInventoryOutputs } from './inventoryProjection'
import {
  getWalletCoordinatorSnapshot,
  shouldYieldChainIngestToSpend,
} from './walletCoordinator'
import { yieldToUi } from './yieldToUi'

const MARKET_LIST_TIMEOUT_MS = 20_000
/**
 * Ceiling for a cold basket with no paint to fall back on. Must stay under the
 * shell's 120s bridge timeout so the caller gets our named error, not a
 * transport one.
 */
const MARKET_LIST_COLD_CEILING_MS = 90_000
const MARKET_VERDICT_CHUNK = 64

function normalizeOutpoint(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const dotted = toDottedOutpoint(raw)
  return /^[0-9a-f]{64}\.(0|[1-9]\d*)$/.test(dotted) ? dotted : null
}

/** The basket as the wallet last painted it — what a stalled toolbox read falls back to. */
export function cachedMarketListOutputs(basket: unknown): { outputs: unknown[]; totalOutputs: number } | null {
  return heldInventoryOutputs(basket)
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
 * BRC-165 view lists by tags + originVerified. Never pull remittance BEEF for
 * a 700-row inventory — that is what wedged market.handcash.io on fox wallets.
 */
function inventoryReadArgs(args: ListOutputsArgs): ListOutputsArgs {
  return {
    ...args,
    includeTags: true,
    includeCustomInstructions: false,
  }
}

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
  const busy = walletBusyForMarketRead()
  // Only an item inventory is large enough to wedge an idle read. A token
  // basket is a few rows, and its paint lags the wallet's own spends: a cancel
  // that just returned units read as a zero balance.
  const paintFirst = basket === '1sat' || basket === 'p 1sat all'
  if (cached && (busy || (paintFirst && cached.outputs.length > 0))) {
    console.info(
      `[market-inventory] serving projected ${String(basket ?? 'basket')} (${cached.outputs.length} row(s)${
        busy ? ', wallet busy' : ''
      })`,
    )
    return cached as ListOutputsResult
  }

  if (busy) {
    console.info(
      `[market-inventory] wallet busy — no cache for ${String(basket ?? 'basket')}`,
    )
  }

  // Hold the read itself, not just a race against it: `listOutputsWithTimeout`
  // abandons the timer's loser, and the scan keeps going regardless.
  const live = (wallet as ActiveWallet['wallet']).listOutputs(
    inventoryReadArgs(args),
  )
  live.catch(() => {})

  try {
    return await raceTimeout(live, MARKET_LIST_TIMEOUT_MS)
  } catch (err) {
    const fallback = cachedMarketListOutputs(basket)
    if (fallback && fallback.outputs.length > 0) {
      console.info(
        `[market-inventory] listOutputs ${err instanceof Error ? err.message : 'failed'} — serving cache (${fallback.outputs.length} row(s))`,
      )
      return fallback as ListOutputsResult
    }
    if (!isListTimeout(err)) throw err
    // Nothing painted to serve and the scan is still running. Failing here
    // would only push the caller into a retry that waits on this same scan,
    // so wait it out instead — a cold basket on a busy wallet has taken
    // upwards of 40s while chain ingest holds the main thread.
    console.info(
      `[market-inventory] ${String(basket ?? 'basket')} cold and slow — waiting out the live read`,
    )
    return await raceTimeout(live, MARKET_LIST_COLD_CEILING_MS)
  }
}

function isListTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === 'listOutputs timed out'
}

/**
 * Race without abandoning the work. The timer is always cleared, so a slow
 * basket cannot leave a pending timeout alive for the rest of the session.
 */
function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('listOutputs timed out')), ms)
  })
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  }) as Promise<T>
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
