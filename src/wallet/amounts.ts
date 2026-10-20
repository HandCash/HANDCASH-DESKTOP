/** Token amounts: integer base units shown with `dec` decimals. */

/** Format token amount with deploy decimals (amt is integer units). */
export function formatTokenAmount(amt: string, dec: number): string {
  const safeDec = Number.isInteger(dec) && dec >= 0 && dec <= 18 ? dec : 0
  const digits = amt.replace(/\D/g, '') || '0'
  if (safeDec === 0) {
    return BigInt(digits).toLocaleString('en-US')
  }
  const padded = digits.padStart(safeDec + 1, '0')
  const whole = padded.slice(0, -safeDec) || '0'
  const frac = padded.slice(-safeDec).replace(/0+$/, '')
  const wholeFmt = BigInt(whole).toLocaleString('en-US')
  return frac ? `${wholeFmt}.${frac}` : wholeFmt
}

/** Typed amount → integer units with deploy decimals; null when not a positive amount that fits `dec`. */
export function parseTokenAmount(display: string, dec: number): string | null {
  const safeDec = Number.isInteger(dec) && dec >= 0 && dec <= 18 ? dec : 0
  const m = /^(\d*)(?:\.(\d*))?$/.exec(display.trim().replace(/,/g, ''))
  if (!m || (!m[1] && !m[2])) return null
  const frac = (m[2] ?? '').replace(/0+$/, '')
  if (frac.length > safeDec) return null
  const units = BigInt((m[1] || '0') + frac.padEnd(safeDec, '0'))
  return units > 0n ? units.toString() : null
}
