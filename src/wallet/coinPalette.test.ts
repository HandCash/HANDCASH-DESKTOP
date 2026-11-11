import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './colorFormat'
import { TICKER_COIN_ORDER } from './tickerCoin'
import { COIN_CHAINS } from './coins/coinChains'
import { coinAccentVar } from './coinHoldings'

const css = readFileSync(fileURLToPath(new URL('../styles/handcash.css', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('\n}', start))
}

function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!.toLowerCase()
  return out
}

const dark = tokens(block(':root'))
const light = { ...dark, ...tokens(block("html[data-aeon-mode='light']")) }

/** Official brand colours (Arc USD is a USDC dollar). */
const BRAND: Record<string, string> = {
  bsv: '#eab300',
  ltc: '#345d9d',
  bch: '#0ac18e',
  btc: '#f7931a',
  doge: '#c2a633',
  'arc-usd': '#2775ca',
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

function hueGap(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b))
  return Math.min(d, 360 - d)
}

const sheets = [
  { name: 'dark', t: dark, grounds: ['#000000', '#0c0c0c'] },
  { name: 'light', t: light, grounds: ['#ffffff', '#fafbfa', '#f3f5f3'] },
] as const

describe('coin palette', () => {
  it('maps every coin to its own accent token', () => {
    expect(TICKER_COIN_ORDER.map(coinAccentVar)).toEqual([
      '--coin-bsv',
      '--coin-ltc',
      '--coin-bch',
      '--coin-btc',
      '--coin-doge',
      '--coin-arc-usd',
    ])
    for (const coin of TICKER_COIN_ORDER) {
      expect(css).toContain(`[data-coin='${coin}'] {\n  --coin-color: var(--coin-${coin});`)
    }
  })

  it('uses the brand colour itself wherever it keeps 3:1 on the dark grounds', () => {
    for (const coin of TICKER_COIN_ORDER) {
      const brand = BRAND[coin]!
      const fits = sheets[0].grounds.every((g) => contrastRatio(brand, g) >= 3)
      if (fits) expect(dark[coinAccentVar(coin)], coin).toBe(brand)
    }
  })

  for (const { name, t, grounds } of sheets) {
    describe(`${name} sheet`, () => {
      const accents = TICKER_COIN_ORDER.map((coin) => [coin, t[coinAccentVar(coin)]] as const)

      it('defines an accent for every coin', () => {
        for (const [coin, hex] of accents) expect(hex, coin).toMatch(/^#[0-9a-f]{6}$/)
      })

      it('keeps each accent on its brand hue', () => {
        for (const [coin, hex] of accents) expect(hueGap(hex!, BRAND[coin]!), coin).toBeLessThanOrEqual(4)
      })

      it('keeps each accent at 3:1 on every ground', () => {
        for (const [coin, hex] of accents) {
          for (const ground of grounds) expect(contrastRatio(hex!, ground), `${coin} on ${ground}`).toBeGreaterThanOrEqual(3)
        }
      })
    })
  }

  it('paints every chain logo disc in its exact brand colour, the same on both sheets', () => {
    for (const chain of [...COIN_CHAINS, 'arc-usd'] as const) {
      const mark = dark[`--coin-${chain}-mark`]
      expect(mark, chain).toBe(BRAND[chain])
      expect(light[`--coin-${chain}-mark`]).toBe(mark)
      expect(css).toContain(`[data-chain-mark='${chain}'] .chain-mark-disc {\n  fill: var(--coin-${chain}-mark);`)
    }
  })

  it('never uses the broken --coin-color-light fallback for light-mode figures', () => {
    // Light sheet redefines --coin-*; figures must read --coin-color so each
    // ticker keeps its own ink (the old -light alias was undefined → all green).
    expect(css).not.toMatch(/--coin-color-light/)
  })
})
