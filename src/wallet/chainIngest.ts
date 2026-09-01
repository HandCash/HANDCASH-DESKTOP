/**
 * Chain ingest layer — network → local toolbox state.
 *
 * Refresh / background poll belong here. This is **not** BRC-39 history replica
 * and **not** Desktop↔Mobile sync. See `layers.ts`.
 *
 * Pipeline:
 * 1. reconcile interrupted pending sends + abort reserved batches
 * 1b. yield to a waiting spend before maintenance / ordinal work
 * 1c. parallel dual-layer / ghost-heal / activity prune / spendable restore
 * 2. scan legacy receive P2PKH → classify → import (`ingestLegacyAddress.ts`)
 * 3. audit spendable outputs — report only, never write off (`auditSpendableOutputs`)
 * 4. refresh spendable balance
 *
 * Sync never marks an output unspendable. Only a spend the network rejected can
 * do that, via `releaseStaleSpendableOutputs`.
 */
import { runChainIngest, runChainIngestDuringSpend, shouldYieldChainIngestToSpend } from './walletCoordinator'
import { getActiveWallet, fetchBalanceSats } from './session'
import { publishDisplayBalanceRefresh } from './displayBalanceRefresh'
import { reconcilePendingSends } from './pendingSend'
import { playWalletSound } from './soundService'
import { setSyncHealth } from './walletHealth'
import {
  finishWalletProgress,
  startWalletProgress,
  updateWalletProgress,
} from './walletProgress'
import { resolveHistoryBackupBaseUrl } from './historyBackupPrefs'
import { toastSuccess } from './toast'
import { getDisplayCurrency } from './displayCurrency'
import { formatPrimaryFromSats } from './fx'
import { ingestLegacyAddressUtxos, ChainIngestYieldToSpendError } from './ingestLegacyAddress'
import { type MigrationItem } from './oneSatImport'
import { isLegacyImportGraceActive } from './legacyImportGuard'
import { isUndefinedPartialFilterError } from './staleOutputRelease'
import { yieldToUi } from './yieldToUi'
import type { Chain } from './vault'

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
  /**
   * Sweep funding and skip all ordinal work. Used when a spend is waiting so
   * Refresh yields ordinal naming; pays themselves do not call chain ingest.
   */
  fundingOnly?: boolean
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

