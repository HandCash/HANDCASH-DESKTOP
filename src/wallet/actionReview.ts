/**
 * Handle toolbox `WERR_REVIEW_ACTIONS` (undelayed create/sign failures) and
 * local failed actions that block later spends after ghost broadcasts.
 */
import { getActiveWallet, type ActiveWallet } from './session'
import { txExistsOnChain } from './legacyScan'
import { healGhostSentItems } from './sentItemGuard'
import { forgetOneSatImported } from './oneSatImportGuard'
import { sweepChangeScripts } from './changeScriptFate'

export type ReviewActionRow = {
  txid?: string
  status?: string
  competingTxs?: string[]
}

export type SendWithRow = {
  txid?: string
  status?: string
}

export function isReservedActionBatchError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes('not reserved by an active action batch') ||
    msg.includes('reserved by an active action batch')
  )
}

/**
 * Abort leftover `noSend` actions (from older HandCash settle paths) and
 * reserved batches so the next createAction is not a double-spend.
 */
export async function releaseStuckNosends(
  active?: ActiveWallet | null,
): Promise<void> {
  const wallet = (active ?? getActiveWallet())?.wallet
  if (!wallet) return
  try {
    await wallet.listNoSendActions({ labels: [], limit: 100 }, true)
  } catch (err) {
    console.warn('[action-review] listNoSendActions abort skipped', err)
  }
  try {
    await wallet.actionBatch.abort()
  } catch {
    /* unused funding reservations only */
  }
  await repairFailedSpendState(active ?? getActiveWallet())
}

/**
 * Release leftover action-batch output reservations (in-memory workspace +
 * persisted IDB rows). Does **not** abort signed noSend txs — those may already
 * be delivered to a peer. Failed unsigned batches are what block the next spend.
 */
export async function abortReservedActionBatches(
  active?: ActiveWallet | null,
): Promise<number> {
  const wallet = (active ?? getActiveWallet())?.wallet
  if (!wallet) return 0
  let aborted = 0

  try {
    if (await wallet.actionBatch.abort()) aborted += 1
  } catch (err) {
    console.warn('[action-review] actionBatch.abort skipped', err)
  }

  try {
    const storage = wallet.storage
    const listed = await storage.runAsStorageProvider(async (sp) => {
      const future = new Date(Date.now() + 2 * 60 * 60 * 1000)
      return sp.findExpiredActionBatches(future)
    })
    for (const batch of listed ?? []) {
      const batchId = String(
        (batch as { batchId?: string }).batchId ?? '',
      ).trim()
      if (!batchId) continue
      try {
        const result = await storage.abortActionBatch(batchId)
        if (result?.aborted !== false) aborted += 1
      } catch (err) {
        console.warn('[action-review] abortActionBatch skipped', batchId, err)
      }
    }
  } catch (err) {
    console.warn('[action-review] persisted action-batch abort skipped', err)
  }

  if (aborted > 0) {
    console.info(`[action-review] aborted ${aborted} reserved action batch(es)`)
  }
  return aborted
}

/**
 * Fail abandoned unsigned/unprocessed txs, run toolbox reviewStatus to free
 * inputs stuck on failed spends, then rebuild or quarantine change outs that
 * have no lockingScript (those crash createAction as `Array.from(undefined)` —
 * see `changeScriptFate`).
 *
 * Does **not** listFailedActions(unfail) — that requeues doubleSpends into
 * TaskSendWaiting and poisons the next pay.
 */
export async function repairFailedSpendState(
  active?: ActiveWallet | null,
): Promise<{
  failedTxs: number
  reviewLog: string
  quarantined: number
  healed: number
}> {
  const resolved = active ?? getActiveWallet()
  const wallet = resolved?.wallet
  const empty = { failedTxs: 0, reviewLog: '', quarantined: 0, healed: 0 }
  if (!wallet?.storage) return empty

  let failedTxs = 0
  let reviewLog = ''

  try {
    failedTxs = await wallet.storage.runAsStorageProvider(async (sp) => {
      let n = 0
      const stuck = await sp.findTransactions({
        partial: {},
        status: ['unprocessed', 'unsigned'],
        noRawTx: true,
        paged: { limit: 100, offset: 0 },
      })
      for (const tx of stuck ?? []) {
        const id = Number((tx as { transactionId?: number }).transactionId)
        if (!Number.isFinite(id) || id <= 0) continue
        try {
          await sp.updateTransactionStatus('failed', id)
          n += 1
        } catch (err) {
          console.warn('[action-review] fail abandoned tx skipped', id, err)
        }
      }
      return n
    })
    if (failedTxs > 0) {
      console.info(`[action-review] failed ${failedTxs} abandoned unsigned/unprocessed tx(s)`)
    }
  } catch (err) {
    console.warn('[action-review] abandon-fail skipped', err)
  }

  try {
    const review = await wallet.storage.runAsStorageProvider(async (sp) =>
      sp.reviewStatus({ agedLimit: new Date(0) }),
    )
    reviewLog = String((review as { log?: string })?.log ?? '')
    if (reviewLog.trim()) {
      console.info('[action-review] reviewStatus', reviewLog.trim().slice(0, 400))
    }
  } catch (err) {
    console.warn('[action-review] reviewStatus skipped', err)
  }

  const sweep = await sweepChangeScripts({ active: resolved })

  return {
    failedTxs,
    reviewLog,
    quarantined: sweep.quarantined,
    healed: sweep.healed,
  }
}

