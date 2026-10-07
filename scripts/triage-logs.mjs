#!/usr/bin/env node
/**
 * Triage a device's uploaded session logs with Jev (TypeSafe System One).
 *
 *   node scripts/triage-logs.mjs [bucket] [--all] [--json] [--state]
 *   node scripts/triage-logs.mjs desktop-local        # this machine, no upload
 *   node scripts/triage-logs.mjs --file <session.log> # any saved upload / ring
 *
 * Buckets default to the ones in `.cursor/rules/remote-support-logs.mdc`.
 * `desktop-local` reads the renderer ring the Desktop app mirrors into its
 * Electron `durable-prefs.json` (`handcash.applog.current.v1` = latest run,
 * `handcash.applog.previous.v1` = the run before) plus the electron-log
 * `main.log` for BRC-100 bridge facts — the same lines an upload would carry,
 * without waiting for one.
 *
 * Division of labour, per the TypeSafe building guide: **code** does the
 * parsing, counting, grouping and correlation — every exact fact. **Jev** only
 * makes the judgment calls that need semantic understanding of what the wallet
 * is doing: is this user-visible, which subsystem is driving it, is custody at
 * risk, is it new versus the previous session. Never ask the model to count.
 *
 * Needs JEV_API_KEY (read from .env or the environment).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KNOWN_BUCKETS,
  askJev,
  beforeLeftBasket,
  bridgeFacts,
  parseElectronLog,
  parseSession,
  ringEvents,
  sessionFacts,
  splitUploads,
  traceTxid,
} from './triage/core.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LOG_BASE = 'https://brc-cloud.bcryderman.workers.dev/v1/logs'

function jevApiKey() {
  for (const name of ['JEV_API_KEY', 'JEV_KEY', 'TYPESAFE_API_KEY']) {
    if (process.env[name]?.trim()) return process.env[name].trim()
  }
  // This repo's .env, then the HandCash workspace .env one level up.
  for (const envFile of [path.join(root, '.env'), path.join(root, '..', '.env')]) {
    if (!fs.existsSync(envFile)) continue
    const env = fs.readFileSync(envFile, 'utf8')
    const hit = env.match(/^\s*(?:JEV_API_KEY|JEV_KEY|TYPESAFE_API_KEY)\s*=\s*(.+)$/m)
    if (hit) return hit[1].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error('JEV_API_KEY / JEV_KEY is not set (env, HandCash/.env or HANDCASH-DESKTOP/.env)')
}

async function fetchLogs(bucket, all) {
  const url = `${LOG_BASE}/${bucket}/${all ? 'all' : 'latest'}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`log fetch ${res.status} ${url}`)
  return res.text()
}

/* ---------------------------------------------------------- local sources */

const ELECTRON_APP_ID = 'handcash-brc100'
const RING_CURRENT_KEY = 'handcash.applog.current.v1'
const RING_PREVIOUS_KEY = 'handcash.applog.previous.v1'

/** Electron `userData` and `logs` folders for the installed Desktop app. */
function desktopLocalPaths() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return {
      prefs: path.join(home, 'Library/Application Support', ELECTRON_APP_ID, 'durable-prefs.json'),
      mainLog: path.join(home, 'Library/Logs', ELECTRON_APP_ID, 'main.log'),
      mainOldLog: path.join(home, 'Library/Logs', ELECTRON_APP_ID, 'main.old.log'),
    }
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData/Roaming')
    const base = path.join(appData, ELECTRON_APP_ID)
    return {
      prefs: path.join(base, 'durable-prefs.json'),
      mainLog: path.join(base, 'logs/main.log'),
      mainOldLog: path.join(base, 'logs/main.old.log'),
    }
  }
  const base = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), ELECTRON_APP_ID)
  return {
    prefs: path.join(base, 'durable-prefs.json'),
    mainLog: path.join(base, 'logs/main.log'),
    mainOldLog: path.join(base, 'logs/main.old.log'),
  }
}

/**
 * The renderer ring as the Desktop app persists it: `{ at, level, message }`
 * rows, newest last. Same lines an upload carries, read straight from disk.
 */
function readDurableRing(prefsPath, key) {
  if (!fs.existsSync(prefsPath)) return []
  const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
  const raw = prefs?.[key]
  if (typeof raw !== 'string' || !raw) return []
  try {
    const rows = JSON.parse(raw)
    return Array.isArray(rows)
      ? rows.filter((r) => r && typeof r.at === 'number' && typeof r.message === 'string')
      : []
  } catch {
    return []
  }
}

/** A session read from the on-disk ring instead of an upload body. */
function ringSession(rows, reason) {
  const events = ringEvents(rows)
  const version = events
    .map((e) => /^App log capture started — v(\d+\.\d+\.\d+)/.exec(e.text)?.[1])
    .filter(Boolean)
    .at(-1)
  return sessionFacts(
    { version: version ?? 'local-ring', platform: process.platform, reason },
    events,
  )
}

/**
 * Spendable balance the wallet last trusted, against coin receives in Activity.
 * A receive row can land while the output never becomes spendable, so the
 * history says "Received" and the balance does not move. Read from the same
 * durable prefs the app writes — not from log lines.
 */
function ledgerFacts(prefsPath, now = Date.now()) {
  const empty = { trustedSats: null, trustedAgeSeconds: null, recentCoinReceives: [] }
  if (!fs.existsSync(prefsPath)) return empty
  let prefs
  try {
    prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
  } catch {
    return empty
  }
  let trusted = null
  for (const [key, raw] of Object.entries(prefs)) {
    if (!key.startsWith('handcash.balance.lastTrusted')) continue
    try {
      const row = JSON.parse(raw)
      if (row && typeof row.sats === 'number' && (trusted == null || row.readAt > trusted.readAt)) {
        trusted = row
      }
    } catch {
      /* not a snapshot */
    }
  }
  const receives = []
  for (const [key, raw] of Object.entries(prefs)) {
    if (!key.includes('appActivity')) continue
    let decoded
    try {
      decoded = JSON.parse(raw)
    } catch {
      continue
    }
    const rows = Array.isArray(decoded) ? decoded : Array.isArray(decoded?.data) ? decoded.data : []
    for (const row of rows) {
      if (row?.kind !== 'earned' || row?.method !== 'receive' || !(row.sats > 1)) continue
      receives.push({
        sats: row.sats,
        txid: typeof row.txid === 'string' ? row.txid.slice(0, 12) : null,
        status: row.status ?? 'settled',
        ageMinutes: Number.isFinite(row.at) ? Math.round((now - row.at) / 60_000) : null,
      })
    }
  }
  receives.sort((a, b) => (a.ageMinutes ?? 1e9) - (b.ageMinutes ?? 1e9))
  const newest = receives[0] ?? null
  const trustedSats = trusted?.sats ?? null
  return {
    trustedSats,
    trustedAgeSeconds: trusted?.readAt ? Math.round((now - trusted.readAt) / 1000) : null,
    recentCoinReceives: receives.slice(0, 6),
    // The newest coin receive is larger than everything the wallet will spend.
    receivedAboveTrusted:
      newest && trustedSats != null && newest.ageMinutes != null && newest.ageMinutes <= 180
        ? Math.max(0, newest.sats - trustedSats)
        : 0,
  }
}


