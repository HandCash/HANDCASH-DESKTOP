/**
 * Payee ingest of a P2P item settle (Atomic BEEF from messagebox).
 *
 * Internalize every 1-sat tip that pays this wallet, then the **payee** broadcasts.
 * If the box has no Atomic BEEF, SPV-fetch by txid (sender-broadcast fallback).
 * Address scan remains the last-resort custody path. Item identity is BRC-150
 * (offline tip→origin proof) resolved from the origin hint + normal inscription
 * resolution — no on-chain latch companion.
 *
 * Batch transfers notify once per item with the same BEEF. Earlier code only
 * kept the first 1-sat tip, so the second fox never entered the basket.
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
import {
  rememberResolvedInscription,
  getResolvedInscription,
  getResolvedInscriptionByOrigin,
} from './inscriptionCache'
import { announceItemsReceived } from './itemArrivalToast'
import {
  noteInboundReceiveComplete,
  noteInboundReceivePending,
  clearInboundReceivePending,
} from './appActivity'
import { scheduleHistoryBackupPush } from './deviceSync'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { stampBrc164Id } from './itemAccess'
import {
  alreadyInternalizedError,
  fetchAtomicBeefFromUrl,
  withRestoredInternalizeStatus,
} from './peerIngestHelpers'
import type { Chain } from './vault'

export type IngestItemSettleResult = {
  accepted: boolean
  outpoints: string[]
  reason?: string
}

function normalizeOriginHint(hint: string | undefined, txid: string): string | undefined {
  const raw = hint?.trim()
  if (!raw) return undefined
  if (/^[0-9a-f]{64}[._]\d+$/i.test(raw)) {
    return raw.replace(/\.(\d+)$/, '_$1').toLowerCase()
  }
  // Genesis / prior origin — keep as-is (underscore form when tip-shaped).
  if (/^[0-9a-f]{64}_\d+$/i.test(raw)) return raw.toLowerCase()
  void txid
  return raw
}

function defaultTipOrigin(txid: string, vout: number): string {
  return `${txid}_${vout}`
}

/**
 * Map a messagebox origin hint onto one tip vout when several pay us.
 * Tip-shaped hints (`txid_N`) win; genesis hints claim the first tip that is
 * still on its default origin (or already carries this genesis).
 */
export function pickTipVoutForOriginHint(
  txid: string,
  tipVouts: number[],
  originHint: string | undefined,
): number | null {
  if (tipVouts.length === 0) return null
  const hint = normalizeOriginHint(originHint, txid)
  if (!hint) return tipVouts[0]!

  const tipShaped = new RegExp(`^${txid}[._](\\d+)$`, 'i').exec(hint)
  if (tipShaped) {
    const v = Number(tipShaped[1])
    if (tipVouts.includes(v)) return v
  }

  for (const vout of tipVouts) {
    const op = `${txid}.${vout}`
    const resolved = getResolvedInscription(op)
    if (resolved?.origin?.trim().toLowerCase() === hint) return vout
  }
  for (const vout of tipVouts) {
    const op = `${txid}.${vout}`
    const resolved = getResolvedInscription(op)
    const def = defaultTipOrigin(txid, vout)
    if (!resolved?.origin || resolved.origin.trim().toLowerCase() === def) {
      return vout
    }
  }
  return tipVouts[0]!
}

