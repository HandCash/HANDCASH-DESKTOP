import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The tray reads PNG because Electron's `nativeImage` cannot decode SVG, so the
 * PNGs are generated output — and once drifted a whole logo generation behind
 * `handcash-tray*.svg`, which put the retired HandCash mark in the macOS menu
 * bar. Regenerate with `npm run icons:tray` when the SVG changes.
 */
const root = path.resolve(__dirname, '..')
const assets = path.join(root, 'electron/assets')
const buildDir = path.join(root, 'build')
const pin = JSON.parse(
  fs.readFileSync(path.join(assets, 'tray-icons.pin.json'), 'utf8'),
) as {
  generatedFrom: Record<string, string>
  pngs: Record<string, { size: number; sha256: string }>
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function sha256Text(file: string): string {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** Width/height straight out of the PNG IHDR. */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('tray icon assets', () => {
  it('has a pin for every tray SVG the loader can be asked for', () => {
    expect(Object.keys(pin.generatedFrom).sort()).toEqual([
      'handcash-tray-black.svg',
      'handcash-tray.svg',
    ])
  })

  it('was regenerated after the source SVG last changed', () => {
    for (const [svg, hash] of Object.entries(pin.generatedFrom)) {
      expect(sha256Text(path.join(assets, svg)), `${svg} changed — run npm run icons:tray`).toBe(
        hash,
      )
    }
  })

  it('ships the exact PNGs that were rasterized from those SVGs', () => {
    for (const [png, expected] of Object.entries(pin.pngs)) {
      const file = path.join(assets, png)
      expect(sha256(file), `${png} is stale — run npm run icons:tray`).toBe(expected.sha256)
      expect(pngSize(file)).toEqual({ width: expected.size, height: expected.size })
    }
  })

  it('keeps build/ byte-identical to electron/assets', () => {
    for (const png of Object.keys(pin.pngs)) {
      expect(sha256(path.join(buildDir, png)), `build/${png} differs`).toBe(
        sha256(path.join(assets, png)),
      )
    }
  })
})
