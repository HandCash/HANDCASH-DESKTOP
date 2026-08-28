/**
 * Payee ingest of a P2P 1Sat fungible settle.
 *
 * Same tip move as collectables, but files into basket `1sat-ft` with FT
 * tags / CI (including face-value `amt`) — never `1sat` (NFT) or `bsv21`.
 */
import { Beef } from '@bsv/sdk'
import type { AtomicBeefPurpose } from './beefCache'
import { rememberBeefTree } from './beefCache'
import {
  buildColourCustomInstructions,
  ONESAT_FT_BASKET,
  colourTags,
  normalizeColourOrigin,
} from './colourCoins'
import { listColourTokens } from './colourListing'
import { scheduleHistoryBackupPush } from './deviceSync'
import { stampBrc164Id } from './itemAccess'
import {
  beginOneSatImport,
  markOneSatImported,
  markOneSatImportFailed,
} from './oneSatImportGuard'
import { scriptPaysAddress } from './ordinalOwnership'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { getActiveWallet } from './session'
import {
  clearInboundReceivePending,
  noteInboundReceiveComplete,
  noteInboundReceivePending,
} from './appActivity'
import type { ItemTransferAsset } from './messageStore'

type ColourAsset = Extract<ItemTransferAsset, { kind: '1sat-ft' }>

/**
 * Activity remittance for a 1sat-ft receive.
 * tokenId is the mint origin (normalizeColourOrigin), never the receive outpoint.
 */
export function colourSettleActivityToken(
  token: ColourAsset,
  origin: string,
  amount: string,
): {
  tokenId: string
  amount: string
  sym: string
  dec: number
} {
  return {
    tokenId: origin,
    amount,
    sym: token.sym?.trim() || 'Token',
    dec: 0,
  }
}

export type IngestColourSettleResult = {
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

export async function internalizePeerColourSettle(opts: {
  txid: string
  tx?: number[]
  beefUrl?: string
  token: ColourAsset
  beefPurpose?: AtomicBeefPurpose
}): Promise<IngestColourSettleResult> {
  const id = opts.txid.trim().toLowerCase()
  let origin: string
  try {
    origin = normalizeColourOrigin(opts.token.origin)
  } catch {
    return { accepted: false, outpoints: [], reason: 'invalid-colour-origin' }
  }
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { accepted: false, outpoints: [], reason: 'invalid-txid' }
  }
  const active = getActiveWallet()
  if (!active) return { accepted: false, outpoints: [], reason: 'locked' }

  const sym = opts.token.sym?.trim() || 'Token'
  const faceAmt = (() => {
    const raw = opts.token.amount?.replace(/\D/g, '') ?? ''
    const n = Number(raw)
    return Number.isSafeInteger(n) && n > 0 ? n : 1
  })()
  const tokenPaint = colourSettleActivityToken(opts.token, origin, String(faceAmt))
  noteInboundReceivePending({
    txid: id,
    item: true,
    itemName: sym,
    itemOrigin: origin,
    token: tokenPaint,
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
        console.warn('[colour-settle] AtomicBEEF fetch failed', id.slice(0, 12), err)
      }
    }
  }
  if (!atomic?.length) {
    clearInboundReceivePending(id)
    return { accepted: false, outpoints: [], reason: 'missing-beef' }
  }

  let tipVout = -1
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
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: sym,
      itemOrigin: origin,
      outpoint: tipOp,
      token: tokenPaint,
    })
    return { accepted: true, outpoints: allOps, reason: 'already-imported' }
  }

  try {
    await broadcastAtomicBeef(id, atomic)
    rememberBeefTree(atomic, id)

    await active.wallet.internalizeAction({
      tx: atomic,
      description: `Receive ${sym}`.slice(0, 50),
      labels: [ONESAT_FT_BASKET, 'handcash-1sat-ft-p2p'],
      outputs: [
        {
          outputIndex: tipVout,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: ONESAT_FT_BASKET,
            tags: stampBrc164Id(colourTags(origin, [`name:${sym.slice(0, 80)}`])),
            customInstructions: buildColourCustomInstructions({
              origin,
              sym,
              name: sym,
              amt: faceAmt,
              supply: opts.token.supply,
              maxSupply: opts.token.maxSupply ?? null,
            }),
          },
        },
      ],
      seekPermission: false,
    })

    markOneSatImported(allOps)
    rememberBeefTree(atomic, id)
    scheduleHistoryBackupPush('internalizeAction')
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: sym,
      itemOrigin: origin,
      outpoint: tipOp,
      token: tokenPaint,
    })
    void listColourTokens(active).catch(() => {})
    console.info(`[1sat-ft-settle] accepted ${tipOp} into 1sat-ft`)
    return { accepted: true, outpoints: allOps }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      markOneSatImported(allOps)
      noteInboundReceiveComplete({
        txid: id,
        item: true,
        itemName: sym,
        itemOrigin: origin,
        outpoint: tipOp,
        token: tokenPaint,
      })
      void listColourTokens(active).catch(() => {})
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