/** Serialize all chain-ingest work (Refresh, migrate refresh, nested yield). */
export async function refreshFromChain(opts?: ChainIngestOptions): Promise<number | null> {
  const balanceSats = await runChainIngest(
    async () => (await refreshFromChainExclusive(opts)).balanceSats,
  )
  // Off the ingest lock (consolidation acquires the exclusive spend region, which
  // is exclusive with chain ingest). Fire-and-forget and fully gated — it only
  // fires when the change pool is genuinely fragmented and no spend is waiting.
  // Never on a funding-only yield pass; that pass exists precisely to free the
  // FIFO for a send.
  if (opts?.fundingOnly !== true) {
    void import('./consolidateChange')
      .then(({ maybeConsolidateChange }) => maybeConsolidateChange())
      .catch((err) => {
        console.warn('[chain-ingest] change consolidation skipped', err)
      })
  }
  return balanceSats
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

let lastReceiveChimeAt = 0
const RECEIVE_CHIME_COOLDOWN_MS = 12_000

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
  if (shouldYieldChainIngestToSpend()) return { suspect: 0, skipped: true }
  if (typeof document !== 'undefined' && document.hidden) {
    return { suspect: 0, skipped: true }
  }

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
    // Report-only. WhatsOnChain /unspent/all 429s Refresh, so stay off the wire.
    const REVIEW_SPENDABLE_ON_INGEST = false
    if (!REVIEW_SPENDABLE_ON_INGEST) {
      console.info('[chain-ingest] skipped spendable indexer review (WOC 429)')
      lastSpendableReviewAt = Date.now()
      return { suspect: 0, skipped: true }
    }

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

/** Repair passes scan local actions/outputs and are not receipt polling. */
const CHAIN_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000
let lastMaintenanceKey = ''
let lastMaintenanceAt = 0

function maintenanceDue(
  active: NonNullable<ReturnType<typeof getActiveWallet>>,
  force: boolean,
): boolean {
  const key = `${active.chain}:${active.identityKey}`
  const now = Date.now()
  if (
    !force &&
    key === lastMaintenanceKey &&
    now - lastMaintenanceAt < CHAIN_MAINTENANCE_INTERVAL_MS
  ) {
    return false
  }
  // Claim the interval before async work so overlapping callers cannot start a
  // second full IDB repair pass.
  lastMaintenanceKey = key
  lastMaintenanceAt = now
  return true
}

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

  // A send is waiting on the coordinator — skip ordinal naming / inventory work
  // so the FIFO frees and the spend can begin.
  const yieldToSpend = shouldYieldChainIngestToSpend()
  const fundingOnly = opts?.fundingOnly === true || yieldToSpend
  if (yieldToSpend && opts?.fundingOnly !== true) {
    console.info('[chain-ingest] yielding ordinal work — send is waiting')
  }

  // One short pill state for the whole pass — phased "Syncing payments / items"
  // labels overflowed the status bubble.
  const syncMessage = fundingOnly
    ? 'Looking for new payments on your address'
    : 'Refreshing funds against the network'
  setSyncHealth({
    phase: 'syncing',
    message: syncMessage,
  })
  void import('./dependencyHealth')
    .then(({ refreshDependencyHealth }) => refreshDependencyHealth())
    .catch(() => {})
  startWalletProgress({
    kind: 'refresh',
    phase: fundingOnly ? 'funding' : 'scanning',
    message: syncMessage,
  })
  let progressTerminal: 'done' | 'failed' = 'done'

  try {
  let balanceBefore = 0
  let balanceBeforeOk = false
  if (opts?.announceReceive !== false) {
    try {
      balanceBefore = await fetchBalanceSats(active.wallet)
      balanceBeforeOk = true
    } catch {
      balanceBefore = 0
    }
  }

  try {
    reconcilePendingSends()
  } catch (err) {
    console.warn('[chain-ingest] pending send reconcile skipped', err)
  }

  // Failed item creates leave tips spent inside noSend. Free them before ingest.
  if (forceReview) {
    try {
      const { releaseStuckNosends, abortReservedActionBatches } =
        await import('./actionReview')
      await releaseStuckNosends(active)
      await abortReservedActionBatches(active)
      console.info('[chain-ingest] released stuck noSend / action batches before ingest')
    } catch (err) {
      console.warn('[chain-ingest] early nosend release skipped', err)
    }
  }

  // Pay first: dual-layer / restore / ordinal work must not hold the spend region.
  if (shouldYieldChainIngestToSpend()) {
    return finishEarlyForSpend(active, {
      heldCount: 0,
      pendingTips: 0,
      importedFunding: 0,
      importedItems: 0,
      scannedTxids: [],
    })
  }

  if (maintenanceDue(active, forceReview)) {
    try {
      // Free abandoned noSend batches as part of repair, not every receipt poll.
      const { abortReservedActionBatches } = await import('./actionReview')
      await abortReservedActionBatches(active)
    } catch (err) {
      console.warn('[chain-ingest] action-batch abort skipped', err)
    }

    // Independent maintenance — run together so wall-clock ≈ slowest step, not sum.
    // Explicit Refresh always runs it; background receipt polling is throttled.
    await runChainMaintenance(active.chain)
  }

  if (shouldYieldChainIngestToSpend()) {
    return finishEarlyForSpend(active, {
      heldCount: 0,
      pendingTips: 0,
      importedFunding: 0,
      importedItems: 0,
      scannedTxids: [],
    })
  }

  await yieldToUi()

  let heldCount = 0
  let pendingTips = 0
  let partialWarn: string | null = null
  let importedFunding = 0
  let importedItems = 0
  let scannedTxids: string[] = []
  let addressUnspentAfterIngest = 0
  let fundingSkippedKnownAfterIngest = 0

  /** Soft UI cap — clear Syncing while beef / SPV providers still finish under the ingest lock. */
  const LEGACY_INGEST_SOFT_MS = 35_000

  try {
    if (!fundingOnly) {
      const { setCollectableVerifyWalkDeferred } = await import('./collectables')
      setCollectableVerifyWalkDeferred(true)
    }
    const ingestPromise = ingestLegacyAddressUtxos({
      active,
      knownItems: opts?.knownItems,
      fundingOnly,
    })
    let softDeadlineHit = false
    const softTimer = setTimeout(() => {
      softDeadlineHit = true
      console.warn(
        `[chain-ingest] legacy ingest soft deadline (${LEGACY_INGEST_SOFT_MS}ms) — clearing Syncing pill`,
      )
      void import('./appLog')
        .then(({ appendAppLog }) => {
          appendAppLog(
            'warn',
            `[chain-ingest] legacy ingest soft deadline (${LEGACY_INGEST_SOFT_MS}ms)`,
          )
        })
        .catch(() => {})
      // Soft deadline is a UI comfort: clear the Syncing *pill phase* while
      // beef / SPV still finish under the lock. Progress bus stays running so
      // Activity / Catching-up chrome do not claim idle Synced.
      updateWalletProgress({
        phase: 'catching-up',
        message: 'Still importing collectables…',
      })
      setSyncHealth({
        phase: 'ok',
        message: 'Still importing collectables in the background…',
        heldOneSats: heldCount,
        pendingTips,
      })
    }, LEGACY_INGEST_SOFT_MS)

    let ingest: Awaited<ReturnType<typeof ingestLegacyAddressUtxos>>
    try {
      ingest = await ingestPromise
    } catch (err) {
      if (err instanceof ChainIngestYieldToSpendError) {
        console.info('[chain-ingest] legacy ingest aborted — send waiting')
        return finishEarlyForSpend(active, {
          heldCount,
          pendingTips,
          importedFunding,
          importedItems,
          scannedTxids,
        })
      }
      throw err
    } finally {
      clearTimeout(softTimer)
    }
    if (softDeadlineHit) {
      // Pill already cleared; still apply inventory side-effects below.
      console.info('[chain-ingest] legacy ingest finished after soft deadline')
    }
    heldCount = ingest.heldOneSats
    pendingTips = ingest.pendingTips
    partialWarn = ingest.partialWarn
    importedFunding = ingest.importedFunding
    importedItems = ingest.importedItems
    addressUnspentAfterIngest = ingest.scan.sats
    fundingSkippedKnownAfterIngest = ingest.fundingSkippedKnown
    // The txid inventory is only consumed by the explicit migration contract.
    // Building another 800k-entry Set on every background refresh doubled the
    // largest allocation in the ingest path for no product benefit.
    if (opts?.knownItems != null) {
      scannedTxids = [
        ...new Set(ingest.scan.utxos.map((u) => u.txid).filter((t): t is string => !!t)),
      ]
    }
    if (shouldYieldChainIngestToSpend()) {
      return finishEarlyForSpend(active, {
        heldCount,
        pendingTips,
        importedFunding,
        importedItems,
        scannedTxids,
      })
    }
    // Inventory is address UTXOs ∩ basket tips — feed the scan and refresh so a
    // spent tip cannot linger and a just-imported tip does not wait on the panel.
    // Do not await on the coordinator critical path — sends must not wait on
    // listOutputs(1sat) (up to 20s). Paint/toast continues in the background.
    if (!fundingOnly) {
      try {
        const {
          invalidateLiveOneSatOutpoints,
          listCollectables,
          rememberLiveOneSatOutpoints,
        } = await import('./collectables')
        // A second pair of full-size outpoint Sets is useful for small wallets
        // but wasteful at ordinal scale. Large baskets trust Toolbox's
        // spendable state between scheduled review passes.
        if (ingest.scan.utxos.length <= 10_000) {
          rememberLiveOneSatOutpoints(ingest.scan.utxos)
        } else {
          invalidateLiveOneSatOutpoints()
        }
        // Defer BRC-150 verify walk while fungibles heal + collectables list run.
        void import('./collectables')
          .then(({ setCollectableVerifyWalkDeferred }) => {
            setCollectableVerifyWalkDeferred(true)
          })
          .then(() =>
            import('./fungibles').then(({ listFungibles }) => listFungibles(active)),
          )
          .then(() =>
            import('./healMisfiledCollectables').then(({ healMisfiledCollectables }) =>
              healMisfiledCollectables(active),
            ),
          )
          .then(() => listCollectables(active))
          .finally(() => {
            void import('./collectables').then(
              ({ setCollectableVerifyWalkDeferred, resumeCollectableVerifyWalk }) => {
                setCollectableVerifyWalkDeferred(false)
                resumeCollectableVerifyWalk()
              },
            )
          })
          .catch((err) => {
            console.warn('[chain-ingest] collectables refresh failed', err)
          })
      } catch (err) {
        console.warn('[chain-ingest] collectables refresh skipped', err)
      }
    }
  } catch (err) {
    console.warn('[chain-ingest] legacy address ingest skipped', err)
    progressTerminal = 'failed'
    setSyncHealth({
      phase: 'error',
      message: 'Couldn’t refresh funds — check your network connection.',
      heldOneSats: heldCount,
      pendingTips,
    })
    return emptyRun()
  }

  if (shouldYieldChainIngestToSpend()) {
    return finishEarlyForSpend(active, {
      heldCount,
      pendingTips,
      importedFunding,
      importedItems,
      scannedTxids,
    })
  }

  await yieldToUi()

  // A sweep in this same pass means the indexer has definitely not caught up,
  // so its answers are noise — skip the round trips rather than log them.
  // Background polls pass audit:false — the audit is report-only and was racing
  // user taps after unlock. Also skip when a send is waiting.
  const review =
    opts?.audit === false || shouldYieldChainIngestToSpend()
      ? { suspect: 0, skipped: true }
      : await auditSpendableOutputs(forceReview && importedFunding === 0)
  if (review.error && forceReview) {
    setSyncHealth({
      phase: 'error',
      message: 'Couldn’t verify spent outputs — check your network connection.',
      heldOneSats: heldCount,
      pendingTips,
    })
  }

  try {
    const balanceAfter = await fetchBalanceSats(active.wallet)
    publishDisplayBalanceRefresh(balanceAfter)
    if (addressUnspentAfterIngest > 0 && fundingSkippedKnownAfterIngest > 0) {
      console.warn(
        `[chain-ingest] ${addressUnspentAfterIngest.toLocaleString()} sats still on legacy address ` +
          `(${fundingSkippedKnownAfterIngest} marked imported, toolbox ${balanceAfter.toLocaleString()}) — ` +
          'sweep may be stuck; Refresh will retry',
      )
    }
    if (announceReceive) {
      const balanceRose = balanceBeforeOk && balanceAfter > balanceBefore
      const gained = Math.max(0, balanceAfter - balanceBefore)
      // Only toast when this Refresh pass actually swept new funding from the
      // legacy address. A balance rise from reclaiming sealed inputs, restoring
      // pending change, or healing a thin Toolbox is recovery — not a payment
      // that just arrived.
      if (balanceRose && importedFunding > 0) {
        maybeReceiveChime()
        const amountLabel =
          gained > 0 ? formatPrimaryFromSats(gained, getDisplayCurrency()) : undefined
        toastSuccess('Payment received', amountLabel)
        document.dispatchEvent(
          new CustomEvent('handcash:receive', {
            detail: {
              title: 'Payment received',
              body: amountLabel ?? 'Your wallet has been updated',
            },
          }),
        )
      } else if (importedFunding > 0 && !balanceRose) {
        console.info(
          `[chain-ingest] imported ${importedFunding} legacy out(s) but balance unchanged — awaiting indexer`,
        )
      } else if (balanceRose && importedFunding === 0) {
        console.info(
          `[chain-ingest] balance rose ${balanceBefore.toLocaleString()}→${balanceAfter.toLocaleString()} without a new legacy sweep — not announcing receive`,
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
      pendingTips,
    })
    return {
      balanceSats: balanceAfter,
      importedFunding,
      importedItems,
      scannedTxids,
    }
  } catch (err) {
    console.warn('[chain-ingest] balance refresh failed', err)
    progressTerminal = 'failed'
    setSyncHealth({
      phase: 'error',
      message: 'Balance refresh failed — check your network connection.',
      heldOneSats: heldCount,
      pendingTips,
    })
    return {
      balanceSats: null,
      importedFunding,
      importedItems,
      scannedTxids,
    }
  }
  } finally {
    const snapMessage =
      progressTerminal === 'failed'
        ? 'Refresh failed'
        : 'Refresh complete'
    finishWalletProgress(progressTerminal, {
      phase: progressTerminal === 'failed' ? 'error' : 'complete',
      message: snapMessage,
    })
  }
}

async function finishEarlyForSpend(
  active: NonNullable<ReturnType<typeof getActiveWallet>>,
  partial: {
    heldCount: number
    pendingTips: number
    importedFunding: number
    importedItems: number
    scannedTxids: string[]
  },
): Promise<ChainIngestRunResult> {
  console.info('[chain-ingest] yielding to send')
  let balanceSats: number | null = null
  try {
    balanceSats = await fetchBalanceSats(active.wallet)
    if (balanceSats != null) publishDisplayBalanceRefresh(balanceSats)
  } catch {
    balanceSats = null
  }
  setSyncHealth({
    phase: 'ok',
    message: null,
    heldOneSats: partial.heldCount,
    pendingTips: partial.pendingTips,
  })
  return {
    balanceSats,
    importedFunding: partial.importedFunding,
    importedItems: partial.importedItems,
    scannedTxids: partial.scannedTxids,
  }
}

/**
 * Pre-scan maintenance that does not depend on each other — parallelized so
 * Refresh wall-clock is max(step) instead of sum(step). Failures stay isolated.
 */
async function runChainMaintenance(chain: Chain): Promise<void> {
  const [
    { reconcileDualLayerState },
    { healGhostSentItems },
    { pruneMissingOnChainActivity, expireStaleInboundPending },
    { rehideInputsOfLiveLocalTxs, restoreLiveSpendableOutputs, reclaimSealedInputsNeverSpent },
    { txExistsOnChain },
    { forgetOneSatImported },
  ] = await Promise.all([
    import('./txReconcile'),
    import('./sentItemGuard'),
    import('./appActivity'),
    import('./staleOutputRelease'),
    import('./legacyScan'),
    import('./oneSatImportGuard'),
  ])

  const results = await Promise.allSettled([
    (async () => {
      const dual = await reconcileDualLayerState()
      if (dual.checked > 0 || dual.mined > 0 || dual.failed > 0 || dual.orphaned > 0) {
        console.info('[chain-ingest] dual-layer reconcile', dual)
      }
    })(),
    (async () => {
      const healed = await healGhostSentItems(chain, txExistsOnChain)
      if (healed.length > 0) {
        forgetOneSatImported(healed)
        console.info(
          `[chain-ingest] restored ${healed.length} tip(s) whose send never landed on-chain`,
          healed,
        )
      }
    })(),
    (async () => {
      const expired = expireStaleInboundPending()
      if (expired > 0) {
        console.info(`[chain-ingest] expired ${expired} stale Verifying… row(s)`)
      }
      const pruned = await pruneMissingOnChainActivity(chain, txExistsOnChain)
      if (pruned > 0) {
        console.info(`[chain-ingest] pruned ${pruned} Activity row(s) missing on-chain`)
      }
    })(),
    (async () => {
      try {
        const { releaseStuckNosends } = await import('./actionReview')
        await releaseStuckNosends()
      } catch (err) {
        console.warn('[chain-ingest] release stuck nosends skipped', err)
      }
      // BRC-39 merges and device sync can leave change rows with satoshis but no
      // locking script. restoreLiveSpendableOutputs skips those rows entirely, so
      // spendable stays 0 while pendingChange credits them — funds look present but
      // Pay cannot select them. Rebuild scripts from local raw tx first, then from
      // chain (budgeted per pass) before the spendable restore loop.
      try {
        const { sweepChangeScripts } = await import('./changeScriptFate')
        const { shouldYieldChainIngestToSpend } = await import('./walletCoordinator')
        let scriptsHealed = 0
        for (let pass = 0; pass < 4; pass += 1) {
          if (shouldYieldChainIngestToSpend()) break
          const sweep = await sweepChangeScripts({ fromChain: true })
          scriptsHealed += sweep.healed
          if (sweep.healed === 0) break
        }
        if (scriptsHealed > 0) {
          console.info(
            `[chain-ingest] rebuilt ${scriptsHealed} change locking script(s) before spendable restore`,
          )
        }
      } catch (err) {
        console.warn('[chain-ingest] change script sweep skipped', err)
      }
      await rehideInputsOfLiveLocalTxs()
      let restored = 0
      for (let pass = 0; pass < 5; pass += 1) {
        const batch = await restoreLiveSpendableOutputs()
        if (batch === 0) break
        restored += batch
      }
      if (restored > 0) {
        console.info(
          `[chain-ingest] restored ${restored} change output(s) previously marked unspendable`,
        )
      }
      // Coins a send sealed for a transaction that never reached a node. Runs
      // after the rehide pass so anything genuinely in flight is sealed first.
      for (let pass = 0; pass < 3; pass += 1) {
        const reclaimed = await reclaimSealedInputsNeverSpent()
        if (reclaimed === 0) break
      }
    })(),
  ])

  const labels = [
    'dual-layer reconcile',
    'ghost-sent heal',
    'activity ghost prune',
    'spendable restore',
  ]
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r?.status === 'rejected') {
      console.warn(`[chain-ingest] ${labels[i]} skipped`, r.reason)
    }
  }
}
