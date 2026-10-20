export type AmountPadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back'

/** The amount after one press on the wallet's number pad: one decimal point, no leading zeros. */
export function applyAmountPadKey(value: string, key: AmountPadKey): string {
  if (key === 'back') return value.slice(0, -1)
  if (key === '.') {
    if (value.includes('.')) return value
    return value === '' ? '0.' : `${value}.`
  }
  if (value === '0') return key
  return value + key
}
