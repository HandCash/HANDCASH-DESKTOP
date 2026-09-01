/**
 * Writing off spendable outputs — the only path allowed to do it.
 *
 * `reviewSpendableOutputs(all, release)` decides an output is dead through
 * `services.isUtxo`, which returns `or.isUtxo === true`. An indexer that has not
 * seen our unconfirmed change and a UTXO service that errored both answer
 * `false`, and `release` then sets `spendable: false` permanently. So a bulk
 * release run on a schedule destroys live coins, which is why chain ingest only
 * ever audits (see `chainIngest.auditSpendableOutputs`).
 *
 * A node rejecting a spend because an input is already spent is different: that
 * is affirmative evidence our set is stale, and it is the only trigger for the
 * release here.
 */
import { parseOutpoint } from './legacyScan'
import { logDiag } from './diagnosticLog'
import { getActiveWallet } from './session'
import {
  creditUtxo,
  hideUtxo,
  isUtxoBlockedFromRestore,
  listUtxoLocks,
  releaseConsumedUtxo,
} from './utxoLockManager'
import {
  inputOutpointsFromAtomicBeef,
  inputOutpointsFromRawTx,
  outpointFromOutput,
} from './txOutpoints'
import { shouldYieldChainIngestToSpend } from './walletCoordinator'
import {
  classifyChangeScript,
  hasLockingScript,
  resolveChangeRowOutpoint,
  sweepChangeScripts,
  type ChangeRow,
} from './changeScriptFate'
import { txLivenessFromStatus } from './balanceView'

/** Toolbox statuses that mean this wallet already committed the tx locally. */
const LIVE_LOCAL_TX = new Set([
  'sending',
  'unproven',
  'completed',
  'nosend',
  'nonfinal',
  'unfail',
])

type TxStatusRow = { status?: string; rawTx?: number[]; txid?: string }

function positiveId(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** True when a local transaction is still this wallet's spend — not failed/abandoned. */
export function isLiveLocalTxStatus(status: unknown): boolean {
  return LIVE_LOCAL_TX.has(String(status ?? '').toLowerCase())
}

/** Cap restore work so a huge dead set cannot stall unlock/refresh. */
const RESTORE_MAX = 200

/** The toolbox rejects `undefined` partial filters on some storage backends. */
export function isUndefinedPartialFilterError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes('must be not undefined') ||
    message.includes('Passing undefined as a filter value is not supported')
  )
}

/** True only for a rejection that proves an input is spent or gone. */
export function isAlreadySpentInputError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('missing inputs') ||
    message.includes('missingorspent') ||
    message.includes('mempool-conflict') ||
    message.includes('already spent') ||
    message.includes('double spend') ||
    message.includes('doublespend')
  )
}

/**
 * Wallet storage marked an input unspendable (failed createAction / signAction
 * that did not roll back). Not proof the UTXO is gone on-chain — do **not**
 * {@link releaseStaleSpendableOutputs}; abort + unfail instead.
 */
export function isNoLongerSpendableError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('no longer spendable') ||
    (message.includes('werr_invalid_operation') && message.includes('spendable'))
  )
}

/**
 * Write off outputs the network refuses to spend. Prefer
 * {@link hideSpentOutpoints} with the rejected tx's inputs — a bulk review
 * treats unseen unconfirmed change as dead and hides live coins.
 *
 * @returns how many outputs were released.
 */
export async function releaseStaleSpendableOutputs(): Promise<number> {
  const active = getActiveWallet()
  if (!active) return 0
  try {
    let result
    try {
      result = await active.wallet.reviewSpendableOutputs(true, true)
    } catch (err) {
      if (!isUndefinedPartialFilterError(err)) throw err
      result = await active.wallet.reviewSpendableOutputs(false, true)
    }
    const outputs = Array.isArray(result.outputs) ? result.outputs : []
    const outpoints = outputs
      .map((row) => outpointFromOutput(row as { txid?: unknown; vout?: unknown }))
      .filter((op): op is string => Boolean(op))
    if (outpoints.length > 0) await hideSpentOutpoints(outpoints)
    if (outputs.length > 0) {
      console.info(
        `[stale-output] released ${outputs.length} output(s) the network rejected as spent`,
      )
    }
    return outputs.length
  } catch (err) {
    console.warn('[stale-output] release failed', err)
    return 0
  }
}

