/**
 * Capabilities exposed to BRC-100 applications through the bridge manifest and
 * health endpoint.
 *
 * BRC-156 / soft-latch was withdrawn. Keep this app-facing contract separate
 * from historical wallet data so legacy names can never become advertised
 * capabilities through an HTTP handler edit.
 */
export const ONE_SAT_APP_CAPABILITIES = Object.freeze({
  brcs: Object.freeze(['147', '150', '164', '165', '230']),
  baskets: Object.freeze(['1sat', 'index']),
  permissions: Object.freeze({
    protocol: 'p 1sat',
    viewScopes: Object.freeze(['all', 'collection', 'app', 'creator', 'id']),
    spendLabel: 'p 1sat input id <key>',
    indexProtocol: 'p index',
    indexScopes: Object.freeze(['install', 'read', 'sync']),
  }),
  indexExpansion: Object.freeze({
    methods: Object.freeze([
      'installIndexExpansion',
      'listIndexExpansions',
      'removeIndexExpansion',
      'syncIndexExpansion',
      'listIndexExpansionEntries',
      'overlayLookup',
    ]),
  }),
  provenanceVerify: Object.freeze(['v2']),
  /**
   * Sigma personas are not the wallet root and not a BRC-169 handle.
   * Apps request a signature by tagging an output `sigma-identity:<id>`.
   * Path: BRC-42 `[0, "sigma identity"]`, counterparty `anyone`, keyID = persona id.
   */
  sigmaIdentity: Object.freeze({
    protocolID: Object.freeze([0, 'sigma identity']),
    counterparty: 'anyone',
    basket: 'sigma-<personaId>',
    mime: 'application/sigma-identity+json',
    algorithm: 'BSM',
    vinBinding: 'explicit non-negative input index',
    tag: 'sigma-identity:<personaId>',
  }),
  walletIdentityProof: Object.freeze({
    brc: '138',
    methods: Object.freeze([
      'waitForAuthentication',
      'getPublicKey',
      'createSignature',
    ]),
    protocolID: Object.freeze([2, 'bsv auth proof']),
    keyID: '<nonce>',
    counterparty: '<verifier-identity-key>',
    identityKey: 'wallet identity key via getPublicKey({ identityKey: true })',
    encoding: 'action\\nidentityKey\\nexpiresAt\\nnonce',
    validityWindowMs: 120000,
    clockSkewMs: 30000,
  }),
})
