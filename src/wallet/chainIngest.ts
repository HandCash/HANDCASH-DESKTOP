/**
 * Chain ingest layer — network → local toolbox state.
 *
 * Refresh / background poll belong here. This is **not** BRC-39 history replica
 * and **not** Desktop↔Mobile sync. See `layers.ts`.
 *
 * Pipeline:
 * 1. reconcile interrupted pending sends
 * 2. scan legacy receive P2PKH → classify → import (`ingestLegacyAddress.ts`)
 * 3. audit spendable outputs — report only, never write off (`auditSpendableOutputs`)
 * 4. refresh spendable balance
 *
 * Sync never marks an output unspendable. Only a spend the network rejected can
 * do that, via `releaseStaleSpendableOutputs`.
 */
import { runChainIngest, runChainIngestDuringSpend } from './walletCoordinator'
import { getActiveWallet, fetchBalanceSats } from './session'
import { reconcilePendingSends } from './pendingSend'
import { playWalletSound } from './soundService'
import { setSyncHealth } from './walletHealth'
import { resolveHistoryBackupBaseUrl } from './historyBackupPrefs'
import { toastSuccess } from './toast'
import { getDisplayCurrency } from './displayCurrency'
import { formatPrimaryFromSats } from './fx'
import { ingestLegacyAddressUtxos } from './ingestLegacyAddress'
import type { MigrationItem } from './oneSatImport'
import { isLegacyImportGraceActive } from './legacyImportGuard'
import { isUndefinedPartialFilterError } from './staleOutputRelease'

export { ingestLegacyAddressUtxos } from './ingestLegacyAddress'
export type { LegacyAddressIngestResult, LegacyAddressIngestOptions } from './ingestLegacyAddress'

export type ChainIngestOptions = {
  /**
   * When true (default), play receive SFX only if spendable balance rises
   * (or a newly seen 1sat outpoint is internalized). Pass false after a local
   * send so we don't double-chime with payment success.
   */
  announceReceive?: boolean
  /** When true, bypass the audit throttle. Background polls throttle instead. */
  forceReview?: boolean
  /**
   * Pass false to skip the spendable audit entirely.
   *
   * The audit costs one UTXO-status request per spendable output and cannot change
   * anything (it never releases), so it has no business on the critical path of a
   * send — it only reports. See `auditSpendableOutputs`.
   */
  audit?: boolean
  /** Cloud migrate may pass ordinal tips the indexer has not classified yet. */
  knownItems?: MigrationItem[]
}

/** Full result of one exclusive ingest pass — migration needs the counts. */
export type ChainIngestRunResult = {
  balanceSats: number | null
  importedFunding: number
  importedItems: number
  scannedTxids: string[]
}

export type SpendableReviewResult = {
  /**
   * Outputs the indexer would not affirm as unspent. Suspect, not condemned:
   * the audit never writes them off. See `auditSpendableOutputs`.
   */
  suspect: number
  /** True when the audit did not run (throttle, no wallet, import grace). */
  skipped: boolean
  error?: string
}

/** Serialize all chain-ingest work (Refresh, migrate refresh, spend heal). */
export async function refreshFromChain(opts?: ChainIngestOptions): Promise<number | null> {
  return runChainIngest(async () => (await refreshFromChainExclusive(opts)).balanceSats)
}

/**
 * Chain heal while a spend session holds the spend region.
 * Used by spendGuard — do not call from Dashboard Refresh.
 */
export async function refreshFromChainDuringSpend(
  opts?: ChainIngestOptions,
): Promise<number | null> {
  return runChainIngestDuringSpend(
    async () => (await refreshFromChainExclusive(opts)).balanceSats,
  )
}

/** Outpoints we've already chimed for this session — avoids re-import noise. */
const announcedOneSatOutpoints = new Set<string>()
const ANNOUNCED_MAX = 500
let lastReceiveChimeAt = 0
const RECEIVE_CHIME_COOLDOWN_MS = 12_000

function noteAnnouncedOneSat(outpoint: string): void {
  announcedOneSatOutpoints.add(outpoint)
  // Session-long receive chimes must not grow without bound across a long unlock.
  if (announcedOneSatOutpoints.size <= ANNOUNCED_MAX) return
  const drop = announcedOneSatOutpoints.size - ANNOUNCED_MAX
  let i = 0
  for (const key of announcedOneSatOutpoints) {
    if (i++ >= drop) break
    announcedOneSatOutpoints.delete(key)
  }
}

/** Background sync should not hammer UTXO status providers. */
const REVIEW_THROTTLE_MS = 2 * 60_000
/** Faster reviews when multi-device BRC-39 parity URL is configured. */
const REVIEW_THROTTLE_PARITY_MS = 45_000
let lastSpendableReviewAt = 0
/** Cleared for the session once storage rejects an all-basket review. */
let allBasketReviewSupported = true

function reviewThrottleMs(): number {
  return resolveHistoryBackupBaseUrl() ? REVIEW_THROTTLE_PARITY_MS : REVIEW_THROTTLE_MS
}

