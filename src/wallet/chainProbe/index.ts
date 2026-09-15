/**
 * Outpoint spent / unspent / unknown — shared rule with BRC-CLOUD.
 *
 * Arcade `/tx/{txid}` reports whether the *source* transaction is known
 * (MINED / SEEN_*), not whether output `vout` is spent. Never treat that
 * answer as output-spent.
 */

export {
  classifyBitailsUtxoStatus,
  spentStatusFromArcadeTxLookup,
  type OutpointSpentStatus,
} from './classify'