/* ----------------------------------------------------------------- report */

const BAR = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '·')

function report(state, answers) {
  const { latest } = state
  console.log(
    `\n${latest.platform} ${latest.version} · ${latest.windowSeconds}s window · ` +
      `upload reason: ${latest.uploadReason}`,
  )
  console.log(
    `${latest.freezes.total} freeze(s), worst ${latest.freezes.worstMs}ms, ` +
      `${(latest.freezes.blockedMsTotal / 1000).toFixed(1)}s blocked total ` +
      `(${latest.idleFreezes} with no wallet layer active)\n`,
  )

  const sev = answers.severity
  const verdict = [
    ['User-visible freeze', answers.user_visible_freeze.noul],
    ['Custody at risk', answers.custody_at_risk.noul],
    ['Regression vs previous', answers.regression_since_previous.noul],
  ]
  for (const [label, p] of verdict) {
    console.log(`${label.padEnd(24)} ${BAR(p)} ${(p * 100).toFixed(0)}%`)
  }
  console.log(
    `${'Severity'.padEnd(24)} ${sev.score.toFixed(2)} — ${
      sev.legend[String(Math.round(sev.score))]
    }`,
  )

  const choiceBlock = (title, c) => {
    console.log(`\n${title}: ${c.choice} (confidence ${c.confidence.toFixed(2)})`)
    for (const [k, v] of Object.entries(c.probabilities).sort((a, b) => b[1] - a[1])) {
      if (v >= 0.03) console.log(`  ${k.padEnd(28)} ${BAR(v)} ${(v * 100).toFixed(0)}%`)
    }
  }
  choiceBlock('Primary driver', answers.primary_driver)
  choiceBlock('Freeze owner', answers.freeze_owner)
  console.log(
    `\n${'Storage adds to freezes'.padEnd(24)} ${BAR(answers.storage_pressure_contributes.noul)} ${(
      answers.storage_pressure_contributes.noul * 100
    ).toFixed(0)}%`,
  )
  choiceBlock('Fix first', answers.fix_first)

  if (latest.workloads.length) {
    console.log('\nWorkloads overlapping blocked time (code-measured):')
    for (const w of latest.workloads) {
      console.log(
        `  ${w.workload.padEnd(28)} ${BAR(w.shareOfBlockedTime)} ${(w.shareOfBlockedTime * 100).toFixed(0)}% · ` +
          `${w.runs} run(s), longest ${w.longestRunMs}ms, inside ${w.freezesInside} freeze(s)`,
      )
    }
  }
  if (latest.precedingLines.length) {
    console.log('\nLast line before a freeze began (code-measured):')
    for (const p of latest.precedingLines.slice(0, 6)) {
      console.log(
        `  ${String(p.freezes).padStart(3)}× · ${(p.shareOfBlockedTime * 100).toFixed(0)}% of blocked time · ${p.message}`,
      )
    }
  }
  if (latest.bursts.length) {
    console.log('\nFreeze bursts:')
    for (const b of latest.bursts.slice(0, 4)) {
      const when = `v${b.build} ${b.secondsAfterLaunch != null ? `+${b.secondsAfterLaunch}s after launch` : 'launch unknown'}`
      console.log(
        `  ${when}: ${b.freezes} freeze(s), ${(b.blockedMs / 1000).toFixed(1)}s blocked over ${b.durationSeconds}s · ${b.activeLayers.join(' | ')}`,
      )
      if (b.overlappingWorkloads.length) console.log(`      during: ${b.overlappingWorkloads.join(', ')}`)
      if (b.overlappingWaits?.length) console.log(`      inside wait: ${b.overlappingWaits.join(', ')}`)
      if (b.lineBefore) console.log(`      preceded by: ${b.lineBefore}`)
      for (const line of b.linesInside ?? []) console.log(`      inside: ${line}`)
    }
  }
  const st = latest.storage
  if (st.refusedWrites || st.slowOps || st.store || st.proofRequestsPurged) {
    console.log('\nOrigin storage:')
    if (st.proofRequestsPurged) {
      console.log(`  proof requests retired: ${st.proofRequestsPurged} (${st.proofPurgedKB}KB) before history backup`)
    }
    if (st.store === 'webview') console.log('  durable store: WebView storage (≈5MB cap) — native file store missing')
    if (st.originMove) {
      const mv = st.originMove
      console.log(`  durable store: app files · moved ${mv.keys} key(s) (${mv.kb}KB) in ${mv.ms}ms, freed ${mv.freedKB}KB of WebView storage`)
    }
    if (st.heldKB != null) {
      console.log(
        `  ${st.heldKB}KB held across ${st.keyCount} keys · ${st.refusedWrites} refused write(s) for ${st.refusedKeys.join(', ')}`,
      )
      console.log(`  largest: ${st.largestKeys.map((k) => `${k.key}=${k.kb}KB`).join('  ')}`)
    } else if (st.refusedWrites) {
      console.log(`  ${st.refusedWrites} refused write(s) for ${st.refusedKeys.join(', ')}`)
    }
    if (st.worstSlowOp) {
      console.log(
        `  ${st.slowOps} slow op(s), worst ${st.worstSlowOp.op} ${st.worstSlowOp.ms}ms on ${st.worstSlowOp.key} (${st.worstSlowOp.kb}KB)`,
      )
    }
  }

  const cu = latest.custody
  if (cu.arcadeRejections.warnings > 0 || cu.utxoHeal.runs > 0) {
    console.log('\nCustody (code-counted):')
    const ar = cu.arcadeRejections
    if (ar.warnings > 0) {
      console.log(
        `  miner refused ${ar.distinctTxids} tx(s) in ${ar.warnings} warning(s) · chains up to ${ar.maxAncestorDepth} deep · ` +
          `${ar.repeatedTxids} re-asked · ${ar.truncatedReasons} reason(s) truncated`,
      )
      for (const r of ar.roots) {
        console.log(`  root ${r.rootTxid.slice(0, 16)}… — ${r.dependants} dependant tx(s)`)
      }
      for (const r of ar.rootReasons) console.log(`  root reason ×${r.count}: ${r.reason}`)
    }
    if (cu.utxoHeal.last) {
      const h = cu.utxoHeal.last
      console.log(
        `  heal ran ${cu.utxoHeal.runs}× · last: checked ${h.checked}, hid spent ${h.spent}, restored ${h.restored}, quarantined ${h.quarantined}, unknown ${h.unknown}`,
      )
    }
    if (answers.rejected_chain_cause) choiceBlock('Why the chain was refused', answers.rejected_chain_cause)
    if (answers.quarantine_next_step) choiceBlock('Quarantine next step', answers.quarantine_next_step)
  }

  const deadPayments = latest.broadcast?.deadTrails ?? []
  if (deadPayments.length) {
    console.log('\nDead payments (code-traced):')
    for (const d of deadPayments) {
      console.log(`  ${d.txid} ${d.cause}${d.winner ? ` · lost to ${d.winner}` : ''}`)
      for (const line of d.before.slice(-3)) console.log(`    before: ${line}`)
      for (const line of d.after.slice(0, 3)) console.log(`    after:  ${line}`)
    }
  }

  const ac = latest.activity
  const ui = latest.ui
  if (ui.duplicateKeyErrors > 0) {
    console.log('\nReact list keys (code-counted):')
    console.log(
      `  ${ui.duplicateKeyErrors} duplicate-key error(s) · owners: ${ui.duplicateKeyOwners.map((o) => `${o.component}×${o.count}`).join('  ') || 'unknown'}`,
    )
    for (const k of ui.duplicateKeys) console.log(`  ${String(k.count).padStart(4)}× key ${k.key}`)
  }
  if (ac.stuckCensuses > 0 || ac.placeholderWrites.length > 0 || ac.orphanRemovals > 0 || ui.duplicateKeyErrors > 0) {
    console.log('\nActivity rows (code-counted):')
    console.log(
      `  writes new ${ac.writes.new} · merged ${ac.writes.merged} · skipped ${ac.writes.skipped} · ` +
        `placeholders swept ${ac.orphanRemovals} · refused writes ${ac.refusedWrites}`,
    )
    if (ac.stuckCensuses > 0) {
      console.log(
        `  ${ac.stuckCensuses} stuck-row census(es): sweep ran in ${ac.censusesWhereSweepRan}, yielded in ${ac.censusesWhereSweepYielded} · ` +
          `${ac.stuckRows.length} distinct row(s), longest stuck ${ac.longestStuckSeconds}s`,
      )
      console.log(
        `  placeholders ${ac.placeholderRows} (surviving a sweep: ${ac.placeholderRowsSurvivingSweep}) · ` +
          `priced rows held while yielding ${ac.pricedRowsHeldWhileYielding} · rewritten fresh ${ac.rowsRewrittenFresh}`,
      )
      for (const r of ac.stuckRows.slice(0, 6)) {
        console.log(
          `  ${r.method}/${r.sats}sat item=${r.item} pending=${r.pendingId} · seen ${r.seen}× · age ${r.firstAgeS}s→${r.maxAgeS}s · survived ${r.sweepsSurvived} sweep(s)`,
        )
      }
    }
    for (const w of ac.placeholderWrites.slice(0, 5)) {
      console.log(`  ${String(w.count).padStart(4)}× placeholder write ${w.write}`)
    }
    if (answers.phantom_row_cause) choiceBlock('Phantom row cause', answers.phantom_row_cause)
  }

  const led = latest.ledger
  if (led && (led.recentCoinReceives.length > 0 || led.trustedSats != null)) {
    console.log('\nLedger (durable prefs, code-counted):')
    console.log(
      `  trusted spendable ${led.trustedSats ?? 'unknown'} sats` +
        (led.trustedAgeSeconds != null ? `, read ${led.trustedAgeSeconds}s ago` : '') +
        ` · newest receive exceeds it by ${led.receivedAboveTrusted} sats`,
    )
    for (const r of led.recentCoinReceives.slice(0, 4)) {
      console.log(`  receive ${r.sats} sats ${r.status} ${r.txid ?? 'no-txid'} · ${r.ageMinutes}min ago`)
    }
    if (answers.balance_gap_cause) choiceBlock('Balance did not rise', answers.balance_gap_cause)
  }

  const dep = latest.tokenDeposits
  if (dep && dep.deposits.length > 0) {
    console.log('\nToken deposits (code-counted):')
    console.log(
      `  ${dep.stillPending} still pending (oldest ${dep.oldestPendingSeconds}s) · ${dep.refused} refused · ${dep.retired} retired · ${dep.internalizeFailed} internalize failure(s) · ${dep.ancestryCompleted} ancestry completed · ${dep.ancestryMissing} parent(s) unavailable`,
    )
    for (const d of dep.deposits.slice(0, 6)) {
      const why = d.refused
        ? `refused: ${d.refused}`
        : d.retired
          ? `retired: ${d.retired}`
          : `pending ${d.pendingLines}× age ${d.maxAgeSeconds}s lookup=${d.lastLookup ?? '?'} fate=${d.lastFate ?? '?'}`
      const ancestry = d.ancestryCompleted
        ? ` · +${d.ancestryCompleted} parent(s) folded in ${d.ancestryCompletionMs}ms`
        : d.ancestryMissing
          ? ` · missing ${d.ancestryMissing}`
          : ''
      console.log(`  ${d.txid} · ${why}${ancestry}`)
    }
    if (answers.stuck_token_deposit) choiceBlock('Stuck token deposit', answers.stuck_token_deposit)
  }

  const att = latest.tokenAttestation
  if (att?.census) {
    const { tokens, ...shelves } = att.census
    console.log('\nToken issuer attestation (code-counted):')
    console.log(
      `  ${tokens} token(s) · ` +
        Object.entries(shelves)
          .map(([k, n]) => `${k} ${n}`)
          .join(' · '),
    )
    for (const t of att.offShelf ?? []) console.log(`    off shelf: ${t.sym} ${t.tokenId} — ${t.step}`)
    const fmt = (bucket) =>
      Object.entries(bucket)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'none'
    console.log(`  heals: bound ${fmt(att.heals.bound)} · refused ${fmt(att.heals.refused)} · ${att.tipsHealed} tip(s)`)
    if (answers.token_off_issuer_shelf) choiceBlock('Token off issuer shelf', answers.token_off_issuer_shelf)
  }

  const cards = latest.tokenLedger
  if (cards?.tokens.length) {
    console.log('\nToken balance vs history (code-counted, raw units):')
    for (const t of cards.tokens) {
      const kinds = Object.entries(t.byKind)
        .map(([k, v]) => `${k} ${v.amt}/${v.tips}`)
        .join(' · ')
      console.log(
        `  ${t.sym} ${t.tokenId} · holds ${t.held} in ${t.tips} tip(s) (${kinds}) · ` +
          `history net ${t.historyNet} over ${t.historyRows} row(s) · beyond history ${t.heldBeyondHistory} · spendable ${t.spendable}`,
      )
    }
    const scripts = Object.entries(cards.remittanceByScript ?? {})
    if (scripts.length) {
      console.log(`  remittance tips by listed script: ${scripts.map(([k, n]) => `${k} ${n}`).join(' · ')}`)
    }
    if (answers.token_balance_beyond_history) {
      choiceBlock('Token balance beyond history', answers.token_balance_beyond_history)
    }
  }

  const flow = latest.appFlow
  if (flow && flow.steps > 0) {
    console.log('\nConnected-app flow (code-counted):')
    console.log(
      `  ${flow.steps} action step(s) · ${flow.stalledSteps} page stall(s) ≥20s · longest page gap ${flow.longestPageGapMs}ms · longest approval ${flow.longestApprovalMs}ms · longest wallet work ${flow.longestWorkMs}ms`,
    )
    for (const s of flow.stalled) {
      console.log(
        `  ${s.method} · page gap ${s.pageGapMs}ms before it arrived (${s.origin}) · approval ${s.approvalMs}ms · work ${s.workMs}ms`,
      )
    }
    for (const r of flow.refusals) {
      console.log(
        `  refused ${r.method} ×${r.count} · ${r.code ?? r.status} · ${r.detail ?? '(no description)'} · ${r.origin}`,
      )
    }
    for (const s of flow.slowest ?? []) {
      if (s.workMs < 3000) continue
      console.log(
        `  slow ${s.method} · wallet work ${s.workMs}ms · approval ${s.approvalMs}ms · ${s.phases ?? s.origin ?? '?'}`,
      )
    }
    for (const [key, b] of Object.entries(flow.workByVisibility ?? {})) {
      const phases = Object.entries(b.medianPhaseMs)
        .map(([phase, ms]) => `${phase} ${ms}ms`)
        .join(' · ')
      console.log(
        `  ${key.padEnd(25)} ${b.steps} step(s) · median work ${b.medianWorkMs}ms · worst ${b.worstWorkMs}ms · ${phases}`,
      )
    }
    for (const t of latest.toolboxSteps ?? []) {
      const medians = Object.entries(t.medianMsByVisibility)
        .map(([visibility, ms]) => `${visibility} ${ms}ms`)
        .join(' · ')
      console.log(
        `  toolbox ${t.step.padEnd(40)} ${t.runs} run(s) · total ${t.totalMs}ms · worst ${t.worstMs}ms · median ${medians}${t.failed ? ` · ${t.failed} failed` : ''}`,
      )
    }
    if (answers.app_flow_stall) choiceBlock('Who held the flow up', answers.app_flow_stall)
    if (answers.slow_signing_owner) choiceBlock('Signing time owner', answers.slow_signing_owner)
    if (answers.app_flow_refusal) choiceBlock('Refusal to fix first', answers.app_flow_refusal)
  }

  const replays = latest.receiptReplays
  if (replays && (replays.replayedReceipts || replays.reentries)) {
    console.log('\nReceipt replays (code-counted):')
    console.log(
      `  ${replays.replayedReceipts} old receipt(s) re-merged ${replays.replayMerges}× · ${replays.reentries} cache re-entr(ies) of ${replays.reenteredCards} announced card(s)`,
    )
    for (const r of replays.replayed.slice(0, 5)) {
      console.log(`  ${r.txid} ${r.method} ×${r.merges} (first seen ${r.firstSeen})`)
    }
  }

  const sw = latest.serverWallet
  if (sw && (sw.funded || sw.internalized || Object.keys(sw.refreshFailed).length || sw.openMs.length)) {
    console.log('\nDev key wallets (code-counted):')
    console.log(
      `  funded ${sw.funded} · internalized ${sw.internalized} · recovered ${sw.recovered} · opens ${sw.openMs.length}${sw.openMs.length ? ` (worst ${Math.max(...sw.openMs)}ms)` : ''}`,
    )
    for (const [label, bucket] of [
      ['deferred', sw.deferred],
      ['refresh failed', sw.refreshFailed],
      ['recover failed', sw.recoverFailed],
    ]) {
      for (const [reason, n] of Object.entries(bucket)) console.log(`  ${label} ×${n}: ${reason}`)
    }
  }

  const ts = latest.tokenSends
  const combine = ts?.combine
  if (ts && (ts.started || ts.planned || combine?.started || Object.keys(combine?.failed ?? {}).length || [ts.failed, ts.blocked, ts.refused].some((b) => Object.keys(b).length))) {
    console.log('\nToken sends (code-counted):')
    console.log(
      `  started ${ts.started} · planned ${ts.planned} · signing ${ts.signing} · signed ${ts.signed} · sent ${ts.sent}${ts.lastPlan ? ` · last plan ${ts.lastPlan}` : ''}`,
    )
    const ib = ts.inputBeef
    if (ib && (ib.framed || ib.trackerRefused)) {
      console.log(`  inputBEEF: framed ${ib.framed} (dropped ${ib.dropped} parentless bod(ies)) · chain tracker refused ${ib.trackerRefused}`)
    }
    if (combine && (combine.started || Object.keys(combine.failed).length)) {
      console.log(`  combine: started ${combine.started} · done ${combine.done}`)
      for (const [reason, n] of Object.entries(combine.failed)) console.log(`  combine failed ×${n}: ${reason}`)
    }
    for (const [label, bucket] of [
      ['failed', ts.failed],
      ['blocked in panel', ts.blocked],
      ['refused', ts.refused],
    ]) {
      for (const [reason, n] of Object.entries(bucket)) console.log(`  ${label} ×${n}: ${reason}`)
    }
    for (const trail of ts.trails) {
      console.log(`  ${trail.txid.slice(0, 16)}… [v${trail.build}]`)
      for (const line of trail.lines) console.log(`    ${line}`)
    }
    const seenStarts = new Set()
    for (const st of ts.starts ?? []) {
      if (st.ended?.startsWith('[bsv21] send plan') || seenStarts.has(st.at)) continue
      seenStarts.add(st.at)
      console.log(`  ${st.token} send at ${st.at} [v${st.build}] never planned — ${st.ended ? `ended: ${st.ended}` : `upload ended +${st.lastSeenMs}ms later`}`)
      for (const line of st.lines.filter((l) => !/^\[nav\]/.test(l.shape)).slice(0, 12)) {
        console.log(`    ${line.times > 1 ? `${line.times}× ` : ''}${line.first}`)
      }
    }
    const seenPlans = new Set()
    for (const fp of ts.failedPlans ?? []) {
      if (seenPlans.has(fp.at)) continue
      seenPlans.add(fp.at)
      console.log(`  planned at ${fp.at} [v${fp.build}] then failed — plan ${fp.plan}`)
      for (const line of fp.lines.slice(0, 20)) {
        console.log(`    ${line.times > 1 ? `${line.times}× ` : ''}${line.first}`)
      }
    }
    for (const sp of ts.stalledPlans ?? []) {
      if (seenPlans.has(sp.at)) continue
      seenPlans.add(sp.at)
      const tail = sp.waitedMs != null ? `still waiting ${sp.waitedMs}ms later when the upload ended` : 'superseded by a new plan'
      console.log(`  planned at ${sp.at} [v${sp.build}] never sent nor failed — ${tail} · plan ${sp.plan}`)
      for (const line of sp.lines.slice(0, 25)) {
        console.log(`    ${line.times > 1 ? `${line.times}× ` : ''}${line.first}`)
      }
    }
  }

  if (latest.chainIngest?.length) {
    console.log('\nChain ingest & recovery (code-counted):')
    for (const { line, count } of latest.chainIngest.slice(0, 12)) console.log(`  ${count}× ${line}`)
  }

  const holdings = latest.holdings
  if (holdings && (holdings.tokens.reads || holdings.tokens.deferred || holdings.items.kept || holdings.items.deferred || holdings.reconcile?.open.length || holdings.reconcile?.filed['left-basket'] || holdings.reconcile?.filed['off-chain-index'] || holdings.reconcile?.filed.unstored || holdings.reconcile?.filed['failed-send'])) {
    const tk = holdings.tokens
    const it = holdings.items
    const rc = holdings.reconcile
    console.log('\nHoldings vs basket (code-counted):')
    console.log(
      `  tokens: ${tk.reads} read(s), ${tk.readsShowingMore} showing more than live · ${tk.leftBasket} tip(s) left the basket · deferred ${tk.deferred} · busy mid-read ${tk.busyMidRead} · timed out ${tk.timedOut}`,
    )
    if (tk.last) console.log(`    last read ${tk.last.at}: live ${tk.last.live} token(s) / ${tk.last.tips} tip(s), showing ${tk.last.showing}${tk.last.unstored ? ` · ${tk.last.unstored} unstored` : ''}`)
    console.log(
      `  items: kept-while-short ${it.kept} · retired ${it.retired} · deferred ${it.deferred} · busy mid-read ${it.busyMidRead} · idle relists ${it.idleRelists} · failed ${it.failed}`,
    )
    if (it.last) console.log(`    last short read ${it.last.at}: cached ${it.last.cached}, basket listed ${it.last.listed}`)
    if (rc) {
      const closed = Object.entries(rc.closed).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'
      const kept = Object.entries(rc.kept).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'
      console.log(
        `  reconcile: filed left-basket ${rc.filed['left-basket']}, off-chain-index ${rc.filed['off-chain-index']}, unstored ${rc.filed.unstored ?? 0}, failed-send ${rc.filed['failed-send'] ?? 0} · closed ${closed} · retired spent ${rc.retiredSpent} · restored ${rc.restored} (refused, reserved ${rc.restoreRefused}) · claims ${rc.claims} (nothing ${rc.claimedNothing}, skipped ${rc.claimSkipped}, spent ${rc.claimSpent}, failed ${rc.claimFailed}) · claims started ${rc.claimsStarted} · kept ${kept}`,
      )
      const notRestored = Object.entries(rc.notRestored).map(([k, n]) => `${k} ${n}`).join(', ')
      if (notRestored || rc.claimRestored > 0) {
        console.log(`    not restored: ${notRestored || 'none'} · restored after claim ${rc.claimRestored}`)
      }
      if (rc.claimsUnfinished.length > 0) {
        const ages = rc.claimsUnfinished.map((c) => c.queuedSecondsBeforeEnd)
        console.log(
          `    claims with no outcome by the end of the upload: ${rc.claimsUnfinished.length} · queued ${Math.min(...ages)}–${Math.max(...ages)}s before the last line`,
        )
      }
      for (const o of rc.open.slice(0, 12)) {
        console.log(`    open ${o.asset} ${o.outpoint} — ${o.gap ?? 'filed earlier'}, last ${o.last} at ${o.at}`)
      }
      const trailed = rc.open.filter((o) => o.asset === 'token' && o.trail?.length).slice(0, 3)
      for (const o of trailed) {
        console.log(`    trail of ${o.outpoint.slice(0, 12)}…:`)
        for (const l of o.trail.slice(0, 14)) console.log(`      ${l.times > 1 ? `${l.times}× ` : ''}${l.first}`)
      }
    }
  }

  const switches = latest.accountSwitches
  if (switches && (switches.switches || switches.prewarms)) {
    console.log('\nAccount switches (code-counted):')
    console.log(
      `  ${switches.switches} switch(es): ${switches.warm} warm (slowest ${switches.slowestWarmMs}ms) · ${switches.cold} cold (slowest ${switches.slowestColdMs}ms) · ingest drain ≤ ${switches.slowestDrainMs}ms`,
    )
    if (switches.prewarms) {
      console.log(`  ${switches.prewarms} account(s) prewarmed, slowest ${switches.slowestPrewarmMs}ms`)
    }
  }

  const imp = latest.legacyImport
  if (imp?.steps?.length) {
    console.log('\nSettings → Import (code-counted, in order):')
    for (const step of imp.steps) {
      const { at, step: name, ...rest } = step
      const fields = Object.entries(rest)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      console.log(`  ${at.slice(11, 19)} ${name}${fields ? ` ${fields}` : ''}`)
    }
    const bg = imp.background
    if (bg?.periods?.length) {
      console.log(
        `  hidden ${Math.round(bg.hiddenMs / 1000)}s total, longest heartbeat gap while hidden ${Math.round(bg.longestHiddenGapMs / 1000)}s (30s = timers ran normally)`,
      )
    }
  }

  const idCards = latest.identityCards
  const idCardPeers = Object.entries(idCards?.peers ?? {})
  if (idCardPeers.length || idCards?.failures?.length || idCards?.oversized) {
    console.log('\nIdentity cards (code-counted, per peer key):')
    for (const [key, p] of idCardPeers) {
      const counts = [
        p.sent && `sent ${p.sent}`,
        p.undelivered && `undelivered ${p.undelivered}`,
        p.asked && `asked ${p.asked}`,
        p.askFailed && `ask failed ${p.askFailed}`,
        p.askedNoIdentity && `asked with no identity to give ${p.askedNoIdentity}`,
        p.ignored && `ignored as not a contact ${p.ignored}`,
        p.kept && `kept ${p.kept}`,
        p.refused.length && `refused (${p.refused.join('; ')})`,
      ].filter(Boolean)
      console.log(`  ${key}… ${counts.join(' · ')} — last: ${p.last?.step ?? 'none'}`)
    }
    if (idCards.oversized) console.log(`  ${idCards.oversized} card(s) over the messagebox limit`)
    for (const f of idCards.failures) console.log(`  ${f.step} failed: ${f.error}`)
  }

  const dead = latest.deadCoins
  const peer = dead?.peerDevice
  const peerActive = peer && (peer.reads || peer.unread || peer.spent)
  if (
    dead &&
    (dead.resigns ||
      dead.sweeps.length ||
      Object.keys(dead.spenders ?? {}).length ||
      peerActive ||
      dead.deadFound?.coins)
  ) {
    console.log('\nDead coins (code-counted):')
    console.log(`  ${dead.resigns} resign(s) over coins a dead or foreign spend held`)
    if (dead.deadFound?.coins) {
      console.log(
        `  found spent elsewhere: ${dead.deadFound.coins} coin(s), ${dead.deadFound.sightings} sighting(s)`,
      )
      for (const r of dead.deadFound.reselected) {
        console.log(`    chosen again after hide: ${r.outpoint} ×${r.times}`)
        for (const m of r.mentions ?? []) {
          console.log(`      ${String(m.count).padStart(4)}× ${m.family}`)
        }
      }
    }
    if (peerActive) {
      console.log(
        `  another install: ${peer.reads} snapshot read(s) · ${peer.spent} coin(s) it spent · ${peer.withdrawn} withdrawn · ${peer.unread} unread · slowest ${peer.slowestMs}ms`,
      )
    }
    for (const s of dead.sweeps) {
      console.log(
        `  sweep checked ${s.checked} · hidden ${s.hidden} · unknown ${s.unknown} · ${s.ms}ms`,
      )
    }
    const adopted = Object.entries(dead.spenders ?? {})
    if (adopted.length) {
      console.log(`  spenders adopted: ${adopted.map(([k, n]) => `${k} ${n}`).join(' · ')}`)
    }
  }

  const der = latest.derivations
  const lp = der?.legacyProof
  if (
    der &&
    (der.replaces || der.echoes.length || der.recoveries.length || der.noEcho.length ||
      der.derivedScripts || lp.proof || lp.parents || lp.tipFail)
  ) {
    console.log('\nChange derivations (code-counted):')
    if (lp.timing) {
      console.log(
        `  source-tx reads: ${lp.timing.reads} · p50 ${lp.timing.p50}ms · p90 ${lp.timing.p90}ms · max ${lp.timing.max}ms · total ${lp.timing.totalMs}ms`,
      )
    }
    if (der.replaces) console.log(`  ${der.replaces} history replace(s) — local toolbox wiped`)
    for (const echo of der.echoes) {
      console.log(`  echoed ${echo.added} new of ${echo.rows} row(s)${echo.ms != null ? ` · ${echo.ms}ms` : ''}`)
    }
    for (const r of der.recoveries) {
      console.log(
        `  recovery checked ${r.checked} · live ${r.live} (${r.sats} sats) · imported ${r.imported} · failed ${r.failed} · spent ${r.spent} · unknown ${r.unknown} · ${r.ms}ms`,
      )
    }
    if (der.noEcho.length) {
      const outs = der.noEcho.reduce((a, row) => a + row.outputs, 0)
      console.log(`  ${outs} live output(s) in ${der.noEcho.length} tx(s) with no derivation anywhere`)
    }
    if (der.derivedScripts) console.log(`  ${der.derivedScripts} locking script(s) rebuilt from BRC-29 keys`)
    if (lp.proof || lp.parents || lp.tipFail) {
      console.log(`  legacy deposits: ${lp.proof} own proof · ${lp.parents} via parents · ${lp.tipFail} unprovable`)
    }
  }

  const cj = der?.journal
  const cjb = cj?.backup
  const writeAhead = Object.entries(cj?.writeAheadFailures ?? {})
  if (cj && (cj.sweeps || cj.refusedWrites || cj.noRecipe || writeAhead.length || cjb.syncs || cjb.failures.length)) {
    console.log('\nCustody journal (code-counted):')
    if (cj.sweeps) console.log(`  ${cj.sweeps} sweep(s) captured ${cj.captured} new recipe(s), slowest ${cj.slowestSweepMs}ms`)
    if (cj.refusedWrites) {
      console.log(`  ${cj.refusedWrites} write(s) refused by the store — up to ${cj.heldInMemory} entr(ies) held in memory only`)
    }
    if (writeAhead.length) {
      console.log(`  write-ahead failures: ${writeAhead.map(([step, n]) => `${step} ${n}`).join(', ')} (sweep catches them)`)
    }
    if (cj.noRecipe) console.log(`  ${cj.noRecipe} live outpoint(s) with no recipe anywhere`)
    if (cjb.syncs || cjb.failures.length) {
      console.log(
        `  backup: ${cjb.syncs} sync(s) · ${cjb.pushes} push(es) · pulled ${cjb.pulled} · ${cjb.failures.length} failure(s)` +
          `${cjb.unreadable ? ` · ${cjb.unreadable} unreadable remote(s) replaced` : ''}` +
          `${cjb.lastEntries != null ? ` · last ${cjb.lastEntries} entries root ${cjb.lastRoot}` : ''}`,
      )
      for (const f of cjb.failures.slice(-3)) console.log(`    ${f.reason}: ${f.error}`)
    }
  }

  const fin = latest.incomingFinality
  if (fin && (fin.nonFinal || fin.finalityUnknown)) {
    console.log('\nIncoming finality (code-counted):')
    console.log(
      `  ${fin.nonFinal} non-final package(s) refused · ${fin.finalityUnknown} with no chain height${fin.txids.length ? ` · ${fin.txids.join(', ')}` : ''}`,
    )
  }

  const outcomes = latest.listingOutcomes
  if (
    outcomes &&
    (outcomes.publishFailed.length ||
      outcomes.neverSent?.length ||
      Object.keys(outcomes.cancelRefused).length ||
      outcomes.pins.hit ||
      outcomes.pins.noLocalRow ||
      outcomes.pins.unreadable)
  ) {
    console.log('\nListings and pins (code-counted):')
    for (const f of outcomes.publishFailed) {
      console.log(`  publish failed ${f.txid} — ${f.reason}`)
    }
    if (outcomes.publishFailed.length) {
      console.log(
        `  ${outcomes.republished} republished · still unpublished: ${outcomes.stillUnpublished.join(', ') || 'none'}`,
      )
    }
    if (outcomes.neverSent?.length) {
      console.log(`  never reached a miner (retired, item kept): ${outcomes.neverSent.join(', ')}`)
    }
    for (const [code, n] of Object.entries(outcomes.cancelRefused)) {
      console.log(`  cancel refused ${code} ×${n}`)
    }
    if (outcomes.cancelProvenBySignedListing) {
      console.log(`  ${outcomes.cancelProvenBySignedListing} cancel(s) proven by the signed listing`)
    }
    const p = outcomes.pins
    console.log(
      `  Arcade pins: ${p.hit} found the local row · ${p.noLocalRow} found none · ${p.unreadable} unreadable${
        p.storageUserMoved.length ? ` · storage user moved ${p.storageUserMoved.join(', ')}` : ''
      }`,
    )
  }

  const notify = latest.notifications
  if (notify && (notify.hiddenValueActions || notify.posted || notify.bridgeDeliversParked)) {
    console.log('\nNotifications (code-counted):')
    console.log(
      `  ${notify.posted} posted · ${notify.hiddenValueActions} hidden value action(s) · ${notify.hiddenValueActionsWithoutNotification} with no notification`,
    )
    if (notify.onScreenSkipsThenHidden || notify.postedWithinGrace) {
      console.log(
        `  ${notify.onScreenSkipsThenHidden} on-screen skip(s) followed by a hide within 3s · ${notify.postedWithinGrace} posted inside the leave grace`,
      )
    }
    if (notify.bridgeDeliversParked) {
      console.log(
        `  ${notify.bridgeDeliversParked} bridge request(s) parked ≥5s before reaching the WebView (${notify.bridgeDeliversParkedUntilResume} released only on resume · worst ${notify.parkedWorstMs}ms)`,
      )
    }
    for (const [k, n] of Object.entries(notify.skipped)) console.log(`  skipped ${k} ×${n}`)
    for (const [k, n] of Object.entries(notify.failed)) console.log(`  failed ${k} ×${n}`)
    for (const s of notify.silentExamples) console.log(`  silent ${s.method} at ${s.at}`)
    if (answers.missing_notifications) {
      choiceBlock('Missing notifications', answers.missing_notifications)
    }
  }

  const nft = latest.nftImport
  if (
    nft &&
    (nft.tipsQueued || nft.collectablesImported || nft.tokensImported || nft.timedSpans.length || nft.partialChunks || nft.phraseSweepFailures)
  ) {
    console.log('\nNFT import (code-counted):')
    console.log(
      `  ${nft.importRuns} chunked run(s), ${nft.tipsQueued} tip(s) queued` +
        (nft.chunkSize ? ` in chunks of ${nft.chunkSize}` : '') +
        ` · imported ${nft.collectablesImported} collectable(s), ${nft.tokensImported} token(s)`,
    )
    console.log(
      `  partial chunks ${nft.partialChunks} · phrase-sweep failures ${nft.phraseSweepFailures} · unrecognized one-sats held ${nft.heldUnrecognized} (reported ${nft.heldUnrecognizedLines}×)`,
    )
    for (const s of nft.timedSpans) {
      console.log(`  ${s.label.padEnd(22)} ${s.runs} run(s), total ${s.totalMs}ms, longest ${s.longestMs}ms`)
    }
    if (answers.nft_import_speedup) choiceBlock('NFT import speed', answers.nft_import_speedup)
  }

  const migrateFrom = latest.legacyImport?.migrate ? ['latest', latest] : state.previous?.legacyImport?.migrate ? ['previous', state.previous] : null
  if (migrateFrom) {
    const [label, session] = migrateFrom
    const mg = session.legacyImport.migrate
    const ps = mg.phaseShare
    console.log(`\nItem migrate (code-counted, ${label} upload v${session.version}):`)
    console.log(
      `  ${mg.bundles} bundle(s), ${mg.tips} tip(s), ${mg.tipsPerBundle}/bundle · ${mg.tipsPerMinute} tips/min over ${Math.round(mg.totalMs / 1000)}s`,
    )
    console.log(
      `  time: create ${Math.round(ps.create * 100)}% · sign ${Math.round(ps.sign * 100)}% · pack ${Math.round(ps.pack * 100)}% · post ${Math.round(ps.post * 100)}%`,
    )
    for (const [vis, v] of Object.entries(mg.byVisibility)) {
      console.log(`  ${vis.padEnd(8)} ${v.bundles} bundle(s), ${v.tips} tip(s), ${v.msPerTip ?? '—'}ms/tip`)
    }
    console.log(
      `  package ${Math.round(mg.packageBytes / 1024)}KB total, largest ${Math.round(mg.largestPackageBytes / 1024)}KB` +
        (mg.postedEfBytes != null ? ` · posted EF ${Math.round(mg.postedEfBytes / 1024)}KB` : '') +
        (mg.largestInputBeefBytes != null ? ` · largest input BEEF ${Math.round(mg.largestInputBeefBytes / 1024)}KB` : ''),
    )
    if (answers.migrate_bottleneck) choiceBlock('Migrate bottleneck', answers.migrate_bottleneck)
  }

  const br = latest.bridge
  if (br && br.requests > 0) {
    console.log('\nBRC-100 bridge (electron main, code-counted):')
    console.log(
      `  ${br.requests} request(s) over ${br.windowSeconds}s · unanswered ${br.unanswered} · renderer not ready ${br.rendererNotReady}`,
    )
    for (const m of br.methods.slice(0, 8)) {
      console.log(
        `  ${m.method.padEnd(26)} ${String(m.requests).padStart(5)} req · p50 ${m.p50ms}ms · p95 ${m.p95ms}ms · max ${m.maxMs}ms · errors ${m.errors}`,
      )
    }
    if (br.errorCodes.length) {
      console.log(`  errors: ${br.errorCodes.map((c) => `${c.code}×${c.count}`).join('  ')}`)
    }
    for (const p of br.otherProblems.slice(0, 4)) {
      console.log(`  ${String(p.occurrences).padStart(4)}× [${p.level}] ${p.message}`)
    }
    if (answers.bridge_health) choiceBlock('Bridge health', answers.bridge_health)
  }

  if (latest.repeatingProblems.length) {
    console.log('\nRepeating problems (code-counted, not model-guessed):')
    for (const p of latest.repeatingProblems.slice(0, 8)) {
      const near = p.shareOfUnattributedFreezesNearby
        ? ` · near ${(p.shareOfUnattributedFreezesNearby * 100).toFixed(0)}% of unexplained freezes`
        : ''
      console.log(`  ${String(p.occurrences).padStart(4)}× [${p.level}] ${p.message}${near}`)
    }
  }
  console.log()
}