/**
 * After already-spent: hide those inputs, keep this tx's change, restore only
 * live local change — never a bulk indexer rewrite of the spendable set.
 */
export async function onAlreadySpentSend(args: {
  txid?: string
  atomic?: number[]
}): Promise<void> {
  const txid = args.txid?.trim().toLowerCase()
  let inputs: string[] = []
  if (txid && args.atomic?.length) {
    inputs = inputOutpointsFromAtomicBeef(args.atomic, txid)
  }
  if (txid && inputs.length === 0) {
    const raw = await loadLocalRawTx(txid)
    if (raw?.length) inputs = inputOutpointsFromRawTx(raw)
  }
  if (inputs.length > 0) {
    const hidden = await hideSpentOutpoints(inputs)
    console.info(
      `[stale-output] hid ${hidden} already-spent input(s) without deleting them`,
    )
  }
  if (txid) await keepChangeOfSignedTx(txid)
  await restoreLiveSpendableOutputs({ onlyLiveChange: true })
}

/** @deprecated Use {@link onAlreadySpentSend} so live change is not bulk-released. */
export async function releaseThenRestoreStaleOutputs(): Promise<void> {
  await restoreLiveSpendableOutputs({ onlyLiveChange: true })
}

/**
 * Mark the inputs a just-signed spend consumed as unspendable, immediately.
 *
 * `createAction` returns a signed transaction whose inputs are gone, but the
 * toolbox rows can still read `spendable: true`. The pass that repaired that —
 * {@link rehideInputsOfLiveLocalTxs} — is chain-ingest maintenance and returns
 * early while a spend is queued, which is exactly the state a burst of sends
 * holds. So back-to-back sends could re-select a coin the previous send had
 * already spent: every broadcaster rejected the second transaction as a double
 * spend and the send failed "Already spent".
 *
 * This runs on the spend path and is deliberately *not* gated on
 * `shouldYieldChainIngestToSpend()` — it is the spend's own bookkeeping, not
 * maintenance that may defer. Rows are hidden, never deleted, so a transaction
 * that ultimately fails can still have its change and inputs recovered.
 */
export async function sealSpentInputsOfSignedTx(
  txid: string | undefined,
  atomic: number[] | undefined,
): Promise<number> {
  const id = txid?.trim().toLowerCase()
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return 0

  let inputs: string[] = []
  if (atomic?.length) inputs = inputOutpointsFromAtomicBeef(atomic, id)
  if (inputs.length === 0) {
    const raw = await loadLocalRawTx(id)
    if (raw?.length) inputs = inputOutpointsFromRawTx(raw)
  }
  if (inputs.length === 0) return 0

  const hidden = await hideSpentOutpoints(inputs, id)
  if (hidden > 0) {
    console.info(
      `[stale-output] sealed ${hidden} input(s) spent by ${id.slice(0, 12)} — next send cannot reselect them`,
    )
  }
  // Promote this tx's change immediately so the spend queue can chain the next
  // payment without waiting for chain ingest (restoreLiveSpendableOutputs yields
  // while a spend holds priority).
  await keepChangeOfSignedTx(id)
  return hidden
}

/**
 * Undo {@link sealSpentInputsOfSignedTx} for a transaction that never broadcast.
 *
 * The seal is placed before the broadcast, so a send that dies in transport
 * leaves live coins retired. On an offline device every broadcaster errors and
 * some of them report that as a double spend, so each failed attempt used to
 * eat another handful of inputs: spendable balance fell with nothing on chain
 * to show for it, and every later send failed "Already spent".
 *
 * Only call this when no service claimed the inputs are gone — a `doubleSpend`
 * or `missingInputs` verdict means they really are spent and must stay sealed.
 * If the transaction does turn up, chain ingest re-hides these inputs from the
 * indexer's own view.
 */
