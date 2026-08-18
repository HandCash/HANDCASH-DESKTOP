/** App semver — mirrors package.json (electron-builder / updater source of truth). */
const PACKAGED_VERSION = '1.2.245'

/**
 * The Mobile shell bundles these sources with its own package.json version, so a
 * build-time define wins over the Desktop constant.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : PACKAGED_VERSION
