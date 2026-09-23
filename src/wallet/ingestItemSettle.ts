import { getActiveWallet } from './session'

/**
 * Payee ingest of a P2P item settle (Atomic BEEF from messagebox).
 *
 * Internalize every 1-sat tip that pays this wallet. Re-posting the same signed
 * BEEF is harmless redundancy; the sender already owns normal propagation.
 * If the box has no Atomic BEEF, SPV-fetch by txid.
 * Address scan remains the last-resort custody path. Item identity is BRC-150
 * (offline tip→origin proof) resolved from the origin hint + normal inscription
 * resolution — no on-chain latch companion.
 *
 * Batch transfers notify once per item with the same BEEF. Earlier code only
 * kept the first 1-sat tip, so the second fox never entered the basket.
 */
import { Beef } from '@bsv/sdk'
import type { AtomicBeefPurpose } from './beefCache'

import { atomicBeefForSubject, rememberBeefTree } from './beefCache'
import { decodeBProtocol } from './bProtocol'
import { decodeBsv21Binary } from './token'
import { scriptPaysAddress } from './ordinalOwnership'
import {
  buildInternalizeCustomInstructions,
  parseProvenanceV2,
  rememberPeerRemittanceForHeldTips,
  rememberProvenanceRemittance,
} from './oneSatProvenance'
import { forgetItemsSent } from './sentItemGuard'
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
import type { ItemTransferMember } from './messageStore'
import { signedChequeAtomic } from './signedChequeArchive'

export type IngestItemSettleResult = {
  accepted: boolean
  outpoints: string[]
  reason?: string
}

