/**
 * Payee ingest of a P2P BSV-21 settle.
 *
 * This is the fungible twin of `internalizePeerItemSettle`: validate the
 * recipient output from Atomic BEEF, let the payee broadcast, then internalize
 * the exact BSV-21 tip into basket `bsv21`. No indexer decides custody.
 */
import { Beef } from '@bsv/sdk'
import type { AtomicBeefPurpose } from './beefCache'
import {
  BSV21_BASKET,
  buildBsv21CustomInstructions,
  bsv21Tags,
  normalizeTokenId,
  parseBsv21Json,
} from './bsv21'
import { rememberBeefTree } from './beefCache'
import { scheduleHistoryBackupPush } from './deviceSync'
import { listFungibles } from './fungibles'
import {
  beginOneSatImport,
  markOneSatImported,
  markOneSatImportFailed,
} from './oneSatImportGuard'
import { parseOrdEnvelope, scriptPaysAddress } from './ordinalOwnership'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { getActiveWallet } from './session'
import { stampBrc164Id } from './itemAccess'
import {
  clearInboundReceivePending,
  noteInboundReceiveComplete,
  noteInboundReceivePending,
} from './appActivity'
import type { ItemTransferAsset } from './messageStore'

type FungibleAsset = Extract<ItemTransferAsset, { kind: 'fungible' }>

export type IngestFungibleSettleResult = {
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

export async function internalizePeerFungibleSettle(opts: {
  txid: string
  tx?: number[]
  beefUrl?: string
  token: FungibleAsset
  /** Inbox hints race sender postBeef and therefore use a short retry backoff. */
  beefPurpose?: AtomicBeefPurpose
}): Promise<IngestFungibleSettleResult> {
  const id = opts.txid.trim().toLowerCase()
  const tokenId = normalizeTokenId(opts.token.tokenId)
  const amount = opts.token.amount.trim()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { accepted: false, outpoints: [], reason: 'invalid-txid' }
  }
  if (!tokenId || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    return { accepted: false, outpoints: [], reason: 'invalid-token-remittance' }
  }
  const active = getActiveWallet()
  if (!active) return { accepted: false, outpoints: [], reason: 'locked' }

  noteInboundReceivePending({
    txid: id,
    item: true,
    itemName: opts.token.sym,
    token: opts.token,
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
        console.warn('[fungible-settle] AtomicBEEF fetch failed', id.slice(0, 12), err)
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
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i]
      const scriptHex = output?.lockingScript?.toHex()
      if (
        output?.satoshis !== 1 ||
        !scriptHex ||
        !scriptPaysAddress(scriptHex, active.address)
      ) {
        continue
      }
      const envelope = parseOrdEnvelope(scriptHex)
      if (!envelope) continue
      let payload: ReturnType<typeof parseBsv21Json> = null
      try {
        payload = parseBsv21Json(
          JSON.parse(new TextDecoder().decode(envelope.body)),
        )
      } catch {
        // Not a BSV-21 inscription.
      }
      if (
        payload?.op === 'transfer' &&
        payload.id === tokenId &&
        payload.amt === amount
      ) {
        if (tipVout >= 0) {
          clearInboundReceivePending(id)
          return {
            accepted: false,
            outpoints: [],
            reason: 'ambiguous-token-output',
          }
        }
        tipVout = i
      }
    }
  } catch (err) {
    clearInboundReceivePending(id)
    return {
      accepted: false,
      outpoints: [],
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  if (tipVout < 0) {
    clearInboundReceivePending(id)
    return { accepted: false, outpoints: [], reason: 'no-token-tip-paying-us' }
  }

  const tipOp = `${id}.${tipVout}`
  const claimed = beginOneSatImport([tipOp])
  if (claimed.length === 0) {
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: opts.token.sym,
      outpoint: tipOp,
      token: opts.token,
    })
    return { accepted: true, outpoints: [tipOp], reason: 'already-imported' }
  }

  try {
    // peerDeliver: the payee is the intended first broadcaster.
    await broadcastAtomicBeef(id, atomic)
    rememberBeefTree(atomic, id)
    await active.wallet.internalizeAction({
      tx: atomic,
      description: `Receive ${opts.token.sym}`.slice(0, 50),
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
                amt: amount,
                sym: opts.token.sym,
                issuer: opts.token.issuer,
                op: 'transfer',
              }),
            ),
            customInstructions: buildBsv21CustomInstructions({
              tokenId,
              amt: amount,
              op: 'transfer',
              sym: opts.token.sym,
              icon: opts.token.icon,
              dec: opts.token.dec,
              issuer: opts.token.issuer,
            }),
          },
        },
      ],
      seekPermission: false,
    })
    markOneSatImported([tipOp])
    rememberBeefTree(atomic, id)
    noteInboundReceiveComplete({
      txid: id,
      item: true,
      itemName: opts.token.sym,
      outpoint: tipOp,
      token: opts.token,
    })
    scheduleHistoryBackupPush('internalizeFungibleAction')
    void listFungibles(active).catch(() => {})
    return { accepted: true, outpoints: [tipOp] }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      markOneSatImported([tipOp])
      noteInboundReceiveComplete({
        txid: id,
        item: true,
        itemName: opts.token.sym,
        outpoint: tipOp,
        token: opts.token,
      })
      void listFungibles(active).catch(() => {})
      return { accepted: true, outpoints: [tipOp], reason: 'already-imported' }
    }
    markOneSatImportFailed([tipOp])
    clearInboundReceivePending(id)
    return {
      accepted: false,
      outpoints: [],
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
