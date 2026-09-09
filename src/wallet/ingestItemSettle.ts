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
import type { AtomicBeefPurpose } from './beefCache'
import { getActiveWallet } from './session'
import { rememberBeefTree } from './beefCache'
import { decodeBProtocol } from './bProtocol'
import { decodeBsv21Binary } from './token'
import { scriptPaysAddress } from './ordinalOwnership'
import { buildInternalizeCustomInstructions } from './oneSatProvenance'
import {
  beginOneSatImport,
  markOneSatImported,
  markOneSatImportFailed,
} from './oneSatImportGuard'
import { rememberResolvedInscription, getResolvedInscriptionByOrigin } from './inscriptionCache'
import { announceItemsReceived } from './itemArrivalToast'
import { noteInboundReceiveComplete, noteInboundReceivePending, clearInboundReceivePending } from './appActivity'
import { scheduleHistoryBackupPush } from './deviceSync'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { stampBrc164Id } from './itemAccess'
import {
  alreadyInternalizedError,
  fetchAtomicBeefFromUrl,
  withRestoredInternalizeStatus,
} from './peerIngestHelpers'

export type IngestItemSettleResult = {
  accepted: boolean
  outpoints: string[]
  reason?: string
}

export async function internalizePeerItemSettle(opts: {
  txid: string
  tx?: number[]
  beefUrl?: string
  name?: string
  /** Optional BRC-150 origin hint from the messagebox notify. */
  origin?: string
  app?: string
  collectionId?: string
  /** Inbox hints race sender postBeef and therefore use a short retry backoff. */
  beefPurpose?: AtomicBeefPurpose
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
      const { getAtomicBeefBinaryForTxid } = await import('./beefCache')
      atomic = await getAtomicBeefBinaryForTxid(active, id, {
        purpose: opts.beefPurpose,
      })
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
  let name = opts.name?.trim() || 'Collectable'
  const app = opts.app?.trim() || undefined
  let collectionId = opts.collectionId?.trim() || undefined
  try {
    const beef = Beef.fromBinary(atomic)
    const tx = beef.findTxid(id)?.tx ?? beef.findAtomicTransaction(id)
    if (!tx) {
      clearInboundReceivePending(id)
      return { accepted: false, outpoints: [], reason: 'beef-missing-tx' }
    }
    const outputs = tx.outputs ?? []
    let tokenVout = -1
    let tokenAmount = 0n
    let tokenId = ''
    let tokenSym = 'Token'
    let tokenDec = 0
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i]
      const sats = out?.satoshis
      const hex = out?.lockingScript?.toHex()
      if (!hex || !scriptPaysAddress(hex, active.address)) continue
      const binary = decodeBsv21Binary(hex)
      if (binary && binary.amount > 0n && binary.role !== 'authority') {
        if (tokenVout < 0) {
          tokenVout = i
          tokenAmount = binary.amount
          tokenId = binary.tokenId ?? `${id}_${i}`
          tokenSym = binary.payload?.sym?.trim() || tokenSym
          tokenDec = binary.payload?.dec ?? 0
        }
        continue
      }
      if (decodeBProtocol(hex)) continue
      if (sats === 1 && tipVout < 0) tipVout = i
    }
    if (tipVout < 0 && tokenVout >= 0 && tokenAmount > 0n) {
      clearInboundReceivePending(id)
      const { internalizePeerFungibleSettle } = await import('./token')
      return internalizePeerFungibleSettle({
        txid: id,
        tx: atomic,
        token: {
          kind: 'fungible',
          tokenId: tokenId || `${id}_${tokenVout}`,
          amount: tokenAmount.toString(),
          sym: tokenSym,
          dec: tokenDec,
        },
        beefPurpose: opts.beefPurpose,
      })
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

  let origin =
    originHint && /^[0-9a-f]{64}[._]\d+$/i.test(originHint)
      ? originHint.replace(/\.(\d+)$/, '_$1').toLowerCase()
      : `${id}_${tipVout}`
  const priorByOrigin = getResolvedInscriptionByOrigin(origin)
  if (priorByOrigin) {
    name = priorByOrigin.name?.trim() || name
    collectionId = collectionId || priorByOrigin.collectionId
  }

  const tipOp = `${id}.${tipVout}`
  const allOps = [tipOp]
  const claimed = beginOneSatImport(allOps)
  if (claimed.length === 0) {
    return { accepted: true, outpoints: allOps, reason: 'already-imported' }
  }

  // Card + Activity row + Verifying… spinner for a freshly held tip. Runs from
  // both the fresh-internalize path and the already-internalized path a send to
  // your own handle hits: createAction files the tip before the messagebox copy
  // arrives, so that receive lands here as "already internalized" and must still
  // paint and spin exactly like any other receive.
  const paintReceivedTip = (): void => {
    rememberResolvedInscription(tipOp, {
      ...(priorByOrigin ?? {}),
      origin,
      name,
      ...(app ? { app } : priorByOrigin?.app ? { app: priorByOrigin.app } : {}),
      ...(collectionId ? { collectionId } : {}),
      traits: priorByOrigin?.traits ?? [],
      extras: priorByOrigin?.extras ?? [],
    })
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: name,
      itemOrigin: origin,
      outpoint: tipOp,
    })
    void import('./collectables')
      .then(({ noteIngestedItem, listCollectables, requestCollectableVerification }) => {
        noteIngestedItem({
          outpoint: tipOp,
          chain: active.chain,
          origin,
          name,
          app,
          collectionId,
          content: priorByOrigin?.content,
        })
        requestCollectableVerification(tipOp)
        announceItemsReceived([tipOp])
        return listCollectables(active)
      })
      .catch(() => {
        announceItemsReceived([tipOp])
      })
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
            ...(collectionId
              ? [`collection:${collectionId.slice(0, 80)}`]
              : []),
          ]),
          customInstructions: buildInternalizeCustomInstructions({
            origin,
            name,
            app,
            collectionId,
          }),
        },
      },
    ]

    await withRestoredInternalizeStatus(id, () =>
      active.wallet.internalizeAction({
        tx: atomic,
        description: 'Receive item',
        labels: ['1sat', 'handcash-item-p2p'],
        outputs: remittanceOutputs,
        seekPermission: false,
      }),
    )

    markOneSatImported(allOps)
    rememberBeefTree(atomic, id)
    scheduleHistoryBackupPush('internalizeAction')
    paintReceivedTip()
    console.info(`[item-settle] accepted ${tipOp} into 1sat`)
    return { accepted: true, outpoints: allOps }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      markOneSatImported(allOps)
      paintReceivedTip()
      console.info(`[item-settle] accepted existing ${tipOp} into 1sat`)
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
