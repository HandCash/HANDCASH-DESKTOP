/**
 * Durable storage registry.
 *
 * Every persisted record has an owner, scope, and schema version here. New
 * versions append a migration; an existing migration is historical fact and
 * must never be rewritten.
 */
export type StorageScope = 'device' | 'chain' | 'wallet'

export type StorageDescriptor = Readonly<{
  key: string
  owner: string
  scope: StorageScope
  version: number
}>

function defineStorage<const T extends StorageDescriptor>(descriptor: T): T {
  return Object.freeze(descriptor)
}

export const storageRegistry = Object.freeze({
  activity: defineStorage({
    key: 'handcash.brc100.appActivity',
    owner: 'activity',
    scope: 'wallet',
    version: 1,
  }),
  messages: defineStorage({
    key: 'handcash.messages.v1',
    owner: 'messages',
    scope: 'wallet',
    version: 1,
  }),
  connectedApps: defineStorage({
    key: 'handcash.brc100.connectedApps',
    owner: 'permissions',
    scope: 'wallet',
    version: 1,
  }),
  collectableProven: defineStorage({
    key: 'handcash.collectables.proven.v2',
    owner: 'collectables',
    scope: 'chain',
    version: 2,
  }),
  collectableProvenLegacy: defineStorage({
    key: 'handcash.collectables.proven.v1',
    owner: 'collectables',
    scope: 'chain',
    version: 1,
  }),
  collectableOrigins: defineStorage({
    key: 'handcash.collectables.originCommitments.v1',
    owner: 'collectables',
    scope: 'chain',
    version: 1,
  }),
  collectableGenesisAttempts: defineStorage({
    key: 'handcash.collectables.genesisAttempt.v1',
    owner: 'collectables',
    scope: 'chain',
    version: 1,
  }),
  collectableGenesisFailures: defineStorage({
    key: 'handcash.collectables.genesisFailure.v1',
    owner: 'collectables',
    scope: 'chain',
    version: 1,
  }),
  txLifecycle: defineStorage({
    key: 'handcash.wallet.txLifecycle.v1',
    owner: 'transactions',
    scope: 'wallet',
    version: 1,
  }),
  utxoLocks: defineStorage({
    key: 'handcash.wallet.utxoLocks.v1',
    owner: 'transactions',
    scope: 'wallet',
    version: 1,
  }),
  pendingMinerOutbox: defineStorage({
    key: 'handcash.wallet.pendingMinerOutbox.v1',
    owner: 'propagation',
    scope: 'wallet',
    version: 1,
  }),
  signedChequeArchive: defineStorage({
    key: 'handcash.wallet.signedChequeArchive.v1',
    owner: 'transactions',
    scope: 'wallet',
    version: 1,
  }),
  pendingBrc29Outbox: defineStorage({
    key: 'handcash.brc29.pendingOutbox.v1',
    owner: 'propagation',
    scope: 'wallet',
    version: 1,
  }),
  pendingItemOutbox: defineStorage({
    key: 'handcash.item.pendingOutbox.v1',
    owner: 'propagation',
    scope: 'wallet',
    version: 1,
  }),
  importedLegacyOutpoints: defineStorage({
    key: 'handcash.brc100.importedLegacyOutpoints.v2',
    owner: 'chain-ingest',
    scope: 'wallet',
    version: 2,
  }),
  importedLegacyOutpointsLegacy: defineStorage({
    key: 'handcash.brc100.importedLegacyOutpoints.v1',
    owner: 'chain-ingest',
    scope: 'wallet',
    version: 1,
  }),
  derivedChangeEcho: defineStorage({
    key: 'handcash.brc100.derivedChangeEcho.v1',
    owner: 'local-state',
    scope: 'wallet',
    version: 1,
  }),
  transactionTelemetry: defineStorage({
    key: 'handcash.wallet.transactionTelemetry.v1',
    owner: 'telemetry',
    scope: 'wallet',
    version: 1,
  }),
  transactionTelemetryDurations: defineStorage({
    key: 'handcash.wallet.transactionTelemetryDurations.v1',
    owner: 'telemetry',
    scope: 'wallet',
    version: 1,
  }),
  blockHeaders: defineStorage({
    key: 'handcash.blockHeaders.v1',
    owner: 'chain',
    scope: 'chain',
    version: 1,
  }),
  appearance: defineStorage({
    key: 'handcash.appearance',
    owner: 'shell',
    scope: 'device',
    version: 1,
  }),
  friends: defineStorage({
    key: 'handcash.brc100.friends',
    owner: 'friends',
    scope: 'wallet',
    version: 1,
  }),
  activitySeen: defineStorage({
    key: 'handcash.activitySeen.v2',
    owner: 'activity',
    scope: 'wallet',
    version: 2,
  }),
  collectablesList: defineStorage({
    key: 'handcash.collectables.list.v1',
    owner: 'collectables',
    scope: 'wallet',
    version: 1,
  }),
  collectablesSeeded: defineStorage({
    key: 'handcash.collectables.seeded.v1',
    owner: 'collectables',
    scope: 'wallet',
    version: 1,
  }),
  sentOutpoints: defineStorage({
    key: 'handcash.collectables.sentOutpoints.v1',
    owner: 'collectables',
    scope: 'wallet',
    version: 1,
  }),
  consumedOutpoints: defineStorage({
    key: 'handcash.collectables.consumedOutpoints.v1',
    owner: 'collectables',
    scope: 'wallet',
    version: 1,
  }),
  abandonedOutpoints: defineStorage({
    key: 'handcash.collectables.abandonedOutpoints.v1',
    owner: 'collectables',
    scope: 'wallet',
    version: 1,
  }),
  tokensList: defineStorage({
    key: 'handcash.tokens.list.v1',
    owner: 'tokens',
    scope: 'wallet',
    version: 1,
  }),
  importedOneSatOutpoints: defineStorage({
    key: 'handcash.brc100.importedOneSatOutpoints.v1',
    owner: 'chain-ingest',
    scope: 'wallet',
    version: 1,
  }),
  failedOneSatOutpoints: defineStorage({
    key: 'handcash.brc100.failedOneSatOutpoints.v1',
    owner: 'chain-ingest',
    scope: 'wallet',
    version: 1,
  }),
  pendingSend: defineStorage({
    key: 'handcash.brc100.pendingSend',
    owner: 'transactions',
    scope: 'wallet',
    version: 1,
  }),
  remittance: defineStorage({
    key: 'handcash.brc150.remittance.v1',
    owner: 'collectables',
    scope: 'wallet',
    version: 1,
  }),
  autoPay: defineStorage({
    key: 'handcash.brc100.autoPay',
    owner: 'permissions',
    scope: 'wallet',
    version: 1,
  }),
  spendingAuthorization: defineStorage({
    key: 'handcash.brc100.spendingAuthorization',
    owner: 'permissions',
    scope: 'wallet',
    version: 1,
  }),
  historyBackup: defineStorage({
    key: 'handcash.brc100.historyBackup.v1',
    owner: 'history-replica',
    scope: 'wallet',
    version: 1,
  }),
  walletConfig: defineStorage({
    key: 'handcash.brc100.walletConfig.v1',
    owner: 'setup',
    scope: 'wallet',
    version: 1,
  }),
  backupConfirmed: defineStorage({
    key: 'handcash.brc100.backupConfirmed',
    owner: 'backup',
    scope: 'wallet',
    version: 1,
  }),
  historyBackupConfirmed: defineStorage({
    key: 'handcash.brc100.historyBackupConfirmed',
    owner: 'backup',
    scope: 'wallet',
    version: 1,
  }),
  backupDeferred: defineStorage({
    key: 'handcash.brc100.backupDeferred',
    owner: 'backup',
    scope: 'wallet',
    version: 1,
  }),
  migrationTxids: defineStorage({
    key: 'handcash.brc100.migrationTxids',
    owner: 'migration',
    scope: 'wallet',
    version: 1,
  }),
  phraseSweepCursor: defineStorage({
    key: 'handcash.brc100.phraseSweepItemCursor.v1',
    owner: 'chain-ingest',
    scope: 'wallet',
    version: 1,
  }),
  listingAuthorizations: defineStorage({
    key: 'handcash.market.listingAuthorizations.v2',
    owner: 'market',
    scope: 'wallet',
    version: 2,
  }),
  marketPending: defineStorage({
    key: 'handcash.market.pending.v2',
    owner: 'market',
    scope: 'wallet',
    version: 2,
  }),
  marketResponses: defineStorage({
    key: 'handcash.market.responses.v2',
    owner: 'market',
    scope: 'wallet',
    version: 2,
  }),
  itemReceiveAnnounced: defineStorage({
    key: 'handcash.items.receiveAnnounced.v1',
    owner: 'collectables',
    scope: 'wallet',
    version: 1,
  }),
  claimedHandle: defineStorage({
    key: 'handcash.brc169.claimedHandle.v1',
    owner: 'identity',
    scope: 'wallet',
    version: 1,
  }),
  utxoHealCheckpoint: defineStorage({
    key: 'handcash.utxoHeal.checkpoint.v1',
    owner: 'local-state',
    scope: 'wallet',
    version: 1,
  }),
  backupWatchdog: defineStorage({
    key: 'handcash.cloudBackup.watchdog.v1',
    owner: 'history-replica',
    scope: 'wallet',
    version: 1,
  }),
  vaultSealStatus: defineStorage({
    key: 'handcash.brc100.vaultSealStatus',
    owner: 'custody',
    scope: 'wallet',
    version: 1,
  }),
  tokenIcons: defineStorage({
    key: 'handcash.bsv21.tokenIcons',
    owner: 'tokens',
    scope: 'chain',
    version: 1,
  }),
  tokenDeployCaps: defineStorage({
    key: 'handcash.bsv21.deploy-cap.v1',
    owner: 'tokens',
    scope: 'chain',
    version: 1,
  }),
  itemArt: defineStorage({
    key: 'handcash.itemArt.v1',
    owner: 'collectables',
    scope: 'chain',
    version: 1,
  }),
  inscriptionResolution: defineStorage({
    key: 'handcash.inscriptionResolution.v1',
    owner: 'collectables',
    scope: 'chain',
    version: 1,
  }),
  inscriptionMiss: defineStorage({
    key: 'handcash.inscriptionMiss.v1',
    owner: 'collectables',
    scope: 'chain',
    version: 1,
  }),
  rawTxMiss: defineStorage({
    key: 'handcash.rawTx.miss.v1',
    owner: 'chain',
    scope: 'chain',
    version: 1,
  }),
  createdBeefIndex: defineStorage({
    key: 'handcash.createdBeef.index',
    owner: 'chain',
    scope: 'chain',
    version: 1,
  }),
  appLogCurrent: defineStorage({
    key: 'handcash.applog.current.v1',
    owner: 'diagnostics',
    scope: 'device',
    version: 1,
  }),
  appLogPrevious: defineStorage({
    key: 'handcash.applog.previous.v1',
    owner: 'diagnostics',
    scope: 'device',
    version: 1,
  }),
  sfx: defineStorage({
    key: 'handcash.sfx.enabled',
    owner: 'shell',
    scope: 'device',
    version: 1,
  }),
  logsUploadUrl: defineStorage({
    key: 'handcash.logs.uploadUrl',
    owner: 'diagnostics',
    scope: 'device',
    version: 1,
  }),
  updateMode: defineStorage({
    key: 'handcash.update.mode',
    owner: 'shell',
    scope: 'device',
    version: 1,
  }),
  vault: defineStorage({
    key: 'handcash.brc100.vault.v1',
    owner: 'custody',
    scope: 'device',
    version: 1,
  }),
  vaultBackup: defineStorage({
    key: 'handcash.brc100.vault.backup.v1',
    owner: 'custody',
    scope: 'device',
    version: 1,
  }),
  vaultAudit: defineStorage({
    key: 'handcash.brc100.vault.audit.v1',
    owner: 'custody',
    scope: 'device',
    version: 1,
  }),
  legacyChat: defineStorage({
    key: 'handcash.brc100.chat.v1',
    owner: 'messages',
    scope: 'wallet',
    version: 1,
  }),
  legacyAllowedOrigins: defineStorage({
    key: 'handcash.brc100.allowedOrigins',
    owner: 'permissions',
    scope: 'wallet',
    version: 1,
  }),
  bsvUsd: defineStorage({
    key: 'handcash.brc100.bsvUsd',
    owner: 'market-data',
    scope: 'device',
    version: 1,
  }),
  bsvMarket: defineStorage({
    key: 'handcash.brc100.bsvMarket',
    owner: 'market-data',
    scope: 'device',
    version: 1,
  }),
  deviceLockMode: defineStorage({
    key: 'handcash.brc100.deviceLock.mode',
    owner: 'custody',
    scope: 'device',
    version: 1,
  }),
  vaultOpenSecret: defineStorage({
    key: 'handcash.brc100.vault.openSecret.v1',
    owner: 'custody',
    scope: 'device',
    version: 1,
  }),
  deviceId: defineStorage({
    key: 'handcash.brc100.deviceId.v1',
    owner: 'device-mesh',
    scope: 'device',
    version: 1,
  }),
  deviceWallets: defineStorage({
    key: 'handcash.brc100.deviceWallets.v1',
    owner: 'device-mesh',
    scope: 'device',
    version: 1,
  }),
  selectedDeviceWallet: defineStorage({
    key: 'handcash.brc100.selectedDeviceWallet.v1',
    owner: 'device-mesh',
    scope: 'device',
    version: 1,
  }),
  deviceKeyBackups: defineStorage({
    key: 'handcash.brc100.deviceKeyBackups.v1',
    owner: 'device-mesh',
    scope: 'device',
    version: 1,
  }),
  deviceKeySparesGiven: defineStorage({
    key: 'handcash.brc100.deviceKeySparesGiven.v1',
    owner: 'device-mesh',
    scope: 'device',
    version: 1,
  }),
  deviceKeySparesReceived: defineStorage({
    key: 'handcash.brc100.deviceKeySparesReceived.v1',
    owner: 'device-mesh',
    scope: 'device',
    version: 1,
  }),
  arcadeCallbackToken: defineStorage({
    key: 'handcash.arcade.callbackToken.v1',
    owner: 'arcade',
    scope: 'device',
    version: 1,
  }),
  arcadeLastEventId: defineStorage({
    key: 'handcash.arcade.sse.lastEventId.v1',
    owner: 'arcade',
    scope: 'device',
    version: 1,
  }),
  arcadeSubmit: defineStorage({
    key: 'handcash.wallet.arcadeSubmit.v1',
    owner: 'chain',
    scope: 'chain',
    version: 1,
  }),
  arcadeRejected: defineStorage({
    key: 'handcash.wallet.arcadeRejected.v1',
    owner: 'chain',
    scope: 'chain',
    version: 1,
  }),
  ghostTx: defineStorage({
    key: 'handcash.wallet.ghostTx.v1',
    owner: 'chain',
    scope: 'chain',
    version: 1,
  }),
  inboundHintFirstSeen: defineStorage({
    key: 'handcash.wallet.inboundHintFirstSeen.v1',
    owner: 'messagebox',
    scope: 'chain',
    version: 1,
  }),
  inboundHintLastFail: defineStorage({
    key: 'handcash.wallet.inboundHintLastFail.v1',
    owner: 'messagebox',
    scope: 'chain',
    version: 1,
  }),
  receiptBeefMiss: defineStorage({
    key: 'handcash.market.receiptBeefMiss.v1',
    owner: 'market',
    scope: 'chain',
    version: 1,
  }),
  balanceLastTrusted: defineStorage({
    key: 'handcash.balance.lastTrusted',
    owner: 'balance',
    scope: 'wallet',
    version: 1,
  }),
  balanceLastTrustedPrefix: defineStorage({
    key: 'handcash.balance.lastTrusted:',
    owner: 'balance',
    scope: 'wallet',
    version: 1,
  }),
  displayCurrency: defineStorage({
    key: 'handcash.brc100.displayCurrency',
    owner: 'shell',
    scope: 'device',
    version: 1,
  }),
  createdBeefPrefix: defineStorage({
    key: 'handcash.createdBeef.',
    owner: 'chain',
    scope: 'chain',
    version: 1,
  }),
  vaultAccountsPrefix: defineStorage({
    key: 'handcash.vault-accounts.v1:',
    owner: 'custody',
    scope: 'device',
    version: 1,
  }),
  collectionViewPrefix: defineStorage({
    key: 'handcash.brc100.collectionView',
    owner: 'shell',
    scope: 'device',
    version: 1,
  }),
  pendingIdbWipe: defineStorage({
    key: 'handcash.brc100.pendingIdbWipe',
    owner: 'custody',
    scope: 'device',
    version: 1,
  }),
  trustholderEnrollmentsLegacy: defineStorage({
    key: 'handcash.brc100.trustholderEnrollments.v1',
    owner: 'setup',
    scope: 'device',
    version: 1,
  }),
  trustholderSharePlanLegacy: defineStorage({
    key: 'handcash.brc100.trustholderSharePlan.v1',
    owner: 'setup',
    scope: 'device',
    version: 1,
  }),
  durableStoreProbe: defineStorage({
    key: 'handcash.durableStore.probe.v1',
    owner: 'shell',
    scope: 'device',
    version: 1,
  }),
})

export type VersionedEnvelope<T> = Readonly<{
  v: number
  data: T
}>

export type StorageMigration = Readonly<{
  from: number
  to: number
  migrate(data: unknown): unknown
}>

/** Apply an append-only migration chain, refusing gaps and downgrades. */
export function migrateEnvelope<T>(
  envelope: VersionedEnvelope<unknown>,
  targetVersion: number,
  migrations: readonly StorageMigration[],
  parse: (data: unknown) => T,
): VersionedEnvelope<T> {
  if (envelope.v > targetVersion) {
    throw new Error(`Storage version ${envelope.v} is newer than ${targetVersion}`)
  }
  let version = envelope.v
  let data = envelope.data
  while (version < targetVersion) {
    const step = migrations.find((candidate) => candidate.from === version)
    if (!step || step.to !== version + 1) {
      throw new Error(`Missing storage migration ${version} → ${version + 1}`)
    }
    data = step.migrate(data)
    version = step.to
  }
  return Object.freeze({ v: version, data: parse(data) })
}
