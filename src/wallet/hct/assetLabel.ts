import { formatFungibleAmount } from '../token/types'

const named = new Map<string, { sym?: string; dec: number }>()

/** Recorded wherever a deploy is read, so a prompt can name what it moves. */
export function rememberHctAsset(assetId: string, fields: { sym?: string; dec?: number }): void {
  named.set(assetId.toLowerCase(), { sym: fields.sym, dec: fields.dec ?? 0 })
}

/**
 * `100000` units of an 8-decimal wLTC reads "0.001 wLTC". An asset this
 * wallet has not read keeps the raw count, marked as units: a prompt never
 * shows a bare number that could pass for a whole-coin amount.
 */
export function hctAmountLabel(assetId: unknown, amount: unknown): string {
  const raw = String(amount ?? '').trim()
  const known = typeof assetId === 'string' ? named.get(assetId.toLowerCase()) : undefined
  if (!/^\d+$/.test(raw)) return raw || '?'
  if (!known) return `${raw} units`
  return `${formatFungibleAmount(raw, known.dec)} ${known.sym ?? 'units'}`
}
