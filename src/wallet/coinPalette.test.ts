import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './colorFormat'
import { HANDCASH_DARK_PALETTE, HANDCASH_LIGHT_PALETTE } from './handcashTheme'
import { TICKER_COIN_ORDER } from './tickerCoin'
import { COIN_CHAINS } from './coins/coinChains'
import { coinAccentVar } from './coinHoldings'

const css = readFileSync(fileURLToPath(new URL('../styles/handcash.css', import.meta.url)), 'utf8')

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

/* Machado et al. 2009 dichromat simulations, full severity, on linear sRGB. */
const CVD: Record<string, number[][] | null> = {
  normal: null,
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
}

function lab(hex: string, matrix: number[][] | null): [number, number, number] {
  let c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  if (matrix) c = matrix.map((row) => row[0]! * c[0]! + row[1]! * c[1]! + row[2]! * c[2]!)
  const [r, g, b] = c as [number, number, number]
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047)
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b)
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** CIEDE2000 colour difference. */
function deltaE(a: string, b: string, matrix: number[][] | null): number {
  const [L1, a1, b1] = lab(a, matrix)
  const [L2, a2, b2] = lab(b, matrix)
  const rad = Math.PI / 180
  const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))
  const a1p = a1 * (1 + G)
  const a2p = a2 * (1 + G)
  const C1 = Math.hypot(a1p, b1)
  const C2 = Math.hypot(a2p, b2)
  const hue = (y: number, x: number) => ((Math.atan2(y, x) / rad) + 360) % 360
  const h1 = hue(b1, a1p)
  const h2 = hue(b2, a2p)
  let dh = C1 * C2 === 0 ? 0 : h2 - h1
  if (dh > 180) dh -= 360
  else if (dh < -180) dh += 360
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * rad) / 2)
  const Lb = (L1 + L2) / 2
  const Cb = (C1 + C2) / 2
  const hb = C1 * C2 === 0 ? h1 + h2 : Math.abs(h1 - h2) > 180 ? (h1 + h2 + 360) / 2 : (h1 + h2) / 2
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad)
  const RT = -Math.sin(2 * 30 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad) * 2 * Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7))
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2)
  const SC = 1 + 0.045 * Cb
  const SH = 1 + 0.015 * Cb * T
  return Math.sqrt(((L2 - L1) / SL) ** 2 + ((C2 - C1) / SC) ** 2 + (dH / SH) ** 2 + RT * ((C2 - C1) / SC) * (dH / SH))
}

const sheets = [
  { name: 'dark', t: dark, grounds: ['#000000', '#0c0c0c'], min: 4.5, danger: HANDCASH_DARK_PALETTE.danger },
  { name: 'light', t: light, grounds: ['#ffffff', '#fafbfa', '#f3f5f3'], min: 3, danger: HANDCASH_LIGHT_PALETTE.danger },
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

  for (const { name, t, grounds, min, danger } of sheets) {
    describe(`${name} sheet`, () => {
      const accents = TICKER_COIN_ORDER.map((coin) => [coin, t[coinAccentVar(coin)]] as const)

      it('defines an accent for every coin', () => {
        for (const [coin, hex] of accents) expect(hex, coin).toMatch(/^#[0-9a-f]{6}$/)
      })

      it(`keeps each accent at ${min}:1 on every ground`, () => {
        for (const [coin, hex] of accents) {
          for (const ground of grounds) expect(contrastRatio(hex!, ground), `${coin} on ${ground}`).toBeGreaterThanOrEqual(min)
        }
      })

      it('keeps the coins apart for normal and colour-blind vision', () => {
        for (const [kind, matrix] of Object.entries(CVD)) {
          for (let i = 0; i < accents.length; i++) {
            for (let j = i + 1; j < accents.length; j++) {
              const [a, ha] = accents[i]!
              const [b, hb] = accents[j]!
              expect(deltaE(ha!, hb!, matrix), `${a}/${b} ${kind}`).toBeGreaterThanOrEqual(9)
            }
          }
        }
      })

      it('keeps the coins apart from the warning, error and info inks', () => {
        const status = { warn: t['--hc-warn']!, info: t['--hc-info']!, danger }
        for (const [coin, hex] of accents) {
          for (const [label, ink] of Object.entries(status)) {
            expect(deltaE(hex!, ink, null), `${coin}/${label}`).toBeGreaterThanOrEqual(10)
          }
        }
      })
    })
  }

  it('gives every chain logo disc 4:1 under its white glyph, the same on both sheets', () => {
    for (const chain of COIN_CHAINS) {
      const mark = dark[`--coin-${chain}-mark`]
      expect(mark, chain).toMatch(/^#[0-9a-f]{6}$/)
      expect(light[`--coin-${chain}-mark`]).toBe(mark)
      expect(contrastRatio(mark!, '#ffffff'), chain).toBeGreaterThanOrEqual(4)
      expect(css).toContain(`[data-chain-mark='${chain}'] .chain-mark-disc {\n  fill: var(--coin-${chain}-mark);`)
    }
  })
})