export function isIteratorCrashError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('is not iterable')
}

export function isReviewActionsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    name?: string
    code?: number
    reviewActionResults?: unknown
    message?: string
  }
  if (e.name === 'WERR_REVIEW_ACTIONS' || e.code === 5) return true
  if (Array.isArray(e.reviewActionResults)) return true
  const msg = (e.message ?? String(err)).toLowerCase()
  return msg.includes('require review') && msg.includes('undelayed')
}

export function reviewActionRows(err: unknown): ReviewActionRow[] {
  if (!err || typeof err !== 'object') return []
  const rows = (err as { reviewActionResults?: unknown }).reviewActionResults
  return Array.isArray(rows) ? (rows as ReviewActionRow[]) : []
}

export function sendWithRows(err: unknown): SendWithRow[] {
  if (!err || typeof err !== 'object') return []
  const rows = (err as { sendWithResults?: unknown }).sendWithResults
  return Array.isArray(rows) ? (rows as SendWithRow[]) : []
}

/** True when delayed/undelayed sendWithResults report a hard failure. */
export function sendWithHasFailure(rows: SendWithRow[] | undefined | null): boolean {
  if (!rows?.length) return false
  return rows.some((r) => {
    const s = (r.status ?? '').toLowerCase()
    return s === 'failed' || s === 'doublespend' || s === 'invalid' || s === 'invalidtx'
  })
}

export function formatReviewActionsError(err: unknown): string {
  const reviews = reviewActionRows(err)
  const sends = sendWithRows(err)
  const statuses = [
    ...reviews.map((r) => r.status).filter(Boolean),
    ...sends.map((r) => r.status).filter(Boolean),
  ].map((s) => String(s).toLowerCase())
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  if (
    statuses.some((s) => s.includes('doublespend')) ||
    msg.includes('doublespend') ||
    msg.includes('double spend') ||
    msg.includes('is not iterable')
  ) {
    return 'A previous failed send is blocking this payment. Cleared local conflicts — try Send again.'
  }
  if (statuses.some((s) => s.includes('service') || s === 'error')) {
    return 'Broadcast service error — check connection and try again.'
  }
  if (statuses.some((s) => s.includes('invalid'))) {
    return 'The network rejected this transaction. Try again or Refresh first.'
  }
  return 'Send did not confirm on the network. Try again after Refresh.'
}

/**
 * Queue failed actions for recovery, drop ghost sent hides, and abort the
 * current signable reference when we still have one.
 */
export async function recoverFromReviewActions(args: {
  err: unknown
  reference?: string | null
  tipOutpoints?: string[]
  active?: ActiveWallet | null
}): Promise<void> {
  const active = args.active ?? getActiveWallet()
  if (!active) return

  if (args.reference?.trim()) {
    try {
      await active.wallet.abortAction({ reference: args.reference.trim() })
    } catch (abortErr) {
      console.warn('[action-review] abortAction skipped', abortErr)
    }
  }

  await abortReservedActionBatches(active)

  // Do not listFailedActions(unfail): leftover doubleSpends re-enter
  // TaskSendWaiting, poison the next real payment, and can surface as
  // "undefined is not iterable". Fail abandoned txs + reviewStatus instead.
  await repairFailedSpendState(active)

  // `Array.from(undefined)` means a change row reached createAction with no
  // locking script. The pre-send sweep only rebuilds from local raw tx; here a
  // coin is already blocking the wallet, so pay for chain lookups and let the
  // audited restore path re-enable whatever we rebuilt.
  if (isIteratorCrashError(args.err)) {
    const rebuilt = await sweepChangeScripts({ active, fromChain: true })
    if (rebuilt.healed > 0) {
      const { restoreLiveSpendableOutputs } = await import('./staleOutputRelease')
      await restoreLiveSpendableOutputs()
    }
  }

  try {
    const healed = await healGhostSentItems(active.chain, txExistsOnChain)
    if (healed.length > 0) {
      forgetOneSatImported(healed)
      console.info('[action-review] restored ghost-hidden tips', healed)
    }
  } catch (healErr) {
    console.warn('[action-review] ghost heal skipped', healErr)
  }

  if (args.tipOutpoints?.length) {
    forgetOneSatImported(args.tipOutpoints)
  }

  const reviews = reviewActionRows(args.err)
  const competing = reviews.flatMap((r) => r.competingTxs ?? [])
  const own = [
    typeof (args.err as { txid?: string })?.txid === 'string'
      ? (args.err as { txid: string }).txid
      : '',
    ...reviews.map((r) => r.txid ?? ''),
    ...sendWithRows(args.err).map((r) => r.txid ?? ''),
  ]
  for (const txid of [...new Set([...own, ...competing])]) {
    const id = txid.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(id)) continue
    try {
      const exists = await txExistsOnChain(id, active.chain)
      console.info(`[action-review] tx ${id.slice(0, 12)}… on-chain=${exists}`)
    } catch {
      /* lookup noise */
    }
  }
}
