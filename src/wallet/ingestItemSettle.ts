/**
 * Payee ingest of a P2P item settle (Atomic BEEF from messagebox).
 *
 * Internalize the tip, then the **payee** broadcasts. If the box has no Atomic
 * BEEF, SPV-fetch by txid (sender-broadcast fallback). Address scan remains the
 * last-resort custody path. Item identity is BRC-150 (offline tip→origin proof)
 * resolved from the origin hint + normal inscription resolution — no on-chain
 * latch companion.
 */
import { Beef } from '@bsv/sdk'
import { getActiveWallet } from './session'
import { rememberBeefTree } from './beefCache'
import { scriptPaysAddress } from './ordinalOwnership'
import { buildInternalizeCustomInstructions } from './oneSatProvenance'
import {
  beginOneSatImport,
  markOneSatImported,
  markOneSatImportFailed,
} from './oneSatImportGuard'
import { rememberResolvedInscription } from './inscriptionCache'
import { announceItemsReceived } from './itemArrivalToast'
import { noteInboundReceiveComplete, noteInboundReceivePending, clearInboundReceivePending } from './appActivity'
import { scheduleHistoryBackupPush } from './deviceSync'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { stampBrc164Id } from './itemAccess'

export type IngestItemSettleResult = {
  accepted: boolean
  outpoints: string[]
  reason?: string
}

function alreadyInternalizedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /already (?:spent|imported|internalized|in (?:the )?wallet|ours)/i.test(
    msg,
  )
}

async function fetchAtomicBeefFromUrl(
  url: string,
): Promise<number[] | undefined> {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.length > 0 ? Array.from(buf) : undefined
  } catch {
    return undefined
  }
}

export async function internalizePeerItemSettle(opts: {
  txid: string
  tx?: number[]
  beefUrl?: string
  name?: string
  /** Optional BRC-150 origin hint from the messagebox notify. */
  origin?: string
  app?: string
}): Promise<IngestItemSettleResult> {
  const id = opts.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { accepted: false, outpoints: [], reason: 'invalid-txid' }
  }
  const active = getActiveWallet()
  if (!active) return { accepted: false, outpoints: [], reason: 'locked' }

  noteInboundReceivePending({
    txid: id,
    item: true,
    itemName: opts.name,
  })

  let atomic = opts.tx
  if ((!atomic || !atomic.length) && opts.beefUrl) {
    atomic = await fetchAtomicBeefFromUrl(opts.beefUrl)
  }
  if (!atomic?.length) {
    try {
      const { getAtomicBeefBinaryForTxid, isAtomicBeefInBackoff } = await import(
        './beefCache'
      )
      if (isAtomicBeefInBackoff(id)) {
        clearInboundReceivePending(id)
        return { accepted: false, outpoints: [], reason: 'beef-backoff' }
      }
      atomic = await getAtomicBeefBinaryForTxid(active, id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/AtomicBEEF backoff/i.test(msg)) {
        console.warn('[item-settle] AtomicBEEF fetch failed', id.slice(0, 12), err)
      }
    }
  }
  if (!atomic?.length) {
    clearInboundReceivePending(id)
    return { accepted: false, outpoints: [], reason: 'missing-beef' }
  }

  let tipVout = -1
  const originHint = opts.origin?.trim()
  let origin =
    originHint && /^[0-9a-f]{64}[._]\d+$/i.test(originHint)
      ? originHint.replace(/\.(\d+)$/, '_$1').toLowerCase()
      : `${id}_0`
  let name = opts.name?.trim() || 'Collectable'
  const app = opts.app?.trim() || undefined
  try {
    const beef = Beef.fromBinary(atomic)
    const tx = beef.findTxid(id)?.tx ?? beef.findAtomicTransaction(id)
    if (!tx) {
      clearInboundReceivePending(id)
      return { accepted: false, outpoints: [], reason: 'beef-missing-tx' }
    }
    const outputs = tx.outputs ?? []
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i]
      const sats = out?.satoshis
      const hex = out?.lockingScript?.toHex()
      if (!hex || !scriptPaysAddress(hex, active.address)) continue
      if (sats === 1 && tipVout < 0) tipVout = i
    }
    if (tipVout < 0) {
      clearInboundReceivePending(id)
      return { accepted: false, outpoints: [], reason: 'no-tip-paying-us' }
    }
  } catch (err) {
    clearInboundReceivePending(id)
    return {
      accepted: false,
      outpoints: [],
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const tipOp = `${id}.${tipVout}`
  const allOps = [tipOp]
  const claimed = beginOneSatImport(allOps)
  if (claimed.length === 0) {
    return { accepted: true, outpoints: allOps, reason: 'already-imported' }
  }

  try {
    // Payee is the intended broadcaster on peerDeliver — confirm network first.
    // Do not existence-check first: that adds RTT on the common payee-first path.
    await broadcastAtomicBeef(id, atomic)
    rememberBeefTree(atomic, id)

    const remittanceOutputs: Array<{
      outputIndex: number
      protocol: 'basket insertion'
      insertionRemittance: {
        basket: string
        tags: string[]
        customInstructions: string
      }
    }> = [
      {
        outputIndex: tipVout,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: '1sat',
          tags: stampBrc164Id([
            'ordinal',
            `origin:${origin.replace(/_(\d+)$/, '.$1')}`,
            ...(name ? [`name:${name.slice(0, 80)}`] : []),
            ...(app ? [`app:${app.slice(0, 40)}`] : []),
          ]),
          customInstructions: buildInternalizeCustomInstructions({
            origin,
            name,
            app,
          }),
        },
      },
    ]

    await active.wallet.internalizeAction({
      tx: atomic,
      description: 'Receive item',
      labels: ['1sat', 'handcash-item-p2p'],
      outputs: remittanceOutputs,
      seekPermission: false,
    })

    markOneSatImported(allOps)
    rememberResolvedInscription(tipOp, {
      origin,
      name,
      ...(app ? { app } : {}),
      traits: [],
      extras: [],
    })
    rememberBeefTree(atomic, id)
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: name,
      itemOrigin: origin,
      outpoint: tipOp,
    })
    announceItemsReceived([tipOp])
    scheduleHistoryBackupPush('internalizeAction')
    // Paint off the ingest critical path — listOutputs(1sat) can take seconds.
    void import('./collectables')
      .then(({ listCollectables }) => listCollectables(active))
      .catch(() => {
        /* paint on next poll */
      })
    return { accepted: true, outpoints: allOps }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      markOneSatImported(allOps)
      noteInboundReceiveComplete({
        txid: id,
        item: true,
        itemName: name,
        itemOrigin: origin,
        outpoint: tipOp,
      })
      return { accepted: true, outpoints: allOps, reason: 'already-imported' }
    }
    markOneSatImportFailed(allOps)
    clearInboundReceivePending(id)
    return {
      accepted: false,
      outpoints: [],
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
