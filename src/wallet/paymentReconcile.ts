/**
 * Reconcile earlier payments before the next one, after a restore.
 *
 * When a restore replaces localState, this device does not yet know which
 * payments it made in the window the history backup missed, or which payees
 * were never told. A payment started in that gap can pay the same person
 * twice. So the restore pulls the notice journal and re-queues every notice
 * still owed — the history's and the journal's — and lists in Activity any
 * payment the restored history no longer shows. Until that finishes, the next
 * payment waits (at most `RECONCILE_HOLD_MS`; a reconcile that cannot reach
 * the backup host must not stop the wallet paying).
 *
 * A journaled payment the restored history does not hold is resumed, never
 * re-made: its signed transaction (the journaled BEEF) seals its inputs here
 * before the hold lifts, so the next payment cannot spend them again, and is
 * then propagated as the same txid. A proven reject voids it and settles its
 * notice, so the payee is never told of a payment that cannot land. Without a
 * journaled BEEF its Activity row stays pending unless the chain shows it.
 *
 * Propagation and delivering the notices run afterwards and never hold a payment.
 */
import { accountKeyScopeFor, type BoundAccountKeyScope } from './accountLocalKeys'
import type { ActivityStatus } from './appActivity'
import { journalNoticeDone, noticeJournalBeef, syncNoticeJournal } from './noticeJournal'
import { paymentNoticeStatus } from './paymentNotice'
import {
  flushPendingBrc29Outbox,
  holdBrc29NoticeForVerdict,
  owedBrc29NoticeRows,
  reopenOwedBrc29Notices,
  type PendingBrc29Remit,
} from './pendingBrc29Outbox'
import type { SignedSendHandle } from './signedSendLifecycle'
import { assertRuntimeCurrent, type WalletRuntime } from './walletRuntime'

export const RECONCILE_HOLD_MS = 20_000

export type PaymentHold =
  | { kind: 'clear' }
  | { kind: 'reconciled'; waitedMs: number }
  | { kind: 'timedOut'; waitedMs: number }

let gate: { runtimeId: string; done: Promise<void> } | null = null

type Resumed = { handle: SignedSendHandle; row: PendingBrc29Remit; release: () => void }

type LostPayment =
  | { kind: 'known' }
  | { kind: 'resumed'; resumed: Resumed }
  | { kind: 'unproven'; onChain: boolean }

/**
 * What the restored wallet can say about an owed payment: its records hold it,
 * or it was resumed from the journaled transaction, or (no BEEF) only the
 * chain can vouch for it.
 */
async function reconcileLostPayment(runtime: WalletRuntime, owner: BoundAccountKeyScope, row: PendingBrc29Remit): Promise<LostPayment> {
  const vout = row.remittance.outputIndex ?? 0
  const status = await paymentNoticeStatus(runtime.instance, row.txid, vout).catch(() => null)
  if (status !== 'untracked') return { kind: 'known' }
  const beef = noticeJournalBeef(owner, row.txid)
  if (beef) {
    const release = holdBrc29NoticeForVerdict(row.txid)
    try {
      const { registerSignedSend } = await import('./signedSendLifecycle')
      const handle = await registerSignedSend({
        txid: row.txid,
        atomicBeef: beef,
        flow: 'brc29',
        satoshis: row.satoshis,
        to: row.payeeIdentityKey,
      })
      return { kind: 'resumed', resumed: { handle, row, release } }
    } catch (err) {
      release()
      throw err
    }
  }
  const { txExistsOnChain } = await import('./legacyScan')
  const onChain = await txExistsOnChain(row.txid, runtime.instance.chain).catch(() => null)
  return { kind: 'unproven', onChain: onChain === true }
}

/**
 * Resume or vouch for every owed payment; list in Activity those it does not
 * show. Resumed payments land in `resumed` as they are sealed, so a reconcile
 * cut short still propagates (and releases) every one it sealed.
 */
