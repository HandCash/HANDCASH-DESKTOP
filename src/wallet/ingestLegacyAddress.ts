/**
 * Legacy receive-address ingest — scan → classify → import.
 * Shared by chainIngest (Refresh) and migration (refreshLegacyAddress).
 * See `layers.ts` chainIngest pipeline steps 2–3.
 */
import { getActiveWallet, type ActiveWallet } from './session'
import {
  scanLegacyAddress,
  importLegacyUtxos,
  txExistsOnChain,
  type LegacyFundingReceipt,
  type LegacyScanResult,
} from './legacyScan'
import {
  forgetLegacyImported,
  legacySweepRecord,
  legacySweepRetryEligible,
} from './legacyImportGuard'
import type { Chain } from './vault'
import {
  hasActivityItemOutpoint,
  hasActivityTxid,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import {
  classifyLegacyUtxos,
  contentUrlForOrigin,
  importOneSatLatches,
  importOneSatOrdinals,
  type MigrationItem,
} from './oneSatImport'
import { filterNewOneSatOutpoints, isOneSatOutpointKnown } from './oneSatImportGuard'
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
  /** Held tips a co-created latch proves are items, still awaiting an origin. */
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
   * Used by the pre-send heal, which needs a trustworthy spendable balance and
   * nothing else.
   */
  fundingOnly?: boolean
}

/**
 * Sweeps safe to try again: old enough to be genuinely stuck, and with their
 * recorded transaction provably absent from the chain.
 *
 * The sweep runs through the toolbox in delayed mode, so a reported success only
 * means the transaction was accepted locally. If it never reached a miner, the
 * deposit sits unspent behind a permanent mark and no other code path can free
 * it — that is a received payment the wallet will never credit.
 *
 * An address scan still listing the input as unspent proves nothing on its own;
 * providers lag our own broadcast by minutes, and re-sweeping on that alone
 * double-spends the first sweep. So the recorded txid must be provably missing.
 * When the provider will not answer, the mark stands.
 */
async function retryableStuckSweeps(
  utxos: Array<{ outpoint: string }>,
  chain: Chain,
): Promise<string[]> {
  const retryable: string[] = []
  for (const u of utxos) {
    const op = u.outpoint.trim().toLowerCase()
    if (!op || !legacySweepRetryEligible(op)) continue
    const txid = legacySweepRecord(op)?.txid
    // No recorded sweep txid means no evidence either way. The original version
    // of this heal treated that as retryable, and re-sweeping on a hunch is what
    // booked one deposit three times. Absent proof, the mark stands.
    if (!txid) continue
    if ((await txExistsOnChain(txid, chain)) !== false) continue
    retryable.push(op)
  }
  return retryable
}

/** Activity rows for newly swept funding — one per incoming payment txid. */
function recordFundingReceipts(receipts: LegacyFundingReceipt[]): void {
  const byTx = new Map<string, number>()
  for (const receipt of receipts) {
    const txid = receipt.receiveTxid.trim().toLowerCase()
    if (!txid || !(receipt.satoshis > 0)) continue
    byTx.set(txid, (byTx.get(txid) ?? 0) + receipt.satoshis)
  }
  for (const [txid, sats] of byTx) {
    if (hasActivityTxid(txid, 'earned')) continue
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats,
      method: 'receive',
      note: 'Received',
      txid,
    })
  }
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
    if (!op || hasActivityItemOutpoint(op)) continue
    const item = byOp.get(op)
    const receiveTxid = item?.txid?.trim().toLowerCase() || op.split('.')[0]
    const origin = item?.origin?.trim() || op.replace(/\.(\d+)$/, '_$1')
    const name = item?.name?.trim() || 'Collectable'
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-collectable',
      note: `Received ${name}`,
      txid: receiveTxid || undefined,
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

  const scan = await scanLegacyAddress(active)
  if (scan.utxos.length === 0) {
    return emptyIngest(scan)
  }

  if (!fundingOnly && shouldYieldChainIngestToSpend()) {
    return emptyIngest(scan)
  }

  const { funding, oneSats, latches, heldOneSats, pendingTips } = await classifyLegacyUtxos(
    scan.utxos,
    active.chain,
    opts.knownItems ?? [],
    { fundingOnly },
  )

  // Latch dust stays on the address after basket insertion, so every poll still
  // classifies it. Skip anything already imported / backing off before we log or
  // touch BEEF — that retry loop was freezing the UI on every Dashboard tick.
  const newLatches = latches.filter((l) => !isOneSatOutpointKnown(l.outpoint))
  const newOneSatCandidates = oneSats.filter((i) => {
    const fresh = filterNewOneSatOutpoints([i.outpoint])
    return fresh.length > 0
  })

  // In fundingOnly mode every 1-sat is held by design, so the count says nothing.
  if (heldOneSats.length > 0 && !fundingOnly) {
    console.info(
      `[chain-ingest] holding ${heldOneSats.length} unrecognized one-sat out(s) — not sweeping` +
        (pendingTips.length > 0 ? ` (${pendingTips.length} latch-proven, awaiting origin)` : ''),
    )
  }
  if (newLatches.length > 0) {
    console.info(
      `[chain-ingest] routing ${newLatches.length} soft-latch dust out(s) to basket 1sat-latch`,
    )
  }

  // An address holding only ordinals classifies no funding, and that is correct —
  // only UTXOs that landed in no bucket at all are worth a warning. Cloud items
  // can name their outpoint in underscore form, so compare on a normal key.
  const outpointKey = (outpoint: string): string =>
    outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  const accounted = new Set<string>([
    ...funding.map((u) => outpointKey(u.outpoint)),
    ...oneSats.map((i) => outpointKey(i.outpoint)),
    ...latches.map((u) => outpointKey(u.outpoint)),
    ...heldOneSats.map((u) => outpointKey(u.outpoint)),
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

  if (newOneSatCandidates.length > 0) {
    const itemResult = await importOneSatOrdinals(newOneSatCandidates, active)
    importedItems = itemResult.imported
    itemsFailed = itemResult.failed
    newOneSatOutpoints = itemResult.outpoints ?? []
    recordItemReceipts(newOneSatOutpoints, oneSats, active.chain)
    if (itemResult.failed > 0) {
      console.warn('[chain-ingest] 1sat import partial', itemResult)
      partialWarn = `Some items didn’t import (${itemResult.failed}). Retrying automatically.`
    }
  }

  // Latch dust is never spendable, so its BEEF work has no place in a send.
  if (newLatches.length > 0 && !fundingOnly) {
    const tipOrigins = new Map<string, string>()
    for (const tip of oneSats) {
      if (tip.txid && tip.origin) tipOrigins.set(tip.txid.toLowerCase(), tip.origin)
    }
    await yieldToUi()
    const latchResult = await importOneSatLatches(newLatches, tipOrigins, active)
    if (latchResult.failed > 0) {
      console.warn('[chain-ingest] latch import partial', latchResult)
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
