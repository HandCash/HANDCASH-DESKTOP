import {
  assertRuntimeAvailable,
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
 * Protocol modules own output construction and peer-remittance ordering. This
 * module alone owns the shared boundary after signing: seal inputs, register
 * ARC/BUMP tracking, durably submit to miners, classify hard rejection, and
 * attempt header-verified SPV finality.
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
import {
  releaseSealedInputsOfUnsentTx,
  sealSpentInputsOfSignedTx,
} from './staleOutputRelease'

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
  let sealed = false
  let preparedAtomic = args.atomicBeef
  try {
    const { prepareBroadcastCheque } = await import('./beefCache')
    const prepared = await prepareBroadcastCheque(
      runtime.instance,
      txid,
      args.atomicBeef,
    )
    assertRuntimeAvailable(runtime)
    const atomicBeef = prepared.atomic
    preparedAtomic = atomicBeef

    // Seal first. A lifecycle must never advertise a signed cheque while its
    // inputs remain selectable by a second send. Use the captured Toolbox even
    // if the user selected another account while BEEF hydration was running.
    await sealSpentInputsOfSignedTx(
      txid,
      atomicBeef,
      runtime.instance,
      runtimeIsCurrent(runtime),
    )
    sealed = true
    assertRuntimeAvailable(runtime)
    // Persist before any Activity/remittance work. Every key is resolved from
    // the immutable owner, never the mutable foreground account.
    const { archiveSignedCheque } = await import('./signedChequeArchive')
    if (!archiveSignedCheque(txid, atomicBeef, { flow: args.flow, owner })) {
      throw new Error('Signed transaction template could not be archived')
    }
    const { enqueuePendingMinerSubmit } = await import('./pendingMinerOutbox')
    if (!enqueuePendingMinerSubmit(txid, atomicBeef, { flow: args.flow, owner })) {
      throw new Error('Signed transaction could not be queued for propagation')
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
    if (!lifecycle) throw new Error('Could not register signed transaction')

    return {
      lifecycleId: lifecycle.id,
      txid,
      atomicBeef,
      flow: args.flow,
      runtime,
      owner,
      releaseRuntime: retention.release,
    }
  } catch (error) {
    // Storage refusal is not a broadcast verdict. Undo the seal before the
    // error reaches feature-level cleanup so an NFT cannot transiently vanish.
    if (sealed && runtimeIsCurrent(runtime)) {
      await releaseSealedInputsOfUnsentTx(txid, preparedAtomic).catch(
        () => undefined,
      )
    }
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