/* -------------------------------------------------------------------- cli */

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const fileIdx = args.indexOf('--file')
const filePath = fileIdx >= 0 ? args[fileIdx + 1] : null
const traceIdx = args.indexOf('--trace')
const tracePrefix = traceIdx >= 0 ? args[traceIdx + 1] : null
const positional = args.filter(
  (a, i) =>
    !a.startsWith('--') &&
    (fileIdx < 0 || i !== fileIdx + 1) &&
    (traceIdx < 0 || i !== traceIdx + 1),
)
const bucketArg = positional[0] ?? 'android'

if (tracePrefix && flags.has('--all') && !filePath && bucketArg !== 'desktop-local') {
  const uploads = splitUploads(await fetchLogs(KNOWN_BUCKETS[bucketArg] ?? bucketArg, true))
  const sessions = uploads.map((u) => {
    const s = parseSession(u)
    const from = s.events[0] ? new Date(s.events[0].at).toISOString() : null
    return { version: s.version, from, events: traceTxid(s, tracePrefix), beforeLeftBasket: beforeLeftBasket(s, tracePrefix) }
  })
  console.log(JSON.stringify(sessions, null, 2))
  process.exit(0)
}

if (flags.has('--history') && !filePath && bucketArg !== 'desktop-local') {
  // A snapshot can predate sends by hours, so one window rarely holds both
  // the replace and the pin that later missed; read every upload kept.
  const uploads = splitUploads(await fetchLogs(KNOWN_BUCKETS[bucketArg] ?? bucketArg, true))
  const sessions = uploads.map((u) => {
    const s = parseSession(u)
    return {
      version: s.version,
      from: s.events[0] ? new Date(s.events[0].at).toISOString() : null,
      to: s.events.at(-1) ? new Date(s.events.at(-1).at).toISOString() : null,
      historyReplica: s.historyReplica,
    }
  })
  console.log(JSON.stringify(sessions, null, 2))
  process.exit(0)
}

