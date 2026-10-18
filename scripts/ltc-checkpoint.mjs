#!/usr/bin/env node
/**
 * Write `src/wallet/wltc/checkpoint.ts`: the Litecoin block every install's
 * header chain starts from, with the window-end times its next retarget reads.
 * It must sit below every backed deposit (see that file), so it is written only
 * for an explicit height. A new checkpoint makes installs drop their chain.
 *
 *   npm run ltc:checkpoint -- --height 3196900
 *   npm run ltc:checkpoint -- --check   # how long a fresh install's first sync is
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://litecoinspace.org/api'
const INTERVAL = 2016
/** A first sync past this many blocks (about a month) is due a bulk header source. */
const LONG_SYNC = 17_280
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wallet', 'wltc', 'checkpoint.ts')

async function get(path) {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res
}

async function block(height) {
  const rows = await (await get(`/blocks/${height}`)).json()
  const row = rows.find((r) => r.height === height)
  if (!row) throw new Error(`block ${height} missing from its page`)
  return row
}

const tip = Number(await (await get('/blocks/tip/height')).text())

if (process.argv.includes('--check')) {
  const shipped = Number(/height: (\d+)/.exec(readFileSync(out, 'utf8'))?.[1])
  const blocks = tip - shipped
  console.log(`A fresh install syncs ${blocks} Litecoin headers (${Math.ceil(blocks / 10)} explorer calls) on its first burial check`)
  process.exit(blocks > LONG_SYNC ? 1 : 0)
}

const height = Number(process.argv[process.argv.indexOf('--height') + 1])
if (!process.argv.includes('--height') || !Number.isSafeInteger(height) || height <= 0 || height > tip - 6) {
  console.error('Usage: npm run ltc:checkpoint -- --height <a block below every backed deposit>')
  process.exit(1)
}
const cp = await block(height)
const lastEnd = Math.floor((height + 1) / INTERVAL) * INTERVAL - 1
const ends = {}
for (const h of [lastEnd - INTERVAL, lastEnd]) ends[h] = (await block(h)).timestamp

const source = readFileSync(out, 'utf8')
const body = `export const LTC_CHECKPOINT: LtcCheckpoint = {
  height: ${height},
  hash: '${cp.id}',
  bits: ${cp.bits},
  time: ${cp.timestamp},
  windowEnds: { ${Object.entries(ends).map(([h, t]) => `${h}: ${t}`).join(', ')} },
}
`
writeFileSync(out, source.replace(/export const LTC_CHECKPOINT[\s\S]*$/, body))
console.log(`Litecoin checkpoint → ${height} ${cp.id}`)