export async function releaseSealedInputsOfUnsentTx(
  txid: string | undefined,
  atomic: number[] | undefined,
): Promise<number> {
  const id = txid?.trim().toLowerCase()
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return 0

  let inputs: string[] = []
  if (atomic?.length) inputs = inputOutpointsFromAtomicBeef(atomic, id)
  if (inputs.length === 0) {
    const raw = await loadLocalRawTx(id)
    if (raw?.length) inputs = inputOutpointsFromRawTx(raw)
  }
  if (inputs.length === 0) return 0

  const unique = [...new Set(inputs.map((o) => o.trim()).filter(Boolean))]
  for (const op of unique) {
    releaseConsumedUtxo(op, `unsent:${id.slice(0, 12)}`)
  }

  const storage = getActiveWallet()?.wallet?.storage
  if (storage?.runAsStorageProvider) {
    try {
      await storage.runAsStorageProvider(async (activeSp) => {
        const sp = activeSp as unknown as LocalStorage
        for (const op of unique) {
          const parsed = parseOutpoint(op)
          if (!parsed) continue
          const rows = await findOutputsForTxid(sp, parsed.txid)
          const match = rows.find(
            (row) => Number(row.vout ?? row.outputIndex) === parsed.vout,
          )
          const outputId = positiveId(match?.outputId)
          if (outputId == null) continue
          try {
            await sp.updateOutput(outputId, { spendable: true })
          } catch (err) {
            console.warn('[stale-output] unseal spendable=true skipped', op, err)
          }
        }
      })
    } catch (err) {
      console.warn('[stale-output] unseal toolbox rows skipped', err)
    }
  }

  console.info(
    `[stale-output] released ${unique.length} input(s) of ${id.slice(0, 12)} — never reached a node`,
  )
  return unique.length
}

/**
 * Hide these outpoints as `spent` and mark toolbox rows unspendable. The
 * storage row stays — Pay / restore skip `spent` overlay status.
 */
export async function hideSpentOutpoints(
  outpoints: string[],
  spentBy?: string,
): Promise<number> {
  const unique = [...new Set(outpoints.map((o) => o.trim()).filter(Boolean))]
  if (unique.length === 0) return 0
  const spender = spentBy?.trim().toLowerCase()
  const id = spender && /^[0-9a-f]{64}$/.test(spender) ? spender : ''
  for (const op of unique) {
    // Record *which* transaction consumed the coin when we know it. A bare
    // marker is unauditable: a coin sealed for a spend that never reached a
    // node looks identical to one a miner really took, so nothing downstream
    // can tell the difference and the coin stays hidden for good.
    hideUtxo(op, { spentBy: id, diagnostic: id ? `spent-by:${id.slice(0, 12)}` : 'already-spent' })
  }
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage?.runAsStorageProvider) {
    return unique.length
  }
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      for (const op of unique) {
        const parsed = parseOutpoint(op)
        if (!parsed) continue
        const rows = await findOutputsForTxid(sp, parsed.txid)
        const match = rows.find((row) => Number(row.vout ?? row.outputIndex) === parsed.vout)
        const outputId = positiveId(match?.outputId)
        if (outputId == null) continue
        try {
          await sp.updateOutput(outputId, { spendable: false })
        } catch (err) {
          console.warn('[stale-output] hide spendable=false skipped', op, err)
        }
      }
    })
  } catch (err) {
    console.warn('[stale-output] hide toolbox rows skipped', err)
  }
  return unique.length
}

/** Sealed coins to re-check per pass, so a long-lived wallet cannot stall. */
const RECLAIM_MAX = 40

/**
 * Give back coins sealed for a spend that never made it onto the chain.
 *
 * A send seals its inputs before broadcasting. When the broadcast dies in
 * transport the coins stay retired, and on a device that was offline for a
 * while those add up until spendable balance is visibly short and further
 * sends fail "Already spent". {@link releaseSealedInputsOfUnsentTx} handles the
 * attempt that is failing right now; this recovers the ones already stranded.
 *
 * Direction of trust matters. `isUtxo === false` is unreliable — an indexer
 * that has not caught up with our unconfirmed change answers false, and acting
 * on that is what destroys live coins (see this module's header). So this only
 * moves on `isUtxo === true`: positive proof from the network that the coin was
 * never actually spent. A sealing transaction this wallet still considers live
 * is left alone regardless.
 */
