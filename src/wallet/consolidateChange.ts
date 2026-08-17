/**
 * Background change consolidation.
 *
 * Many small BRC-29 receives leave the wallet with a fragmented managed-change
 * pool, and `createAction` coin selection walks that pool on every send — so a
 * badly fragmented wallet signs slowly. This pass collapses the whole spendable
 * change pool into a single managed-change UTXO with one self-payment, using the
 * toolbox `maxPossibleSatoshis` "largest fundable amount" output. That is the
 * same primitive the toolbox's own `Wallet.sweepTo` uses, aimed at our own
 * identity instead of another wallet.
 *
 * Safety (mirrors `.cursor/rules/explicit-wallet-paths.mdc`):
 * - The decision is a tagged union ({@link planChangeConsolidation}) — never a
 *   bare `count > N`.
 * - Only spendable managed change is selected. Assets (`1sat`, `bsv21`) live in
 *   their own baskets and the toolbox change allocator never touches them, so a
 *   consolidation can never sweep an ordinal or a token.
 * - It runs in the exclusive spend region ({@link runExclusiveSpend}), so it can
 *   never race a user send; a queued send simply waits out the one self-payment.
 * - It yields when a spend is already waiting, is rate-limited by a cooldown,
 *   and is fully fail-closed: any error logs and returns, never throwing into
 *   chain ingest.
 */
import { createNonce, P2PKH, PublicKey } from '@bsv/sdk'
import { getActiveWallet, type ActiveWallet } from './session'
import { assertOnlineForPayment } from './paymentPolicy'
import { runExclusiveSpend } from './spendGuard'
import {
  isRecomposeCoordinatorActive,
  shouldYieldChainIngestToSpend,
} from './walletCoordinator'
import { withVisibleOnChainBeef } from './legacyBeef'
import { sealSpentInputsOfSignedTx } from './staleOutputRelease'
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  BRC29_PROTOCOL_ID,
  atomicBeefFromCreateAction,
  ensurePaymentBroadcasted,
} from './sendBrc29Payment'
import {
  planChangeConsolidation,
  type ChangeConsolidationStats,
} from './changeConsolidationPath'

/**
 * Mirror of wallet-toolbox `generateChange.maxPossibleSatoshis`. One output of
 * this value is adjusted down by the toolbox to the largest fundable amount,
 * which pulls in every available change input — exactly the consolidation we
 * want. Kept as a local constant so we do not import a deep toolbox path.
 */
export const MAX_POSSIBLE_SATOSHIS = 2_099_999_999_999_999

/** Do not attempt more than once per this interval (success or failure). */
const CONSOLIDATION_COOLDOWN_MS = 10 * 60_000
const ENUM_PAGE = 500
const ENUM_MAX_PAGES = 20

let lastConsolidationAttemptAt = 0

/** Test-only — reset the cooldown between cases. */
export function __resetConsolidationCooldownForTests(): void {
  lastConsolidationAttemptAt = 0
}

export type ConsolidationOutcome =
  | { ran: true; txid: string; fragments: number }
  | {
      ran: false
      reason:
        | 'cooldown'
        | 'spendPending'
        | 'locked'
        | 'offline'
        | 'noStorage'
        | 'tooFewFragments'
        | 'belowFeeFloor'
        | 'error'
    }

type OutputRow = { satoshis?: number; change?: boolean; basket?: string }

/**
 * Count spendable managed-change outputs in a single storage session.
 *
 * Assets are excluded twice over: the loop skips the `1sat` / `bsv21` baskets,
 * and only outputs flagged `change: true` (managed change) are counted. A
 * received 1-sat tip is neither.
 */
