/**
 * What the user may do about a spend that never confirmed — items and payments.
 *
 * A chain 404 alone never authorizes another spend. Retry is offered only when
 * the wallet can prove the original funds are still spendable, and the exact
 * recipient data was persisted with the attempt.
 *
 * Clearing is not a cancel. A signed transaction stays in Activity until every
 * one of its inputs is already spent on chain. Dropping the row earlier, then
 * repairing local spend state, is how a later resync can lose the coins that
 * transaction still holds. Unsigned attempts (no txid) never bound those coins.
 */
import { inputOutpointsFromRawTx } from './txOutpoints'
import {
  countFailedActivity,
  isFailedActivity,
  listFailedActivity,
  removeActivityById,
  removeFailedActivity,
  type ActivityEntry,
  type ActivityRetry,
} from './appActivity'
import { isCollectableOutpointSpendable, sendCollectable } from './collectables'
import {
  getCachedFungibles,
  getFungible,
} from './fungibles'
import { sendFungible } from './sendFungible'
import { counterpartyMaySettle } from './sentItemGuard'
import { getBeefForTxidCached } from './beefCache'
import {
  parseOutpoint,
  spentStatusOfOutpoint,
  txExistsOnChain,
} from './legacyScan'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { getActiveWallet } from './session'
import { itemSendMachine, maySenderBroadcast } from './itemSendMachine'
import { getTxByTxid } from './txStore'
import type { Chain } from './vault'
import { createActor } from 'xstate'

export type SpendAttemptFate =
  | { kind: 'notAttempt' }
  | { kind: 'checking' }
  | { kind: 'confirmed' }
  | {
      kind: 'refuse'
      reason:
        | 'statusUnknown'
        | 'missingRetryDetails'
        | 'sourceNotSpendable'
        /**
         * Every input of this signed send is already spent on chain. The row
         * is history only — clearing it does not undo the spend.
         */
        | 'inputsSpent'
        /**
         * The transfer left this wallet and the payee may still broadcast it.
         * Neither retry nor clear is safe: retry would race a live transaction,
         * and clearing would delete the sender's only record of an item that can
         * still land in the recipient's wallet.
         */
        | 'counterpartyMaySettle'
      message: string
      mayClear: boolean
      /**
       * Reserved coins may be released even when the row must stay. Repair only
       * fails *unsigned* transactions, so it frees a stuck balance without
       * touching a signed transfer the payee still holds.
       */
      mayReleaseFunds?: boolean
    }
  | {
      kind: 'retry'
      /**
       * `rebroadcast` re-submits the transaction this attempt already signed.
       * `recreateItem` re-runs a collectable / token send that died before signing.
       * `reopenPayment` hands a coin send back to the Send screen — the wallet
       * must never silently re-spend coins on the user's behalf.
       */
      action: 'rebroadcast' | 'recreateItem' | 'reopenPayment'
      retry: ActivityRetry
      message: string
      mayClear: boolean
    }

const ITEM_METHOD = 'send-collectable'
const TOKEN_METHOD = 'send-token'
const BSV_METHOD = 'send'
const INPUTS_STILL_LIVE =
  'This transaction cannot be cleared while its inputs are still unspent.'

/**
 * How long a broadcast row is left alone before a chain 404 counts as trouble.
 * Item / token sends can be settled by the payee (`peerDeliver`), so their
 * transaction is legitimately absent for far longer than a coin payment's.
 */
const ITEM_UNCONFIRMED_GRACE_MS = 10 * 60_000
const BSV_UNCONFIRMED_GRACE_MS = 2 * 60_000

function isItemOrTokenMethod(method: string): boolean {
  return method === ITEM_METHOD || method === TOKEN_METHOD
}