function originForTipVout(
  txid: string,
  vout: number,
  tipVouts: number[],
  originHint: string | undefined,
): string {
  const preferred = pickTipVoutForOriginHint(txid, tipVouts, originHint)
  const hint = normalizeOriginHint(originHint, txid)
  if (hint && preferred === vout) return hint
  const existing = getResolvedInscription(`${txid}.${vout}`)?.origin?.trim()
  if (existing) return existing.replace(/\.(\d+)$/, '_$1').toLowerCase()
  return defaultTipOrigin(txid, vout)
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

  const tipVouts: number[] = []
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
      if (sats === 1) tipVouts.push(i)
    }
    if (tipVouts.length === 0 && tokenVout >= 0 && tokenAmount > 0n) {
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
    if (tipVouts.length === 0) {
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

  const allOps = tipVouts.map((vout) => `${id}.${vout}`)
  const claimed = beginOneSatImport(allOps)
  if (claimed.length === 0) {
    // Already in the basket — still (re)paint so a second batch notify can bind
    // its genesis origin onto the next tip instead of overwriting tip .0.
    paintReceivedTips({
      txid: id,
      tipVouts,
      originHint,
      name,
      app,
      collectionId,
      chain: active.chain,
    })
    return { accepted: true, outpoints: allOps, reason: 'already-imported' }
  }

  try {
    // Payee is the intended broadcaster on peerDeliver — confirm network first.
    // Do not existence-check first: that adds RTT on the common payee-first path.
    await broadcastAtomicBeef(id, atomic)
    rememberBeefTree(atomic, id)

    const remittanceOutputs = tipVouts.map((vout) => {
      const origin = originForTipVout(id, vout, tipVouts, originHint)
      const priorByOrigin = getResolvedInscriptionByOrigin(origin)
      const tipName =
        (originHint && origin === normalizeOriginHint(originHint, id)
          ? name
          : priorByOrigin?.name?.trim()) || name
      const tipCollection =
        collectionId || priorByOrigin?.collectionId || undefined
      const tipApp = app || priorByOrigin?.app || undefined
      return {
        outputIndex: vout,
        protocol: 'basket insertion' as const,
        insertionRemittance: {
          basket: '1sat',
          tags: stampBrc164Id([
            'ordinal',
            `origin:${origin.replace(/_(\d+)$/, '.$1')}`,
            ...(tipName ? [`name:${tipName.slice(0, 80)}`] : []),
            ...(tipApp ? [`app:${tipApp.slice(0, 40)}`] : []),
            ...(tipCollection
              ? [`collection:${tipCollection.slice(0, 80)}`]
              : []),
          ]),
          customInstructions: buildInternalizeCustomInstructions({
            origin,
            name: tipName,
            app: tipApp,
            collectionId: tipCollection,
          }),
        },
      }
    })

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
    paintReceivedTips({
      txid: id,
      tipVouts,
      originHint,
      name,
      app,
      collectionId,
      chain: active.chain,
    })
    console.info(
      `[item-settle] accepted ${allOps.join(', ')} into 1sat (${allOps.length} tip(s))`,
    )
    return { accepted: true, outpoints: allOps }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      markOneSatImported(allOps)
      paintReceivedTips({
        txid: id,
        tipVouts,
        originHint,
        name,
        app,
        collectionId,
        chain: active.chain,
      })
      console.info(
        `[item-settle] accepted existing ${allOps.join(', ')} into 1sat`,
      )
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

function paintReceivedTips(args: {
  txid: string
  tipVouts: number[]
  originHint: string | undefined
  name: string
  app: string | undefined
  collectionId: string | undefined
  chain: Chain
}): void {
  const { txid: id, tipVouts, originHint, app, collectionId, chain } = args
  let name = args.name
  const preferred = pickTipVoutForOriginHint(id, tipVouts, originHint)
  const hint = normalizeOriginHint(originHint, id)

  const paintedOps: string[] = []
  for (const vout of tipVouts) {
    const tipOp = `${id}.${vout}`
    const origin = originForTipVout(id, vout, tipVouts, originHint)
    const priorByOrigin = getResolvedInscriptionByOrigin(origin)
    const isHintTip = Boolean(hint && preferred === vout && origin === hint)
    if (isHintTip && priorByOrigin?.name?.trim()) {
      name = priorByOrigin.name.trim()
    }
    const tipName = isHintTip
      ? name
      : priorByOrigin?.name?.trim() || name
    const tipCollection =
      (isHintTip ? collectionId : undefined) ||
      collectionId ||
      priorByOrigin?.collectionId
    const tipApp = (isHintTip ? app : undefined) || app || priorByOrigin?.app

    rememberResolvedInscription(tipOp, {
      ...(priorByOrigin ?? {}),
      origin,
      name: tipName,
      ...(tipApp ? { app: tipApp } : priorByOrigin?.app ? { app: priorByOrigin.app } : {}),
      ...(tipCollection ? { collectionId: tipCollection } : {}),
      traits: priorByOrigin?.traits ?? [],
      extras: priorByOrigin?.extras ?? [],
    })
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: tipName,
      itemOrigin: origin,
      outpoint: tipOp,
    })
    paintedOps.push(tipOp)
  }

  void import('./collectables')
    .then(({ noteIngestedItem, listCollectables, requestCollectableVerification }) => {
      for (const vout of tipVouts) {
        const tipOp = `${id}.${vout}`
        const resolved = getResolvedInscription(tipOp)
        const tipOrigin =
          resolved?.origin || originForTipVout(id, vout, tipVouts, originHint)
        noteIngestedItem({
          outpoint: tipOp,
          chain,
          origin: tipOrigin,
          name: resolved?.name,
          app: resolved?.app,
          collectionId: resolved?.collectionId,
          content: resolved?.content,
        })
        requestCollectableVerification(tipOp)
      }
      announceItemsReceived(paintedOps)
      return listCollectables()
    })
    .catch(() => {
      announceItemsReceived(paintedOps)
    })
}
