import { Transaction } from '@bsv/sdk'
import { fileHoldingsDepartures } from './holdingsReconcile'
import { scriptPaysAddress } from './ordinalOwnership'
import { decodeBsv21Binary } from './token/decode162'
import { subjectRawTxFromAtomicBeef } from './txOutpoints'

/**
 * A signed send that reached a miner while local storage never recorded it
 * (Toolbox auto action batch, before 1.3.428) left its own token and item
 * change in no basket. File those 1-sat outputs with the holdings reconcile,
 * which proves each unspent on chain and claims it from this transaction.
 * BSV change has no such path: its derivation lived only in the dropped batch.
 */
export function fileUnstoredSendTips(
  txid: string,
  atomic: number[],
  address: string,
): { tokens: number; items: number } {
  const raw = subjectRawTxFromAtomicBeef(atomic, txid)
  if (!raw) return { tokens: 0, items: 0 }
  const tx = Transaction.fromBinary(raw)
  const tokens: string[] = []
  const items: string[] = []
  tx.outputs.forEach((out, vout) => {
    if (out.satoshis !== 1) return
    const script = out.lockingScript.toHex()
    if (!scriptPaysAddress(script, address)) return
    const outpoint = `${txid.toLowerCase()}.${vout}`
    if (decodeBsv21Binary(out.lockingScript)) tokens.push(outpoint)
    else items.push(outpoint)
  })
  if (tokens.length > 0) fileHoldingsDepartures('token', tokens)
  if (items.length > 0) fileHoldingsDepartures('item', items)
  if (tokens.length + items.length > 0) {
    console.info(
      `[holdings] unstored send ${txid.slice(0, 12)} — filed tokens=${tokens.length} items=${items.length} for claim`,
    )
  }
  return { tokens: tokens.length, items: items.length }
}
