import type { Transaction } from '@bsv/sdk'
import { uiBudgetExpired, yieldToUi } from './yieldToUi'

/**
 * Unlock the wallet's own tip inputs, one template at a time.
 *
 * `Transaction.sign()` deep-copies the whole transaction graph — every source
 * transaction, inscriptions included — once per signed input, so n tips cost
 * n² source copies in one task. That, not the signatures, is what froze the
 * renderer at ten tips and kept bulk sends and burns capped. Each template
 * here signs the live transaction, and the UI gets a turn between inputs.
 *
 * Every vin must already carry its `unlockingScriptTemplate` and the source
 * output its sighash commits to. Returns the unlocking script hex per vin.
 */
export async function signTipInputs(
  tx: Transaction,
  vins: readonly number[],
): Promise<Record<number, { unlockingScript: string }>> {
  const startedAt = Date.now()
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const vin of vins) {
    const input = tx.inputs[vin]
    const template = input?.unlockingScriptTemplate
    if (!input || !template) throw new Error(`Input ${vin} has no unlocking template`)
    if (uiBudgetExpired()) await yieldToUi()
    const unlocking = await template.sign(tx, vin)
    input.unlockingScript = unlocking
    const hex = unlocking?.toHex()
    if (!hex) throw new Error(`Input ${vin} signed to an empty unlocking script`)
    spends[vin] = { unlockingScript: hex }
  }
  const ms = Date.now() - startedAt
  if (ms >= 250) console.info(`[sign] tip inputs done ${ms}ms — ${vins.length} input(s)`)
  return spends
}
