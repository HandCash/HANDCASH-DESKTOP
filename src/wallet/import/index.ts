/**
 * Import section — legacy wallets stored and viewed beside this one.
 *
 * Imported sources are never the BRC-100 identity and never accounts in the
 * switcher. They are sealed key sets the user can scan and view; the only
 * thing that moves value is an explicit, compatible-only sweep.
 */
export {
  IMPORT_SOURCE_HINTS,
  IMPORT_SOURCE_KINDS,
  IMPORT_SOURCE_LABELS,
  keyDeriverFor,
  parseImportSecret,
  type ImportSecret,
  type ImportSourceKind,
  type ParsedSecret,
} from './importSource'
export {
  describeImportHold,
  formatTokenAmount,
  totalHoldings,
  type AddressHoldings,
  type HeldTally,
  type HoldingsTotals,
  type ImportHoldReason,
  type TokenHolding,
} from './holdings'
export { locateAddress, type DiscoveredAddress } from './discovery'
export {
  normalizeHandCashHandle,
  probeHandCashHandle,
  type HandleProbe,
} from './handcashHandle'
export {
  addImportedSource,
  loadImportedSources,
  removeImportedSource,
  subscribeImportedSources,
  updateImportedSource,
  type ImportedSource,
  type SourceScan,
  type SweepSummary,
} from './store'
export { scanImportedSource, type ScanProgress } from './scan'
export {
  IMPORT_ITEMS_PER_TX,
  planSweep,
  sweepImportedSource,
  type SweepPlan,
  type SweepProgress,
} from './sweep'
export { HANDCASH_GAP } from './pathCatalog'
export { requestImportKind, subscribeImportIntent, takeImportIntent } from './importIntent'
export {
  parseRecoveryHints,
  rememberRecoveryHints,
  type HandCashRecoveryHints,
} from './recoveryHints'
