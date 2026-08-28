/**
 * Legacy receive-address ingest — scan → classify → import.
 * Shared by chainIngest (Refresh) and migration (refreshLegacyAddress).
 * See `layers.ts` chainIngest pipeline steps 2–3.
 */
import { getActiveWallet, type ActiveWallet } from './session'
import {
  scanLegacyAddress,
  importLegacyUtxos,
  type LegacyScanResult,
  type LegacyUtxo,
} from './legacyScan'
import { scanAddressOrdinalTxos } from './tokenAddressScan'
import { forgetLegacyImported } from './legacyImportGuard'
import { retryableStuckSweeps } from './legacyStuckSweep'
import { recordFundingReceipts } from './legacyReceiptActivity'
import type { Chain } from './vault'
import {
  hasSettledActivityItemOutpoint,
  upsertAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import {
  classifyLegacyUtxos,
  contentUrlForOrigin,
  importOneSatOrdinals,
  type MigrationItem,
} from './oneSatImport'
import {
  filterNewOneSatOutpoints,
  forgetOneSatImported,
  isOneSatOutpointKnown,
} from './oneSatImportGuard'
import { isItemAbandoned, isItemSent } from './sentItemGuard'
import { yieldToUi } from './yieldToUi'
import { shouldYieldChainIngestToSpend } from './walletCoordinator'

export type LegacyAddressIngestResult = {
  scan: LegacyScanResult
  importedFunding: number
  importedItems: number
  fundingFailed: number
  itemsFailed: number
  fundingSkippedKnown: number
  importedFundingOutpoints: string[]
  heldOneSats: number
  /** Held tips known to be items, still awaiting an origin. */
  pendingTips: number
  /** Outpoints of those pending tips (for receive toasts before import). */
  pendingOutpoints: string[]
  newOneSatOutpoints: string[]
  /** Human-facing retry hint when partial import occurred. */
  partialWarn: string | null
}

export type LegacyAddressIngestOptions = {
  /** Cloud migrate may pass ordinal tips the indexer has not classified yet. */
  knownItems?: MigrationItem[]
  active?: ActiveWallet | null
  /**
   * Sweep funding only — no ordinal identification, no item internalization.
   * Used when Refresh yields to an in-flight spend (fundingOnly / yield path).
   */
  fundingOnly?: boolean
}

/** Activity rows for newly internalized collectables. */
function recordItemReceipts(
  importedOutpoints: string[],
  candidates: MigrationItem[],
  chain: Chain,
): void {
  if (importedOutpoints.length === 0) return
  const byOp = new Map(
    candidates.map((item) => [item.outpoint.trim().toLowerCase(), item]),
  )
  for (const raw of importedOutpoints) {
    const op = raw.trim().toLowerCase()
    if (!op || hasSettledActivityItemOutpoint(op)) continue
    const item = byOp.get(op)
    const receiveTxid = item?.txid?.trim().toLowerCase() || op.split('.')[0]
    const origin = item?.origin?.trim() || op.replace(/\.(\d+)$/, '_$1')
    const name = item?.name?.trim() || 'Collectable'
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-collectable',
      note: `Received ${name}`,
      txid: receiveTxid || undefined,
      status: 'complete',
      item: {
        name,
        origin,
        outpoint: op,
        imageUrl: contentUrlForOrigin(origin, chain),
        ...(item?.app?.trim() ? { app: item.app.trim() } : {}),
      },
    })
  }
}

/**
 * Scan the wallet legacy P2PKH receive address and internalize funding + 1sats.
 * Does not run spendable review — callers run that first when needed.
 */
function emptyIngest(scan: LegacyScanResult): LegacyAddressIngestResult {
  return {
    scan,
    importedFunding: 0,
    importedItems: 0,
    fundingFailed: 0,
    itemsFailed: 0,
    fundingSkippedKnown: 0,
    importedFundingOutpoints: [],
    heldOneSats: 0,
    pendingTips: 0,
    pendingOutpoints: [],
    newOneSatOutpoints: [],
    partialWarn: null,
  }
}


