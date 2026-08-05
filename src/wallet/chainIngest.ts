/**
 * Chain ingest layer — network → local toolbox state.
 *
 * Refresh / background poll belong here. This is **not** BRC-39 history replica
 * and **not** Desktop↔Mobile sync. See `layers.ts`.
 *
 * Pipeline:
 * 1. scan legacy receive P2PKH → classify → import (`ingestLegacyAddress.ts`)
 * 2. reviewSpendableOutputs (drop outs spent elsewhere; skipped briefly after import)
 */
import { runChainIngest, runChainIngestDuringSpend } from './walletCoordinator'
import { getActiveWallet, fetchBalanceSats } from './session'
import { reconcilePendingSends } from './pendingSend'
import { clearCollectablesCache } from './collectables'
import { playWalletSound } from './soundService'
import { setSyncHealth } from './walletHealth'
import { resolveHistoryBackupBaseUrl } from './historyBackupPrefs'
import { toastSuccess } from './toast'
import { getDisplayCurrency } from './displayCurrency'
import { formatPrimaryFromSats } from './fx'
import { ingestLegacyAddressUtxos } from './ingestLegacyAddress'
import { isLegacyImportGraceActive } from './legacyImportGuard'

export { ingestLegacyAddressUtxos } from './ingestLegacyAddress'
export type { LegacyAddressIngestResult, LegacyAddressIngestOptions } from './ingestLegacyAddress'

/** Serialize all chain-ingest work (Refresh, migrate refresh, spend heal). */
export async function refreshFromChain(opts?: ChainIngestOptions): Promise<number | null> {
  return runChainIngest(() => refreshFromChainExclusive(opts))
}

/**
 * Chain heal while a spend session holds the spend region.
 * Used by spendGuard — do not call from Dashboard Refresh.
 */
export async function refreshFromChainDuringSpend(
  opts?: ChainIngestOptions,
): Promise<number | null> {
  return runChainIngestDuringSpend(() => refreshFromChainExclusive(opts))
}

/** @deprecated prefer refreshFromChain */
export const syncLegacyFunds = refreshFromChain

/** @deprecated prefer runChainIngest from walletCoordinator */
export { runChainIngest as runOnChainIngestQueue } from './walletCoordinator'

export type ChainIngestOptions = {
  /**
   * When true (default), play receive SFX only if spendable balance rises
   * (or a newly seen 1sat outpoint is internalized). Pass false after a local
   * send so we don't double-chime with payment success.
   */
  announceReceive?: boolean
  /**
   * When true, always run spendability review (all baskets, release dead outs).
   * Use for explicit Refresh. Background polls throttle reviews.
   */
  forceReview?: boolean
}

/** @deprecated alias — prefer ChainIngestOptions */
export type SyncLegacyFundsOptions = ChainIngestOptions

/** Outpoints we've already chimed for this session — avoids re-import noise. */
const announcedOneSatOutpoints = new Set<string>()
let lastReceiveChimeAt = 0
const RECEIVE_CHIME_COOLDOWN_MS = 12_000

/** Background sync should not hammer UTXO status providers. */
const REVIEW_THROTTLE_MS = 2 * 60_000
/** Faster reviews when multi-device BRC-39 parity URL is configured. */
const REVIEW_THROTTLE_PARITY_MS = 45_000
let lastSpendableReviewAt = 0

function reviewThrottleMs(): number {
  return resolveHistoryBackupBaseUrl() ? REVIEW_THROTTLE_PARITY_MS : REVIEW_THROTTLE_MS
}

function maybeReceiveChime(): void {
  const now = Date.now()
  if (now - lastReceiveChimeAt < RECEIVE_CHIME_COOLDOWN_MS) return
  lastReceiveChimeAt = now
  playWalletSound('receive')
}

function isUndefinedPartialFilterError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes('must be not undefined') ||
    message.includes('Passing undefined as a filter value is not supported')
  )
}

/**
 * Drop outs that are no longer UTXOs on-chain (e.g. spent on another device
 * with the same restored identity). Covers default change and basket `1sat`.
 */
