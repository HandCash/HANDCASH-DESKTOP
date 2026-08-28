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
import { Transaction } from '@bsv/sdk'
import { getActiveWallet, type ActiveWallet } from './session'

export type ChangeRow = {
  outputId?: number
  txid?: string
  vout?: number
  satoshis?: number
  change?: boolean
  spendable?: boolean
  lockingScript?: unknown
}

export type ChangeScriptFate =
  | { kind: 'scripted' }
  | { kind: 'heal'; lockingScript: number[] }
  | {
      kind: 'refuse'
      reason: 'no-outpoint' | 'no-rawtx' | 'vout-missing' | 'satoshis-mismatch'
    }

/** Page size for the output scan; matches the toolbox's own paging shape. */
const PAGE = 200
/** Ceiling so a corrupt row count cannot stall a send forever. */
const MAX_PAGES = 40
/** Chain lookups per pass. Local storage hydration is unbounded; network is not. */
const CHAIN_FETCH_MAX = 12

export function hasLockingScript(row: ChangeRow): boolean {
  const script = row.lockingScript
  if (typeof script === 'string') return script.length > 0
  if (Array.isArray(script)) return script.length > 0
  if (script instanceof Uint8Array) return script.length > 0
  return false
}

function isChangeRow(row: ChangeRow): boolean {
  return row.change === true
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

async function readRawTx(
  active: ActiveWallet,
  txid: string,
  cache: Map<string, number[] | null>,
  fromChain: boolean,
  budget: { chainFetches: number },
  opts?: { spendable?: boolean },
): Promise<number[] | null> {
  const cached = cache.get(txid)
  if (cached !== undefined) return cached

  let rawTx: number[] | null = null
  try {
    const local = (await active.wallet.storage.runAsStorageProvider(async (sp) =>
      sp.getProvenOrRawTx(txid),
    )) as { rawTx?: number[] } | undefined
    if (local?.rawTx?.length) rawTx = local.rawTx
  } catch (err) {
    console.warn('[change-script] local rawTx lookup skipped', txid, err)
  }

  if (!rawTx && fromChain && budget.chainFetches < CHAIN_FETCH_MAX) {
    // Already-quarantined rows: if a prior Refresh confirmed the body missing,
    // do not spend another chain slot re-asking (global miss TTL covers this).
    if (opts?.spendable === false) {
      try {
        const { peekRawTxLookup } = await import('./oneSatImport')
        if (peekRawTxLookup(txid) === 'miss') {
          cache.set(txid, null)
          return null
        }
      } catch {
        // import / cache probe failed — fall through to a budgeted fetch
      }
    }
    budget.chainFetches += 1
    try {
      const { fetchRawTxHex } = await import('./oneSatImport')
      const hex = await fetchRawTxHex(txid, active.chain)
      if (hex) rawTx = Transaction.fromHex(hex).toBinary()
    } catch (err) {
      console.warn('[change-script] chain rawTx lookup skipped', txid, err)
    }
  }

  cache.set(txid, rawTx)
  return rawTx
}

export type ChangeScriptSweep = {
  scanned: number
  healed: number
  quarantined: number
  refused: number
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
  }
  const rawTxCache = new Map<string, number[] | null>()
  const budget = { chainFetches: 0 }

  for (const row of unscripted) {
    const outputId = Number(row.outputId)
    if (!Number.isFinite(outputId) || outputId <= 0) continue

    const txid = (row.txid ?? '').trim().toLowerCase()
    const rawTx = /^[0-9a-f]{64}$/.test(txid)
      ? await readRawTx(active, txid, rawTxCache, args?.fromChain === true, budget, {
          spendable: row.spendable === true,
        })
      : null
    const fate = classifyChangeScript(row, rawTx)

    if (fate.kind === 'scripted') continue

    if (fate.kind === 'heal') {
      try {
        await active.wallet.storage.runAsStorageProvider(async (sp) => {
          await sp.updateOutput(outputId, { lockingScript: fate.lockingScript })
        })
        result.healed += 1
        continue
      } catch (err) {
        console.warn('[change-script] heal skipped', outputId, err)
      }
    } else {
      result.refused += 1
    }

    // Fail closed: an unscripted row must not stay spendable.
    if (row.spendable !== true) continue
    try {
      await active.wallet.storage.runAsStorageProvider(async (sp) => {
        await sp.updateOutput(outputId, { spendable: false, spentBy: undefined })
      })
      result.quarantined += 1
    } catch (err) {
      console.warn('[change-script] quarantine skipped', outputId, err)
    }
  }

  if (result.healed > 0) {
    console.info(
      `[change-script] rebuilt ${result.healed} change locking script(s) from raw tx`,
    )
  }
  if (result.quarantined > 0) {
    console.info(
      `[change-script] quarantined ${result.quarantined} change output(s) with no rebuildable script`,
    )
  }
  return result
}