export async function reclaimSealedInputsNeverSpent(opts?: {
  /** Spend-path reclaim — do not defer while a send holds spend priority. */
  forSpendChain?: boolean
}): Promise<number> {
  const forSpendChain = opts?.forSpendChain === true
  if (!forSpendChain && shouldYieldChainIngestToSpend()) return 0
  const active = getActiveWallet()
  const isUtxo = active?.services?.isUtxo
  const storage = active?.wallet?.storage
  if (typeof isUtxo !== 'function' || !storage?.runAsStorageProvider) return 0

  const sealed = listUtxoLocks()
    .filter((rec) => !!rec.spentBy && /^[0-9a-f]{64}$/.test(rec.spentBy))
    .slice(0, RECLAIM_MAX)
  if (sealed.length === 0) return 0

  // A sealing tx this wallet still treats as live is a real spend in flight.
  const liveSealers = new Set<string>()
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      if (typeof sp.findTransactions !== 'function') return
      for (const txid of new Set(sealed.map((rec) => rec.spentBy as string))) {
        try {
          const rows = await sp.findTransactions({
            partial: { txid },
            paged: { limit: 1, offset: 0 },
          })
          if (rows?.some((row) => isLiveLocalTxStatus(row?.status))) liveSealers.add(txid)
        } catch (err) {
          // Unknown status is not permission to resurrect a coin.
          if (!isUndefinedPartialFilterError(err)) {
            console.warn('[stale-output] sealer status skipped', txid.slice(0, 12), err)
          }
          liveSealers.add(txid)
        }
      }
    })
  } catch (err) {
    console.warn('[stale-output] reclaim status sweep skipped', err)
    return 0
  }

  const revive: string[] = []
  for (const rec of sealed) {
    if (shouldYieldChainIngestToSpend()) break
    if (liveSealers.has(rec.spentBy as string)) continue
    const parsed = parseOutpoint(rec.outpoint)
    if (!parsed) continue
    try {
      const result = await isUtxo({ txid: parsed.txid, vout: parsed.vout } as never)
      const alive =
        result === true ||
        (!!result && typeof result === 'object' && (result as { isUtxo?: unknown }).isUtxo === true)
      if (alive) revive.push(rec.outpoint)
    } catch {
      // No answer means no evidence. Leave the coin sealed.
    }
  }
  if (revive.length === 0) return 0

  for (const outpoint of revive) releaseConsumedUtxo(outpoint, 'reclaim:never-spent')
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      for (const outpoint of revive) {
        const parsed = parseOutpoint(outpoint)
        if (!parsed) continue
        const rows = await findOutputsForTxid(sp, parsed.txid)
        const match = rows.find((row) => Number(row.vout ?? row.outputIndex) === parsed.vout)
        const outputId = positiveId(match?.outputId)
        if (outputId == null) continue
        try {
          await sp.updateOutput(outputId, { spendable: true, spentBy: undefined })
        } catch (err) {
          console.warn('[stale-output] reclaim spendable=true skipped', outpoint, err)
        }
      }
    })
  } catch (err) {
    console.warn('[stale-output] reclaim toolbox rows skipped', err)
  }

  console.info(
    `[stale-output] reclaimed ${revive.length} sealed input(s) the indexer still reports unspent`,
  )
  return revive.length
}

/**
 * Credit this signed tx's change even when the creator was marked failed and
 * the indexer 404s the txid. Clearing a send that later shows on chain used
 * to leave change `spendable: false` forever.
 */