export function isSpendAttempt(
  entry: ActivityEntry | null,
  now = Date.now(),
): boolean {
  if (!entry || entry.kind !== 'spent' || entry.status === 'pending') return false
  const isItemLike = isItemOrTokenMethod(entry.method)
  if (isItemLike ? !entry.item : entry.method !== BSV_METHOD) return false
  if (isFailedActivity(entry)) return true
  const grace = isItemLike ? ITEM_UNCONFIRMED_GRACE_MS : BSV_UNCONFIRMED_GRACE_MS
  return now - entry.at >= grace
}

/**
 * True when the payee still owns the outcome of this item / token transfer.
 *
 * A failed row is not automatically a dead row: on a `peerDeliver` settle the
 * signed transfer is already in the recipient's inbox, so it can land hours
 * later. Offering retry or clear in that window is how a sender either races a
 * live transaction or deletes the only local record of an item that is really
 * gone.
 */
export function isCounterpartySettlePending(
  entry: ActivityEntry,
  now = Date.now(),
): boolean {
  if (!isItemOrTokenMethod(entry.method)) return false
  const outpoint =
    entry.retry?.kind === 'send-collectable'
      ? entry.retry.outpoint
      : entry.item?.outpoint
  if (!outpoint) return false
  return counterpartyMaySettle(outpoint, now)
}

function hasTxid(entry: ActivityEntry): boolean {
  return Boolean(entry.txid && /^[0-9a-f]{64}$/i.test(entry.txid))
}

type SignedInputsFate = 'unsigned' | 'spent' | 'unspent' | 'unknown'

async function loadLocalRawTx(txid: string): Promise<number[] | null> {
  const storage = getActiveWallet()?.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  try {
    const found = await storage.runAsStorageProvider(
      async (sp: {
        getProvenOrRawTx?: (id: string) => Promise<{ rawTx?: number[] } | undefined>
      }) => {
        if (typeof sp.getProvenOrRawTx !== 'function') return undefined
        return sp.getProvenOrRawTx(txid)
      },
    )
    const raw = found?.rawTx
    if (Array.isArray(raw) && raw.length > 0) return raw
  } catch (err) {
    console.warn('[spend-attempt] local raw tx lookup skipped', err)
  }
  return null
}

async function loadSignedInputOutpoints(txid: string): Promise<string[]> {
  const raw = await loadLocalRawTx(txid)
  if (raw?.length) {
    const fromRaw = inputOutpointsFromRawTx(raw)
    if (fromRaw.length > 0) return fromRaw
  }
  const stored = getTxByTxid(txid)?.inputOutpoints ?? []
  const dotted: string[] = []
  for (const key of stored) {
    const parsed = parseOutpoint(key)
    if (parsed) dotted.push(`${parsed.txid}.${parsed.vout}`)
  }
  return dotted
}

/**
 * Spend status of every input on a signed attempt.
 *
 * Clear is allowed only for `unsigned` (nothing was signed) or `spent` (the
 * coins already moved). `unspent` and `unknown` keep the row — the latter is
 * how a missing body or indexer silence fails closed.
 */
async function signedTxInputsFate(
  entry: ActivityEntry,
  chain: Chain,
): Promise<SignedInputsFate> {
  if (!hasTxid(entry)) return 'unsigned'
  const outpoints = await loadSignedInputOutpoints(entry.txid!)
  if (outpoints.length === 0) return 'unknown'
  const statuses = await Promise.all(
    outpoints.map((outpoint) => spentStatusOfOutpoint(outpoint, chain)),
  )
  if (statuses.some((s) => s === 'unknown')) return 'unknown'
  if (statuses.some((s) => s === 'unspent')) return 'unspent'
  return 'spent'
}

function mayClearSignedInputs(
  fate: SignedInputsFate,
  txConfirmedOnChain: boolean | null = null,
): boolean {
  if (fate === 'unsigned' || fate === 'spent') return true
  // Signed but never broadcast — inputs still local; safe to drop the history row.
  if (fate === 'unspent' && txConfirmedOnChain === false) return true
  return false
}

