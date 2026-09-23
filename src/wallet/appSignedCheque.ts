/**
 * App-signed BRC-100 actions use the same cheque funnel as wallet sends.
 *
 * `createAction` / `signAction` / `processAction` already produce a signed
 * body. That body is the template heal needs — not a second 16-slot cache.
 */
import { archiveSignedCheque } from './signedChequeArchive'
import {
  assertRuntimeCurrent,
  requireWalletRuntime,
} from './walletRuntime'

export async function funnelAppSignedCheque(args: {
  txid: string
  atomicBeef: number[]
  satoshis?: number
}): Promise<boolean> {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid) || args.atomicBeef.length === 0) return false
  const runtime = requireWalletRuntime()
  const owner = {
    accountIndex: runtime.instance.accountIndex,
    identityKey: runtime.instance.identityKey,
    chain: runtime.instance.chain,
  } as const
  if (
    !archiveSignedCheque(txid, args.atomicBeef, {
      flow: 'brc100_action',
      owner,
    })
  ) {
    console.error('[brc100] signed cheque archive refused', txid.slice(0, 12))
    return false
  }
  try {
    const { registerSignedSend } = await import('./signedSendLifecycle')
    assertRuntimeCurrent(runtime)
    const handle = await registerSignedSend({
      txid,
      atomicBeef: args.atomicBeef,
      flow: 'brc100_action',
      satoshis: Math.max(0, Math.trunc(args.satoshis ?? 0)),
    })
    // The app owns propagation after processAction. Registration only needs
    // the retention through its durable archive/outbox boundary.
    handle.releaseRuntime?.()
    return true
  } catch (err) {
    console.warn(
      '[brc100] signed cheque funnel deferred',
      txid.slice(0, 12),
      err,
    )
    return false
  }
}
