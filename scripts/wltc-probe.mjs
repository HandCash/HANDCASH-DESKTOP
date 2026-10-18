#!/usr/bin/env node
/**
 * Outside check of what this Mac's wallet records for its Litecoin deposits.
 *
 * Reads the wLTC bridge record each account keeps (durable-prefs.json) and
 * sets it beside an explorer's view. The wallet never uses this explorer for
 * depth; here it is only a witness, so a disagreement is shown, not resolved.
 *
 *   node scripts/wltc-probe.mjs                 one report
 *   node scripts/wltc-probe.mjs --watch 30      every 30 s until Ctrl-C
 *   node scripts/wltc-probe.mjs --json
 *   node scripts/wltc-probe.mjs --prefs <file>  another profile's durable-prefs.json
 *
 * Exits 1 when the wallet claims more than the chain shows.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NEEDED = 6
const API = 'https://litecoinspace.org/api'
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const json = args.includes('--json')
const watch = Number(flag('--watch') ?? 0)
const prefsPath =
  flag('--prefs') ??
  join(homedir(), 'Library', 'Application Support', 'handcash-brc100', 'durable-prefs.json')

async function get(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15_000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function readRecords() {
  const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'))
  return Object.entries(prefs)
    .filter(([key]) => key.startsWith('handcash.wltc.v1:'))
    .map(([key, raw]) => ({ account: key.split(':').slice(1, 4).join(':'), state: JSON.parse(raw) }))
}

/** What the wallet's record says, in the same words the UI derives. */
function walletView(d) {
  const p = d.phase
  if (d.status !== 'credited') return { phase: d.status, counted: null }
  if (!p) return { phase: d.proven === false ? 'unchecked' : 'movable', counted: d.proven === false ? 0 : NEEDED }
  if (p.kind === 'confirming') return { phase: 'confirming', counted: p.confirmations, height: p.height, checkedAt: p.checkedAt }
  if (p.kind === 'unchecked') return { phase: 'unchecked', counted: p.last?.confirmations ?? 0, height: p.last?.height, checkedAt: p.last?.checkedAt }
  if (p.kind === 'movable') return { phase: 'movable', counted: NEEDED, height: p.height, checkedAt: p.checkedAt }
  return { phase: p.kind, counted: 0, checkedAt: p.checkedAt ?? p.since }
}

/** Every claim the wallet makes that the chain contradicts. Lagging behind is honest; running ahead is not. */
function judge(wallet, chain) {
  const problems = []
  const notes = []
  if (chain.state === 'unknown') {
    if (wallet.phase === 'movable') problems.push('movable, but no explorer knows the deposit')
    return { problems, notes }
  }
  if (wallet.counted != null && wallet.counted > chain.confirmations && wallet.phase !== 'movable')
    problems.push(`counts ${wallet.counted}, the chain shows only ${chain.confirmations}`)
  if (wallet.phase === 'movable' && chain.confirmations < NEEDED)
    problems.push(`movable at ${chain.confirmations} confirmation(s); needs ${NEEDED}`)
  if (wallet.height != null && chain.height != null && wallet.height !== chain.height)
    problems.push(`records block ${wallet.height}, the chain has it in ${chain.height}`)
  if ((wallet.phase === 'missing' || wallet.phase === 'abandoned') && chain.state !== 'unknown')
    notes.push(`shown ${wallet.phase}, but the explorer knows it (${chain.state}); next check should recover`)
  if (wallet.phase !== 'movable' && chain.confirmations >= NEEDED)
    notes.push(`chain already shows ${chain.confirmations}; wallet will catch up on its next check`)
  if (wallet.counted != null && wallet.phase !== 'movable' && wallet.counted < chain.confirmations)
    notes.push(`lags the chain by ${chain.confirmations - wallet.counted} (own header chain or last check)`)
  return { problems, notes }
}

async function report() {
  const tip = Number(await get('/blocks/tip/height'))
  const rows = []
  for (const { account, state } of readRecords()) {
    for (const [outpoint, d] of Object.entries(state.deposits ?? {})) {
      const [txid, vout] = outpoint.split(':')
      const status = await get(`/tx/${txid}/status`)
      const chain = !status
        ? { state: 'unknown', confirmations: 0, height: null }
        : status.confirmed
          ? { state: 'in-block', confirmations: tip - status.block_height + 1, height: status.block_height }
          : { state: 'unconfirmed', confirmations: 0, height: null }
      const wallet = walletView(d)
      rows.push({ account, outpoint: `${txid}:${vout}`, litoshi: d.litoshi, wallet, chain, ...judge(wallet, chain) })
    }
  }
  return { at: new Date().toISOString(), tip, rows }
}

function print(r) {
  console.log(`\n${r.at}  Litecoin tip ${r.tip.toLocaleString()} (explorer)`)
  if (!r.rows.length) console.log('  no wLTC deposits recorded')
  for (const row of r.rows) {
    const ltc = (Number(row.litoshi) / 1e8).toFixed(8)
    const age = row.wallet.checkedAt ? ` · checked ${Math.round((Date.now() - row.wallet.checkedAt) / 1000)}s ago` : ''
    console.log(`  ${row.outpoint.slice(0, 12)}…:${row.outpoint.split(':')[1]}  ${ltc} LTC  [${row.account}]`)
    console.log(`    wallet  ${row.wallet.phase}${row.wallet.counted != null ? ` ${row.wallet.counted}/${NEEDED}` : ''}${row.wallet.height ? ` · block ${row.wallet.height}` : ''}${age}`)
    console.log(`    chain   ${row.chain.state}${row.chain.height ? ` · block ${row.chain.height} · ${row.chain.confirmations} conf` : ''}`)
    for (const p of row.problems) console.log(`    ✗ ${p}`)
    for (const n of row.notes) console.log(`    · ${n}`)
  }
}

async function once() {
  const r = await report()
  if (json) console.log(JSON.stringify(r, null, 2))
  else print(r)
  return r.rows.some((row) => row.problems.length)
}

if (watch > 0) {
  for (;;) {
    try {
      await once()
    } catch (err) {
      console.error(`probe failed: ${err.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, watch * 1000))
  }
} else {
  process.exit((await once()) ? 1 : 0)
}
