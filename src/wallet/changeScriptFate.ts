/**
 * Change rows with no locking script — the only thing that can crash
 * `createAction` as `Array.from(undefined)`.
 *
 * `StorageIdb.allocateChangeInput` picks funding with `noScript: true`, so the
 * candidate scan never looks at scripts. It hydrates only the winner through
 * `validateOutputScript`, and that hydration returns *without changing
 * anything* when `scriptOffset` / `scriptLength` / `txid` are missing — rows
 * that arrive that way from a BRC-39 restore or a device-peer sync. The toolbox
 * then calls `asString(o.lockingScript)` on the winner, which is
 * `Array.from(undefined)`.
 *
 * Two consequences drive this module:
 *
 * 1. Every spendable change row needs an explicit fate. A windowed scan leaves
 *    poison rows behind for `allocateChangeInput` to find, so the sweep pages
 *    the whole set.
 * 2. Healing beats writing off. The coin is real and counted in the balance, so
 *    we rebuild the script from the raw tx (local storage first, chain second)
 *    and only quarantine what we cannot rebuild.
 *
 * Healing never flips `spendable`. Re-enabling a written-off output requires
 * on-chain evidence, which is `restoreLiveSpendableOutputs`' job.
 */
import { P2PKH, Transaction } from '@bsv/sdk'
import { getActiveWallet, type ActiveWallet } from './session'

export type ChangeRow = {
  outputId?: number
  txid?: string
  vout?: number
  outputIndex?: number
  transactionId?: number
  satoshis?: number
  change?: boolean
  spendable?: boolean
  lockingScript?: unknown
}

export type ChangeRefuseReason =
  | 'no-outpoint'
  | 'no-rawtx'
  | 'vout-missing'
  | 'satoshis-mismatch'

export type ChangeScriptFate =
  | { kind: 'scripted' }
  | { kind: 'heal'; lockingScript: number[] }
  | {
      kind: 'refuse'
      reason: ChangeRefuseReason
    }

/** Page size for the output scan; matches the toolbox's own paging shape. */
const PAGE = 200
/** Ceiling so a corrupt row count cannot stall a send forever. */
const MAX_PAGES = 40
/** Chain lookups per pass. Local storage hydration is unbounded; network is not. */
const CHAIN_FETCH_MAX = 32
/** Rows per IDB session — long single sessions block listOutputs during sync. */
const SWEEP_BATCH_SIZE = 40

type TxStatusRow = { status?: string; rawTx?: number[]; txid?: string }

type ChangeStorage = {
  findTransactions?: (args: unknown) => Promise<TxStatusRow[] | undefined>
  getProvenOrRawTx?: (txid: string) => Promise<{ rawTx?: number[] } | undefined>
  updateOutput: (outputId: number, update: Record<string, unknown>) => Promise<unknown>
}

export function txidFromTxRow(row: TxStatusRow | null | undefined): string | null {
  if (!row) return null
  const direct = String(row.txid ?? '')
    .trim()
    .toLowerCase()
  if (/^[0-9a-f]{64}$/.test(direct)) return direct
  if (row.rawTx?.length) {
    try {
      return Transaction.fromBinary(row.rawTx).id('hex')
    } catch {
      return null
    }
  }
  return null
}

/** Match a toolbox output row to a vout when BRC-39 restore omitted vout. */
export function findMatchingVout(rawTx: number[], satoshis: number | undefined): number {
  const target = Math.max(0, Math.trunc(Number(satoshis) || 0))
  if (target <= 0) return -1
  try {
    const tx = Transaction.fromBinary(rawTx)
    const matches: number[] = []
    tx.outputs.forEach((out, index) => {
      if (Number(out.satoshis) === target) matches.push(index)
    })
    if (matches.length === 1) return matches[0]!
    // Wallet change is usually the last matching output in a multi-output tx.
    if (matches.length > 1) return matches[matches.length - 1]!
  } catch {
    return -1
  }
  return -1
}

/**
 * BRC-39 / device-peer merges often leave `transactionId` but no `txid`/`vout`.
 * Resolve both from the parent transaction row before classifying script fate.
 */
