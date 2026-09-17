/**
 * Durable storage registry.
 *
 * Every persisted record has an owner, scope, and schema version here. New
 * versions append a migration; an existing migration is historical fact and
 * must never be rewritten.
 */
export type StorageScope = 'global' | 'account'

export type StorageDescriptor = Readonly<{
  key: string
  owner: 'activity' | 'messages' | 'permissions' | 'collectables'
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
    scope: 'account',
    version: 1,
  }),
  messages: defineStorage({
    key: 'handcash.messages.v1',
    owner: 'messages',
    scope: 'account',
    version: 1,
  }),
  connectedApps: defineStorage({
    key: 'handcash.brc100.connectedApps',
    owner: 'permissions',
    scope: 'account',
    version: 1,
  }),
  collectableProven: defineStorage({
    key: 'handcash.collectables.proven.v2',
    owner: 'collectables',
    scope: 'global',
    version: 2,
  }),
  collectableProvenLegacy: defineStorage({
    key: 'handcash.collectables.proven.v1',
    owner: 'collectables',
    scope: 'global',
    version: 1,
  }),
  collectableOrigins: defineStorage({
    key: 'handcash.collectables.originCommitments.v1',
    owner: 'collectables',
    scope: 'global',
    version: 1,
  }),
  collectableGenesisAttempts: defineStorage({
    key: 'handcash.collectables.genesisAttempt.v1',
    owner: 'collectables',
    scope: 'global',
    version: 1,
  }),
  collectableGenesisFailures: defineStorage({
    key: 'handcash.collectables.genesisFailure.v1',
    owner: 'collectables',
    scope: 'global',
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