/** True when the wallet still holds enough of this token to recreate the send. */
function isTokenSendRetryable(
  retry: Extract<ActivityRetry, { kind: 'send-token' }>,
): boolean | null {
  try {
    const token =
      getFungible(retry.tokenId) ??
      getCachedFungibles().find(
        (t) => t.tokenId === retry.tokenId || t.tokenIds?.includes(retry.tokenId),
      )
    if (!token) return false
    if (token.spendKind === 'cosigned' || token.spendKind === 'mixed') return false
    const held = BigInt(token.amt.replace(/\D/g, '') || '0')
    const need = BigInt(retry.amount.replace(/\D/g, '') || '0')
    if (need <= 0n) return false
    return held >= need
  } catch {
    return null
  }
}

export async function resolveSpendAttemptFate(
  entry: ActivityEntry,
  chain: Chain,
): Promise<SpendAttemptFate> {
  if (!isSpendAttempt(entry)) return { kind: 'notAttempt' }

  if (isCounterpartySettlePending(entry)) {
    return {
      kind: 'refuse',
      reason: 'counterpartyMaySettle',
      message:
        'The recipient has this transfer and can still broadcast it, so it is not lost. Retrying would race a live transaction and clearing would delete your only record of it.',
      mayClear: false,
      mayReleaseFunds: true,
    }
  }

  let txOnChain: boolean | null = null
  if (hasTxid(entry)) {
    const onChain = await Promise.resolve(
      txExistsOnChain(entry.txid!, chain),
    ).catch(() => null)
    if (onChain === true) return { kind: 'confirmed' }
    if (onChain === null) {
      return {
        kind: 'refuse',
        reason: 'statusUnknown',
        message:
          'Confirmation status is unavailable. Retry stays disabled until the chain can be checked.',
        mayClear: false,
      }
    }
    txOnChain = onChain
  }

  const inputsFate = await signedTxInputsFate(entry, chain)
  if (inputsFate === 'spent') {
    return {
      kind: 'refuse',
      reason: 'inputsSpent',
      message:
        'The coins this send used are already spent on chain. You can drop the history row — that does not undo the spend.',
      mayClear: true,
    }
  }

  const retry = entry.retry
  if (!retry) {
    return {
      kind: 'refuse',
      reason: 'missingRetryDetails',
      message: isFailedActivity(entry)
        ? 'This send failed and cannot be retried — its original recipient details were not saved.'
        : 'This send did not confirm and cannot be retried — its original recipient details were not saved.',
      mayClear: mayClearSignedInputs(inputsFate, txOnChain),
    }
  }

  if (retry.kind === 'send-bsv') {
    return {
      kind: 'retry',
      action: 'reopenPayment',
      retry,
      message: hasTxid(entry)
        ? 'This payment never landed on chain. You can send it again from the Send screen.'
        : 'This payment failed before it reached the network. You can send it again from the Send screen, or clear it.',
      mayClear: mayClearSignedInputs(inputsFate, txOnChain),
    }
  }

  if (retry.kind === 'send-token') {
    const spendable = isTokenSendRetryable(retry)
    if (spendable === null) {
      return {
        kind: 'refuse',
        reason: 'statusUnknown',
        message:
          'Token balance could not be checked. Retry stays disabled until the wallet refreshes.',
        mayClear: false,
      }
    }
    if (!spendable) {
      return {
        kind: 'refuse',
        reason: 'sourceNotSpendable',
        message:
          'This send cannot be retried — there is no longer enough of this token spendable in this wallet.',
        mayClear: mayClearSignedInputs(inputsFate, txOnChain),
      }
    }
    return {
      kind: 'retry',
      action: hasTxid(entry) ? 'rebroadcast' : 'recreateItem',
      retry,
      message: hasTxid(entry)
        ? 'This send did not confirm. The token tips are still unspent, so the signed transfer can be broadcast again.'
        : 'This send failed before it produced a transaction. The token is still spendable and can be retried.',
      mayClear: mayClearSignedInputs(inputsFate, txOnChain),
    }
  }

  const spendable = await Promise.resolve(
    isCollectableOutpointSpendable(retry.outpoint),
  ).catch(() => null)
  if (spendable === null) {
    return {
      kind: 'refuse',
      reason: 'statusUnknown',
      message:
        'Item spendability could not be checked. Retry stays disabled until the wallet refreshes.',
      mayClear: false,
    }
  }
  if (!spendable) {
    return {
      kind: 'refuse',
      reason: 'sourceNotSpendable',
      message:
        'This send cannot be retried — the original item output is no longer spendable in this wallet.',
      mayClear: mayClearSignedInputs(inputsFate, txOnChain),
    }
  }

  return {
    kind: 'retry',
    action: hasTxid(entry) ? 'rebroadcast' : 'recreateItem',
    retry,
    message: hasTxid(entry)
      ? 'This send did not confirm. The item is still unspent, so the signed transfer can be broadcast again.'
      : 'This send failed before it produced a transaction. The item is still spendable and can be retried.',
    mayClear: mayClearSignedInputs(inputsFate, txOnChain),
  }
}

