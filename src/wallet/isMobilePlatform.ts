/** True when the Capacitor mobile shell hosts the shared wallet UI. */
export function isMobileWalletPlatform(): boolean {
  if (typeof window === 'undefined') return false
  const platform = window.handcash?.platform
  return platform === 'android' || platform === 'ios'
}
