import { getActiveWallet } from './session'

import { inputOutpointsFromAtomicBeef, inputOutpointsFromRawTx } from './txOutpoints'
import { normalizeTxid } from './txid'

/** Prevouts of a signed tx from Atomic BEEF, else local storage raw. */
export async function inputOutpointsForSignedTx(
  txid: string,
  atomic?: number[],
): Promise<string[]> {
  const id = normalizeTxid(txid)
  if (!id) return []
  if (atomic?.length) {
    const fromBeef = inputOutpointsFromAtomicBeef(atomic, id)
    if (fromBeef.length > 0) return fromBeef
  }
  const storage = getActiveWallet()?.wallet?.storage
  if (!storage?.runAsStorageProvider) return []
  try {
    const raw = await storage.runAsStorageProvider(
      async (sp: { getProvenOrRawTx?: (txid: string) => Promise<{ rawTx?: number[] }> }) =>
        sp.getProvenOrRawTx?.(id),
    )
    if (raw?.rawTx?.length) return inputOutpointsFromRawTx(raw.rawTx)
  } catch {
    /* local raw optional */
  }
  return []
}
