import {
  assertRuntimeCurrent,
  requireWalletRuntime,
} from './walletRuntime'

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
import { sealSpentInputsOfSignedTx } from './staleOutputRelease'

export type SignedSendHandle = {
  lifecycleId: string
  txid: string
  atomicBeef: number[]
  flow: TransactionFlow
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
  const owner = {
    accountIndex: runtime.instance.accountIndex,
    identityKey: runtime.instance.identityKey,
    chain: runtime.instance.chain,
  } as const
  const { prepareBroadcastCheque } = await import('./beefCache')
  const prepared = await prepareBroadcastCheque(
    runtime.instance,
    txid,
    args.atomicBeef,
  )
  assertRuntimeCurrent(runtime)
  const atomicBeef = prepared.atomic

  // Seal first. A lifecycle must never advertise a signed cheque while its
  // inputs remain selectable by a second send.
  await sealSpentInputsOfSignedTx(txid, atomicBeef)
  assertRuntimeCurrent(runtime)
  // Persist before any Activity/remittance work. The cheque archive is what
  // heal replays; the miner outbox is only the still-propagating subset.
  const { archiveSignedCheque } = await import('./signedChequeArchive')
  assertRuntimeCurrent(runtime)
  if (!archiveSignedCheque(txid, atomicBeef, { flow: args.flow, owner })) {
    throw new Error('Signed transaction template could not be archived')
  }
  const { enqueuePendingMinerSubmit } = await import('./pendingMinerOutbox')
  assertRuntimeCurrent(runtime)
  enqueuePendingMinerSubmit(txid, atomicBeef, { flow: args.flow })

  const lifecycle = args.lifecycleId
    ? noteDualLayerSigned(args.lifecycleId, txid)
    : beginSignedTxLifecycle({
        txid,
        satoshis: args.satoshis ?? 0,
        to: args.to,
      })
  if (!lifecycle) throw new Error('Could not register signed transaction')

  return {
    lifecycleId: lifecycle.id,
    txid,
    atomicBeef,
    flow: args.flow,
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
      { flow: handle.flow },
    )
    if (result.kind === 'accepted' && result.summary) {
      noteDualLayerPostBeef(handle.lifecycleId, result.summary)
    }
    void tryFinalizeDualLayerTx(handle.lifecycleId).catch((err) => {
      console.warn(
        '[signed-send] SPV finality deferred',
        handle.txid.slice(0, 12),
        err,
      )
    })
    return result
  } catch (reason) {
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
    throw reason
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
