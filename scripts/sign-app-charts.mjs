#!/usr/bin/env node
/**
 * Sign the built-in chart apps in src/apps/builtin/*.json and pin their hashes
 * in src/apps/builtin/hashes.json.
 *
 * The author key comes from HANDCASH_APPS_SIGNING_KEY, else the macOS login
 * Keychain item `handcash-apps-author-key`. It is never written to disk.
 *
 *   node scripts/sign-app-charts.mjs          sign every chart
 *   node scripts/sign-app-charts.mjs --check  fail if any chart's signature or pin is stale
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'src/apps/builtin')
const check = process.argv.includes('--check')

const bundled = await build({
  entryPoints: [path.join(root, 'src/apps/chartSignature.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const tmp = path.join(root, 'node_modules/.cache/sign-app-charts.mjs')
fs.mkdirSync(path.dirname(tmp), { recursive: true })
fs.writeFileSync(tmp, bundled.outputFiles[0].text)
const { chartHash, signChart, verifyChartSignature } = await import(pathToFileURL(tmp).href)

function signingKey() {
  if (process.env.HANDCASH_APPS_SIGNING_KEY) return process.env.HANDCASH_APPS_SIGNING_KEY.trim()
  return execFileSync('security', ['find-generic-password', '-s', 'handcash-apps-author-key', '-w'], {
    encoding: 'utf8',
  }).trim()
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'hashes.json').sort()
const hashesPath = path.join(dir, 'hashes.json')
const pinned = fs.existsSync(hashesPath) ? JSON.parse(fs.readFileSync(hashesPath, 'utf8')) : {}
const hashes = {}
let stale = 0
const key = check ? null : signingKey()

for (const file of files) {
  const full = path.join(dir, file)
  const chart = JSON.parse(fs.readFileSync(full, 'utf8'))
  const hash = chartHash(chart)
  hashes[chart.id] = hash
  if (check) {
    if (!verifyChartSignature(chart) || pinned[chart.id] !== hash) {
      console.error(`${file}: signature or pinned hash is stale`)
      stale += 1
    }
    continue
  }
  const signed = signChart(chart, key)
  fs.writeFileSync(full, `${JSON.stringify(signed, null, 2)}\n`)
  console.log(`${file}  ${hash}`)
}

if (check) {
  if (stale) process.exit(1)
  console.log(`${files.length} charts signed and pinned`)
} else {
  fs.writeFileSync(hashesPath, `${JSON.stringify(hashes, null, 2)}\n`)
}