function maybeReceiveChime(): void {
  const now = Date.now()
  if (now - lastReceiveChimeAt < RECEIVE_CHIME_COOLDOWN_MS) return
  lastReceiveChimeAt = now
  playWalletSound('receive')
}

/**
 * Report outputs the indexer will not affirm as unspent — without writing any off.
 *
 * `reviewSpendableOutputs(all, release)` is never called here with `release`, and
 * that is deliberate. The toolbox decides an output is dead via
 * `services.isUtxo`, which is `or.isUtxo === true`: an indexer that has not seen
 * our unconfirmed change, or a UTXO service that simply errored, both answer
 * `false`, and `release` then sets `spendable: false` for good. Silence is not
 * evidence of a spend, and the two costs are not symmetric — a stale spendable
 * output costs one failed send, which is visible and recoverable, while a wrong
 * release destroys live coins permanently.
 *
 * Genuinely spent outputs (e.g. spent on another device sharing this identity)
 * are cleared by `releaseStaleSpendableOutputs`, on evidence, instead.
 */
export async function auditSpendableOutputs(force = false): Promise<SpendableReviewResult> {
  const active = getActiveWallet()
  if (!active) return { suspect: 0, skipped: true }

  const now = Date.now()
  if (!force && now - lastSpendableReviewAt < reviewThrottleMs()) {
    return { suspect: 0, skipped: true }
  }

  // A fresh sweep guarantees the indexer is behind, so the answers would be
  // noise. Nothing is written off either way; this just saves the round trips.
  if (!force && isLegacyImportGraceActive()) {
    return { suspect: 0, skipped: true }
  }

  try {
    let result
    if (allBasketReviewSupported) {
      try {
        result = await active.wallet.reviewSpendableOutputs(true, false)
      } catch (err) {
        if (!isUndefinedPartialFilterError(err)) throw err
        // This storage build cannot filter on an undefined basket. Remember it,
        // so every later sync goes straight to the default basket.
        allBasketReviewSupported = false
        console.info(
          '[chain-ingest] all-basket spendable review unsupported here; auditing default basket only',
        )
      }
    }
    if (!result) result = await active.wallet.reviewSpendableOutputs(false, false)
    lastSpendableReviewAt = Date.now()
    const suspect = result.outputs?.length ?? 0
    if (suspect > 0) {
      console.info(
        `[chain-ingest] ${suspect} output(s) unconfirmed by the indexer — keeping them spendable`,
      )
    }
    return { suspect, skipped: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[chain-ingest] spendable audit failed', err)
    return { suspect: 0, skipped: false, error: message }
  }
}


const emptyRun = (): ChainIngestRunResult => ({
  balanceSats: null,
  importedFunding: 0,
  importedItems: 0,
  scannedTxids: [],
})

/**
 * Exclusive chain-ingest body. Callers that already hold the ingest lock
 * (recompose, migration via runChainIngest) use this directly.
 */
export async function refreshFromChainExclusive(
  opts?: ChainIngestOptions,
): Promise<ChainIngestRunResult> {
  const announceReceive = opts?.announceReceive !== false
  const forceReview = opts?.forceReview === true
  const active = getActiveWallet()
  if (!active) return emptyRun()

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
  let importedItems = 0
  let scannedTxids: string[] = []
  let newOneSatOutpoints: string[] = []

  try {
    const ingest = await ingestLegacyAddressUtxos({
      active,
      knownItems: opts?.knownItems,
    })
    heldCount = ingest.heldOneSats
    partialWarn = ingest.partialWarn
    importedFunding = ingest.importedFunding
    importedItems = ingest.importedItems
    scannedTxids = [
      ...new Set(ingest.scan.utxos.map((u) => u.txid).filter((t): t is string => !!t)),
    ]
    newOneSatOutpoints = ingest.newOneSatOutpoints.filter(
      (op) => !announcedOneSatOutpoints.has(op),
    )
    for (const op of ingest.newOneSatOutpoints) {
      noteAnnouncedOneSat(op)
    }
  } catch (err) {
    console.warn('[chain-ingest] legacy address ingest skipped', err)
    setSyncHealth({
      phase: 'error',
      message: 'Couldn’t refresh funds — check your network connection.',
      heldOneSats: heldCount,
    })
    return emptyRun()
  }

  // A sweep in this same pass means the indexer has definitely not caught up,
  // so its answers are noise — skip the round trips rather than log them.
  const review =
    opts?.audit === false
      ? { suspect: 0, skipped: true }
      : await auditSpendableOutputs(forceReview && importedFunding === 0)
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
      review.suspect > 0
        ? `${review.suspect} output${review.suspect === 1 ? '' : 's'} still awaiting the indexer.`
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
    return {
      balanceSats: balanceAfter,
      importedFunding,
      importedItems,
      scannedTxids,
    }
  } catch (err) {
    console.warn('[chain-ingest] balance refresh failed', err)
    setSyncHealth({
      phase: 'error',
      message: 'Balance refresh failed — check your network connection.',
      heldOneSats: heldCount,
    })
    return {
      balanceSats: null,
      importedFunding,
      importedItems,
      scannedTxids,
    }
  }
}
