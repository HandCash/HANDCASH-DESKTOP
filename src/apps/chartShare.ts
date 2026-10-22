import { chartHash, canonicalJson } from './chartSignature'
import { CHART_MAX_BYTES, verifyChart, type ChartVerification } from './chartValidator'
import { COIN_NAMES, type ChartApp, type ChartCoinId, type ChartNetwork, type ChartWalletSupport } from './chartTypes'

/**
 * Sharing a chart app wallet to wallet (BRC-260 §10): the signed chart travels
 * in a small packet with its hash and readable name, and the receiver checks
 * all three before it shows the app.
 */

export const CHART_SHARE_FORMAT = 'chart-app-share/1'
export const CHART_SHARE_MAX_BYTES = CHART_MAX_BYTES + 1024
export const CHART_SHARE_DESCRIPTION = 'Send a small signed app straight to another wallet. It opens by name and runs only what it lists.'

export type ChartShare = {
  format: typeof CHART_SHARE_FORMAT
  name: string
  hash: string
  chart: ChartApp
}

/** Which author key holds a readable name in this wallet, and the chart it last opened under it. */
export type ChartNameEntry = { authorKey: string; id: string; hash: string }
export type ChartNameBook = Readonly<Record<string, ChartNameEntry>>

export type OpenedChartShare =
  | { ok: true; chart: ChartApp; hash: string; name: string; coinUse: string }
  | { ok: false; reason: 'malformed' | 'name' | 'taken' | Extract<ChartVerification, { ok: false }>['reason']; errors: string[] }

const READABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const HASH = /^[0-9a-f]{64}$/

/** Lowercase letters, digits and single dashes, at most 32 characters. */
export function nameSlug(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '')
  return slug || 'author'
}

/** `author/app-id`, e.g. `handcash/tip-jar`. The name book, not the name, ties it to a key. */
export function chartReadableName(chart: Pick<ChartApp, 'id' | 'author'>): string {
  return `${nameSlug(chart.author.name)}/${chart.id}`
}

/** A typed name in its stored form, or null when it is not one. */
export function parseReadableName(text: string): string | null {
  const name = text.trim().toLowerCase()
  return READABLE_NAME.test(name) ? name : null
}

/** Every coin the chart's payment, request and item effects name, with the networks it runs on. */
export function chartCoinUses(chart: ChartApp): Array<{ coin: ChartCoinId; networks: ChartNetwork[] }> {
  const uses = new Map<ChartCoinId, Set<ChartNetwork>>()
  for (const effect of Object.values(chart.effects)) {
    if (effect.kind !== 'sendPayment' && effect.kind !== 'requestPayment' && effect.kind !== 'sendItem') continue
    const networks = uses.get(effect.coin) ?? new Set<ChartNetwork>()
    for (const n of effect.networks) networks.add(n)
    uses.set(effect.coin, networks)
  }
  return [...uses].map(([coin, networks]) => ({
    coin,
    networks: (['mainnet', 'testnet'] as const).filter((n) => networks.has(n)),
  }))
}

export function describeCoinUse(chart: ChartApp): string {
  const uses = chartCoinUses(chart)
  if (uses.length === 0) return 'Moves no coins or items'
  return `Uses ${uses.map((u) => `${COIN_NAMES[u.coin]} on ${u.networks.join(' or ')}`).join(' and ')}`
}

export function buildChartShare(chart: ChartApp): ChartShare {
  return { format: CHART_SHARE_FORMAT, name: chartReadableName(chart), hash: chartHash(chart), chart }
}

export function encodeChartShare(share: ChartShare): string {
  return canonicalJson(share)
}

/** True when another author key already holds this author name in the book. */
function authorHeldByOther(book: ChartNameBook, name: string, authorKey: string): boolean {
  const author = name.slice(0, name.indexOf('/') + 1)
  return Object.entries(book).some(([held, entry]) => held.startsWith(author) && entry.authorKey !== authorKey)
}

function malformed(error: string): OpenedChartShare {
  return { ok: false, reason: 'malformed', errors: [error] }
}

/**
 * Everything a receiving wallet checks before it shows a shared app: the
 * packet's shape, the chart (BRC-260 §8) under the hash it was sent with, that
 * the name is the one the chart gives itself, and that no other key holds its author name.
 */
export function openChartShare(raw: unknown, support: ChartWalletSupport, book: ChartNameBook): OpenedChartShare {
  let packet: unknown = raw
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).length > CHART_SHARE_MAX_BYTES) return malformed(`Share is over ${CHART_SHARE_MAX_BYTES} bytes`)
    try {
      packet = JSON.parse(raw)
    } catch {
      return malformed('Share is not JSON')
    }
  }
  if (typeof packet !== 'object' || packet === null || Array.isArray(packet)) return malformed('Share is not an object')
  const p = packet as Record<string, unknown>
  const keys = Object.keys(p).sort().join(',')
  if (keys !== 'chart,format,hash,name') return malformed('Share must hold exactly format, name, hash and chart')
  if (p.format !== CHART_SHARE_FORMAT) return malformed(`Share format must be ${CHART_SHARE_FORMAT}`)
  if (typeof p.hash !== 'string' || !HASH.test(p.hash)) return malformed('Share hash must be 64 lowercase hex characters')
  if (typeof p.name !== 'string') return malformed('Share name must be text')

  const v = verifyChart(p.chart, support, { expectedHash: p.hash })
  if (!v.ok) return v
  const name = chartReadableName(v.chart)
  if (p.name !== name) return { ok: false, reason: 'name', errors: [`The app calls itself ${name}, not ${p.name}`] }
  if (authorHeldByOther(book, name, v.chart.author.identityKey)) {
    return { ok: false, reason: 'taken', errors: [`The author name in ${name} already belongs to another key in this wallet`] }
  }
  return { ok: true, chart: v.chart, hash: v.hash, name, coinUse: describeCoinUse(v.chart) }
}

/** Record that this wallet opened a chart under its name. Refuses an author name another key holds. */
export function bindChartName(
  book: ChartNameBook,
  chart: ChartApp,
): { ok: true; book: ChartNameBook; name: string } | { ok: false; name: string } {
  const name = chartReadableName(chart)
  if (authorHeldByOther(book, name, chart.author.identityKey)) return { ok: false, name }
  return { ok: true, name, book: { ...book, [name]: { authorKey: chart.author.identityKey, id: chart.id, hash: chartHash(chart) } } }
}

export function resolveChartName(book: ChartNameBook, text: string): ChartNameEntry | null {
  const name = parseReadableName(text)
  return name ? (book[name] ?? null) : null
}

/** A name book holding the shipped apps' names, so no shared app can take them. */
export function nameBookFromCharts(charts: readonly ChartApp[]): ChartNameBook {
  let book: ChartNameBook = {}
  for (const chart of charts) {
    const bound = bindChartName(book, chart)
    if (bound.ok) book = bound.book
  }
  return book
}
