/**
 * Payee ingest of a P2P soft-latch item settle (Atomic BEEF from messagebox).
 *
 * Internalize tip + latch, then the **payee** broadcasts. Chain custody still
 * works if the box is down — address scan remains the fallback.
 */
import { Beef } from '@bsv/sdk'
import { getActiveWallet } from './session'
import { rememberBeefTree } from './beefCache'
import { scriptPaysAddress } from './ordinalOwnership'
import {
  findLatchStateForTip,
  isLatchDustSats,
  latchOutputTags,
  ONE_SAT_LATCH_BASKET,
} from './oneSatLatch'
import { buildInternalizeCustomInstructions } from './oneSatProvenance'
import {
  beginOneSatImport,
  markOneSatImported,
  markOneSatImportFailed,
} from './oneSatImportGuard'
import { rememberResolvedInscription } from './inscriptionCache'
import { announceItemsReceived } from './itemArrivalToast'
import { scheduleHistoryBackupPush } from './deviceSync'
import { broadcastAtomicBeef } from './sendBrc29Payment'

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
}): Promise<IngestItemSettleResult> {
  const id = opts.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { accepted: false, outpoints: [], reason: 'invalid-txid' }
  }
  if (!opts.tx?.length && !opts.beefUrl?.trim()) {
    return { accepted: false, outpoints: [], reason: 'missing-beef' }
  }
  const active = getActiveWallet()
  if (!active) return { accepted: false, outpoints: [], reason: 'locked' }

  let atomic = opts.tx
  if ((!atomic || !atomic.length) && opts.beefUrl) {
    atomic = await fetchAtomicBeefFromUrl(opts.beefUrl)
  }
  if (!atomic?.length) {
    return { accepted: false, outpoints: [], reason: 'missing-beef' }
  }

  let tipVout = -1
  let latchVout = -1
  let origin = `${id}_0`
  let name = opts.name?.trim() || 'Collectable'
  let app: string | undefined
  try {
    const beef = Beef.fromBinary(atomic)
    const tx = beef.findTxid(id)?.tx ?? beef.findAtomicTransaction(id)
    if (!tx) {
      return { accepted: false, outpoints: [], reason: 'beef-missing-tx' }
    }
    const outputs = tx.outputs ?? []
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i]
      const sats = out?.satoshis
      const hex = out?.lockingScript?.toHex()
      if (!hex || !scriptPaysAddress(hex, active.address)) continue
      if (sats === 1 && tipVout < 0) tipVout = i
      else if (typeof sats === 'number' && isLatchDustSats(sats) && latchVout < 0) {
        latchVout = i
      }
    }
    if (tipVout < 0) {
      return { accepted: false, outpoints: [], reason: 'no-tip-paying-us' }
    }
    const latchState = findLatchStateForTip(
      outputs.map((o) => ({ lockingScript: o?.lockingScript?.toHex() })),
      tipVout,
    )
    if (latchState?.origin) origin = latchState.origin
    if (latchState?.name?.trim()) name = latchState.name.trim()
    if (latchState?.app?.trim()) app = latchState.app.trim()
  } catch (err) {
    return {
      accepted: false,
      outpoints: [],
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const tipOp = `${id}.${tipVout}`
  const latchOp = latchVout >= 0 ? `${id}.${latchVout}` : null
  const allOps = latchOp ? [tipOp, latchOp] : [tipOp]
  const claimed = beginOneSatImport(allOps)
  if (claimed.length === 0) {
    return { accepted: true, outpoints: allOps, reason: 'already-imported' }
  }

  try {
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
          tags: [
            'ordinal',
            `origin:${origin.replace(/_(\d+)$/, '.$1')}`,
            ...(name ? [`name:${name.slice(0, 80)}`] : []),
            ...(app ? [`app:${app.slice(0, 40)}`] : []),
          ],
          customInstructions: buildInternalizeCustomInstructions({
            origin,
            name,
            app,
          }),
        },
      },
    ]
    if (latchVout >= 0) {
      remittanceOutputs.push({
        outputIndex: latchVout,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: ONE_SAT_LATCH_BASKET,
          tags: latchOutputTags({ origin, tip: 'OUTPUT:0' }),
          customInstructions: JSON.stringify({
            schema: 1,
            origin,
            tip: 'OUTPUT:0',
          }),
        },
      })
    }

    await active.wallet.internalizeAction({
      tx: atomic,
      description: 'Receive soft-latch item',
      labels: ['1sat', '1sat-latch', 'handcash-item-p2p'],
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
    announceItemsReceived([tipOp])
    scheduleHistoryBackupPush('internalizeAction')
    try {
      const { listCollectables } = await import('./collectables')
      await listCollectables(active)
    } catch {
      /* paint on next poll */
    }
    return { accepted: true, outpoints: allOps }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      markOneSatImported(allOps)
      return { accepted: true, outpoints: allOps, reason: 'already-imported' }
    }
    markOneSatImportFailed(allOps)
    return {
      accepted: false,
      outpoints: [],
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