async function reconcileLostPayments(runtime: WalletRuntime, resumed: Resumed[]): Promise<number> {
  const owner = accountKeyScopeFor(runtime.instance)
  const rows = owedBrc29NoticeRows(owner)
  if (rows.length === 0) return 0
  const { formatActivityRecipientDisplay, hasActivityTxid, upsertAppActivity, WALLET_ACTIVITY_ORIGIN } =
    await import('./appActivity')
  const { listFriends } = await import('./friends')
  const labelOf = new Map(listFriends().map((f) => [f.identityKey.toLowerCase(), f.label]))
  let listed = 0
  for (const row of rows) {
    assertRuntimeCurrent(runtime)
    const fate = await reconcileLostPayment(runtime, owner, row).catch((err: unknown): LostPayment => {
      console.warn(
        `[payment-reconcile] payment ${row.txid.slice(0, 12)}… not resumed`,
        err instanceof Error ? err.message : String(err),
      )
      return { kind: 'unproven', onChain: false }
    })
    if (fate.kind === 'resumed') resumed.push(fate.resumed)
    if (hasActivityTxid(row.txid, 'spent', owner)) continue
    // A signed payment reads as sent; a late proven reject marks it failed.
    const status: ActivityStatus = fate.kind === 'unproven' && !fate.onChain ? 'pending' : 'complete'
    const to = row.payeeIdentityKey.toLowerCase()
    upsertAppActivity(
      {
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: row.satoshis,
        method: 'send',
        note: `Sent to ${formatActivityRecipientDisplay({ friendLabel: labelOf.get(to), to })}`,
        txid: row.txid,
        status,
      },
      owner,
    )
    listed += 1
  }
  return listed
}

/** Propagate the resumed payments; a proven reject voids one and settles its notice. */
async function propagateResumed(owner: BoundAccountKeyScope, resumed: Resumed[]): Promise<void> {
  if (resumed.length === 0) return
  const { propagateSignedSend } = await import('./signedSendLifecycle')
  await Promise.all(
    resumed.map(({ handle, row, release }) =>
      propagateSignedSend(handle)
        .catch((reason: unknown) => {
          console.warn(
            `[payment-reconcile] resumed payment ${row.txid.slice(0, 12)}… rejected — void, notice settled`,
            reason instanceof Error ? reason.message : String(reason),
          )
          journalNoticeDone(owner, row.txid, row.remittance.outputIndex ?? 0)
        })
        .finally(release),
    ),
  )
}

/**
 * After a restore replaced localState: pull the notice journal, re-queue what
 * is owed, list what Activity lost. The next payment waits for this. Never throws.
 */
export function reconcilePaymentsAfterRestore(runtime: WalletRuntime): Promise<void> {
  const started = Date.now()
  const owner = accountKeyScopeFor(runtime.instance)
  const resumed: Resumed[] = []
  const done = (async () => {
    try {
      const journal = await syncNoticeJournal(runtime.instance, 'recover')
      assertRuntimeCurrent(runtime)
      const queued = await reopenOwedBrc29Notices(runtime)
      const listed = await reconcileLostPayments(runtime, resumed)
      console.info(
        `[payment-reconcile] restore done ${Date.now() - started}ms — journal ${journal.kind}, ${queued} notice(s) queued, ` +
          `${listed} payment(s) relisted, ${resumed.length} resumed`,
      )
    } catch (err) {
      console.warn(
        `[payment-reconcile] restore incomplete after ${Date.now() - started}ms`,
        err instanceof Error ? err.message : String(err),
      )
    }
  })()
  gate = { runtimeId: runtime.runtimeId, done }
  void done.then(async () => {
    if (gate?.done === done) gate = null
    try {
      // A rejected payment's notice is settled before the flush could send it.
      await propagateResumed(owner, resumed)
      await flushPendingBrc29Outbox({ rootKeyHex: runtime.instance.rootKeyHex, runtime })
    } catch (err) {
      console.warn('[payment-reconcile] notices deferred', err instanceof Error ? err.message : String(err))
    }
  })
  return done
}

/** Wait for a running restore reconcile before a payment. Never throws. */
export async function awaitPaymentReconcile(
  runtime: WalletRuntime | null,
  timeoutMs = RECONCILE_HOLD_MS,
): Promise<PaymentHold> {
  const held = gate
  if (!held || !runtime || held.runtimeId !== runtime.runtimeId) return { kind: 'clear' }
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const finished = await Promise.race([
    held.done.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    }),
  ])
  clearTimeout(timer)
  const waitedMs = Date.now() - started
  if (!finished) {
    console.warn(`[payment-reconcile] payment held ${waitedMs}ms — reconcile still running, sending anyway`)
    return { kind: 'timedOut', waitedMs }
  }
  if (waitedMs >= 250) console.info(`[payment-reconcile] payment held done ${waitedMs}ms`)
  return { kind: 'reconciled', waitedMs }
}

export function resetPaymentReconcileForTests(): void {
  gate = null
}
