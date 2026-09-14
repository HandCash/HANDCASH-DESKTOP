/**
 * Finish a signable createAction input with the persona key, not the root.
 * Sighash scriptCode is the full locking script (inscription ‖ P2PKH ‖ Sigma).
 */

import { Beef, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import type { ActiveWallet } from '../session'

export async function completeSignableWithKey(
  active: ActiveWallet,
  signable: { tx: number[]; reference: string },
  inputOutpoint: string,
  key: PrivateKey,
): Promise<{ txid: string; tx?: number[] }> {
  const [txidRaw, voutRaw] = inputOutpoint.trim().toLowerCase().split('.')
  const want = `${txidRaw}.${Number(voutRaw)}`
  const beef = Beef.fromBinary(signable.tx)
  let unsigned: Transaction | undefined
  let vin = -1
  for (const btx of beef.txs) {
    if (!btx.tx) continue
    for (let i = 0; i < btx.tx.inputs.length; i++) {
      const input = btx.tx.inputs[i]
      const keyId = `${String(input?.sourceTXID).toLowerCase()}.${input?.sourceOutputIndex}`
      if (keyId === want) {
        unsigned = btx.tx
        vin = i
        break
      }
    }
    if (unsigned) break
  }
  if (!unsigned || vin < 0) {
    throw new Error('Sigma identity input is missing from the signable transaction.')
  }
  if (vin !== 0) {
    throw new Error('Sigma identity input was not VIN 0, so the signature would not bind.')
  }
  const input = unsigned.inputs[vin]!
  input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
  const sourceOut = input.sourceTransaction?.outputs[input.sourceOutputIndex]
  const satoshis = sourceOut?.satoshis
  const lockingScript = sourceOut?.lockingScript
  if (typeof satoshis !== 'number' || !lockingScript) {
    throw new Error('Sigma identity input is missing its source transaction.')
  }
  input.unlockingScriptTemplate = new P2PKH().unlock(
    key,
    'all',
    false,
    satoshis,
    lockingScript,
  )
  await unsigned.sign()
  const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
  if (!unlockingScript) throw new Error('Could not sign the Sigma identity input.')

  const signed = await active.wallet.signAction({
    reference: signable.reference,
    spends: { [vin]: { unlockingScript } },
  })
  const txid = typeof signed.txid === 'string' ? signed.txid.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error('Sigma identity sign returned no transaction id.')
  }
  const tx = Array.isArray(signed.tx) ? (signed.tx as number[]) : undefined
  return { txid, ...(tx ? { tx } : {}) }
}