export async function keepChangeOfSignedTx(txid: string): Promise<number> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return 0
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage?.runAsStorageProvider) return 0

  try {
    return (await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      const rows = await findOutputsForTxid(sp, id)
      const txCache = new Map<number, TxStatusRow | null>()
      let kept = 0
      for (const row of rows) {
        const outputId = positiveId(row.outputId)
        const outpoint = outpointFromOutput(row)
        if (outputId == null || !outpoint) continue
        if (positiveId(row.spentBy) != null) continue
        const basket = String(row.basket ?? '').toLowerCase()
        if (basket === '1sat' || basket === 'bsv21') continue
        const sats = Math.max(0, Math.trunc(Number(row.satoshis) || 0))
        const isChange = row.change === true || sats > 1
        if (!isChange) continue

        const healed = await healLockingScript(sp, row, txCache)
        const scripted = healed != null || hasLockingScript(row)
        if (!scripted) continue

        await sp.updateOutput(outputId, {
          spendable: true,
          spentBy: undefined,
          ...(healed != null ? { lockingScript: healed } : {}),
        })
        creditUtxo(outpoint, { satoshis: sats })
        kept += 1
      }
      if (kept > 0) {
        console.info(
          `[stale-output] kept ${kept} change output(s) of ${id.slice(0, 12)}`,
        )
      }
      return kept
    })) as number
  } catch (err) {
    console.warn('[stale-output] keep change skipped', id.slice(0, 12), err)
    return 0
  }
}

/** Statuses whose change outputs may still be unspendable in the toolbox. */
const PENDING_CHANGE_TX_STATUSES = [
  'sending',
  'unproven',
  'nosend',
  'nonfinal',
  'unfail',
] as const

/**
 * Promote change from live local sends without paging the whole unspendable set.
 *
 * `restoreLiveSpendableOutputs` only inspects the first {@link RESTORE_MAX} dead
 * rows. Wallets with hundreds of historical script-less change rows never reach
 * a small pending credit (e.g. 8822 sats) — displayed balance includes it but
 * Pay cannot select it. This walks pending local txids and calls
 * {@link keepChangeOfSignedTx} for each.
 */
export async function promotePendingLocalChangeOutputs(opts?: {
  forSpendChain?: boolean
}): Promise<number> {
  const forSpendChain = opts?.forSpendChain === true
  if (!forSpendChain && shouldYieldChainIngestToSpend()) return 0
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage?.runAsStorageProvider) return 0

  const txids = new Set<string>()
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as LocalStorage
      if (typeof sp.findTransactions !== 'function') return
      for (const status of PENDING_CHANGE_TX_STATUSES) {
        if (!forSpendChain && shouldYieldChainIngestToSpend()) break
        for (let page = 0; page < 5; page += 1) {
          const rows = await sp.findTransactions({
            partial: {},
            status: [status],
            noRawTx: true,
            paged: { limit: 25, offset: page * 25 },
          })
          if (!rows?.length) break
          for (const row of rows) {
            const txid = String(row.txid ?? '').trim().toLowerCase()
            if (/^[0-9a-f]{64}$/.test(txid)) txids.add(txid)
          }
          if (rows.length < 25) break
        }
      }
    })
  } catch (err) {
    console.warn('[stale-output] pending tx scan skipped', err)
    return 0
  }

  if (txids.size === 0) return 0

  let promoted = 0
  for (const txid of txids) {
    if (!forSpendChain && shouldYieldChainIngestToSpend()) break
    promoted += await keepChangeOfSignedTx(txid)
  }
  if (promoted > 0) {
    console.info(
      `[stale-output] promoted ${promoted} pending local change output(s) from ${txids.size} live tx(s)`,
    )
  }
  return promoted
}

async function loadLocalRawTx(txid: string): Promise<number[] | null> {
  const storage = getActiveWallet()?.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  try {
    const found = await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      if (typeof sp.getProvenOrRawTx !== 'function') return undefined
      return sp.getProvenOrRawTx(txid)
    })
    const raw = found?.rawTx
    return Array.isArray(raw) && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

async function findOutputsForTxid(
  sp: { findOutputs?: (args: unknown) => Promise<unknown> },
  txid: string,
): Promise<Array<ChangeRow & { outputIndex?: number; basket?: string; spentBy?: number }>> {
  if (typeof sp.findOutputs !== 'function') return []
  try {
    const rows = await sp.findOutputs({
      partial: { txid },
      paged: { limit: 50, offset: 0 },
    })
    return Array.isArray(rows) ? (rows as never) : []
  } catch (err) {
    if (!isUndefinedPartialFilterError(err)) {
      console.warn('[stale-output] findOutputs by txid skipped', err)
    }
    return []
  }
}