let latest
let previous = null
if (filePath) {
  // A saved upload body (or `/all` dump) on disk.
  const uploads = splitUploads(fs.readFileSync(filePath, 'utf8'))
  latest = parseSession(uploads[0])
  previous = uploads[1] ? parseSession(uploads[1]) : null
} else if (bucketArg === 'desktop-local') {
  const paths = desktopLocalPaths()
  const current = readDurableRing(paths.prefs, RING_CURRENT_KEY)
  if (current.length === 0) {
    throw new Error(`no renderer ring at ${paths.prefs} — is HandCash Desktop installed on this machine?`)
  }
  latest = ringSession(current, 'local-ring')
  const before = readDurableRing(paths.prefs, RING_PREVIOUS_KEY)
  previous = before.length ? ringSession(before, 'local-ring-previous') : null
  if (fs.existsSync(paths.mainLog)) {
    latest.bridge = bridgeFacts(parseElectronLog(fs.readFileSync(paths.mainLog, 'utf8')))
  }
  latest.ledger = ledgerFacts(paths.prefs)
} else {
  const bucket = KNOWN_BUCKETS[bucketArg] ?? bucketArg
  // `/all` is what makes "is this new?" answerable, so compare by default.
  const uploads = splitUploads(await fetchLogs(bucket, true))
  latest = parseSession(uploads[0])
  previous = uploads[1] ? parseSession(uploads[1]) : null
}
const state = previous ? { latest, previous } : { latest }

if (tracePrefix) {
  console.log(JSON.stringify({ latest: traceTxid(latest, tracePrefix), previous: previous ? traceTxid(previous, tracePrefix) : [] }, null, 2))
  process.exit(0)
}

if (flags.has('--state')) {
  console.log(JSON.stringify(state, null, 2))
  process.exit(0)
}

const { answers, usage } = await askJev(state, jevApiKey())

if (flags.has('--json')) {
  console.log(JSON.stringify({ state, answers, usage }, null, 2))
} else {
  report(state, answers)
  console.log(`jev-latest · ${usage.input_tokens} in / ${usage.output_tokens} out tokens\n`)
}
