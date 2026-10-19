#!/usr/bin/env node
/**
 * Write a coin's checkpoint (`BCH_CHECKPOINT`, `BTC_CHECKPOINT`,
 * `DOGE_CHECKPOINT`): the block every install's header chain for that coin
 * starts from. Two Electrum servers must serve the same header bytes or
 * nothing is written. A new checkpoint makes installs drop their chain, so it
 * is written only for an explicit height below every coin the wallet must
 * still prove.
 *
 *   npm run coin:checkpoint -- btc --height 968000
 *   npm run coin:checkpoint -- doge --check   # how long a fresh install's first sync is
 *
 * Each chain's retarget decides which earlier block times ride along:
 *   bch  ASERT reads only the anchor, so none.
 *   btc  the first block of the checkpoint's 2016-block window.
 *   doge DigiShield reads the two blocks before each block, so the parent.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHAINS = {
  bch: {
    label: 'Bitcoin Cash',
    constant: 'BCH_CHECKPOINT',
    servers: ['wss://bch.imaginary.cash:50004', 'wss://bch.loping.net:50004', 'wss://fulcrum.greyh.at:50004'],
    longSync: 4_320,
    burial: 6,
    windowFirst: () => null,
  },
  btc: {
    label: 'Bitcoin',
    constant: 'BTC_CHECKPOINT',
    servers: [
      'wss://fulcrum.grey.pw:50004',
      'wss://bitcoinserver.nl:50004',
      'wss://btc.electroncash.dk:60004',
      'wss://electrum1.cipig.net:30000',
      'wss://electrum2.cipig.net:30000',
    ],
    longSync: 4_320,
    burial: 3,
    windowFirst: (height) => height - (height % 2016),
  },
  doge: {
    label: 'Dogecoin',
    constant: 'DOGE_CHECKPOINT',
    servers: ['wss://electrum1.cipig.net:30060', 'wss://electrum2.cipig.net:30060', 'wss://electrum3.cipig.net:30060'],
    longSync: 43_200,
    burial: 20,
    windowFirst: (height) => height - 1,
  },
}

const chainId = process.argv[2]
const chain = CHAINS[chainId]
if (!chain) {
  console.error(`Usage: npm run coin:checkpoint -- <${Object.keys(CHAINS).join('|')}> (--height <n> | --check)`)
  process.exit(1)
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wallet', chainId, 'headers.ts')

function rpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`${url} timed out`))
    }, 15_000)
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'server.version', params: ['handcash-checkpoint', '1.4'] }))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`${url} unreachable`))
    }
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(`${url} ${msg.error.message ?? JSON.stringify(msg.error)}`))
      else resolve(msg.result)
    }
  })
}

/** The same answer from two servers, or an error. */
async function agreed(method, params, pick = (r) => r) {
  const answers = []
  for (const url of chain.servers) {
    try {
      answers.push(JSON.stringify(pick(await rpc(url, method, params))))
    } catch (err) {
      console.warn(String(err instanceof Error ? err.message : err))
      continue
    }
    const counts = answers.reduce((m, a) => m.set(a, (m.get(a) ?? 0) + 1), new Map())
    for (const [answer, n] of counts) if (n >= 2) return JSON.parse(answer)
  }
  throw new Error(`no two servers agreed on ${method} ${JSON.stringify(params)}`)
}

/** The 80-byte block header at `height`; a Dogecoin server appends the AuxPoW, which a checkpoint does not keep. */
async function header(height) {
  const hex = await agreed('blockchain.block.header', [height], (r) => String(r).slice(0, 160))
  const raw = Buffer.from(hex, 'hex')
  if (raw.length !== 80) throw new Error(`header ${height} is ${raw.length} bytes`)
  return raw
}

const tip = (await agreed('blockchain.headers.subscribe', [], (r) => r.height))

if (process.argv.includes('--check')) {
  const shipped = Number(new RegExp(`${chain.constant}[\\s\\S]*?height: (\\d+)`).exec(readFileSync(out, 'utf8'))?.[1])
  const blocks = tip - shipped
  console.log(`A fresh install syncs ${blocks} ${chain.label} headers on its first burial check`)
  process.exit(blocks > chain.longSync ? 1 : 0)
}

const height = Number(process.argv[process.argv.indexOf('--height') + 1])
if (!process.argv.includes('--height') || !Number.isSafeInteger(height) || height <= 0 || height > tip - chain.burial) {
  console.error(`Usage: npm run coin:checkpoint -- ${chainId} --height <a block ${chain.burial} or more below the tip (${tip})>`)
  process.exit(1)
}
const raw = await header(height)
const sha = (b) => createHash('sha256').update(b).digest()
const hash = Buffer.from(sha(sha(raw))).reverse().toString('hex')
const time = raw.readUInt32LE(68)
const bits = raw.readUInt32LE(72)
const first = chain.windowFirst(height)
const windowEnds = first === null ? {} : { [first]: first === height ? time : (await header(first)).readUInt32LE(68) }

const source = readFileSync(out, 'utf8')
const ends = Object.entries(windowEnds).map(([h, t]) => `${h}: ${t}`).join(', ')
const body = `export const ${chain.constant}: LtcCheckpoint = {
  height: ${height},
  hash: '${hash}',
  bits: ${bits},
  time: ${time},
  windowEnds: {${ends ? ` ${ends} ` : ''}},
}`
const next = source.replace(new RegExp(`export const ${chain.constant}: LtcCheckpoint = \\{[\\s\\S]*?\\n\\}`), body)
if (next === source && !source.includes(body)) throw new Error(`${chain.constant} not found in ${out}`)
writeFileSync(out, next)
console.log(`${chain.label} checkpoint → ${height} ${hash}`)
