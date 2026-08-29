/**
 * Payee ingest of a P2P token settle tagged `1sat-ft` (inbound decode only).
 * Files 162 value tips into basket `bsv21`. Non-162 1sat-ft is rejected —
 * never basket `1sat-ft`. 1sat NFT settle stays on ingestItemSettle.
 */
import { Beef } from '@bsv/sdk'
import type { AtomicBeefPurpose } from './beefCache'
import { rememberBeefTree } from './beefCache'
import { normalizeColourOrigin } from './colourCoins'
import { listBsv21BinaryTokens } from './colourListing'
import {
  BSV21_BASKET,
  buildBsv21CustomInstructions,
  bsv21Tags,
} from './bsv21'
import { decodeBsv21Binary } from './bsv21Binary'
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

    const tipScript = (() => {
      try {
        const beef = Beef.fromBinary(atomic)
        const tx = beef.findTxid(id)?.tx ?? beef.findAtomicTransaction(id)
        return tx?.outputs?.[tipVout]?.lockingScript?.toHex()
      } catch {
        return undefined
      }
    })()
    const binary = tipScript ? decodeBsv21Binary(tipScript) : null
    const fileBsv21 = Boolean(binary && binary.amount > 0n)
    if (!fileBsv21) {
      markOneSatImportFailed(allOps)
      clearInboundReceivePending(id)
      return { accepted: false, outpoints: [], reason: 'not-bsv21' }
    }
    const tokenId = binary?.tokenId ?? origin
    const amtStr = binary?.amount.toString() ?? String(faceAmt)
    await active.wallet.internalizeAction({
      tx: atomic,
      description: `Receive ${sym}`.slice(0, 50),
      labels: [BSV21_BASKET, 'handcash-token-p2p'],
      outputs: [
        {
          outputIndex: tipVout,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: BSV21_BASKET,
            tags: stampBrc164Id(
              bsv21Tags({
                tokenId,
                amt: amtStr,
                sym,
                op: 'transfer',
              }),
            ),
            customInstructions: buildBsv21CustomInstructions({
              tokenId,
              amt: amtStr,
              op: 'transfer',
              sym,
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
    void listBsv21BinaryTokens(active).catch(() => {})
    console.info(`[token-settle] accepted ${tipOp} into bsv21`)
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
      void listBsv21BinaryTokens(active).catch(() => {})
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