export function resolveChangeRowOutpoint(
  row: ChangeRow,
  txRow: TxStatusRow | null | undefined,
): ChangeRow | null {
  let txid = String(row.txid ?? '')
    .trim()
    .toLowerCase()
  let vout = Number(row.vout ?? row.outputIndex)

  if (!/^[0-9a-f]{64}$/.test(txid)) {
    txid = txidFromTxRow(txRow) ?? ''
  }

  if ((!Number.isInteger(vout) || vout < 0) && txRow?.rawTx?.length) {
    const found = findMatchingVout(txRow.rawTx, row.satoshis)
    if (found >= 0) vout = found
  }

  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) {
    return null
  }
  return { ...row, txid, vout }
}

export function hasLockingScript(row: ChangeRow): boolean {
  const script = row.lockingScript
  if (typeof script === 'string') return script.length > 0
  if (Array.isArray(script)) return script.length > 0
  if (script instanceof Uint8Array) return script.length > 0
  return false
}

function isChangeRow(row: ChangeRow): boolean {
  const sats = Math.max(0, Math.trunc(Number(row.satoshis) || 0))
  return row.change === true || sats > 1
}

/**
 * Decide what to do with one script-less change row given the raw tx that
 * created it. Pure so the fate table is testable without storage.
 */
export function classifyChangeScript(
  row: ChangeRow,
  rawTx: number[] | null,
): ChangeScriptFate {
  if (hasLockingScript(row)) return { kind: 'scripted' }

  const txid = (row.txid ?? '').trim().toLowerCase()
  const vout = Number(row.vout)
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) {
    return { kind: 'refuse', reason: 'no-outpoint' }
  }
  if (!rawTx?.length) return { kind: 'refuse', reason: 'no-rawtx' }

  let out: { satoshis?: number; lockingScript: { toBinary: () => number[] } }
  try {
    out = Transaction.fromBinary(rawTx).outputs[vout]
  } catch {
    return { kind: 'refuse', reason: 'no-rawtx' }
  }
  if (!out) return { kind: 'refuse', reason: 'vout-missing' }

  // A script from the wrong tx would be spent as someone else's coin.
  if (Number(out.satoshis) !== Number(row.satoshis)) {
    return { kind: 'refuse', reason: 'satoshis-mismatch' }
  }

  const lockingScript = out.lockingScript.toBinary()
  if (!lockingScript.length) return { kind: 'refuse', reason: 'vout-missing' }
  return { kind: 'heal', lockingScript }
}

/** Every change row, spendable or written off, paged to the end. */
async function readChangeRows(active: ActiveWallet): Promise<ChangeRow[]> {
  const storage = active.wallet.storage
  const rows: ChangeRow[] = []
  for (const spendable of [true, false]) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = (await storage.runAsStorageProvider(async (sp) =>
        sp.findOutputs({
          partial: { spendable },
          paged: { limit: PAGE, offset: page * PAGE },
        }),
      )) as ChangeRow[] | undefined
      if (!batch?.length) break
      rows.push(...batch.filter(isChangeRow))
      if (batch.length < PAGE) break
    }
  }
  return rows
}

async function loadTxRowByTransactionId(
  sp: ChangeStorage,
  transactionId: number,
  cache: Map<number, TxStatusRow | null>,
): Promise<TxStatusRow | null> {
  if (cache.has(transactionId)) return cache.get(transactionId) ?? null
  if (typeof sp.findTransactions !== 'function') {
    cache.set(transactionId, null)
    return null
  }
  try {
    const rows = await sp.findTransactions({
      partial: { transactionId },
      noRawTx: false,
      paged: { limit: 1, offset: 0 },
    })
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null
    cache.set(transactionId, row)
    return row
  } catch (err) {
    console.warn('[change-script] transactionId lookup skipped', transactionId, err)
    cache.set(transactionId, null)
    return null
  }
}

