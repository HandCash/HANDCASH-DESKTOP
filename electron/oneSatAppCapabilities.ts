/**
 * Capabilities exposed to BRC-100 applications through the bridge manifest and
 * health endpoint.
 *
 * BRC-156 / soft-latch was withdrawn. Keep this app-facing contract separate
 * from historical wallet data so legacy names can never become advertised
 * capabilities through an HTTP handler edit.
 */
export const ONE_SAT_APP_CAPABILITIES = Object.freeze({
  brcs: Object.freeze(['147', '150', '164', '165']),
  baskets: Object.freeze(['1sat']),
  permissions: Object.freeze({
    protocol: 'p 1sat',
    viewScopes: Object.freeze(['all', 'collection', 'app', 'creator', 'id']),
    spendLabel: 'p 1sat input id <key>',
  }),
  provenanceVerify: Object.freeze(['v2']),
  walletIdentityProof: Object.freeze({
    version: 1,
    methods: Object.freeze([
      'waitForAuthentication',
      'getPublicKey',
      'createSignature',
    ]),
    protocolID: Object.freeze([2, 'wallet identity proof']),
    keyID: 'identity-proof:<normalized-origin>',
    counterparty: 'anyone',
    challenge: Object.freeze({
      domain: 'handcash-wallet-identity-proof',
      encoding: 'canonical-json-utf8',
      maxTtlMs: 300000,
      minNonceBits: 128,
    }),
  }),
})
