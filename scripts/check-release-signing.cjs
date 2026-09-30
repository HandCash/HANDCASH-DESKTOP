module.exports = async context => {
  if (process.env.HANDCASH_ALLOW_UNSIGNED === '1') {
    context.packager.config.forceCodeSigning = false
    if (context.packager.config.mac) { context.packager.config.mac.identity = null; context.packager.config.mac.notarize = false }
    return
  }
  if (context.electronPlatformName !== 'darwin') return
  const password = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
  const apiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
  if (!password && !apiKey) throw new Error('Release requires Apple notarization credentials and a Developer ID signing identity. HANDCASH_ALLOW_UNSIGNED=1 is for local testing only.')
}
