#!/usr/bin/env node
/**
 * Rasterize the tray SVGs into the PNGs the tray actually loads.
 *
 * Electron's `nativeImage` cannot decode SVG, so the tray reads PNG — which let
 * the shipped PNGs drift a whole logo generation behind `handcash-tray*.svg` and
 * put the retired HandCash mark in the macOS menu bar. The SVG stays the source
 * of truth; these PNGs are build output, and `trayAssets.test.ts` fails if the
 * SVG moves without a regenerate.
 *
 *   node scripts/build-tray-icons.mjs            # regenerate PNGs + pin
 *   node scripts/build-tray-icons.mjs --check    # verify pin only (no Chrome)
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assets = path.join(root, 'electron/assets')
const buildDir = path.join(root, 'build')
const pinPath = path.join(assets, 'tray-icons.pin.json')

/** Menu bar / StatusNotifier renders at 18–24pt; 128 covers 4x, 32 covers 1x. */
const VARIANTS = [
  { svg: 'handcash-tray.svg', png: 'tray-icon.png', size: 128 },
  { svg: 'handcash-tray.svg', png: 'tray-icon-32.png', size: 32 },
  { svg: 'handcash-tray-black.svg', png: 'tray-icon-black.png', size: 128 },
  { svg: 'handcash-tray-black.svg', png: 'tray-icon-black-32.png', size: 32 },
]

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** One Electron per icon: a second offscreen transparent window fails to load. */
function rasterize(job) {
  const electron = path.join(root, 'node_modules/.bin/electron')
  if (!fs.existsSync(electron)) {
    console.error('Electron is not installed — run npm install first.')
    process.exit(1)
  }
  fs.rmSync(job.out, { force: true })
  execFileSync(electron, [path.join(root, 'scripts/trayRasterize.cjs')], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 120_000,
    env: { ...process.env, TRAY_JOBS: JSON.stringify([job]) },
  })
  if (!fs.existsSync(job.out)) {
    throw new Error(`rasterize wrote nothing for ${path.basename(job.out)}`)
  }
}

const checkOnly = process.argv.includes('--check')
const pin = { generatedFrom: {}, pngs: {} }

if (!checkOnly) {
  for (const variant of VARIANTS) {
    const outFile = path.join(assets, variant.png)
    rasterize({
      svg: path.join(assets, variant.svg),
      out: outFile,
      size: variant.size,
    })
    // build/ is what electron-builder ships; keep it byte-identical.
    fs.copyFileSync(outFile, path.join(buildDir, variant.png))
    console.log(`${variant.svg} → ${variant.png} (${variant.size}px)`)
  }
}

for (const variant of VARIANTS) {
  pin.generatedFrom[variant.svg] = sha256(path.join(assets, variant.svg))
  pin.pngs[variant.png] = { size: variant.size, sha256: sha256(path.join(assets, variant.png)) }
}

if (checkOnly) {
  const recorded = JSON.parse(fs.readFileSync(pinPath, 'utf8'))
  const drift = JSON.stringify(recorded) !== JSON.stringify(pin)
  if (drift) {
    console.error('Tray PNGs are stale — run: node scripts/build-tray-icons.mjs')
    process.exit(1)
  }
  console.log('Tray PNGs match their SVG source.')
} else {
  fs.writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`)
  console.log(`Pinned tray icons → ${path.relative(root, pinPath)}`)
}
