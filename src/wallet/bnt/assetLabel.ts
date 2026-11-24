import { formatTokenAmount } from '../amounts'

type Named = { sym?: string; dec: number; backing?: { chain: string; issuers: string[] } }

const named = new Map<string, Named>()

/** Recorded wherever a deploy is read, so a prompt can name what it moves and who redeems it. */
export function rememberBntAsset(
  assetId: string,
  fields: { sym?: string; dec?: number; bk?: { chain: string } | null; iss?: readonly string[] },
): void {
  named.set(assetId.toLowerCase(), {
    sym: fields.sym,
    dec: fields.dec ?? 0,
    ...(fields.bk ? { backing: { chain: fields.bk.chain, issuers: [...(fields.iss ?? [])] } } : {}),
  })
}

/** The chain a backed asset stands for and the issuers whose reserve redeems it (BRC-212 §10); null when unbacked or unread. */
export function bntBackingOf(assetId: unknown): { chain: string; issuers: readonly string[] } | null {
  return (typeof assetId === 'string' ? named.get(assetId.toLowerCase())?.backing : undefined) ?? null
}

/**
 * `100000` units of an 8-decimal wLTC reads "0.001 wLTC". An asset this
 * wallet has not read keeps the raw count, marked as units: a prompt never
 * shows a bare number that could pass for a whole-coin amount.
 */
export function bntAmountLabel(assetId: unknown, amount: unknown): string {
  const raw = String(amount ?? '').trim()
  const known = typeof assetId === 'string' ? named.get(assetId.toLowerCase()) : undefined
  if (!/^\d+$/.test(raw)) return raw || '?'
  if (!known) return `${raw} units`
  return `${formatTokenAmount(raw, known.dec)} ${known.sym ?? 'units'}`
}
