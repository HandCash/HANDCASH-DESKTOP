#!/usr/bin/env node
// Development-only replay of bsv-script-lean's recorded seed verdicts.
// Provenance, scope and upstream licence links: docs/bsv-script-conformance.md.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Transaction, Spend, LockingScript } from '@bsv/sdk'

export const PIN = '1c051eaef1077cc95e5d1618686d5efacc4aa097'
export const SEED_SHA256 = 'bc0651d0f7f8193aebbd233b258148d81ca553a8f43a01fc2594b51610f554b0'
const SPEC = 'spec@cb7e46e'
// Seed consensus word 4015663, NOT the stricter mempool word 4016127.
// corpus/witnesses/ts-sdk/manifest.json at PIN, seed.words.
const FLAGS = [
  'P2SH', 'STRICTENC', 'DERSIG', 'LOW_S', 'CHECKLOCKTIMEVERIFY',
  'CHECKSEQUENCEVERIFY', 'NULLFAIL', 'SIGHASH_FORKID', 'GENESIS',
  'UTXO_AFTER_GENESIS', 'CHRONICLE', 'UTXO_AFTER_CHRONICLE'
]

export function parseSeed(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== SEED_SHA256) {
    throw new Error('Seed SHA-256 mismatch; refusing unreviewed corpus')
  }
  const rows = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  if (rows.length !== 10000 || new Set(rows.map(row => row.id)).size !== 10000) {
    throw new Error('Incomplete or duplicate seed corpus')
  }
  for (const row of rows) {
    if (!['valid', 'invalid'].includes(row.expect?.[SPEC]?.verdict) ||
        row.params?.consensus !== true || row.params.era !== 'post-chronicle' ||
        row.params.spend_height !== 967896 || ![1, 2].includes(row.params.tx_version) ||
        row.prevouts.some(prev => prev.height !== 967896)) {
      throw new Error('Unsupported seed configuration: ' + row.id)
    }
  }
  return rows
}

export function evaluate(row, explicitFlags = true) {
  // Adapter/decoding failures are errors, never an expected script rejection.
  const tx = Transaction.fromHex(row.tx)
  if (tx.version !== row.params.tx_version || tx.inputs.length !== row.prevouts.length ||
      tx.inputs.length === 0) throw new Error('Invalid input configuration: ' + row.id)
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i]
    const prev = row.prevouts[i]
    if (input.sourceTXID !== prev.txid || input.sourceOutputIndex !== prev.vout) {
      throw new Error('Prevout mismatch: ' + row.id)
    }
    const spend = new Spend({
      sourceTXID: input.sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: prev.satoshis,
      lockingScript: LockingScript.fromHex(prev.script),
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== i),
      allInputs: tx.inputs,
      outputs: tx.outputs,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence,
      inputIndex: i,
      lockTime: tx.lockTime,
      ...(explicitFlags ? { verifyFlags: FLAGS } : {})
    })
    try {
      if (!spend.validate()) return 'invalid'
    } catch (error) {
      if (error?.constructor?.name === 'ScriptEvaluationError') return 'invalid'
      throw error
    }
  }
  return 'valid'
}

export function replay(rows) {
  const mismatches = []
  let defaultDifferences = 0
  let valid = 0
  for (const row of rows) {
    const expected = row.expect[SPEC].verdict
    if (expected === 'valid') valid++
    const actual = evaluate(row)
    if (actual !== expected) mismatches.push({ id: row.id, rule: row.rule, expected, actual })
    if (evaluate(row, false) !== expected) defaultDifferences++
  }
  return { cases: rows.length, valid, invalid: rows.length - valid,
    consensusMismatches: mismatches.length, defaultDifferences, mismatches }
}

async function main() {
  if (process.argv[2] === '--evaluate') {
    const bytes = readFileSync(0)
    const rows = parseSeed(bytes)
    const sdk = JSON.parse(readFileSync(new URL('../node_modules/@bsv/sdk/package.json', import.meta.url)))
    const result = replay(rows)
    console.log(JSON.stringify({ pin: PIN, spec: SPEC, sdk: sdk.version,
      scope: 'seed script verdicts only; recorded oracle, not live Lean/node', ...result }, null, 2))
    if (result.consensusMismatches) process.exitCode = 1
    return
  }
  const args = process.argv.slice(2)
  if (args.length && !(args.length === 2 && args[0] === '--corpus')) {
    throw new Error('Usage: node scripts/bsv-script-conformance.mjs [--corpus /path/to/seed.jsonl]')
  }
  let bytes
  if (args.length) bytes = readFileSync(args[1])
  else {
    const response = await fetch(
      'https://raw.githubusercontent.com/Calhooon/bsv-script-lean/' + PIN + '/corpus/seed/seed.jsonl',
      { signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error('Corpus download failed: HTTP ' + response.status)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  parseSeed(bytes)
  // Kill a hung evaluator rather than leaving CPU work running after a timeout.
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--evaluate'], {
    input: bytes, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024
  })
  if (child.stdout) process.stdout.write(child.stdout)
  if (child.stderr) process.stderr.write(child.stderr)
  if (child.error) throw child.error
  if (child.status === null) throw new Error('Evaluator terminated: ' + child.signal)
  process.exitCode = child.status
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