export async function reviewAndReleaseSpentOutputs(
  force = false,
): Promise<{ released: number; skipped: boolean; error?: string }> {
  const active = getActiveWallet()
  if (!active) return { released: 0, skipped: true }

  const now = Date.now()
  if (!force && now - lastSpendableReviewAt < reviewThrottleMs()) {
    return { released: 0, skipped: true }
  }

  // Fresh legacy sweeps produce managed change that indexers may not yet treat as
  // spendable — releasing during this window drops the deposit from balance.
  // A forced review is a spend heal or an explicit Refresh: outputs this device
  // just spent have to be released, or sent items keep listing here.
  if (!force && isLegacyImportGraceActive()) {
    return { released: 0, skipped: true }
  }

  try {
    let result
    try {
      result = await active.wallet.reviewSpendableOutputs(true, true)
    } catch (err) {
      if (!isUndefinedPartialFilterError(err)) throw err
      console.warn(
        '[chain-ingest] all-basket spendable review unsupported; reviewing default basket only',
        err instanceof Error ? err.message : err,
      )
      result = await active.wallet.reviewSpendableOutputs(false, true)
    }
    lastSpendableReviewAt = Date.now()
    const released = result.outputs?.length ?? 0
    if (released > 0) {
      clearCollectablesCache()
    }
    return { released, skipped: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[chain-ingest] spendable review failed — not releasing', err)
    return { released: 0, skipped: false, error: message }
  }
}

export async function refreshFromChainExclusive(opts?: ChainIngestOptions): Promise<number | null> {
  const announceReceive = opts?.announceReceive !== false
  const forceReview = opts?.forceReview === true
  const active = getActiveWallet()
  if (!active) return null

  if (forceReview) {
    setSyncHealth({ phase: 'syncing', message: 'Refreshing funds against the network' })
  }

  let balanceBefore = 0
  let balanceBeforeOk = false
  try {
    balanceBefore = await fetchBalanceSats(active.wallet)
    balanceBeforeOk = true
  } catch {
    balanceBefore = 0
  }

  try {
    reconcilePendingSends()
  } catch (err) {
    console.warn('[chain-ingest] pending send reconcile skipped', err)
  }

  let heldCount = 0
  let partialWarn: string | null = null
  let importedFunding = 0
  let newOneSatOutpoints: string[] = []

  try {
    const ingest = await ingestLegacyAddressUtxos({ active })
    heldCount = ingest.heldOneSats
    partialWarn = ingest.partialWarn
    importedFunding = ingest.importedFunding
    newOneSatOutpoints = ingest.newOneSatOutpoints.filter(
      (op) => !announcedOneSatOutpoints.has(op),
    )
    for (const op of ingest.newOneSatOutpoints) {
      announcedOneSatOutpoints.add(op)
    }
  } catch (err) {
    console.warn('[chain-ingest] legacy address ingest skipped', err)
    setSyncHealth({
      phase: 'error',
      message: 'Couldn’t refresh funds — check your network connection.',
      heldOneSats: heldCount,
    })
    return null
  }

  // A sweep in this same pass means the indexer has definitely not caught up yet,
  // so hold the release even when forced — that is what the grace window is for.
  const review = await reviewAndReleaseSpentOutputs(forceReview && importedFunding === 0)
  if (review.error && forceReview) {
    setSyncHealth({
      phase: 'error',
      message: 'Couldn’t verify spent outputs — check your network connection.',
      heldOneSats: heldCount,
    })
  }

  try {
    const balanceAfter = await fetchBalanceSats(active.wallet)
    if (announceReceive) {
      const balanceRose = balanceBeforeOk && balanceAfter > balanceBefore
      const newItems = newOneSatOutpoints.length > 0
      // Only announce when balance actually rose or new collectables arrived — not on
      // import attempt alone (indexer lag can show a phantom deposit then review drops it).
      if (balanceRose || newItems) {
        maybeReceiveChime()
        const gained = balanceRose ? Math.max(0, balanceAfter - balanceBefore) : 0
        const amountLabel =
          gained > 0 ? formatPrimaryFromSats(gained, getDisplayCurrency()) : undefined
        toastSuccess(
          balanceRose ? 'Payment received' : 'Item received',
          amountLabel
            ? `${amountLabel}${newItems ? ` · ${newOneSatOutpoints.length} item${newOneSatOutpoints.length === 1 ? '' : 's'}` : ''}`
            : newItems
              ? `${newOneSatOutpoints.length} collectable${newOneSatOutpoints.length === 1 ? '' : 's'}`
              : undefined,
        )
      } else if (importedFunding > 0 && !balanceRose) {
        console.info(
          `[chain-ingest] imported ${importedFunding} legacy out(s) but balance unchanged — awaiting indexer`,
        )
      }
    }

    const reviewNote =
      review.released > 0
        ? `Updated ${review.released} spent output${review.released === 1 ? '' : 's'} from the network.`
        : null

    setSyncHealth({
      phase: review.error && !partialWarn ? 'error' : 'ok',
      message:
        partialWarn ??
        (review.error
          ? 'Spend check incomplete — retrying automatically.'
          : reviewNote),
      heldOneSats: heldCount,
    })
    return balanceAfter
  } catch (err) {
    console.warn('[chain-ingest] balance refresh failed', err)
    setSyncHealth({
      phase: 'error',
      message: 'Balance refresh failed — check your network connection.',
      heldOneSats: heldCount,
    })
    return null
  }
}
