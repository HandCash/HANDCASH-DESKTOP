/**
 * App-signed BRC-100 actions use the same cheque funnel as wallet sends.
 *
 * `createAction` / `signAction` / `processAction` already produce a signed
 * body. That body is the template heal needs — not a second 16-slot cache.
 */
import { archiveSignedCheque } from './signedChequeArchive'

export async function funnelAppSignedCheque(args: {
  txid: string
  atomicBeef: number[]
  satoshis?: number
}): Promise<boolean> {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid) || args.atomicBeef.length === 0) return false
  archiveSignedCheque(txid, args.atomicBeef, { flow: 'brc100_action' })
  try {
    const { registerSignedSend } = await import('./signedSendLifecycle')
    await registerSignedSend({
      txid,
      atomicBeef: args.atomicBeef,
      flow: 'brc100_action',
      satoshis: Math.max(0, Math.trunc(args.satoshis ?? 0)),
    })
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
