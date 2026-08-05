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

export type LegacyAddressIngestResult = {
  scan: LegacyScanResult
  importedFunding: number
  importedItems: number
  fundingFailed: number
  itemsFailed: number
  fundingSkippedKnown: number
  importedFundingOutpoints: string[]
  heldOneSats: number
  newOneSatOutpoints: string[]
  /** Human-facing retry hint when partial import occurred. */
  partialWarn: string | null
}

export type LegacyAddressIngestOptions = {
  /** Cloud migrate may pass ordinal tips the indexer has not classified yet. */
  knownItems?: MigrationItem[]
  active?: ActiveWallet | null
}

/**
 * Sweeps that are safe to try again: old enough to be genuinely stuck, and with
 * their recorded transaction provably absent from the chain.
 *
 * An address scan still listing the input as unspent proves nothing — providers
 * lag our own broadcast by minutes. Re-sweeping on that alone double-spends the
 * first sweep, so the wallet books a second deposit whose change can never be
 * spent. When the provider will not answer, we leave the mark in place.
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
    if (txid && (await txExistsOnChain(txid, chain)) !== false) continue
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
    if (hasActivityTxid(txid)) continue
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
export async function ingestLegacyAddressUtxos(
  opts: LegacyAddressIngestOptions = {},
): Promise<LegacyAddressIngestResult> {
  const active = opts.active ?? getActiveWallet()
  if (!active) throw new Error('Wallet locked')

  const scan = await scanLegacyAddress(active)
  if (scan.utxos.length === 0) {
    return {
      scan,
      importedFunding: 0,
      importedItems: 0,
      fundingFailed: 0,
      itemsFailed: 0,
      fundingSkippedKnown: 0,
      importedFundingOutpoints: [],
      heldOneSats: 0,
      newOneSatOutpoints: [],
      partialWarn: null,
    }
  }

  const { funding, oneSats, latches, heldOneSats } = await classifyLegacyUtxos(
    scan.utxos,
    active.chain,
    opts.knownItems ?? [],
  )

  if (heldOneSats.length > 0) {
    console.info(
      `[chain-ingest] holding ${heldOneSats.length} unrecognized one-sat out(s) — not sweeping`,
    )
  }
  if (latches.length > 0) {
    console.info(
      `[chain-ingest] routing ${latches.length} soft-latch dust out(s) to basket 1sat-latch`,
    )
  }

  if (funding.length === 0 && scan.sats > 0) {
    console.warn(
      `[chain-ingest] address has ${scan.sats} sats across ${scan.utxos.length} UTXO(s) but no funding classified (source=${scan.source})`,
      scan.utxos.map((u) => `${u.outpoint}:${u.satoshis}`),
    )
  }

  let importedItems = 0
  let itemsFailed = 0
  let newOneSatOutpoints: string[] = []
  let partialWarn: string | null = null

  if (oneSats.length > 0) {
    const itemResult = await importOneSatOrdinals(oneSats, active)
    importedItems = itemResult.imported
    itemsFailed = itemResult.failed
    newOneSatOutpoints = itemResult.outpoints ?? []
    recordItemReceipts(newOneSatOutpoints, oneSats, active.chain)
    if (itemResult.failed > 0) {
      console.warn('[chain-ingest] 1sat import partial', itemResult)
      partialWarn = `Some items didn’t import (${itemResult.failed}). Retrying automatically.`
    }
  }

  if (latches.length > 0) {
    const tipOrigins = new Map<string, string>()
    for (const tip of oneSats) {
      if (tip.txid && tip.origin) tipOrigins.set(tip.txid.toLowerCase(), tip.origin)
    }
    const latchResult = await importOneSatLatches(latches, tipOrigins, active)
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

    // Marked imported but still unspent on legacy with nothing swept — heal the
    // blacklist, but only for sweeps we can prove never landed.
    if (
      result.imported === 0 &&
      result.skippedKnown > 0 &&
      scan.sats > 0
    ) {
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
    newOneSatOutpoints,
    partialWarn,
  }
}