export type SpendAttemptRetryResult =
  | { kind: 'rebroadcasted'; txid: string }
  | { kind: 'recreated'; txid: string }
  | { kind: 'reopenPayment'; toAddress: string; satoshis: number }

/**
 * Retry the transaction this attempt already signed when one exists. A new
 * spend is created only for an item / token attempt that never produced a
 * txid; coin payments are handed back to the Send screen instead.
 */
export async function retrySpendAttempt(
  entry: ActivityEntry,
  chain: Chain,
): Promise<SpendAttemptRetryResult> {
  const fate = await resolveSpendAttemptFate(entry, chain)
  if (fate.kind !== 'retry') {
    throw new Error(
      fate.kind === 'refuse' ? fate.message : 'This send cannot be retried.',
    )
  }

  if (fate.action === 'reopenPayment' && fate.retry.kind === 'send-bsv') {
    return {
      kind: 'reopenPayment',
      toAddress: fate.retry.toAddress,
      satoshis: fate.retry.satoshis,
    }
  }

  if (fate.retry.kind === 'send-token') {
    if (fate.action === 'recreateItem') {
      const sent = await sendFungible({
        tokenId: fate.retry.tokenId,
        amount: fate.retry.amount,
        toAddress: fate.retry.toAddress,
        recipientIdentityKey: fate.retry.recipientIdentityKey,
        friendLabel: fate.retry.friendLabel,
      })
      return { kind: 'recreated', txid: sent.txid }
    }
    const spentTip = entry.item?.outpoint?.trim()
    if (!spentTip) {
      throw new Error(
        'The token input for this signed transfer is no longer available.',
      )
    }
    return rebroadcastSignedTransfer(entry, spentTip)
  }

  if (fate.retry.kind !== 'send-collectable') {
    throw new Error('This send cannot be retried.')
  }

  if (fate.action === 'recreateItem') {
    const sent = await sendCollectable({
      outpoint: fate.retry.outpoint,
      toAddress: fate.retry.toAddress,
      recipientIdentityKey: fate.retry.recipientIdentityKey,
      friendLabel: fate.retry.friendLabel,
      name: entry.item?.name,
      origin: entry.item?.origin,
      app: entry.item?.app,
    })
    return { kind: 'recreated', txid: sent.txid }
  }

  return rebroadcastSignedTransfer(entry, fate.retry.outpoint)
}