type LocalStorage = {
  updateOutput: (outputId: number, update: Record<string, unknown>) => Promise<unknown>
  findOutputs?: (args: unknown) => Promise<unknown>
  findTransactions?: (args: unknown) => Promise<TxStatusRow[] | undefined>
  getProvenOrRawTx?: (txid: string) => Promise<{ rawTx?: number[] } | undefined>
}

async function loadTxRow(
  sp: LocalStorage,
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
      noRawTx: true,
      paged: { limit: 1, offset: 0 },
    })
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null
    cache.set(transactionId, row)
    return row
  } catch (err) {
    console.warn('[stale-output] tx lookup skipped', transactionId, err)
    cache.set(transactionId, null)
    return null
  }
}

async function healLockingScript(
  sp: LocalStorage,
  output: ChangeRow & { transactionId?: number; outputIndex?: number },
  txCache: Map<number, TxStatusRow | null>,
  opts?: { fromChain?: boolean },
): Promise<number[] | null> {
  if (hasLockingScript(output)) return null

  let txRow: TxStatusRow | null = null
  const transactionId = Number(output.transactionId)
  if (Number.isFinite(transactionId) && transactionId > 0) {
    txRow = await loadTxRow(sp, transactionId, txCache)
  }

  const resolved = resolveChangeRowOutpoint(output, txRow)
  if (!resolved?.txid) return null

  const txid = resolved.txid
  if (typeof sp.getProvenOrRawTx === 'function') {
    try {
      const local = await sp.getProvenOrRawTx(txid)
      const fate = classifyChangeScript(resolved, local?.rawTx?.length ? local.rawTx : null)
      if (fate.kind === 'heal') return fate.lockingScript
    } catch (err) {
      console.warn('[stale-output] change script heal skipped', txid.slice(0, 12), err)
    }
  }

  if (typeof sp.findTransactions === 'function') {
    try {
      const rows = await sp.findTransactions({
        partial: { txid },
        noRawTx: false,
        paged: { limit: 1, offset: 0 },
      })
      const raw = rows?.[0]?.rawTx ?? txRow?.rawTx
      if (Array.isArray(raw) && raw.length) {
        const fate = classifyChangeScript(resolved, raw)
        if (fate.kind === 'heal') return fate.lockingScript
      }
    } catch (err) {
      console.warn('[stale-output] toolbox tx raw heal skipped', txid.slice(0, 12), err)
    }
  }

  if (opts?.fromChain !== true) return null

  try {
    const active = getActiveWallet()
    if (!active) return null
    const { fetchRawTxHex } = await import('./oneSatImport')
    const hex = await fetchRawTxHex(txid, active.chain)
    if (!hex) return null
    const { Transaction } = await import('@bsv/sdk')
    const fate = classifyChangeScript(resolved, Transaction.fromHex(hex).toBinary())
    return fate.kind === 'heal' ? fate.lockingScript : null
  } catch (err) {
    console.warn('[stale-output] chain script heal skipped', txid.slice(0, 12), err)
    return null
  }
}

/**
 * After createAction the inputs are this wallet's spent coins and the change is
 * already in storage. Rebuild locking scripts from the local raw tx so the next
 * send can select that change before any indexer has seen the payment.
 */
export async function sealLocalSpendChange(): Promise<void> {
  await sweepChangeScripts({ fromChain: false })
}

const REHIDE_TX_LIMIT = 40

function txidFromRow(row: { txid?: unknown }): string | null {
  const txid = String(row.txid ?? '')
    .trim()
    .toLowerCase()
  return /^[0-9a-f]{64}$/.test(txid) ? txid : null
}

/**
 * Hide inputs of this wallet's live local spends. Restore used to trust
 * indexer `isUtxo` and flip spent coins back to spendable (and clear
 * `spentBy`) — that inflated Pay and made the next send hang on dead coins.
 */
