import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { BUILTIN_CHARTS, BUILTIN_CHART_HASHES } from './builtin'
import { signChart } from './chartSignature'
import { verifyChart } from './chartValidator'
import {
  bindChartName,
  buildChartShare,
  chartReadableName,
  describeCoinUse,
  encodeChartShare,
  nameBookFromCharts,
  nameSlug,
  openChartShare,
  parseReadableName,
  resolveChartName,
} from './chartShare'
import type { ChartApp, ChartWalletSupport, UnsignedChartApp } from './chartTypes'

const SUPPORT: ChartWalletSupport = { coins: [{ coin: 'BSV', network: 'mainnet' }], boxes: ['inbox'] }

const key = (n: number) => PrivateKey.fromHex(n.toString(16).padStart(64, '0'))

function builtin(id: string): ChartApp {
  const raw = BUILTIN_CHARTS.find((c) => (c as { id: string }).id === id)
  const v = verifyChart(raw, SUPPORT, { expectedHash: BUILTIN_CHART_HASHES[id] })
  if (!v.ok) throw new Error(`${id}: ${v.errors.join('; ')}`)
  return v.chart
}

function signedBy(n: number, chart: UnsignedChartApp, authorName = chart.author.name): ChartApp {
  const author = key(n)
  return signChart({ ...chart, author: { name: authorName, identityKey: author.toPublicKey().toString() } }, author.toHex())
}

const ALL = BUILTIN_CHARTS.map((c) => builtin((c as { id: string }).id))

describe('readable names', () => {
  it('slugs the author name and joins the app id', () => {
    expect(nameSlug('Café Ünïcode  Apps!')).toBe('cafe-unicode-apps')
    expect(nameSlug('***')).toBe('author')
    const tip = builtin('tip-jar')
    expect(chartReadableName(tip)).toBe(`${nameSlug(tip.author.name)}/tip-jar`)
  })

  it('parses typed names and refuses anything else', () => {
    expect(parseReadableName('  Alice/Tip-Jar ')).toBe('alice/tip-jar')
    expect(parseReadableName('alice')).toBeNull()
    expect(parseReadableName('https://alice.com/tip-jar')).toBeNull()
    expect(parseReadableName('alice/tip jar')).toBeNull()
  })

  it('resolves a bound name to its author key and chart hash', () => {
    const book = nameBookFromCharts(ALL)
    const tip = builtin('tip-jar')
    expect(resolveChartName(book, chartReadableName(tip).toUpperCase())).toEqual({
      authorKey: tip.author.identityKey,
      id: 'tip-jar',
      hash: BUILTIN_CHART_HASHES['tip-jar'],
    })
    expect(resolveChartName(book, 'nobody/tip-jar')).toBeNull()
  })

  it('keeps an author name with the first key that holds it', () => {
    const book = nameBookFromCharts(ALL)
    const tip = builtin('tip-jar')
    const squat = signedBy(50, { ...tip, id: 'other-app' })
    expect(bindChartName(book, squat)).toEqual({ ok: false, name: chartReadableName(squat) })
    const own = signedBy(50, tip, 'Alice')
    const bound = bindChartName(book, own)
    expect(bound.ok && bound.book['alice/tip-jar']?.authorKey).toBe(key(50).toPublicKey().toString())
  })
})

describe('coin use', () => {
  it('names each coin and network the app can move, or says it moves none', () => {
    expect(describeCoinUse(builtin('tip-jar'))).toMatch(/^Uses Bitcoin SV on mainnet/)
    expect(describeCoinUse(builtin('message-box'))).toBe('Moves no coins or items')
  })
})

describe('chart shares', () => {
  const book = nameBookFromCharts(ALL)

  it('round-trips a built-in app through its encoded packet', () => {
    const tip = builtin('tip-jar')
    const opened = openChartShare(encodeChartShare(buildChartShare(tip)), SUPPORT, book)
    expect(opened).toMatchObject({ ok: true, name: chartReadableName(tip), hash: BUILTIN_CHART_HASHES['tip-jar'] })
    expect(opened.ok && opened.coinUse).toMatch(/Bitcoin SV/)
  })

  it('opens an app from a new author and lets the wallet bind its name', () => {
    const app = signedBy(51, builtin('tip-jar'), 'Alice')
    const opened = openChartShare(buildChartShare(app), SUPPORT, book)
    expect(opened).toMatchObject({ ok: true, name: 'alice/tip-jar' })
  })

  it('refuses an app that borrows a held author name', () => {
    const fake = signedBy(52, { ...builtin('tip-jar'), id: 'drain' })
    expect(openChartShare(buildChartShare(fake), SUPPORT, book)).toMatchObject({ ok: false, reason: 'taken' })
  })

  it('refuses a packet whose name or hash does not match its chart', () => {
    const share = buildChartShare(builtin('tip-jar'))
    expect(openChartShare({ ...share, name: 'alice/tip-jar' }, SUPPORT, book)).toMatchObject({ ok: false, reason: 'name' })
    expect(openChartShare({ ...share, hash: '0'.repeat(64) }, SUPPORT, book)).toMatchObject({ ok: false, reason: 'hash' })
  })

  it('refuses a chart changed after signing', () => {
    const share = buildChartShare(builtin('tip-jar'))
    const changed = { ...share.chart, summary: 'Changed' }
    const rehashed = buildChartShare(changed)
    expect(openChartShare(rehashed, SUPPORT, book)).toMatchObject({ ok: false, reason: 'signature' })
  })

  it('refuses an app needing a coin or network the wallet does not run', () => {
    const share = buildChartShare(builtin('tip-jar'))
    const btcOnly: ChartWalletSupport = { coins: [{ coin: 'BTC', network: 'mainnet' }], boxes: ['inbox'] }
    expect(openChartShare(share, btcOnly, book)).toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('refuses malformed packets', () => {
    const share = buildChartShare(builtin('tip-jar'))
    expect(openChartShare('not json', SUPPORT, book)).toMatchObject({ ok: false, reason: 'malformed' })
    expect(openChartShare([], SUPPORT, book)).toMatchObject({ ok: false, reason: 'malformed' })
    expect(openChartShare({ ...share, extra: 1 }, SUPPORT, book)).toMatchObject({ ok: false, reason: 'malformed' })
    expect(openChartShare({ ...share, format: 'chart-app-share/2' }, SUPPORT, book)).toMatchObject({ ok: false, reason: 'malformed' })
    expect(openChartShare('x'.repeat(40_000), SUPPORT, book)).toMatchObject({ ok: false, reason: 'malformed' })
  })
})