async function rebroadcastSignedTransfer(
  entry: ActivityEntry,
  chartKey: string,
): Promise<SpendAttemptRetryResult> {
  const txid = entry.txid?.trim().toLowerCase() ?? ''
  const active = getActiveWallet()
  if (!active || !/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error('The signed transfer is no longer available to rebroadcast.')
  }
  const chart = createActor(itemSendMachine).start()
  chart.send({ type: 'RETRY_BROADCAST', outpoint: chartKey, txid })
  if (!maySenderBroadcast(chart.getSnapshot())) {
    chart.stop()
    throw new Error('The item send statechart refused this broadcast retry.')
  }
  let atomic: number[]
  try {
    const beef = await getBeefForTxidCached(active, txid, {
      allowUnprovenRawTx: true,
    })
    atomic = Array.from(beef.toBinaryAtomic(txid))
  } catch {
    chart.send({ type: 'FAIL', error: 'Signed transaction body unavailable' })
    chart.stop()
    throw new Error(
      'The signed transaction body is no longer available. This attempt cannot be retried.',
    )
  }
  if (!(await broadcastAtomicBeef(txid, atomic))) {
    chart.send({ type: 'FAIL', error: 'Network refused broadcast retry' })
    chart.stop()
    throw new Error(
      'The network did not accept the transfer. The original output remains safe.',
    )
  }
  chart.send({ type: 'BROADCASTED' })
  chart.stop()
  return { kind: 'rebroadcasted', txid }
}

function fateAllowsClear(fate: SpendAttemptFate): boolean {
  return (
    (fate.kind === 'retry' || fate.kind === 'refuse') && fate.mayClear === true
  )
}

/**
 * Drop a dead attempt from Activity.
 *
 * Unsigned rows (no txid) may also release local reservations they left on our
 * outputs. A signed row is only removed once every input is spent on chain.
 * Clearing that row keeps its change spendable and hides the spent inputs —
 * it does not undo the spend and does not run unsigned-tx repair.
 */
export async function clearSpendAttempt(
  entry: ActivityEntry,
): Promise<{ removed: boolean }> {
  if (isCounterpartySettlePending(entry)) {
    throw new Error(
      'The recipient can still broadcast this transfer, so it cannot be cleared yet.',
    )
  }
  const chain = getActiveWallet()?.chain
  if (!chain) {
    throw new Error('Wallet is not unlocked.')
  }
  const fate = await resolveSpendAttemptFate(entry, chain)
  if (!fateAllowsClear(fate)) {
    throw new Error(
      fate.kind === 'refuse' ? fate.message : INPUTS_STILL_LIVE,
    )
  }
  if (!hasTxid(entry)) await releaseLocalSpendReservations()
  else {
    const inputsFate = await signedTxInputsFate(entry, chain)
    if (inputsFate === 'spent') {
      const { keepChangeOfSignedTx, hideSpentOutpoints } = await import(
        './staleOutputRelease'
      )
      const inputs = await loadSignedInputOutpoints(entry.txid!)
      if (inputs.length > 0) await hideSpentOutpoints(inputs)
      await keepChangeOfSignedTx(entry.txid!)
    }
  }
  return { removed: removeActivityById(entry.id) }
}

/**
 * Free the coins a dead attempt reserved, without touching history.
 *
 * Repair only fails *unsigned* transactions, so this unblocks a balance that a
 * half-built send is sitting on while leaving any signed transfer — and every
 * Activity row — alone. It is the safe half of "clear" for an attempt whose
 * record has to stay.
 */
export async function releaseSpendAttemptFunds(): Promise<void> {
  await releaseLocalSpendReservations()
}

/**
 * Clear failed sends from history in one pass.
 *
 * Unsigned rows may repair local reservations first. Signed rows are dropped
 * only when every input is already spent on chain, and never through that
 * repair. Item transfers the payee can still broadcast are kept. Returns how
 * many rows were removed and how many were kept back.
 */
