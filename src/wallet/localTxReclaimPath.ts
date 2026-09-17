/**
 * May the wallet take back the inputs of a signed transaction that never
 * reached the chain?
 *
 * A send seals its inputs before anyone broadcasts. On a `peerDeliver` item
 * transfer the recipient is the broadcaster, so a transfer they never publish
 * leaves the sender's coins sealed against a transaction that does not exist —
 * unclearable by design (the row is the only record) and unspendable in
 * practice. Reclaim is the deliberate way out: the holder spends over a transfer
 * nobody published.
 *
 * Same shape as `TipKind` / `SendPath` / `ItemSettlePath`: a tagged union so this
 * can never become a boolean that silently double-spends a live transaction.
 * Every uncertainty refuses.
 */
import type { SignedInputsFate } from './kernel/signedInputsFate'

export type LocalTxReclaimPath =
  | {
      path: 'reclaimInputs'
      /** Nothing was published, so reusing these inputs races nothing on chain. */
      reason: 'neverReachedChain'
    }
  | {
      path: 'refuse'
      reason:
        /** The transaction is on chain — reclaim would be a real double-spend. */
        | 'onChain'
        /** Explorer/indexer silence. Fail closed rather than guess. */
        | 'statusUnknown'
        /** Inputs already moved: there is nothing left to take back. */
        | 'inputsSpentOnChain'
        /** Nothing was signed; local reservation repair covers this row. */
        | 'nothingSigned'
        /**
         * Arcade already saw this transaction, so it may be mid-submit on a
         * service we cannot query. Waiting is the only safe verdict.
         */
        | 'arcadeContacted'
    }

export function chooseLocalTxReclaimPath(args: {
  /** `null` when no explorer could answer. */
  onChain: boolean | null
  inputsFate: SignedInputsFate
  arcadeContacted: boolean
}): LocalTxReclaimPath {
  if (args.onChain === true) return { path: 'refuse', reason: 'onChain' }
  if (args.onChain === null) return { path: 'refuse', reason: 'statusUnknown' }
  if (args.inputsFate === 'unsigned') {
    return { path: 'refuse', reason: 'nothingSigned' }
  }
  if (args.inputsFate === 'spent') {
    return { path: 'refuse', reason: 'inputsSpentOnChain' }
  }
  if (args.inputsFate === 'unknown') {
    return { path: 'refuse', reason: 'statusUnknown' }
  }
  if (args.arcadeContacted) {
    return { path: 'refuse', reason: 'arcadeContacted' }
  }
  return { path: 'reclaimInputs', reason: 'neverReachedChain' }
}

/** Why the wallet would not take the coins back, in the user's words. */
export function localTxReclaimRefusal(
  reason: Extract<LocalTxReclaimPath, { path: 'refuse' }>['reason'],
): string {
  switch (reason) {
    case 'onChain':
      return 'This transaction is on chain, so the coins are already spent — there is nothing to take back.'
    case 'statusUnknown':
      return 'The chain could not be checked just now. Taking the coins back stays disabled until it can be.'
    case 'inputsSpentOnChain':
      return 'The coins this transfer used have already moved on chain.'
    case 'nothingSigned':
      return 'This attempt never signed a transaction, so there are no sealed coins to take back.'
    case 'arcadeContacted':
      return 'This transaction was already handed to Arcade, which may still be submitting it. Taking the coins back stays disabled while that is possible.'
  }
}
