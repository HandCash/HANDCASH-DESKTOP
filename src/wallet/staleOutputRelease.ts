/**
 * Writing off spendable outputs — the only path allowed to do it.
 *
 * `reviewSpendableOutputs(all, release)` decides an output is dead through
 * `services.isUtxo`, which returns `or.isUtxo === true`. An indexer that has not
 * seen our unconfirmed change and a UTXO service that errored both answer
 * `false`, and `release` then sets `spendable: false` permanently. So a bulk
 * release run on a schedule destroys live coins, which is why chain ingest only
 * ever audits (see `chainIngest.auditSpendableOutputs`).
 *
 * A node rejecting a spend because an input is already spent is different: that
 * is affirmative evidence our set is stale, and it is the only trigger for the
 * release here.
 */
import { getActiveWallet } from './session'

/** Cap restore work so a huge dead set cannot stall unlock/refresh. */
const RESTORE_MAX = 200

/** The toolbox rejects `undefined` partial filters on some storage backends. */
export function isUndefinedPartialFilterError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes('must be not undefined') ||
    message.includes('Passing undefined as a filter value is not supported')
  )
}

/** True only for a rejection that proves an input is spent or gone. */
export function isAlreadySpentInputError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('missing inputs') ||
    message.includes('missingorspent') ||
    message.includes('mempool-conflict') ||
    message.includes('already spent') ||
    message.includes('double spend') ||
    message.includes('doublespend')
  )
}

/**
 * Wallet storage marked an input unspendable (failed createAction / signAction
 * that did not roll back). Not proof the UTXO is gone on-chain — do **not**
 * {@link releaseStaleSpendableOutputs}; abort + unfail instead.
 */
export function isNoLongerSpendableError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('no longer spendable') ||
    (message.includes('werr_invalid_operation') && message.includes('spendable'))
  )
}

/**
 * Write off outputs the network refuses to spend. Call only after a spend failed
 * with {@link isAlreadySpentInputError}.
 *
 * @returns how many outputs were released.
 */
export async function releaseStaleSpendableOutputs(): Promise<number> {
  const active = getActiveWallet()
  if (!active) return 0
  try {
    let result
    try {
      result = await active.wallet.reviewSpendableOutputs(true, true)
    } catch (err) {
      if (!isUndefinedPartialFilterError(err)) throw err
      result = await active.wallet.reviewSpendableOutputs(false, true)
    }
    const released = result.outputs?.length ?? 0
    if (released > 0) {
      console.info(
        `[stale-output] released ${released} output(s) the network rejected as spent`,
      )
    }
    return released
  } catch (err) {
    console.warn('[stale-output] release failed', err)
    return 0
  }
}

/**
 * Re-enable outputs that were written off (`spendable: false`) but are still
 * unspent on-chain. Used after a bad bulk release (iterator-crash recovery)
 * so balance matches reality again.
 *
 * @returns how many outputs were restored.
 */
export async function restoreLiveSpendableOutputs(): Promise<number> {
  const active = getActiveWallet()
  if (!active) return 0
  const storage = active.wallet.storage
  const services = active.services
  if (!storage || typeof storage.findOutputs !== 'function') return 0
  if (!services || typeof services.isUtxo !== 'function') return 0

  try {
    const dead = await storage.findOutputs({ partial: { spendable: false } })
    if (!dead?.length) return 0

    let restored = 0
    for (const output of dead.slice(0, RESTORE_MAX)) {
      const outputId = Number((output as { outputId?: number }).outputId)
      if (!Number.isFinite(outputId) || outputId <= 0) continue
      try {
        const stillUtxo = await services.isUtxo(output as never)
        if (stillUtxo !== true) continue
        await storage.runAsStorageProvider(async (sp) => {
          await sp.updateOutput(outputId, {
            spendable: true,
            spentBy: undefined,
          })
        })
        restored += 1
      } catch (err) {
        console.warn(
          '[stale-output] restore skipped',
          outputId,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    if (restored > 0) {
      console.info(
        `[stale-output] restored ${restored} live output(s) previously marked unspendable`,
      )
    }
    return restored
  } catch (err) {
    console.warn('[stale-output] restore failed', err)
    return 0
  }
}