async function readRawTxInSession(
  active: ActiveWallet,
  txid: string,
  sp: ChangeStorage,
  cache: Map<string, number[] | null>,
  fromChain: boolean,
  budget: { chainFetches: number },
  primed?: TxStatusRow | null,
): Promise<number[] | null> {
  const key = txid.trim().toLowerCase()
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  if (primed?.rawTx?.length) {
    cache.set(key, primed.rawTx)
    return primed.rawTx
  }

  let rawTx: number[] | null = null
  try {
    if (typeof sp.getProvenOrRawTx === 'function') {
      const local = await sp.getProvenOrRawTx(key)
      if (local?.rawTx?.length) rawTx = local.rawTx
    }
  } catch (err) {
    console.warn('[change-script] local rawTx lookup skipped', key, err)
  }

  if (!rawTx) {
    try {
      const { getLocalBeefForTxid } = await import('./beefCache')
      const beef = await getLocalBeefForTxid(active, key)
      const tx = beef?.findTxid(key)?.tx
      if (tx) rawTx = tx.toBinary()
    } catch {
      // local BEEF optional
    }
  }

  if (!rawTx && typeof sp.findTransactions === 'function') {
    try {
      const rows = await sp.findTransactions({
        partial: { txid: key },
        noRawTx: false,
        paged: { limit: 1, offset: 0 },
      })
      const local = rows?.[0]?.rawTx
      if (Array.isArray(local) && local.length > 0) rawTx = local
    } catch (err) {
      console.warn('[change-script] toolbox rawTx lookup skipped', key, err)
    }
  }

  if (!rawTx && fromChain && budget.chainFetches < CHAIN_FETCH_MAX) {
    try {
      const { peekRawTxLookup } = await import('./oneSatImport')
      if (peekRawTxLookup(key) === 'miss') {
        cache.set(key, null)
        return null
      }
    } catch {
      // fall through
    }
    budget.chainFetches += 1
    try {
      const { fetchRawTxHex } = await import('./oneSatImport')
      const hex = await fetchRawTxHex(key, active.chain)
      if (hex) rawTx = Transaction.fromHex(hex).toBinary()
    } catch (err) {
      console.warn('[change-script] chain rawTx lookup skipped', key, err)
    }
  }

  cache.set(key, rawTx)
  return rawTx
}

export type ChangeScriptSweep = {
  scanned: number
  healed: number
  quarantined: number
  refused: number
  addressFallback?: number
}

/** Change rows the wallet created — not 1-sat item tips. */
export function isWalletChangeRow(row: ChangeRow): boolean {
  const sats = Math.max(0, Math.trunc(Number(row.satoshis) || 0))
  return row.change === true || sats > 1
}

/** Last resort when BRC-39 rows have no outpoint or raw tx — P2PKH change to this wallet. */
export function walletChangeLockingScript(active: ActiveWallet): number[] | null {
  const address = active.address?.trim()
  if (!address) return null
  try {
    return new P2PKH().lock(address).toBinary()
  } catch {
    return null
  }
}

/**
 * Give every script-less change row a fate: rebuild the script, or make it
 * unspendable so `allocateChangeInput` can never hand it to `createAction`.
 *
 * @param fromChain allow network raw-tx lookups. Off for the pre-send sweep,
 * on for iterator-crash recovery where a coin is already blocking the wallet.
 */
