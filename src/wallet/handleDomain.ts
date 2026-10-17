/**
 * The BRC-169 handle namespace of this wallet's registry.
 *
 * A domain is a handle authority only when it publishes `metanet.trust` in its
 * own `/manifest.json` (BRC-169 §5.1). BRC-CLOUD publishes that at its host,
 * so its host is the namespace. handcash.io publishes no handle manifest, so
 * no handle is ever certified or displayed under it.
 */
export const HOME_HANDLE_DOMAIN = 'brc-cloud.bcryderman.workers.dev'
