import { Beef, P2PKH, Transaction } from '@bsv/sdk'
import { hydrateInputBeef, rememberBeefBinary } from './beefCache'
import type { ActiveWallet } from './session'
import { tipSigningKey } from './tipKeys'

/** Ceiling on proof hydration before the signed body is cached raw. */
const HYDRATE_BUDGET_MS = 6_000

export type SignableTransaction = {
  tx: number[]
  reference: string
}

/**
 * Sigma anchor inputs use `unlockingScriptLength`, so createAction returns
 * `signableTransaction` without a txid. Complete each named input with the
 * P2PKH key its tip derives from.
 */
export async function completeSignableWithTipKeys(
  active: ActiveWallet,
  signable: SignableTransaction,
  inputOutpoints: string[],
): Promise<{ txid: string; tx?: number[] }> {
  const targets = new Set(
    inputOutpoints
      .map((op) => normalizeDotOutpoint(op))
      .filter(Boolean)
      .map((op) => {
        const [txid, vout] = op.split('.')
        return `${txid}.${Number(vout)}`
      }),
  )
  if (targets.size === 0) {
    throw new Error('Signable transaction has no inputs to unlock')
  }

  const beef = Beef.fromBinary(signable.tx)
  let unsigned: Transaction | undefined
  const vins: number[] = []
  for (const btx of beef.txs) {
    if (!btx.tx) continue
    for (let i = 0; i < btx.tx.inputs.length; i++) {
      const input = btx.tx.inputs[i]
      const key = `${String(input?.sourceTXID).toLowerCase()}.${input?.sourceOutputIndex}`
      if (targets.has(key)) {
        unsigned = btx.tx
        vins.push(i)
      }
    }
    if (unsigned && vins.length === targets.size) break
  }
  if (!unsigned || vins.length === 0) {
    throw new Error('Anchor input missing from the signable transaction')
  }

  const spends: Record<number, { unlockingScript: string }> = {}
  for (const vin of vins) {
    const input = unsigned.inputs[vin]!
    input.sourceTransaction ??= beef.findTxid(String(input.sourceTXID))?.tx
    const sourceOut =
      input.sourceTransaction?.outputs[input.sourceOutputIndex]
    const satoshis = sourceOut?.satoshis
    const lockingScript = sourceOut?.lockingScript
    if (typeof satoshis !== 'number' || !lockingScript) {
      throw new Error('Signable input is missing its source transaction')
    }
    // Sighash scriptCode must be the full locking script; a plain P2PKH
    // template fails CHECKSIG on a tip carrying an envelope or Sigma tape.
    input.unlockingScriptTemplate = new P2PKH().unlock(
      await tipSigningKey(active, lockingScript.toHex()),
      'all',
      false,
      satoshis,
      lockingScript,
    )
  }
  await unsigned.sign()
  for (const vin of vins) {
    const unlockingScript = unsigned.inputs[vin]?.unlockingScript?.toHex()
    if (!unlockingScript) throw new Error('Could not sign the anchor input')
    spends[vin] = { unlockingScript }
  }

  const signed = await active.wallet.signAction({
    reference: signable.reference,
    spends,
  })
  const txid =
    typeof signed.txid === 'string' ? signed.txid.trim().toLowerCase() : ''
  if (!txid) throw new Error('signAction returned no txid')

  let txBinary: number[] | undefined = Array.isArray(signed.tx)
    ? (signed.tx as number[])
    : undefined
  if (!txBinary) {
    try {
      // Cache parents + the newly signed subject so a follow-up spend can
      // prove it before any indexer has it.
      const wrap = new Beef()
      wrap.mergeBeef(signable.tx)
      wrap.mergeTransaction(unsigned)
      wrap.atomicTxid = undefined
      txBinary = (await hydrateWithinBudget(active, wrap)) ?? rawBeefBinary(wrap)
    } catch (err) {
      console.warn('[signable] could not wrap the signed tx for the BEEF cache', err)
    }
  }
  if (txBinary?.length) {
    try {
      const stored =
        (await hydrateWithinBudget(active, Beef.fromBinary(txBinary))) ?? txBinary
      rememberBeefBinary(txid, stored)
      txBinary = stored
    } catch {
      rememberBeefBinary(txid, txBinary)
    }
  }

  return {
    txid,
    ...(txBinary ? { tx: txBinary } : {}),
  }
}

function normalizeDotOutpoint(op: string): string {
  const m = op
    .trim()
    .toLowerCase()
    .match(/^([0-9a-f]{64})[._](\d+)$/)
  if (!m) return op.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  return `${m[1]}.${m[2]}`
}

async function hydrateWithinBudget(
  active: ActiveWallet,
  beef: Beef,
): Promise<number[] | undefined> {
  try {
    return await Promise.race([
      hydrateInputBeef(active, beef),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), HYDRATE_BUDGET_MS),
      ),
    ])
  } catch (err) {
    console.warn('[signable] BEEF hydrate failed', err)
    return undefined
  }
}

/**
 * Serialize without asking whether the ancestry is proven. Signing only needs
 * each spend's source body; proofs are a broadcast concern.
 */

function rawBeefBinary(beef: Beef): number[] | undefined {
  try {
    const work = beef.clone()
    work.atomicTxid = undefined
    return work.toBinary()
  } catch {
    return undefined
  }
}