export async function rehideInputsOfLiveLocalTxs(): Promise<number> {
  if (shouldYieldChainIngestToSpend()) return 0
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage || typeof storage.runAsStorageProvider !== 'function') return 0

  const inputs = new Set<string>()
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      if (typeof sp.findTransactions !== 'function') return
      let rows: TxStatusRow[] = []
      try {
        rows =
          (await sp.findTransactions({
            partial: {},
            status: [...LIVE_LOCAL_TX],
            noRawTx: false,
            paged: { limit: REHIDE_TX_LIMIT, offset: 0 },
          })) ?? []
      } catch (err) {
        if (!isUndefinedPartialFilterError(err)) {
          console.warn('[stale-output] live-tx list skipped', err)
        }
        for (const status of LIVE_LOCAL_TX) {
          if (shouldYieldChainIngestToSpend()) return
          try {
            const batch = await sp.findTransactions({
              partial: { status },
              noRawTx: false,
              paged: { limit: 15, offset: 0 },
            })
            if (Array.isArray(batch)) rows.push(...batch)
          } catch (inner) {
            console.warn('[stale-output] live-tx list skipped', status, inner)
          }
        }
      }
      for (const row of rows.slice(0, REHIDE_TX_LIMIT)) {
        if (shouldYieldChainIngestToSpend()) return
        let raw = Array.isArray(row.rawTx) && row.rawTx.length > 0 ? row.rawTx : null
        const txid = txidFromRow(row)
        if (!raw && txid && typeof sp.getProvenOrRawTx === 'function') {
          try {
            const found = await sp.getProvenOrRawTx(txid)
            raw = Array.isArray(found?.rawTx) && found.rawTx.length > 0 ? found.rawTx : null
          } catch {
            raw = null
          }
        }
        if (!raw) continue
        for (const op of inputOutpointsFromRawTx(raw)) inputs.add(op)
      }
    })
  } catch (err) {
    console.warn('[stale-output] rehide live inputs skipped', err)
    return 0
  }
  if (inputs.size === 0) return 0
  const hidden = await hideSpentOutpoints([...inputs])
  if (hidden > 0) {
    console.info(
      `[stale-output] rehid ${hidden} input(s) of live local spends so they stay unspendable`,
    )
  }
  return hidden
}

async function loadUnspendableChange(
  // Method syntax on purpose: the toolbox signature is narrower than `unknown`,
  // and only a bivariant position accepts it.
  storage: { findOutputs(args: unknown): Promise<unknown[] | undefined> },
): Promise<unknown[]> {
  try {
    const change = await storage.findOutputs({
      partial: { spendable: false, change: true },
      paged: { limit: RESTORE_MAX, offset: 0 },
    })
    if (Array.isArray(change)) return change
  } catch (err) {
    if (!isUndefinedPartialFilterError(err)) {
      console.warn('[stale-output] change-row lookup skipped', err)
    }
  }
  try {
    const dead = await storage.findOutputs({
      partial: { spendable: false },
      paged: { limit: RESTORE_MAX, offset: 0 },
    })
    return Array.isArray(dead) ? dead : []
  } catch (err) {
    console.warn('[stale-output] unspendable lookup skipped', err)
    return []
  }
}

/**
 * Re-enable change left `spendable: false` after a local send.
 *
 * Never asks the indexer `isUtxo`. Indexer lag after a spend answers `true`
 * for coins this wallet already consumed, and restoring those inflated Pay
 * and poisoned the next createAction. Overlay-hidden and locally-spent
 * inputs stay hidden.
 *
 * Restores change of **pending** local txs (still in flight) and **settled**
 * txs (`completed` locally) that never got promoted back to spendable — the
 * usual cause of `spendable=0` with a large `pendingChange` display credit.
 *
 * @returns how many outputs were restored.
 */
