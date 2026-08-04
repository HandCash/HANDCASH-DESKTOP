/**
 * Chain ingest layer — network → local toolbox state.
 *
 * Refresh / background poll belong here. This is **not** BRC-39 history replica
 * and **not** Desktop↔Mobile sync. See `layers.ts`.
 *
 * Pipeline:
 * 1. reviewSpendableOutputs (drop outs spent elsewhere)
 * 2. scan legacy receive P2PKH
 * 3. import funding → managed change; import 1sat → basket `1sat`
 */
export {
  reviewAndReleaseSpentOutputs,
  syncLegacyFunds as refreshFromChain,
  syncLegacyFunds,
  type SyncLegacyFundsOptions as ChainIngestOptions,
  type SyncLegacyFundsOptions,
} from './syncFunds'
