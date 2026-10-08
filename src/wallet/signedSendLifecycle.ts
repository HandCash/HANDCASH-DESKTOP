import {
  requireWalletRuntime,
  retainWalletRuntime,
  runtimeIsCurrent,
  type WalletRuntime,
} from './walletRuntime'
import {
  accountKeyScopeFor,
  type BoundAccountKeyScope,
} from './accountLocalKeys'

/**
 * One lifecycle for every locally signed outbound transaction.
 *
 * The signed Atomic BEEF is the cheque. SPV is primary: seal inputs, archive
 * the body, and account the cheque as an unconfirmed spend (`bodies-complete`
 * until a header covers it; `headerProven` after BUMP vs local headers).
 * Broadcasting — Arcade / miner retry — is how we cash that cheque. It is
 * required, and it is secondary. HTTP 200 and Arcade accept are transmission,
 * not finality. Only a proven hard reject or a competing spend rewrites the
 * cheque. Protocol modules own output construction and remittance; they do
 * not invent a second spend.
 */
import type { MinerSubmitResult } from './minerSubmit'
import type { TransactionFlow } from './transactionTelemetry'
import {
  beginSignedTxLifecycle,
  failDualLayerSend,
  noteDualLayerPostBeef,
  noteDualLayerSigned,
  tryFinalizeDualLayerTx,
} from './dualLayerSend'
import { sealSpentInputsOfSignedTx } from './staleOutputRelease'

export type SignedSendHandle = {
  lifecycleId: string
  txid: string
  atomicBeef: number[]
  flow: TransactionFlow
  /** Immutable signer and storage owner; never replaced by an account switch. */
  runtime?: WalletRuntime
  owner?: BoundAccountKeyScope
  releaseRuntime?: () => void
}

export async function registerSignedSend(args: {
  txid: string
  atomicBeef: number[]
  flow: TransactionFlow
  /** Existing payment preflight record; protocol sends omit this. */
  lifecycleId?: string
  satoshis?: number
  to?: string | null
}): Promise<SignedSendHandle> {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid) || args.atomicBeef.length === 0) {
    throw new Error('Signed send is missing its transaction body')
  }

  // Freeze the signer/account identity before the first await. Derivation
  // scope must never follow a later account switch halfway through a cheque.
  const runtime = requireWalletRuntime()
  const retention = retainWalletRuntime(runtime)
  const owner = accountKeyScopeFor(runtime.instance)
  try {
    let atomicBeef = args.atomicBeef
    try {
      const { prepareBroadcastCheque } = await import('./beefCache')
      const prepared = await prepareBroadcastCheque(
        runtime.instance,
        txid,
        args.atomicBeef,
      )
      atomicBeef = prepared.atomic
    } catch (error) {
      // The subject is already signed. Missing ancestry may delay propagation,
      // but it must never turn the cheque back into an unsigned/failed action.
      console.warn(
        '[signed-send] BEEF preparation deferred; preserving signed cheque',
        txid.slice(0, 12),
        error,
      )
    }

    // Seal first. A lifecycle must never advertise a signed cheque while its
    // inputs remain selectable by a second send. Use the captured Toolbox even
    // if the user selected another account while BEEF hydration was running.
    try {
      await sealSpentInputsOfSignedTx(
        txid,
        atomicBeef,
        runtime.instance,
        runtimeIsCurrent(runtime),
      )
    } catch (error) {
      // createAction/signAction already committed the signed transaction to the
      // wallet. A projection failure cannot authorize abandoning it.
      console.error(
        '[signed-send] input seal projection failed; cheque remains signed',
        txid.slice(0, 12),
        error,
      )
    }
    // Persist before any Activity/remittance work. Every key is resolved from
    // the immutable owner, never the mutable foreground account.
    const { archiveSignedCheque } = await import('./signedChequeArchive')
    if (!archiveSignedCheque(txid, atomicBeef, { flow: args.flow, owner })) {
      // Toolbox still owns the signed transaction. Continue to the retry queue
      // (which can carry its own body) and immediate propagation.
      console.error(
        '[signed-send] auxiliary archive refused; preserving wallet cheque',
        txid.slice(0, 12),
      )
    }
    const { enqueuePendingMinerSubmit } = await import('./pendingMinerOutbox')
    if (!enqueuePendingMinerSubmit(txid, atomicBeef, { flow: args.flow, owner })) {
      // Immediate propagation still has the in-memory body. Never unseal or
      // rewrite the send as unsigned merely because secondary storage is full.
      console.error(
        '[signed-send] durable retry unavailable; propagating signed cheque now',
        txid.slice(0, 12),
      )
    }

    // Foreground-only projections must not land in the newly selected wallet.
    const lifecycle = runtimeIsCurrent(runtime)
      ? args.lifecycleId
        ? noteDualLayerSigned(args.lifecycleId, txid)
        : beginSignedTxLifecycle({
            txid,
            satoshis: args.satoshis ?? 0,
            to: args.to,
          })
      : { id: args.lifecycleId ?? `background:${txid}` }
    const lifecycleId =
      lifecycle?.id ?? args.lifecycleId ?? `signed:${txid}`

    return {
      lifecycleId,
      txid,
      atomicBeef,
      flow: args.flow,
      runtime,
      owner,
      releaseRuntime: retention.release,
    }
  } catch (error) {
    // Nothing in this catch authorizes unsealing: the transaction was signed
    // before this function was entered and remains wallet history.
    retention.release()
    throw error
  }
}

/**
 * Cash a registered cheque. Transport/provider silence remains queued; only
 * minerSubmit's proven hard-reject path throws and rewrites the local send.
 */
export async function propagateSignedSend(
  handle: SignedSendHandle,
  opts?: { pendingId?: string; pendingIds?: string[] },
): Promise<MinerSubmitResult> {
  try {
    const { submitAtomicBeefToMiners } = await import('./minerSubmit')
    const result = await submitAtomicBeefToMiners(
      handle.txid,
      handle.atomicBeef,
      {
        flow: handle.flow,
        runtime: handle.runtime,
        owner: handle.owner,
      },
    )
    const foreground =
      !handle.runtime || runtimeIsCurrent(handle.runtime)
    if (foreground && result.kind === 'accepted' && result.summary) {
      noteDualLayerPostBeef(handle.lifecycleId, result.summary)
    }
    if (foreground) {
      void tryFinalizeDualLayerTx(handle.lifecycleId).catch((err) => {
        console.warn(
          '[signed-send] SPV finality deferred',
          handle.txid.slice(0, 12),
          err,
        )
      })
    }
    return result
  } catch (reason) {
    if (!handle.runtime || runtimeIsCurrent(handle.runtime)) {
      failDualLayerSend(
        handle.lifecycleId,
        'ARC_REJECTED',
        reason instanceof Error ? reason.message : String(reason),
      )
      const { reportLateMinerSubmitFailure } = await import('./minerSubmit')
      const pendingIds = opts?.pendingIds?.length
        ? opts.pendingIds
        : [opts?.pendingId]
      await Promise.all(
        pendingIds.map((pendingId) =>
          reportLateMinerSubmitFailure({
            pendingId,
            txid: handle.txid,
            reason,
          }),
        ),
      )
    }
    throw reason
  } finally {
    handle.releaseRuntime?.()
  }
}

/** Common optimistic payment rule: signing completes UI; propagation is late. */
export function startSignedSendPropagation(
  handle: SignedSendHandle,
  opts?: { pendingId?: string; pendingIds?: string[] },
): void {
  void propagateSignedSend(handle, opts).catch(() => {
    // propagateSignedSend already rewrites Activity/lifecycle and surfaces toast.
  })
}