export async function restoreLiveSpendableOutputs(opts?: {
  onlyLiveChange?: boolean
  /**
   * When set, only re-enable unspent change created by this local txid.
   * Used to chain burn fees without touching any other pending output.
   */
  creatorTxid?: string
  /**
   * Spend-path chaining — do not yield to queued sends. Maintenance scans defer
   * while a spend holds priority; promoting pending change for the next queued
   * tx must run inside that same region.
   */
  forSpendChain?: boolean
}): Promise<number> {
  const onlyLiveChange = opts?.onlyLiveChange === true
  const creatorTxid = opts?.creatorTxid?.trim().toLowerCase() || null
  const forSpendChain = opts?.forSpendChain === true
  if (!forSpendChain && shouldYieldChainIngestToSpend()) return 0
  const active = getActiveWallet()
  if (!active) return 0
  const storage = active.wallet.storage
  if (!storage || typeof storage.findOutputs !== 'function') return 0
  if (typeof storage.runAsStorageProvider !== 'function') return 0

  try {
    const dead = await loadUnspendableChange(storage)
    if (!dead.length) return 0

    let restored = 0
    let unscripted = 0
    let keptSpent = 0
    const txCache = new Map<number, TxStatusRow | null>()

    // One storage session for the whole sweep. Re-entering the provider per
    // output cost a session apiece — on a phone carrying a few hundred
    // unspendable rows that was seconds of IndexedDB churn on the UI thread,
    // paid on every refresh and after every send.
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage

      for (const raw of dead.slice(0, RESTORE_MAX)) {
        if (!forSpendChain && shouldYieldChainIngestToSpend()) {
          console.info(
            `[stale-output] restore yielded to spend after ${restored} restore(s)`,
          )
          break
        }
        const output = raw as ChangeRow & {
          transactionId?: number
          spentBy?: number
          outputIndex?: number
          basket?: string
          change?: boolean
          spendable?: boolean
        }
        const outputId = positiveId(output.outputId)
        if (outputId == null) continue
        const basket = String(output.basket ?? '').toLowerCase()
        if (basket === '1sat' || basket === 'bsv21') continue
        const overlayKey = outpointFromOutput(output)
        if (overlayKey && isUtxoBlockedFromRestore(overlayKey)) {
          keptSpent += 1
          continue
        }

        try {
          const spentBy = positiveId(output.spentBy)
          if (spentBy != null) {
            const spender = await loadTxRow(sp, spentBy, txCache)
            if (isLiveLocalTxStatus(spender?.status)) {
              keptSpent += 1
              continue
            }
          }

          const creatorId = positiveId(output.transactionId)
          const creator =
            creatorId != null ? await loadTxRow(sp, creatorId, txCache) : null
          if (creatorTxid) {
            const rowTxid = txidFromRow(creator ?? {})?.toLowerCase()
            if (rowTxid !== creatorTxid) continue
          }
          const creatorLiveness = txLivenessFromStatus(creator?.status)
          const sats = Math.max(0, Math.trunc(Number(output.satoshis) || 0))
          const isChangeOutput = output.change === true || sats > 1
          const localChange =
            isChangeOutput &&
            creatorLiveness === 'pending' &&
            spentBy == null
          const settledChange =
            isChangeOutput &&
            creatorLiveness === 'settled' &&
            spentBy == null &&
            output.spendable !== true
          const orphanRecoveredChange =
            isChangeOutput &&
            spentBy == null &&
            output.spendable !== true &&
            creatorLiveness === 'none'

          const healed = await healLockingScript(sp, output, txCache, { fromChain: forSpendChain })
          if (healed == null && !hasLockingScript(output)) {
            unscripted += 1
            continue
          }

          if (onlyLiveChange) {
            if (!localChange) continue
          } else if (!localChange && !settledChange && !orphanRecoveredChange) {
            continue
          }

          await sp.updateOutput(outputId, {
            spendable: true,
            spentBy: undefined,
            ...(healed != null ? { lockingScript: healed } : {}),
          })
          restored += 1
        } catch (err) {
          console.warn(
            '[stale-output] restore skipped',
            outputId,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    })

    if (restored > 0) {
      console.info(
        `[stale-output] restored ${restored} live change output(s) previously marked unspendable`,
      )
    }
    if (keptSpent > 0) {
      console.info(
        `[stale-output] left ${keptSpent} locally-spent input(s) unspendable (network lag)`,
      )
    }
    if (unscripted > 0) {
      logDiag('stale-output', 'warn', 'unscripted-skipped', { count: unscripted })
    }
    return restored
  } catch (err) {
    console.warn('[stale-output] restore failed', err)
    return 0
  }
}
