import { scanLegacyAddress, importLegacyUtxos } from './legacyScan'
import { getActiveWallet, fetchBalanceSats } from './session'
import { reconcilePendingSends } from './pendingSend'
import { classifyLegacyUtxos, importOneSatOrdinals } from './oneSatImport'
import { clearCollectablesCache } from './collectables'
import { playWalletSound } from './soundService'
import { setSyncHealth } from './walletHealth'
import { resolveHistoryBackupBaseUrl } from './historyBackupPrefs'
import { toastSuccess } from './toast'
import { getDisplayCurrency } from './displayCurrency'
import { formatPrimaryFromSats } from './fx'
import { runOnChainIngestQueue } from './chainIngestQueue'

export type SyncLegacyFundsOptions = {
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

/** wallet-toolbox StorageIdb: undefined filter values must be omitted, not passed. */
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

  try {
    // Prefer all baskets (`all` tag). Older toolbox builds pass `basketId: undefined`
    // for that path, which StorageIdb rejects — fall back to default basket only.
    let result
    try {
      result = await active.wallet.reviewSpendableOutputs(true, true)
    } catch (err) {
      if (!isUndefinedPartialFilterError(err)) throw err
      console.warn(
        '[sync] all-basket spendable review unsupported; reviewing default basket only',
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
    console.warn('[sync] spendable review failed — not releasing', err)
    // Do not mark outs spent when the provider fails / returns unknown.
    return { released: 0, skipped: false, error: message }
  }
}

/**
 * Quietly reconcile this device with the **chain** (chainIngest layer):
 * 1) release outs spent elsewhere (same identity on another device)
 * 2) scan the receive address and import new funding / 1sat tips
 *
 * Prefer importing as `refreshFromChain` from `./chainIngest`.
 * Refresh ≠ BRC-39 history backup — see `./layers`.
 *
 * Concurrent callers are serialized so the same legacy UTXO cannot be swept twice.
 */
export async function syncLegacyFunds(
  opts?: SyncLegacyFundsOptions,
): Promise<number | null> {
  return runOnChainIngestQueue(() => syncLegacyFundsExclusive(opts))
}

async function syncLegacyFundsExclusive(
  opts?: SyncLegacyFundsOptions,
): Promise<number | null> {
  const announceReceive = opts?.announceReceive !== false
  const forceReview = opts?.forceReview === true
  const active = getActiveWallet()
  if (!active) return null

  // Soft / background polls must not flash the titlebar — only explicit Refresh.
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
    console.warn('[sync] pending send reconcile skipped', err)
  }

  const review = await reviewAndReleaseSpentOutputs(forceReview)
  if (review.error && forceReview) {
    setSyncHealth({
      phase: 'error',
      message: 'Couldn’t verify spent outputs — check your network connection.',
      heldOneSats: 0,
    })
  }

  let newOneSatOutpoints: string[] = []
  let heldCount = 0
  let partialWarn: string | null = null
  let importedFunding = 0

  try {
    const scan = await scanLegacyAddress(active)
    if (scan.utxos.length > 0) {
      const { funding, oneSats, heldOneSats } = await classifyLegacyUtxos(
        scan.utxos,
        active.chain,
      )
      heldCount = heldOneSats.length
      if (heldOneSats.length > 0) {
        console.info(
          `[sync] holding ${heldOneSats.length} unrecognized one-sat out(s) — not sweeping`,
        )
      }
      if (oneSats.length > 0) {
        const itemResult = await importOneSatOrdinals(oneSats, active)
        if (itemResult.failed > 0) {
          console.warn('[sync] 1sat import partial', itemResult)
          partialWarn = `Some items didn’t import (${itemResult.failed}). Retrying automatically.`
        }
        newOneSatOutpoints = (itemResult.outpoints ?? []).filter(
          (op) => !announcedOneSatOutpoints.has(op),
        )
        for (const op of itemResult.outpoints ?? []) {
          announcedOneSatOutpoints.add(op)
        }
      }
      if (funding.length > 0) {
        const result = await importLegacyUtxos(funding, active)
        importedFunding = result.imported
        if (result.failed > 0) {
          console.warn('[sync] legacy import partial', result)
          partialWarn =
            partialWarn ??
            `Some funds didn’t import (${result.failed}). Retrying automatically.`
        }
      }
    }
  } catch (err) {
    console.warn('[sync] legacy scan/import skipped', err)
    setSyncHealth({
      phase: 'error',
      message: 'Couldn’t refresh funds — check your network connection.',
      heldOneSats: heldCount,
    })
    return null
  }

  try {
    const balanceAfter = await fetchBalanceSats(active.wallet)
    if (announceReceive) {
      const balanceRose = balanceBeforeOk && balanceAfter > balanceBefore
      const newItems = newOneSatOutpoints.length > 0
      // Announce when we imported funding this tick, balance rose, or new items arrived.
      // Serialization + outpoint guards prevent the same UTXO from toasting N times.
      if (importedFunding > 0 || newItems || balanceRose) {
        maybeReceiveChime()
        const gained = balanceRose ? Math.max(0, balanceAfter - balanceBefore) : 0
        const amountLabel =
          gained > 0 ? formatPrimaryFromSats(gained, getDisplayCurrency()) : undefined
        toastSuccess(
          balanceRose || importedFunding > 0 ? 'Payment received' : 'Item received',
          amountLabel
            ? `${amountLabel}${newItems ? ` · ${newOneSatOutpoints.length} item${newOneSatOutpoints.length === 1 ? '' : 's'}` : ''}`
            : newItems
              ? `${newOneSatOutpoints.length} collectable${newOneSatOutpoints.length === 1 ? '' : 's'}`
              : undefined,
        )
      }
    }

    const heldMessage =
      heldCount > 0
        ? `${heldCount} one-sat output${heldCount === 1 ? '' : 's'} waiting on the index — not spendable as BSV.`
        : null

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
          : (reviewNote ?? heldMessage)),
      heldOneSats: heldCount,
    })
    return balanceAfter
  } catch (err) {
    console.warn('[sync] balance refresh failed', err)
    setSyncHealth({
      phase: 'error',
      message: 'Balance refresh failed — check your network connection.',
      heldOneSats: heldCount,
    })
    return null
  }
}
