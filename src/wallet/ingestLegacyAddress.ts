/**
 * Legacy receive-address ingest — scan → classify → import.
 * Shared by chainIngest (Refresh) and migration (refreshLegacyAddress).
 * See `layers.ts` chainIngest pipeline steps 2–3.
 */
import { getActiveWallet, type ActiveWallet } from './session'
import { scanLegacyAddress, importLegacyUtxos, type LegacyScanResult } from './legacyScan'
import {
  classifyLegacyUtxos,
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
      heldOneSats: 0,
      newOneSatOutpoints: [],
      partialWarn: null,
    }
  }

  const { funding, oneSats, heldOneSats } = await classifyLegacyUtxos(
    scan.utxos,
    active.chain,
    opts.knownItems ?? [],
  )

  if (heldOneSats.length > 0) {
    console.info(
      `[chain-ingest] holding ${heldOneSats.length} unrecognized one-sat out(s) — not sweeping`,
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
    if (itemResult.failed > 0) {
      console.warn('[chain-ingest] 1sat import partial', itemResult)
      partialWarn = `Some items didn’t import (${itemResult.failed}). Retrying automatically.`
    }
  }

  let importedFunding = 0
  let fundingFailed = 0
  let fundingSkippedKnown = 0

  if (funding.length > 0) {
    const result = await importLegacyUtxos(funding, active)
    importedFunding = result.imported
    fundingFailed = result.failed
    fundingSkippedKnown = result.skippedKnown
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
    heldOneSats: heldOneSats.length,
    newOneSatOutpoints,
    partialWarn,
  }
}