export function itemSettleIsSelfSend(txid: string): boolean {
  return Boolean(signedChequeAtomic(txid.trim().toLowerCase())?.length)
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
  /** BRC-150 remittance from the inbox envelope — verify without an indexer walk. */
  provenance?: unknown
  /** Per-vout identities merged from every inbox card sharing this txid. */
  items?: ItemTransferMember[]
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

  const parsedProof = parseProvenanceV2(opts.provenance)
  if (parsedProof) rememberProvenanceRemittance(parsedProof)
  for (const item of opts.items ?? []) {
    const proof = parseProvenanceV2(item.provenance)
    if (proof) rememberProvenanceRemittance(proof)
  }

  // Every source is re-framed for this subject: internalize takes AtomicBEEF
  // only, and a plain-BEEF envelope must fall through to the next source rather
  // than fail the settle for good.
  let atomic = atomicBeefForSubject(opts.tx, id)
  if (!atomic?.length && opts.beefUrl) {
    atomic = atomicBeefForSubject(await fetchAtomicBeefFromUrl(opts.beefUrl), id)
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
  const members = new Map(
    (opts.items ?? [])
      .filter((item) => tipVouts.includes(item.outputIndex))
      .map((item) => [item.outputIndex, item] as const),
  )
  // Tips this account is internalizing are tips this account holds. Hide
  // marks written by another wallet on this device (builds before the guards
  // were scoped per account) would otherwise keep them out of Collect.
  forgetItemsSent(allOps)
  // A messagebox copy of our own item send can arrive before the sender pin
  // finishes. createAction already filed the self-owned tip in `1sat`; calling
  // internalizeAction on the same noSend transaction again can detach its
  // managed-change row and make the cash balance disappear until a deep heal.
  // The signed archive is account-scoped, so this is specifically a self-send,
  // not another wallet on the same device receiving the transaction.
  if (itemSettleIsSelfSend(id)) {
    markOneSatImported(allOps)
    rememberReceivedProofs(id, tipVouts, members, opts.provenance)
    paintReceivedTips({
      txid: id,
      tipVouts,
      originHint,
      name,
      app,
      collectionId,
      members,
      chain: active.chain,
    })
    console.info(
      `[item-settle] accepted self-send ${allOps.join(', ')} from existing basket`,
    )
    return { accepted: true, outpoints: allOps, reason: 'already-imported' }
  }
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
      members,
      chain: active.chain,
    })
    return { accepted: true, outpoints: allOps, reason: 'already-imported' }
  }

  try {
    // Re-post the same signed cheque as best-effort redundancy. Asset
    // internalization is not gated by miner transport or metadata type.
    void broadcastAtomicBeef(id, atomic).catch((err) => {
      console.warn(
        '[item-settle] redundant broadcast failed',
        id.slice(0, 12),
        err,
      )
    })
    rememberBeefTree(atomic, id)

    const remittanceOutputs = tipVouts.map((vout) => {
      const member = members.get(vout)
      const memberOrigin = member?.origin?.trim()
      const origin = memberOrigin
        ? normalizeOriginHint(memberOrigin, id)!
        : originForTipVout(id, vout, tipVouts, originHint)
      const priorByOrigin = getResolvedInscriptionByOrigin(origin)
      const tipName =
        member?.name?.trim() ||
        (originHint && origin === normalizeOriginHint(originHint, id)
          ? name
          : priorByOrigin?.name?.trim()) || name
      const tipCollection =
        member?.collectionId?.trim() ||
        collectionId ||
        priorByOrigin?.collectionId ||
        undefined
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
    rememberReceivedProofs(id, tipVouts, members, opts.provenance)
    scheduleHistoryBackupPush('internalizeAction')
    paintReceivedTips({
      txid: id,
      tipVouts,
      originHint,
      name,
      app,
      collectionId,
      members,
      chain: active.chain,
    })
    console.info(
      `[item-settle] accepted ${allOps.join(', ')} into 1sat (${allOps.length} tip(s))`,
    )
    return { accepted: true, outpoints: allOps }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      markOneSatImported(allOps)
      rememberReceivedProofs(id, tipVouts, members, opts.provenance)
      paintReceivedTips({
        txid: id,
        tipVouts,
        originHint,
        name,
        app,
        collectionId,
        members,
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

function rememberReceivedProofs(
  txid: string,
  tipVouts: number[],
  members: ReadonlyMap<number, ItemTransferMember>,
  fallback: unknown,
): void {
  if (members.size === 0) {
    rememberPeerRemittanceForHeldTips(
      tipVouts.map((vout) => `${txid}.${vout}`),
      fallback,
    )
    return
  }
  for (const vout of tipVouts) {
    rememberPeerRemittanceForHeldTips(
      [`${txid}.${vout}`],
      members.get(vout)?.provenance,
    )
  }
}

function paintReceivedTips(args: {
  txid: string
  tipVouts: number[]
  originHint: string | undefined
  name: string
  app: string | undefined
  collectionId: string | undefined
  members: ReadonlyMap<number, ItemTransferMember>
  chain: Chain
}): void {
  const { txid: id, tipVouts, originHint, app, collectionId, members, chain } = args
  let name = args.name
  const preferred = pickTipVoutForOriginHint(id, tipVouts, originHint)
  const hint = normalizeOriginHint(originHint, id)

  // Drop the early txid-only Verifying… row so per-tip completes don't leave an
  // orphan pending beside the real outpoint rows.
  clearInboundReceivePending(id)

  const paintedOps: string[] = []
  for (const vout of tipVouts) {
    const tipOp = `${id}.${vout}`
    const member = members.get(vout)
    const origin = member?.origin?.trim()
      ? normalizeOriginHint(member.origin, id)!
      : originForTipVout(id, vout, tipVouts, originHint)
    const priorByOrigin = getResolvedInscriptionByOrigin(origin)
    const isHintTip = Boolean(hint && preferred === vout && origin === hint)
    if (isHintTip && priorByOrigin?.name?.trim()) {
      name = priorByOrigin.name.trim()
    }
    const tipName = member?.name?.trim() || (isHintTip
      ? name
      : priorByOrigin?.name?.trim() || name)
    const tipCollection =
      member?.collectionId?.trim() ||
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