/** Normalize outpoint keys the same way import guards do. */
function outpointKey(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

/**
 * Fold ordinal-index tips into the provider scan.
 *
 * The sources answer different questions, so rows only ever get added —
 * a tip the address provider already listed keeps the provider's row, and
 * an empty index result leaves the scan untouched.
 */
export function mergeTokenTxos(
  scan: LegacyScanResult,
  tokenTxos: LegacyUtxo[],
): LegacyScanResult {
  if (tokenTxos.length === 0) return scan
  const seen = new Set(scan.utxos.map((u) => outpointKey(u.outpoint)))
  const extra = tokenTxos.filter((u) => !seen.has(outpointKey(u.outpoint)))
  if (extra.length === 0) return scan

  console.info(
    `[chain-ingest] ordinal index added ${extra.length} tip(s) the address scan could not see`,
  )
  const utxos = [...scan.utxos, ...extra]
  return { ...scan, utxos, sats: utxos.reduce((s, u) => s + u.satoshis, 0) }
}

/** One page — same bound as Collect so large inventories heal completely. */
const ONE_SAT_BASKET_PAGE = 1000

function inferBasketListedTotal(
  offset: number,
  pageLength: number,
  pageLimit: number,
  reportedTotal: number | undefined,
): number {
  const reached = offset + pageLength
  if (pageLength < pageLimit) return reached
  const reported = Number.isFinite(reportedTotal)
    ? Math.max(0, Math.trunc(reportedTotal!))
    : reached
  return Math.max(reached, reported)
}

async function listOneSatBasketOutpointKeys(active: ActiveWallet): Promise<{
  keys: Set<string>
  fullyListed: boolean
}> {
  const keys = new Set<string>()
  let offset = 0
  let total: number | null = null

  while (true) {
    const listed = await active.wallet.listOutputs({
      basket: '1sat',
      limit: ONE_SAT_BASKET_PAGE,
      offset: -(offset + 1),
      includeTags: false,
      includeCustomInstructions: false,
      seekPermission: false,
    })
    const page = listed.outputs ?? []
    for (const o of page) {
      keys.add(outpointKey(o.outpoint))
    }
    total = inferBasketListedTotal(
      offset,
      page.length,
      ONE_SAT_BASKET_PAGE,
      typeof listed.totalOutputs === 'number' ? listed.totalOutputs : undefined,
    )
    if (page.length < ONE_SAT_BASKET_PAGE) break
    offset += page.length
    if (keys.size >= total) break
  }

  return { keys, fullyListed: total == null || keys.size >= total }
}

/**
 * Live 1-sat outs on our address that still carry durable import marks but are
 * missing from the local `1sat` basket cannot be re-ingested until the marks
 * are cleared. Ghost-drop / thin IDB after restart is the usual cause — Refresh
 * then sees the tips on-chain and skips them as "already imported".
 *
 * Only forget when the basket list is complete (page covers totalOutputs) so a
 * tip on a later page is never mistaken for an orphan.
 */
async function healOrphanOneSatImportMarks(
  active: ActiveWallet,
  liveOneSats: MigrationItem[],
): Promise<number> {
  const marked = [
    ...new Set(
      liveOneSats
        .map((i) => outpointKey(i.outpoint))
        .filter(
          (op) =>
            op.length > 0 &&
            isOneSatOutpointKnown(op) &&
            // A tip the holder forgot, or one a send just spent, is absent from
            // the basket on purpose. Healing those marks would re-import it.
            !isItemAbandoned(op) &&
            !isItemSent(op),
        ),
    ),
  ]
  if (marked.length === 0) return 0

  let basketKeys = new Set<string>()
  let basketFullyListed = false
  try {
    const listed = await listOneSatBasketOutpointKeys(active)
    basketKeys = listed.keys
    basketFullyListed = listed.fullyListed
  } catch (err) {
    console.warn('[chain-ingest] orphan 1sat mark heal skipped (basket list failed)', err)
    return 0
  }
  if (!basketFullyListed) return 0

  const orphans = marked.filter((op) => !basketKeys.has(op))
  if (orphans.length === 0) return 0
  forgetOneSatImported(orphans)
  console.info(
    `[chain-ingest] forgot ${orphans.length} orphan 1sat import mark(s) — live on address, missing from basket`,
  )
  return orphans.length
}

export async function ingestLegacyAddressUtxos(
  opts: LegacyAddressIngestOptions = {},
): Promise<LegacyAddressIngestResult> {
  const active = opts.active ?? getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const fundingOnly = opts.fundingOnly === true
  // A send is queued — don't start a 7s address scan the FIFO is waiting on.
  if (!fundingOnly && shouldYieldChainIngestToSpend()) {
    return emptyIngest({
      address: active.address,
      chain: active.chain,
      sats: 0,
      utxos: [],
      source: 'services',
    })
  }

  // Inscribed outputs (1Sat NFT) are P2PKH + ord envelope — absent from the
  // plain address scan. Ordinal index covers NFT tips. Legacy BSV-21 is
  // burn-only for tips already in basket `bsv21` — do not re-scan / import more.
  const [addressScan, ordinalTxos] = await Promise.all([
    scanLegacyAddress(active),
    fundingOnly
      ? Promise.resolve<LegacyUtxo[]>([])
      : scanAddressOrdinalTxos(active.address, active.chain),
  ])

  const scan = mergeTokenTxos(addressScan, ordinalTxos)
  if (scan.utxos.length === 0) {
    return emptyIngest(scan)
  }

  if (!fundingOnly && shouldYieldChainIngestToSpend()) {
    return emptyIngest(scan)
  }

  const { funding, oneSats, bsv21, heldOneSats, heldUneconomical, pendingTips } =
    await classifyLegacyUtxos(scan.utxos, active.chain, opts.knownItems ?? [], {
      fundingOnly,
    })

  // Clear durable import marks for tips still live on our address but gone from
  // the local basket so the filter below can re-claim them on this Refresh.
  if (!fundingOnly && oneSats.length > 0) {
    await healOrphanOneSatImportMarks(active, oneSats)
  }

  const newOneSatCandidates = oneSats.filter((i) => {
    const fresh = filterNewOneSatOutpoints([i.outpoint])
    return fresh.length > 0
  })
  // Never auto-import BSV-21 into Collect. Hold on-address tips so Refresh
  // does not sweep them as funding; burn uses basket tips already held.
  if (bsv21.length > 0 && !fundingOnly) {
    console.info(
      `[chain-ingest] holding ${bsv21.length} legacy BSV-21 tip(s) — burn-only (not importing)`,
    )
  }

  // In fundingOnly mode every 1-sat is held by design, so the count says nothing.
  if (heldOneSats.length > 0 && !fundingOnly) {
    console.info(
      `[chain-ingest] holding ${heldOneSats.length} unrecognized one-sat out(s) — not sweeping` +
        (pendingTips.length > 0 ? ` (${pendingTips.length} awaiting origin)` : ''),
    )
  }
  if (heldUneconomical.length > 0) {
    console.info(
      `[chain-ingest] holding ${heldUneconomical.length} uneconomical out(s) — not a sweep path`,
    )
  }

  // An address holding only ordinals / dust classifies no funding, and that is
  // correct — only UTXOs that landed in no bucket at all are worth a warning.
  // Cloud items can name their outpoint in underscore form, so compare on a
  // normal key.
  const accounted = new Set<string>([
    ...funding.map((u) => outpointKey(u.outpoint)),
    ...oneSats.map((i) => outpointKey(i.outpoint)),
    ...bsv21.map((i) => outpointKey(i.outpoint)),
    ...heldOneSats.map((u) => outpointKey(u.outpoint)),
    ...heldUneconomical.map((u) => outpointKey(u.outpoint)),
  ])
  const unclassified = scan.utxos.filter((u) => !accounted.has(outpointKey(u.outpoint)))
  if (unclassified.length > 0) {
    console.warn(
      `[chain-ingest] ${unclassified.length} UTXO(s) matched no class (source=${scan.source})`,
      unclassified.map((u) => `${u.outpoint}:${u.satoshis}`),
    )
  }

  let importedItems = 0
  let itemsFailed = 0
  let newOneSatOutpoints: string[] = []
  let partialWarn: string | null = null

  await yieldToUi()

  // Large orphan re-ingests (hundreds of tips) can run for minutes. Chunk so
  // Collect paints after each batch instead of staying on a stale 9-item cache
  // until the entire importOneSatOrdinals call returns.
  const ONE_SAT_IMPORT_CHUNK = 48
  if (newOneSatCandidates.length > 0) {
    const totalTips = newOneSatCandidates.length
    if (totalTips > ONE_SAT_IMPORT_CHUNK) {
      console.info(
        `[chain-ingest] importing ${totalTips} 1sat tip(s) in chunks of ${ONE_SAT_IMPORT_CHUNK}`,
      )
    }
    const candidateByOp = new Map(
      oneSats.map((item) => [outpointKey(item.outpoint), item]),
    )
    for (let i = 0; i < newOneSatCandidates.length; i += ONE_SAT_IMPORT_CHUNK) {
      const chunk = newOneSatCandidates.slice(i, i + ONE_SAT_IMPORT_CHUNK)
      await yieldToUi()
      const itemResult = await importOneSatOrdinals(chunk, active)
      importedItems += itemResult.imported
      itemsFailed += itemResult.failed
      newOneSatOutpoints.push(...(itemResult.outpoints ?? []))
      recordItemReceipts(itemResult.outpoints ?? [], oneSats, active.chain)
      if (itemResult.failed > 0) {
        console.warn('[chain-ingest] 1sat import partial', itemResult)
        partialWarn =
          partialWarn ??
          `Some items didn’t import (${itemResult.failed}). Retrying automatically.`
      }
      // Paint after every chunk — do not wait on funding BEEF / remaining chunks.
      if ((itemResult.outpoints ?? []).length > 0) {
        void import('./collectables')
          .then(async ({ noteIngestedItem, listCollectables, rememberLiveOneSatOutpoints }) => {
            rememberLiveOneSatOutpoints(scan.utxos)
            for (const raw of itemResult.outpoints ?? []) {
              const op = outpointKey(raw)
              const item = candidateByOp.get(op)
              noteIngestedItem({
                outpoint: op,
                chain: active.chain,
                origin: item?.origin,
                name: item?.name,
              })
            }
            const { announceItemsReceived } = await import('./itemArrivalToast')
            announceItemsReceived(itemResult.outpoints ?? [])
            return listCollectables(active)
          })
          .catch((err) => {
            console.warn('[chain-ingest] early collectables paint failed', err)
          })
      }
    }
    if (importedItems > 0) {
      console.info(
        `[chain-ingest] imported ${importedItems} collectable tip(s) from address scan`,
      )
    }
  }

  let importedFunding = 0
  let fundingFailed = 0
  let fundingSkippedKnown = 0
  let importedFundingOutpoints: string[] = []

  if (funding.length > 0) {
    let result = await importLegacyUtxos(funding, active)
    importedFunding = result.imported
    fundingFailed = result.failed
    fundingSkippedKnown = result.skippedKnown
    importedFundingOutpoints = result.importedOutpoints
    recordFundingReceipts(result.importedReceipts)

    // Everything marked imported, yet the coins are still sitting on the address:
    // that is the stuck-sweep signature. Only reachable in that exact state, so
    // the txid checks below cost nothing on a healthy wallet.
    if (result.imported === 0 && result.skippedKnown > 0 && scan.sats > 0) {
      const retryable = await retryableStuckSweeps(funding, active.chain)
      if (retryable.length > 0) {
        forgetLegacyImported(retryable)
        console.warn(
          `[chain-ingest] ${retryable.length} legacy out(s) marked imported but ${scan.sats} sats still on address and no sweep tx on chain — retrying sweep`,
        )
        result = await importLegacyUtxos(funding, active)
        importedFunding = result.imported
        fundingFailed = result.failed
        fundingSkippedKnown = result.skippedKnown
        importedFundingOutpoints = result.importedOutpoints
        recordFundingReceipts(result.importedReceipts)
      } else {
        console.info(
          `[chain-ingest] ${result.skippedKnown} legacy out(s) already swept — waiting for the indexer instead of sweeping again`,
        )
      }
    }

    if (result.failed > 0) {
      console.warn('[chain-ingest] legacy funding import partial', result)
      partialWarn =
        partialWarn ??
        `Some funds didn’t import (${result.failed}). Retrying automatically.`
    } else if (result.imported === 0 && result.skippedKnown > 0) {
      console.info(
        `[chain-ingest] ${result.skippedKnown} funding out(s) already marked imported — balance should already include them`,
      )
    }
  }

  return {
    scan,
    importedFunding,
    importedItems,
    fundingFailed,
    itemsFailed,
    fundingSkippedKnown,
    importedFundingOutpoints,
    heldOneSats: heldOneSats.length,
    pendingTips: pendingTips.length,
    pendingOutpoints: pendingTips.map((u) => u.outpoint),
    newOneSatOutpoints,
    partialWarn,
  }
}
