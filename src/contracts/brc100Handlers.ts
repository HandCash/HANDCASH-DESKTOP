/**
 * Frozen ownership manifest for the legacy dispatcher.
 *
 * Existing handlers remain behavior-compatible while they are extracted. New
 * methods must declare one owner here and in the protocol contract; the
 * contract test rejects switch-only additions.
 */
export const BRC100_HANDLER_MANIFEST = Object.freeze({
  createAdminIdentityProof: 'identity',
  getLegacyAddress: 'migration',
  refreshLegacyAddress: 'migration',
  listMigrationTxids: 'migration',
  createMarketListingAdvert: 'market',
  getTokenIcon: 'tokens',
  createMarketPurchaseIntent: 'market',
  verifyMarketListingProvenance: 'market',
  purchaseMarketListing: 'market',
  getMarketSettlementReceipt: 'market',
  createCancelMarketListingAdvert: 'market',
  getMarketListingStatus: 'market',
  markMarketListingPublishFailed: 'market',
  claimCloudHandle: 'identity',
  getClaimedCloudHandle: 'identity',
  clearClaimedCloudHandle: 'identity',
  getVersion: 'wallet',
  getNetwork: 'wallet',
  isAuthenticated: 'wallet',
  waitForAuthentication: 'wallet',
  getPublicKey: 'wallet',
  createAction: 'wallet',
  signAction: 'wallet',
  abortAction: 'wallet',
  listActions: 'wallet',
  internalizeAction: 'wallet',
  listOutputs: 'wallet',
  relinquishOutput: 'wallet',
  getBalance: 'wallet',
  encrypt: 'wallet',
  decrypt: 'wallet',
  createHmac: 'wallet',
  verifyHmac: 'wallet',
  createSignature: 'wallet',
  verifySignature: 'wallet',
  acquireCertificate: 'wallet',
  listCertificates: 'wallet',
  proveCertificate: 'wallet',
  relinquishCertificate: 'wallet',
  discoverByIdentityKey: 'wallet',
  discoverByAttributes: 'wallet',
  revealCounterpartyKeyLinkage: 'wallet',
  revealSpecificKeyLinkage: 'wallet',
  getHeight: 'wallet',
  getHeaderForHeight: 'wallet',
  health: 'wallet',
} as const)

export type Brc100HandlerMethod = keyof typeof BRC100_HANDLER_MANIFEST
export type Brc100HandlerOwner =
  (typeof BRC100_HANDLER_MANIFEST)[Brc100HandlerMethod]

export function brc100HandlerOwner(method: string): Brc100HandlerOwner | null {
  return Object.prototype.hasOwnProperty.call(BRC100_HANDLER_MANIFEST, method)
    ? BRC100_HANDLER_MANIFEST[method as Brc100HandlerMethod]
    : null
}
