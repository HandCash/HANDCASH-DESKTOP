/**
 * Frozen BRC-100 surface.
 *
 * Method names are protocol, not implementation details. Feature code may
 * provide handlers for these names but must not invent a second list.
 */
export const PUBLIC_BRC100_METHODS = [
  'getVersion',
  'getNetwork',
  'getHeight',
  'getHeaderForHeight',
  'health',
] as const

export const SILENT_AUTH_BRC100_METHODS = ['isAuthenticated'] as const

export const CONNECT_BRC100_METHODS = ['waitForAuthentication'] as const

export const ACTION_BRC100_METHODS = [
  'createAction',
  'signAction',
  'internalizeAction',
  'relinquishOutput',
  'relinquishCertificate',
  'createSignature',
  'createAdminIdentityProof',
  'createMarketListingAdvert',
  'createMarketPurchaseIntent',
  'purchaseMarketListing',
  'createCancelMarketListingAdvert',
  'encrypt',
  'decrypt',
  'revealCounterpartyKeyLinkage',
  'revealSpecificKeyLinkage',
  'proveCertificate',
  'acquireCertificate',
] as const

export const MIGRATION_BRC100_METHODS = [
  'getLegacyAddress',
  'refreshLegacyAddress',
  'listMigrationTxids',
] as const

export type PublicBrc100Method = (typeof PUBLIC_BRC100_METHODS)[number]
export type ActionBrc100Method = (typeof ACTION_BRC100_METHODS)[number]
export type MigrationBrc100Method = (typeof MIGRATION_BRC100_METHODS)[number]

const publicMethods: ReadonlySet<string> = new Set(PUBLIC_BRC100_METHODS)
const silentAuthMethods: ReadonlySet<string> = new Set(SILENT_AUTH_BRC100_METHODS)
const connectMethods: ReadonlySet<string> = new Set(CONNECT_BRC100_METHODS)
const actionMethods: ReadonlySet<string> = new Set(ACTION_BRC100_METHODS)
const migrationMethods: ReadonlySet<string> = new Set(MIGRATION_BRC100_METHODS)

export const brc100Contract = Object.freeze({
  isPublicMethod: (method: string): boolean => publicMethods.has(method),
  isSilentAuthMethod: (method: string): boolean => silentAuthMethods.has(method),
  isConnectMethod: (method: string): boolean => connectMethods.has(method),
  // No action shares consent with another: each authorizes one payload and
  // one execution, so even byte-identical payments get their own prompt.
  isActionMethod: (method: string): boolean => actionMethods.has(method),
  isMigrationMethod: (method: string): boolean => migrationMethods.has(method),
})