export async function clearAllFailedSpends(): Promise<{
  removed: number
  kept: number
}> {
  const now = Date.now()
  const chain = getActiveWallet()?.chain
  const failed = countFailedActivity()
  const keepIds = new Set<string>()
  let unsignedToClear = false

  const toKeepChange: string[] = []

  for (const row of listFailedActivity()) {
    if (isCounterpartySettlePending(row, now)) {
      keepIds.add(row.id)
      continue
    }
    if (!hasTxid(row)) {
      unsignedToClear = true
      continue
    }
    if (!chain) {
      keepIds.add(row.id)
      continue
    }
    let txOnChain: boolean | null = null
    if (hasTxid(row)) {
      txOnChain = await txExistsOnChain(row.txid!, chain).catch(() => null)
      if (txOnChain === null) {
        keepIds.add(row.id)
        continue
      }
    }
    const inputsFate = await signedTxInputsFate(row, chain)
    if (!mayClearSignedInputs(inputsFate, txOnChain)) keepIds.add(row.id)
    else if (inputsFate === 'spent') toKeepChange.push(row.txid!)
  }

  if (unsignedToClear) await releaseLocalSpendReservations()
  if (toKeepChange.length > 0) {
    const { keepChangeOfSignedTx, hideSpentOutpoints } = await import(
      './staleOutputRelease'
    )
    const cleanupFailedTxids = new Set<string>()
    for (const txid of toKeepChange) {
      try {
        const inputs = await loadSignedInputOutpoints(txid)
        if (inputs.length > 0) await hideSpentOutpoints(inputs)
        await keepChangeOfSignedTx(txid)
      } catch (err) {
        console.warn('[spend-attempt] clear failed row cleanup skipped', txid, err)
        cleanupFailedTxids.add(txid.toLowerCase())
      }
    }
    if (cleanupFailedTxids.size > 0) {
      for (const row of listFailedActivity()) {
        const txid = row.txid?.toLowerCase()
        if (txid && cleanupFailedTxids.has(txid)) keepIds.add(row.id)
      }
    }
  }
  const removed = removeFailedActivity((entry) => keepIds.has(entry.id))
  return { removed, kept: Math.max(0, failed - removed) }
}

/** Failed sends whose signed transfer can be re-submitted without a new spend. */
export async function countRebroadcastableFailedSpends(
  chain: Chain,
): Promise<number> {
  let count = 0
  for (const row of listFailedActivity()) {
    if (isCounterpartySettlePending(row)) continue
    const fate = await resolveSpendAttemptFate(row, chain)
    if (fate.kind === 'retry' && fate.action === 'rebroadcast') count += 1
  }
  return count
}

/**
 * Rebroadcast every failed send that already has a signed transfer.
 *
 * Unsigned failures and coin payments are skipped — those need a fresh send from
 * the Send screen, not a silent rebroadcast.
 */
export async function rebroadcastAllFailedSpends(): Promise<{
  rebroadcasted: number
  skipped: number
  failed: number
  errors: string[]
}> {
  const chain = getActiveWallet()?.chain
  if (!chain) throw new Error('Wallet is not unlocked.')

  let rebroadcasted = 0
  let skipped = 0
  let failed = 0
  const errors: string[] = []

  for (const row of listFailedActivity()) {
    if (isCounterpartySettlePending(row)) {
      skipped += 1
      continue
    }
    const fate = await resolveSpendAttemptFate(row, chain)
    if (fate.kind !== 'retry' || fate.action !== 'rebroadcast') {
      skipped += 1
      continue
    }
    try {
      await retrySpendAttempt(row, chain)
      rebroadcasted += 1
    } catch (err) {
      failed += 1
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  return { rebroadcasted, skipped, failed, errors }
}

/** Best-effort release of the local reservations a dead spend left behind. */
const RELEASE_RESERVATIONS_BUDGET_MS = 30_000

async function withClearBudget<T>(
  label: string,
  ms: number,
  work: () => Promise<T>,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } catch (err) {
    console.warn(`[spend-attempt] ${label} skipped`, err)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function releaseLocalSpendReservations(): Promise<void> {
  const repair = await withClearBudget(
    'release unsigned spend reservations',
    RELEASE_RESERVATIONS_BUDGET_MS,
    async () => {
      const { releaseUnsignedSpendReservations } = await import('./actionReview')
      return releaseUnsignedSpendReservations()
    },
  )
  if (
    repair &&
    (repair.failedTxs > 0 || repair.batchesAborted > 0 || repair.reviewLog.trim())
  ) {
    console.info('[spend-attempt] cleared local spend state', repair)
  }
}
