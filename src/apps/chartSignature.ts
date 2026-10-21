import { Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { CHART_APP_FORMAT, type ChartApp, type UnsignedChartApp } from './chartTypes'

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace,
 * integers only (a subset of RFC 8785 that every language prints the same).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Charts hold integers only')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  throw new Error(`Charts cannot hold ${typeof value}`)
}

export function unsignedChart(chart: ChartApp | UnsignedChartApp): UnsignedChartApp {
  const { signature: _signature, ...rest } = chart as ChartApp
  return rest
}

/** SHA-256 of the canonical JSON of the chart without its signature, hex. */
export function chartHash(chart: ChartApp | UnsignedChartApp): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(canonicalJson(unsignedChart(chart)), 'utf8')))
}

/** The text the author signs: the format tag, a newline, then the chart hash. */
export function chartSigningPreimage(hash: string): string {
  return `${CHART_APP_FORMAT}\n${hash}`
}

export function signChart(chart: UnsignedChartApp, authorKeyHex: string): ChartApp {
  const key = PrivateKey.fromHex(authorKeyHex.trim())
  if (key.toPublicKey().toString().toLowerCase() !== chart.author.identityKey.toLowerCase()) {
    throw new Error('The signing key is not the chart author key')
  }
  const preimage = Utils.toArray(chartSigningPreimage(chartHash(chart)), 'utf8')
  const signature = Utils.toHex(key.sign(preimage).toDER() as number[])
  return { ...unsignedChart(chart), signature }
}

export function verifyChartSignature(chart: ChartApp): boolean {
  try {
    if (!/^[0-9a-f]+$/i.test(chart.signature)) return false
    const sig = Signature.fromDER(chart.signature, 'hex')
    const preimage = Utils.toArray(chartSigningPreimage(chartHash(chart)), 'utf8')
    return PublicKey.fromString(chart.author.identityKey).verify(preimage, sig)
  } catch {
    return false
  }
}