async function countConsolidatableChange(
  active: ActiveWallet,
): Promise<ChangeConsolidationStats | null> {
  const storage = active.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  try {
    return await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as {
        findOutputs?: (args: unknown) => Promise<OutputRow[] | undefined>
      }
      if (typeof sp.findOutputs !== 'function') return null

      let fragments = 0
      let totalSats = 0
      for (let page = 0; page < ENUM_MAX_PAGES; page += 1) {
        let batch: OutputRow[] = []
        try {
          batch =
            (await sp.findOutputs({
              partial: { spendable: true, change: true },
              paged: { limit: ENUM_PAGE, offset: page * ENUM_PAGE },
            })) ?? []
        } catch {
          batch =
            (await sp.findOutputs({
              partial: { spendable: true },
              paged: { limit: ENUM_PAGE, offset: page * ENUM_PAGE },
            })) ?? []
        }
        if (!batch.length) break

        for (const row of batch) {
          if (row.change !== true) continue
          const basket = String(row.basket ?? '').toLowerCase()
          if (basket === '1sat' || basket === 'bsv21') continue
          const sats = Math.floor(Number(row.satoshis) || 0)
          if (sats <= 1) continue
          fragments += 1
          totalSats += sats
        }
        if (batch.length < ENUM_PAGE) break
      }
      return { fragments, totalSats }
    })
  } catch (err) {
    console.warn('[consolidate] enumerate change failed', err)
    return null
  }
}

/**
 * Sign, broadcast and internalize a single self-payment that collapses the
 * spendable change pool into one managed-change output.
 *
 * This is a self-consolidation, not a user payment: it is silent (no Activity
 * row, no receive toast), internalizing the output directly like the toolbox's
 * `sweepTo`. Delivery / remittance do not apply — the counterparty is us.
 */
async function runSelfConsolidation(): Promise<string> {
  return runExclusiveSpend(async () => {
    assertOnlineForPayment()
    const active = getActiveWallet()
    if (!active) throw new Error('Wallet locked')

    const { releaseStuckNosends } = await import('./actionReview')
    await releaseStuckNosends(active)

    // Derive a BRC-29 output to our own identity, then internalize it back as
    // managed change. Same shape as a selfReceive send, minus the delivery.
    const [derivationPrefix, derivationSuffix] = await Promise.all([
      createNonce(active.wallet, 'self'),
      createNonce(active.wallet, 'self'),
    ])
    const keyID = `${derivationPrefix} ${derivationSuffix}`
    const { publicKey } = await active.wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL_ID,
      keyID,
      counterparty: active.identityKey,
    })
    if (typeof publicKey !== 'string' || !publicKey.trim()) {
      throw new Error('Failed to derive self key for change consolidation')
    }
    const address = PublicKey.fromString(publicKey).toAddress(
      active.chain === 'main' ? 'mainnet' : 'testnet',
    )
    const lockingScript = new P2PKH().lock(address).toHex()

    const createActionArgs = {
      description: 'Consolidate change',
      labels: ['handcash-consolidate'],
      outputs: [
        {
          lockingScript,
          // Adjusted down to the largest fundable amount — pulls in every
          // spendable change input and returns a single output.
          satoshis: MAX_POSSIBLE_SATOSHIS,
          outputDescription: 'Consolidated change',
          customInstructions: JSON.stringify({
            derivationPrefix,
            derivationSuffix,
            payee: active.identityKey,
          }),
        },
      ],
      options: {
        randomizeOutputs: false as const,
        signAndProcess: true as const,
        acceptDelayedBroadcast: true as const,
        trustSelf: 'known' as const,
      },
    }

    let result: Awaited<ReturnType<typeof active.wallet.createAction>>
    try {
      result = await active.wallet.createAction(createActionArgs)
    } catch (firstErr) {
      const { isIteratorCrashError, isReviewActionsError, recoverFromReviewActions } =
        await import('./actionReview')
      if (!isIteratorCrashError(firstErr) && !isReviewActionsError(firstErr)) {
        throw firstErr
      }
      console.warn(
        '[consolidate] createAction poison — repairing and retrying once',
        firstErr instanceof Error ? firstErr.message : String(firstErr),
      )
      await recoverFromReviewActions({ err: firstErr, active })
      result = await active.wallet.createAction(createActionArgs)
    }

    const realTxid = (result as { txid?: string })?.txid
    const atomicBeef = atomicBeefFromCreateAction(result)
    const sendWith = (result as { sendWithResults?: Array<{ status?: string }> })
      .sendWithResults
    const { sendWithHasFailure } = await import('./actionReview')
    if (sendWithHasFailure(sendWith) || !realTxid) {
      const { formatReviewActionsError, recoverFromReviewActions } = await import(
        './actionReview'
      )
      await recoverFromReviewActions({
        err: { name: 'WERR_REVIEW_ACTIONS', sendWithResults: sendWith, txid: realTxid },
        active,
      })
      throw new Error(
        formatReviewActionsError({ sendWithResults: sendWith, reviewActionResults: [] }),
      )
    }

    const txid = realTxid
    // Retire the coins this transaction consumed before anything else can pick
    // them — same protection the send paths use after createAction.
    await sealSpentInputsOfSignedTx(txid, atomicBeef)
    await ensurePaymentBroadcasted(txid, atomicBeef)

    // Internalize the single output back into managed change, silently. Direct
    // internalizeAction (not internalizeBrc29Payment) so there is no inbound
    // "Payment received" Activity row for money that never left the wallet.
    if (atomicBeef?.length) {
      await withVisibleOnChainBeef(() =>
        active.wallet.internalizeAction({
          tx: atomicBeef,
          description: 'Consolidated change',
          labels: ['handcash-consolidate'],
          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix,
                derivationSuffix,
                senderIdentityKey: active.identityKey,
              },
            },
          ],
          seekPermission: false,
        }),
      )
    }

    scheduleHistoryBackupPush('send')
    return txid
  })
}

