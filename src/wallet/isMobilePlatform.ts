/** True when the Capacitor mobile shell hosts the shared wallet UI. */
export function isMobileWalletPlatform(): boolean {
  const platform = window.handcash?.platform
  return platform === 'android' || platform === 'ios'
}