export async function sweepChangeScripts(args?: {
  active?: ActiveWallet | null
  fromChain?: boolean
}): Promise<ChangeScriptSweep> {
  const active = args?.active ?? getActiveWallet()
  const empty: ChangeScriptSweep = {
    scanned: 0,
    healed: 0,
    quarantined: 0,
    refused: 0,
  }
  if (!active?.wallet?.storage) return empty

  let rows: ChangeRow[]
  try {
    rows = await readChangeRows(active)
  } catch (err) {
    console.warn('[change-script] change scan skipped', err)
    return empty
  }

  const unscripted = rows.filter((row) => !hasLockingScript(row))
  if (unscripted.length === 0) return { ...empty, scanned: rows.length }

  const result: ChangeScriptSweep = {
    scanned: rows.length,
    healed: 0,
    quarantined: 0,
    refused: 0,
    addressFallback: 0,
  }
  const refuseReasons: Partial<Record<ChangeRefuseReason, number>> = {}
  const fromChain = args?.fromChain === true
  const ordered = [...unscripted].sort(
    (a, b) => Math.max(0, Number(b.satoshis) || 0) - Math.max(0, Number(a.satoshis) || 0),
  )

  const rawTxCache = new Map<string, number[] | null>()
  const txByIdCache = new Map<number, TxStatusRow | null>()
  const budget = { chainFetches: 0 }
  const walletScript = walletChangeLockingScript(active)

  const processBatch = async (batch: ChangeRow[]): Promise<void> => {
    await active.wallet.storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as ChangeStorage

      const tryAddressFallback = async (row: ChangeRow, outputId: number): Promise<boolean> => {
        if (!isWalletChangeRow(row) || !walletScript) return false
        try {
          await sp.updateOutput(outputId, { lockingScript: walletScript })
          result.healed += 1
          result.addressFallback = (result.addressFallback ?? 0) + 1
          return true
        } catch (err) {
          console.warn('[change-script] address fallback skipped', outputId, err)
          return false
        }
      }

      for (const row of batch) {
        const outputId = Number(row.outputId)
        if (!Number.isFinite(outputId) || outputId <= 0) continue

        const transactionId = Number(row.transactionId)
        const txRow =
          Number.isFinite(transactionId) && transactionId > 0
            ? await loadTxRowByTransactionId(sp, transactionId, txByIdCache)
            : null
        const resolved = resolveChangeRowOutpoint(row, txRow)
        if (!resolved?.txid) {
          if (await tryAddressFallback(row, outputId)) continue
          result.refused += 1
          refuseReasons['no-outpoint'] = (refuseReasons['no-outpoint'] ?? 0) + 1
          if (row.spendable === true) {
            try {
              await sp.updateOutput(outputId, { spendable: false, spentBy: undefined })
              result.quarantined += 1
            } catch (err) {
              console.warn('[change-script] quarantine skipped', outputId, err)
            }
          }
          continue
        }

        const rawTx = await readRawTxInSession(
          active,
          resolved.txid,
          sp,
          rawTxCache,
          fromChain,
          budget,
          txRow,
        )
        const fate = classifyChangeScript(resolved, rawTx)

        if (fate.kind === 'scripted') continue

        if (fate.kind === 'heal') {
          try {
            await sp.updateOutput(outputId, { lockingScript: fate.lockingScript })
            result.healed += 1
            continue
          } catch (err) {
            console.warn('[change-script] heal skipped', outputId, err)
          }
        } else {
          result.refused += 1
          refuseReasons[fate.reason] = (refuseReasons[fate.reason] ?? 0) + 1
        }

        if (row.spendable !== true) continue
        try {
          await sp.updateOutput(outputId, { spendable: false, spentBy: undefined })
          result.quarantined += 1
        } catch (err) {
          console.warn('[change-script] quarantine skipped', outputId, err)
        }
      }
    })
  }

  try {
    for (let offset = 0; offset < ordered.length; offset += SWEEP_BATCH_SIZE) {
      if (offset > 0) {
        const { shouldYieldChainIngestToSpend } = await import('./walletCoordinator')
        if (shouldYieldChainIngestToSpend()) {
          console.info('[change-script] yielding mid-sweep — send waiting')
          break
        }
        const { yieldToUi } = await import('./yieldToUi')
        await yieldToUi()
      }
      const batch = ordered.slice(offset, offset + SWEEP_BATCH_SIZE)
      await processBatch(batch)
    }
  } catch (err) {
    console.warn('[change-script] sweep session failed', err)
    return result
  }

  if (result.healed > 0) {
    const viaFallback = result.addressFallback ?? 0
    const viaRawTx = result.healed - viaFallback
    if (viaRawTx > 0) {
      console.info(
        `[change-script] rebuilt ${viaRawTx} change locking script(s) from raw tx`,
      )
    }
    if (viaFallback > 0) {
      console.info(
        `[change-script] assigned ${viaFallback} wallet P2PKH script(s) (no outpoint/raw tx)`,
      )
    }
  }
  if (result.quarantined > 0) {
    console.info(
      `[change-script] quarantined ${result.quarantined} change output(s) with no rebuildable script`,
    )
  }
  if (result.refused > 0 || result.quarantined > 0 || result.healed > 0) {
    void import('./diagnosticLog').then(({ logDiag }) => {
      logDiag('change-script', result.healed > 0 ? 'info' : 'warn', 'sweep', {
        scanned: result.scanned,
        unscripted: unscripted.length,
        healed: result.healed,
        quarantined: result.quarantined,
        refused: result.refused,
        fromChain,
        ...(result.addressFallback ? { addressFallback: result.addressFallback } : {}),
        ...(refuseReasons['no-outpoint']
          ? { noOutpoint: refuseReasons['no-outpoint'] }
          : {}),
        ...(refuseReasons['no-rawtx'] ? { noRawtx: refuseReasons['no-rawtx'] } : {}),
        ...(refuseReasons['vout-missing']
          ? { voutMissing: refuseReasons['vout-missing'] }
          : {}),
        ...(refuseReasons['satoshis-mismatch']
          ? { satMismatch: refuseReasons['satoshis-mismatch'] }
          : {}),
      })
    })
  }
  return result
}