/**
 * Consolidate the change pool if it is fragmented enough to be worth it.
 *
 * Safe to call after every chain-ingest pass: the cooldown and the tagged-union
 * plan make it cheap when nothing is needed, and it fails closed. Fire it
 * *after* the chain-ingest lock is released — it acquires the spend region,
 * which is exclusive with chain ingest.
 */
export async function maybeConsolidateChange(): Promise<ConsolidationOutcome> {
  const now = Date.now()
  if (now - lastConsolidationAttemptAt < CONSOLIDATION_COOLDOWN_MS) {
    return { ran: false, reason: 'cooldown' }
  }
  if (shouldYieldChainIngestToSpend()) return { ran: false, reason: 'spendPending' }
  if (isRecomposeCoordinatorActive()) return { ran: false, reason: 'spendPending' }
  if (typeof document !== 'undefined' && document.hidden) {
    return { ran: false, reason: 'spendPending' }
  }

  const active = getActiveWallet()
  if (!active) return { ran: false, reason: 'locked' }
  try {
    assertOnlineForPayment()
  } catch {
    return { ran: false, reason: 'offline' }
  }

  const stats = await countConsolidatableChange(active)
  if (!stats) return { ran: false, reason: 'noStorage' }

  const plan = planChangeConsolidation(stats)
  if (plan.action === 'skip') return { ran: false, reason: plan.reason }

  // Cool down on the attempt itself so a repeatedly failing consolidation does
  // not retry on every poll.
  lastConsolidationAttemptAt = now
  console.info(
    `[consolidate] collapsing ${plan.fragments} change output(s) (~${plan.totalSats} sats, est fee ${plan.estFeeSats}) into one`,
  )
  try {
    const txid = await runSelfConsolidation()
    console.info(
      `[consolidate] done — ${plan.fragments} output(s) collapsed by ${txid.slice(0, 12)}…`,
    )
    return { ran: true, txid, fragments: plan.fragments }
  } catch (err) {
    console.warn(
      '[consolidate] pass failed — pool left as-is',
      err instanceof Error ? err.message : String(err),
    )
    return { ran: false, reason: 'error' }
  }
}
