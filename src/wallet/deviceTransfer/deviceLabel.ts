/** The name other devices see for this one in sign-in and device lists. */
export function localDeviceLabel(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/android/i.test(userAgent)) return 'Android phone'
  if (/iphone|ipad/i.test(userAgent)) return 'iPhone'
  if (/mac/i.test(userAgent)) return 'Mac'
  if (/win/i.test(userAgent)) return 'Windows PC'
  if (/linux/i.test(userAgent)) return 'Linux PC'
  return 'HandCash device'
}
