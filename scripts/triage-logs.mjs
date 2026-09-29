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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LOG_BASE = 'https://brc-cloud.bcryderman.workers.dev/v1/logs'
const KNOWN_BUCKETS = {
  phone: 'hc-2c00efc3249a742845a7',
  android: 'hc-a580a83ef98f5463f546',
  desktop: 'hc-ad7afbfaae0d01fffcb3',
}
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'

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

/** A ring row becomes one upload-format event; multi-line messages stay one event. */
function ringEvents(rows) {
  return rows.map((r) => ({
    at: r.at,
    level: String(r.level ?? 'info'),
    text: r.message.replace(/\s*\n\s*/g, ' ⏎ ').trim(),
  }))
}

/** electron-log main process lines: `[2026-08-29 10:55:55.497] [info]  message`. */
const ELECTRON_LINE = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\] \[(\w+)\]\s+(.*)$/

function parseElectronLog(text) {
  const events = []
  for (const raw of text.split('\n')) {
    const m = ELECTRON_LINE.exec(raw.trim())
    if (m) events.push({ at: Date.parse(m[1]), level: m[2], text: m[3] })
  }
  return events
}

/* ---------------------------------------------------------------- parsing */

const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\[(\w+)\]\s+(.*)$/

/** Collapse ids, hashes, sizes and timings so repeats group into one family. */
function family(message) {
  return message
    .replace(/\b[0-9a-f]{12,64}\b/gi, '<id>')
    .replace(/\btrace-[0-9a-f-]+/gi, '<trace>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/\b\d+(\.\d+)?(ms|s|MB|KB|sats?)\b/gi, '<qty>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

function parseSession(text) {
  const header = {}
  for (const m of text.matchAll(/^# (version|uploaded|reason|platform) (.+)$/gm)) {
    header[m[1]] ??= m[2].trim()
  }
  const versionLine = text.match(/^# version (\S+) · platform (\S+)/m)
  if (versionLine) {
    header.version = versionLine[1]
    header.platform = versionLine[2]
  }

  const events = []
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trim())
    if (m) events.push({ at: Date.parse(m[1]), level: m[2], text: m[3] })
  }
  return sessionFacts(header, events)
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

function sessionFacts(header, events) {
  const stalls = []
  const longtasks = []
  const navs = []
  for (const e of events) {
    let m = /^\[stall\] main thread blocked (\d+)ms · (.+)$/.exec(e.text)
    if (m) {
      stalls.push({ at: e.at, ms: Number(m[1]), during: m[2].trim() })
      continue
    }
    m = /^\[longtask\] (\d+)ms/.exec(e.text)
    if (m) longtasks.push({ at: e.at, ms: Number(m[1]) })
    m = /^\[nav\] (.+)$/.exec(e.text)
    if (m) navs.push({ at: e.at, to: m[1].trim() })
  }

  const byFamily = new Map()
  for (const e of events) {
    if (e.level !== 'warn' && e.level !== 'error') continue
    // The freeze reports themselves are already counted in `freezes`. Leaving
    // them here would correlate every freeze with itself and hand the model a
    // tautology instead of a cause.
    if (/^\[(stall|longtask)\]/.test(e.text)) continue
    const key = family(e.text)
    const cur = byFamily.get(key) ?? { family: key, level: e.level, count: 0, at: [] }
    cur.count += 1
    if (cur.at.length < 40) cur.at.push(e.at)
    if (e.level === 'error') cur.level = 'error'
    byFamily.set(key, cur)
  }

  // Which repeating warning best explains the freezes? Pure arithmetic: share
  // of stalls within 3s of an occurrence of that family. Reported separately
  // for freezes recorded with no wallet layer active, because those are the
  // ones `byActiveLayer` cannot already account for.
  const WINDOW_MS = 3_000
  const idle = stalls.filter((s) => /idle/i.test(s.during))
  const share = (f, set) =>
    set.length
      ? Number(
          (
            set.filter((s) => f.at.some((t) => Math.abs(t - s.at) <= WINDOW_MS))
              .length / set.length
          ).toFixed(2),
        )
      : 0
  const repeats = [...byFamily.values()].filter((f) => f.count >= 3)
  for (const f of repeats) {
    f.stallShare = share(f, stalls)
    f.idleStallShare = share(f, idle)
  }

  const stallClasses = {}
  for (const s of stalls) {
    const c = (stallClasses[s.during] ??= { count: 0, worstMs: 0, totalMs: 0 })
    c.count += 1
    c.totalMs += s.ms
    c.worstMs = Math.max(c.worstMs, s.ms)
  }

  const blockedMsTotal = stalls.reduce((a, s) => a + s.ms, 0)
  const workloads = workloadOverlap(events, stalls, blockedMsTotal)
  const precedingLines = stallTriggers(events, stalls, blockedMsTotal)
  const storage = storagePressure(events)
  const bursts = stallBursts(events, stalls, workloads.spans)
  const custody = custodyFacts(events)
  const activity = activityFacts(events)
  const ui = uiFacts(events)
  const nftImport = nftImportFacts(events)
  const tokenDeposits = tokenDepositFacts(events)

  const span =
    events.length > 0
      ? Math.round((events.at(-1).at - events[0].at) / 1000)
      : 0

  return {
    version: header.version ?? 'unknown',
    platform: header.platform ?? 'unknown',
    uploadReason: (header.reason ?? 'unknown').split('·')[0].trim(),
    windowSeconds: span,
    lineCount: events.length,
    freezes: {
      total: stalls.length,
      worstMs: stalls.reduce((a, s) => Math.max(a, s.ms), 0),
      blockedMsTotal,
      byActiveLayer: stallClasses,
      longtaskCount: longtasks.length,
    },
    // "layers idle" means nothing the wallet coordinator names was running.
    idleFreezes: stalls.filter((s) => /idle/i.test(s.during)).length,
    // Timed work whose span overlapped blocked time. Spans from different
    // workloads can overlap each other, so shares may sum above 1.
    workloads: workloads.rows,
    // The last line logged before each freeze began. Lines *after* a freeze
    // are callbacks that were queued behind it, so only the preceding line
    // can name what was running when the thread stopped.
    precedingLines,
    // Freezes within 3s of each other, with everything that overlapped them.
    bursts,
    storage,
    // Signed transactions the miner refused, what they were chained on, and
    // what the UTXO heal did about coins the chain says are spent by a tx
    // this wallet does not hold.
    custody,
    // Activity rows: what was written, which pending rows outlived their
    // send, and whether the expiry sweep saw them and left them anyway.
    activity,
    // React list-key collisions: which key, which component's list.
    ui,
    // 1sat / collectable import: how many tips, what failed, which timed spans
    // sat next to it. Empty means this window did not import.
    nftImport,
    // Token deposits that ingest kept pending, refused, or failed to internalize.
    tokenDeposits,
    screensVisited: [...new Set(navs.map((n) => n.to))].slice(0, 15),
    repeatingProblems: repeats
      .sort((a, b) => b.count - a.count)
      .slice(0, 14)
      .map((f) => ({
        level: f.level,
        occurrences: f.count,
        shareOfFreezesNearby: f.stallShare,
        shareOfUnattributedFreezesNearby: f.idleStallShare,
        message: f.family,
      })),
  }
}

/* ------------------------------------------------------- freeze forensics */

const FREEZE_LINE_RE = /^\[(stall|longtask)\]/
const TAG_RE = /^\[([\w-]+)[^\]]*\]\s*(.*)$/
/**
 * `listOutputs done 19570ms`, `listOutputs done (ownership) 31ms`, or
 * `[brc29-ingest …] +1781ms beef`.
 */
const DURATION_RE =
  /(?:(\S+)\s+)?(?:done|finished|completed?)(?:\s+\([^)]*\))?\s+(\d+)ms|\+(\d+)ms/i

const overlapMs = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
const stallStart = (s) => s.at - s.ms
/**
 * A span longer than this was waiting, not working: the WebView was hidden
 * (timers do not fire in the background) or the call sat behind a storage
 * lock. Counting every freeze that happened meanwhile against it would name
 * the wrong owner — a 439s `local-lookup` once absorbed 22 unrelated freezes.
 */
const WAIT_SPAN_MS = 60_000

/**
 * Turn every "took N ms" line into a span and measure how much blocked time
 * fell inside spans of each workload. A log line cannot be written while the
 * thread is blocked, so a span that *contains* a freeze was running across it.
 */
function workloadOverlap(events, stalls, blockedMsTotal) {
  const spans = []
  const waits = []
  for (const e of events) {
    const tag = TAG_RE.exec(e.text)
    if (!tag) continue
    const d = DURATION_RE.exec(tag[2])
    if (!d) continue
    const ms = Number(d[2] ?? d[3])
    if (!Number.isFinite(ms) || ms <= 0) continue
    const verb = d[2] != null && d[1] && !/^\W/.test(d[1]) ? ` ${d[1]}` : ''
    const span = { label: `${tag[1]}${verb}`, start: e.at - ms, end: e.at, ms }
    if (ms > WAIT_SPAN_MS) waits.push(span)
    else spans.push(span)
  }

  const byLabel = new Map()
  const rowFor = (label) => {
    const row =
      byLabel.get(label) ??
      {
        label,
        spans: 0,
        waits: 0,
        longestMs: 0,
        longestWaitMs: 0,
        blockedMsInside: 0,
        freezes: new Set(),
        all: [],
      }
    byLabel.set(label, row)
    return row
  }
  for (const sp of spans) {
    const row = rowFor(sp.label)
    row.spans += 1
    row.longestMs = Math.max(row.longestMs, sp.ms)
    row.all.push(sp)
  }
  for (const sp of waits) {
    const row = rowFor(sp.label)
    row.waits += 1
    row.longestWaitMs = Math.max(row.longestWaitMs, sp.ms)
  }
  // Concurrent runs of the same workload (a deferred read finishing beside a
  // live one) would count the same blocked millisecond twice; union them so a
  // label's share is at most 1.
  for (const row of byLabel.values()) {
    const merged = []
    for (const sp of row.all.sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1)
      if (last && sp.start <= last.end) last.end = Math.max(last.end, sp.end)
      else merged.push({ start: sp.start, end: sp.end })
    }
    for (const iv of merged) {
      for (const s of stalls) {
        const o = overlapMs(iv.start, iv.end, stallStart(s), s.at)
        if (o > 0) {
          row.blockedMsInside += o
          row.freezes.add(s.at)
        }
      }
    }
  }

  const rows = [...byLabel.values()]
    .filter((r) => r.blockedMsInside > 0)
    .sort((a, b) => b.blockedMsInside - a.blockedMsInside)
    .slice(0, 8)
    .map((r) => ({
      workload: r.label,
      runs: r.spans,
      longestRunMs: r.longestMs,
      ...(r.waits
        ? { waitsExcluded: r.waits, longestWaitMs: r.longestWaitMs }
        : {}),
      freezesInside: r.freezes.size,
      blockedMsInside: Math.round(r.blockedMsInside),
      shareOfBlockedTime: blockedMsTotal
        ? Number((r.blockedMsInside / blockedMsTotal).toFixed(2))
        : 0,
    }))
  return { rows, spans }
}

/** Family of the last line before each freeze started, grouped. */
function stallTriggers(events, stalls, blockedMsTotal) {
  const LOOKBACK_MS = 5_000
  const candidates = events.filter((e) => !FREEZE_LINE_RE.test(e.text))
  const byFamily = new Map()
  for (const s of stalls) {
    const start = stallStart(s)
    let last = null
    for (const e of candidates) {
      if (e.at >= start) break
      if (e.at >= start - LOOKBACK_MS) last = e
    }
    if (!last) continue
    const key = family(last.text)
    const row = byFamily.get(key) ?? { message: key, freezes: 0, blockedMs: 0 }
    row.freezes += 1
    row.blockedMs += s.ms
    byFamily.set(key, row)
  }
  return [...byFamily.values()]
    .sort((a, b) => b.blockedMs - a.blockedMs)
    .slice(0, 8)
    .map((r) => ({
      ...r,
      shareOfBlockedTime: blockedMsTotal ? Number((r.blockedMs / blockedMsTotal).toFixed(2)) : 0,
    }))
}

/**
 * Origin-storage quota facts. A refused write means the WebView's ~5MB store
 * is full; the report line names what is holding it. Slow-store lines are the
 * per-operation cost the storage layer measured itself.
 */
function storagePressure(events) {
  const REFUSED_RE =
    /^\[storage\] durable write refused for (\S+)(?: \((\d+)KB\) — (\d+)KB held across (\d+) keys · largest: (.*))?$/
  const SLOW_RE = /^\[storage\] slow (\S+) (\d+)ms · (\S+) \((\d+)KB\)/
  const RECLAIM_RE = /^\[storage\] reclaimed (\d+)KB/
  const shortKey = (k) => k.split(':wallet:')[0]

  const out = {
    refusedWrites: 0,
    refusedKeys: [],
    heldKB: null,
    keyCount: null,
    largestKeys: [],
    slowOps: 0,
    worstSlowOp: null,
    reclaimedKB: 0,
  }
  const refusedKeys = new Set()
  for (const e of events) {
    let m = REFUSED_RE.exec(e.text)
    if (m) {
      out.refusedWrites += 1
      refusedKeys.add(shortKey(m[1]))
      if (m[3]) {
        out.heldKB = Number(m[3])
        out.keyCount = Number(m[4])
        out.largestKeys = (m[5] ?? '')
          .split(/\s+/)
          .map((tok) => /^(.+)=(\d+)KB$/.exec(tok))
          .filter(Boolean)
          .map((t) => ({ key: shortKey(t[1]), kb: Number(t[2]) }))
      }
      continue
    }
    m = SLOW_RE.exec(e.text)
    if (m) {
      out.slowOps += 1
      const ms = Number(m[2])
      if (!out.worstSlowOp || ms > out.worstSlowOp.ms) {
        out.worstSlowOp = { op: m[1], ms, key: shortKey(m[3]), kb: Number(m[4]) }
      }
      continue
    }
    m = RECLAIM_RE.exec(e.text)
    if (m) out.reclaimedKB += Number(m[1])
  }
  out.refusedKeys = [...refusedKeys].slice(0, 6)
  return out
}

/** Cluster freezes closer than 3s and describe each cluster's surroundings. */
function stallBursts(events, stalls, spans) {
  const GAP_MS = 3_000
  const launches = events.filter((e) => /^App log capture started/.test(e.text)).map((e) => e.at)
  const sorted = [...stalls].sort((a, b) => stallStart(a) - stallStart(b))
  const clusters = []
  for (const s of sorted) {
    const cur = clusters.at(-1)
    if (cur && stallStart(s) - cur.end <= GAP_MS) {
      cur.end = Math.max(cur.end, s.at)
      cur.stalls.push(s)
    } else {
      clusters.push({ start: stallStart(s), end: s.at, stalls: [s] })
    }
  }
  const nonFreeze = events.filter((e) => !FREEZE_LINE_RE.test(e.text))
  return clusters
    .map((c) => {
      const launch = launches.filter((t) => t <= c.start).at(-1)
      const before = nonFreeze.filter((e) => e.at < c.start).at(-1)
      const overlapping = new Map()
      for (const sp of spans) {
        const o = overlapMs(sp.start, sp.end, c.start, c.end)
        if (o > 0) overlapping.set(sp.label, (overlapping.get(sp.label) ?? 0) + o)
      }
      return {
        secondsAfterLaunch: launch != null ? Math.round((c.start - launch) / 1000) : null,
        durationSeconds: Math.round((c.end - c.start) / 1000),
        freezes: c.stalls.length,
        blockedMs: c.stalls.reduce((a, s) => a + s.ms, 0),
        activeLayers: [...new Set(c.stalls.map((s) => s.during))],
        overlappingWorkloads: [...overlapping.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([label, ms]) => `${label} (${Math.round(ms)}ms overlap)`),
        lineBefore: before ? family(before.text) : null,
      }
    })
    .sort((a, b) => b.blockedMs - a.blockedMs)
    .slice(0, 6)
}

/**
 * `/all` concatenates uploads oldest-first; return them newest-first so
 * `latest` really is the newest session and `previous` is the baseline.
 */
/* ------------------------------------------------------- custody facts */

const ARCADE_REJECT_RE = /^\[arcade\] ([0-9a-f]{12}) rejected — (.*)$/
const ANCESTOR_RE = /ancestor ([0-9a-f]{64}) rejected:?/g
const HEAL_SUMMARY_RE =
  /^\[stale-output\] evidence heal checked=(\d+) spent=(\d+) restored=(\d+) quarantined=(\d+) unknown=(\d+)/
/** `reason` is cut at this length by the wallet; a chain this long loses its root. */
const ARCADE_REASON_CAP = 240

/**
 * Arcade rejections form chains: a child is refused because its parent was.
 * Group them by the root ancestor so the model sees one cause with N
 * dependants instead of N warnings, and surface the root's own reason —
 * the only text that says *why* the chain died.
 */
function custodyFacts(events) {
  const rejected = new Map()
  const roots = new Map()
  const rootReasons = new Map()
  let rejectLines = 0
  let truncatedReasons = 0
  for (const e of events) {
    const m = ARCADE_REJECT_RE.exec(e.text)
    if (!m) continue
    rejectLines += 1
    const reason = m[2].trim()
    const chain = [...reason.matchAll(ANCESTOR_RE)].map((c) => c[1])
    const root = chain.at(-1) ?? null
    const tail = reason.split(/rejected:\s*/).at(-1).trim()
    const truncated = reason.length >= ARCADE_REASON_CAP - 1 && !/[.)]$/.test(tail)
    if (truncated) truncatedReasons += 1
    const rootReason = chain.length === 0 ? reason : truncated ? '<truncated>' : tail
    const row = rejected.get(m[1]) ?? { txid: m[1], lines: 0, ancestorDepth: 0, root, rootReason }
    row.lines += 1
    row.ancestorDepth = Math.max(row.ancestorDepth, chain.length)
    rejected.set(m[1], row)
    if (root) {
      const r = roots.get(root) ?? { rootTxid: root, dependants: new Set(), warnings: 0 }
      r.dependants.add(m[1])
      r.warnings += 1
      roots.set(root, r)
    }
    const key = family(rootReason)
    rootReasons.set(key, (rootReasons.get(key) ?? 0) + 1)
  }

  const heals = []
  const quarantinedOutpoints = new Set()
  for (const e of events) {
    const m = HEAL_SUMMARY_RE.exec(e.text)
    if (!m) continue
    const named = /quarantinedOutpoints=(\S+)/.exec(e.text)?.[1]?.split(',') ?? []
    for (const op of named) quarantinedOutpoints.add(op)
    heals.push({
      at: e.at,
      checked: Number(m[1]),
      spent: Number(m[2]),
      restored: Number(m[3]),
      quarantined: Number(m[4]),
      unknown: Number(m[5]),
    })
  }
  // A quarantined coin whose funding tx the miner refused is not "spent by a
  // stranger": it is an output of a dead chain.
  const refusedPrefixes = new Set([
    ...rejected.keys(),
    ...[...roots.keys()].map((id) => id.slice(0, 12)),
  ])
  const quarantinedFromRefusedTx = [...quarantinedOutpoints].filter((op) =>
    refusedPrefixes.has(op.slice(0, 12)),
  ).length
  const quarantineLines = events.filter((e) => /quarantin/i.test(e.text)).length
  const launches = events.filter((e) => /^App log capture started/.test(e.text)).length

  return {
    launchesInWindow: launches,
    arcadeRejections: {
      warnings: rejectLines,
      distinctTxids: rejected.size,
      // Same txid warned again means the terminal verdict was not remembered.
      // With one launch in the window that is the durable rejection set not
      // being written; across launches it is expected once per launch.
      repeatedTxids: [...rejected.values()].filter((r) => r.lines > 1).length,
      maxAncestorDepth: Math.max(0, ...[...rejected.values()].map((r) => r.ancestorDepth)),
      truncatedReasons,
      roots: [...roots.values()]
        .sort((a, b) => b.dependants.size - a.dependants.size)
        .slice(0, 6)
        .map((r) => ({ rootTxid: r.rootTxid, dependants: r.dependants.size, warnings: r.warnings })),
      rootReasons: [...rootReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([reason, count]) => ({ reason, count })),
    },
    utxoHeal: {
      runs: heals.length,
      last: heals.at(-1) ?? null,
      // "quarantined" = the chain says spent, no local spender: coins that
      // left through a transaction this wallet never saw or signed.
      quarantinedTotal: heals.reduce((a, h) => a + h.quarantined, 0),
      restoredTotal: heals.reduce((a, h) => a + h.restored, 0),
      hiddenSpentTotal: heals.reduce((a, h) => a + h.spent, 0),
      quarantinedOutpoints: [...quarantinedOutpoints].slice(0, 12),
      quarantinedFromRefusedTx,
    },
    quarantineLines,
  }
}

/* ------------------------------------------------------ activity facts */

const ACTIVITY_WRITE_RE =
  /^\[activity\] (new|merged|skipped) (spent|earned)\/([\w-]+) (-?\d+) sat (no-txid|[0-9a-f]{12}…) — (.*)$/
const STUCK_CENSUS_RE = /^\[activity\] (\d+) outbound row\(s\) stuck past 90s — (.+?): (.*)$/
const STUCK_ROW_RE =
  /([\w-]+)\/(-?\d+)sat age=(\d+)s id=(\S+) pending=(\S+)(?: item=(\S+))?/g
const ORPHAN_REMOVED_RE = /^\[activity\] removed orphan approval placeholder id=(\S+) pending=(\S+)/
const WRITE_REFUSED_RE = /^\[activity\] durable write refused/

/**
 * Pending Activity rows that outlive their send. The wallet prints a census of
 * every txid-less pending spend older than 90s (at most once a minute) and a
 * line for each approval placeholder it sweeps. Reading both across time says
 * whether a row is being rewritten fresh, whether the sweep saw it and left
 * it, and whether the store refused the write that would have removed it.
 */
function activityFacts(events) {
  const writes = { new: 0, merged: 0, skipped: 0 }
  const placeholderWrites = new Map()
  let orphanRemovals = 0
  let refusedWrites = 0
  const censuses = []
  const rows = new Map()

  for (const e of events) {
    let m = ACTIVITY_WRITE_RE.exec(e.text)
    if (m) {
      writes[m[1]] += 1
      // A zero-sat, txid-less spend is the "Approving" placeholder.
      if (m[2] === 'spent' && Number(m[4]) <= 0 && m[5] === 'no-txid') {
        const key = `${m[3]} · ${family(m[6])}`
        placeholderWrites.set(key, (placeholderWrites.get(key) ?? 0) + 1)
      }
      continue
    }
    if (ORPHAN_REMOVED_RE.test(e.text)) {
      orphanRemovals += 1
      continue
    }
    if (WRITE_REFUSED_RE.test(e.text)) {
      refusedWrites += 1
      continue
    }
    m = STUCK_CENSUS_RE.exec(e.text)
    if (!m) continue
    const sweepRan = !/holds priority/i.test(m[2])
    const census = { at: e.at, stuck: Number(m[1]), sweepRan, rows: [] }
    for (const r of m[3].matchAll(STUCK_ROW_RE)) {
      const id = r[4]
      const ageS = Number(r[3])
      const row = rows.get(id) ?? {
        id,
        method: r[1],
        sats: Number(r[2]),
        pendingId: r[5],
        item: r[6] ?? 'unknown',
        seen: 0,
        firstAgeS: ageS,
        lastAgeS: ageS,
        maxAgeS: ageS,
        ageShrank: false,
        seenAfterSweepRan: 0,
        sweepsSurvived: 0,
      }
      row.seen += 1
      if (ageS < row.lastAgeS) row.ageShrank = true
      row.lastAgeS = ageS
      row.maxAgeS = Math.max(row.maxAgeS, ageS)
      rows.set(id, row)
      census.rows.push(id)
    }
    censuses.push(census)
  }

  // A row listed in a census *after* one where the sweep ran was seen by the
  // sweep and left in place.
  let lastSweepAt = null
  for (const c of censuses) {
    for (const id of c.rows) {
      const row = rows.get(id)
      if (lastSweepAt != null && c.at > lastSweepAt) row.seenAfterSweepRan += 1
    }
    if (c.sweepRan) {
      lastSweepAt = c.at
      for (const id of c.rows) rows.get(id).sweepsSurvived += 1
    }
  }

  const stuckRows = [...rows.values()].sort((a, b) => b.maxAgeS - a.maxAgeS)
  const isPlaceholder = (r) => r.sats <= 0 && (r.item === 'none' || r.item === 'unknown')
  return {
    writes,
    placeholderWrites: [...placeholderWrites.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([write, count]) => ({ write, count })),
    orphanRemovals,
    refusedWrites,
    stuckCensuses: censuses.length,
    censusesWhereSweepRan: censuses.filter((c) => c.sweepRan).length,
    censusesWhereSweepYielded: censuses.filter((c) => !c.sweepRan).length,
    stuckRows: stuckRows.slice(0, 12),
    // Zero-sat, item-less rows are UI placeholders; the sweep removes them
    // even while a spend holds priority. One that survives a sweep it should
    // have removed is the fact the feed cannot explain on its own.
    placeholderRows: stuckRows.filter(isPlaceholder).length,
    placeholderRowsSurvivingSweep: stuckRows.filter((r) => isPlaceholder(r) && r.sweepsSurvived > 0 && r.seenAfterSweepRan > 0).length,
    pricedRowsHeldWhileYielding: stuckRows.filter((r) => r.sats > 0 && r.seen > 1).length,
    rowsRewrittenFresh: stuckRows.filter((r) => r.ageShrank).length,
    // Ages that keep growing across the window mean the same durable row is
    // still there, not a new one each time.
    longestStuckSeconds: stuckRows[0]?.maxAgeS ?? 0,
  }
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

/* ------------------------------------------------------------ ui facts */

const DUPLICATE_KEY_RE = /^Encountered two children with the same key, `%s`\./
/** `%s` is left literal by console capture; the substituted args follow the text. */
const DUPLICATE_KEY_TAIL_RE = /identity across updates\. Non-unique keys may cause children to be duplicated and\/or omitted — the behavior is unsupported and could change in a future version\.\s*(\S+)(?:\s+(.*))?$/s

/**
 * React list-key collisions. A feed that renders two rows under one key can
 * paint duplicated or stale rows, which reads exactly like a phantom Activity
 * entry, so the offending key and the component that owns the list are facts
 * worth having in the state.
 */
function uiFacts(events) {
  const keys = new Map()
  const owners = new Map()
  let duplicateKeyErrors = 0
  for (const e of events) {
    if (e.level !== 'error' || !DUPLICATE_KEY_RE.test(e.text)) continue
    duplicateKeyErrors += 1
    const tail = DUPLICATE_KEY_TAIL_RE.exec(e.text)
    const key = tail?.[1] ?? '<unknown>'
    keys.set(key, (keys.get(key) ?? 0) + 1)
    const stack = tail?.[2] ?? ''
    const owner = /\bat\s+([A-Z]\w+)/.exec(stack)?.[1] ?? '<unknown>'
    owners.set(owner, (owners.get(owner) ?? 0) + 1)
  }
  return {
    duplicateKeyErrors,
    duplicateKeys: [...keys.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, count]) => ({ key: key.slice(0, 120), count })),
    duplicateKeyOwners: [...owners.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([component, count]) => ({ component, count })),
  }
}

/* -------------------------------------------------- token deposit facts */

const TIP_PENDING_AGE_RE = /^\[tip-ingest\] tip ([0-9a-f]{12})… still pending — lookup=(\S+) age=(\d+)s/
const TIP_PENDING_FATE_RE = /^\[tip-ingest\] tip ([0-9a-f]{12})… still pending — fate=(\S+) lookup=(\S+)/
const TIP_RETIRED_RE = /^\[tip-ingest\] tip ([0-9a-f]{12})… retired — (.*)$/
const TIP_REFUSED_RE = /^\[tip-ingest\] item settle refused ([0-9a-f]{12})… — (.*)$/
const TOKEN_INTERNALIZE_RE = /^\[bsv21\] internalize failed (\S+)/
const FUNGIBLE_BEEF_RE = /^\[fungible-settle\] AtomicBEEF fetch failed ([0-9a-f]{12})/
const FUNGIBLE_BROADCAST_RE = /^\[fungible-settle\] post-internalize broadcast failed ([0-9a-f]{12})/
const ANCESTRY_COMPLETED_RE = /^\[(?:fungible|item)-settle\] ([0-9a-f]{12}) ancestry completed \+(\d+) parent\(s\) done (\d+)ms/
const ANCESTRY_INCOMPLETE_RE = /^\[(?:fungible|item)-settle\] ([0-9a-f]{12}) ancestry incomplete — missing (.*)$/

/**
 * A token deposit the wallet has not finished. Pending lines repeat as the tip
 * ages; refused / retired / internalize-failed lines say why it stopped.
 * Grouped by txid prefix so one stuck deposit is one row, not one row per poll.
 */
function tokenDepositFacts(events) {
  const rows = new Map()
  const rowFor = (id) => {
    const row = rows.get(id) ?? {
      txid: id,
      pendingLines: 0,
      maxAgeSeconds: 0,
      lastLookup: null,
      lastFate: null,
      retired: null,
      refused: null,
      internalizeFailed: 0,
      beefFetchFailed: 0,
      broadcastFailed: 0,
      ancestryCompleted: 0,
      ancestryCompletionMs: 0,
      ancestryMissing: null,
    }
    rows.set(id, row)
    return row
  }
  for (const e of events) {
    let m = TIP_PENDING_AGE_RE.exec(e.text)
    if (m) {
      const row = rowFor(m[1])
      row.pendingLines += 1
      row.maxAgeSeconds = Math.max(row.maxAgeSeconds, Number(m[3]))
      row.lastLookup = m[2]
      continue
    }
    m = TIP_PENDING_FATE_RE.exec(e.text)
    if (m) {
      const row = rowFor(m[1])
      row.pendingLines += 1
      row.lastFate = m[2]
      row.lastLookup = m[3]
      continue
    }
    m = TIP_RETIRED_RE.exec(e.text)
    if (m) {
      rowFor(m[1]).retired = m[2].slice(0, 160)
      continue
    }
    m = TIP_REFUSED_RE.exec(e.text)
    if (m) {
      rowFor(m[1]).refused = m[2].slice(0, 160)
      continue
    }
    m = TOKEN_INTERNALIZE_RE.exec(e.text)
    if (m) {
      rowFor(m[1].slice(0, 12)).internalizeFailed += 1
      continue
    }
    m = FUNGIBLE_BEEF_RE.exec(e.text)
    if (m) {
      rowFor(m[1]).beefFetchFailed += 1
      continue
    }
    m = FUNGIBLE_BROADCAST_RE.exec(e.text)
    if (m) {
      rowFor(m[1]).broadcastFailed += 1
      continue
    }
    m = ANCESTRY_COMPLETED_RE.exec(e.text)
    if (m) {
      const row = rowFor(m[1])
      row.ancestryCompleted += Number(m[2])
      row.ancestryCompletionMs = Math.max(row.ancestryCompletionMs, Number(m[3]))
      continue
    }
    m = ANCESTRY_INCOMPLETE_RE.exec(e.text)
    if (m) {
      rowFor(m[1]).ancestryMissing = m[2].slice(0, 160)
      continue
    }
  }
  const deposits = [...rows.values()].sort((a, b) => b.maxAgeSeconds - a.maxAgeSeconds || b.pendingLines - a.pendingLines)
  return {
    deposits: deposits.slice(0, 8),
    stillPending: deposits.filter((d) => d.pendingLines > 0 && !d.retired).length,
    refused: deposits.filter((d) => d.refused).length,
    retired: deposits.filter((d) => d.retired).length,
    internalizeFailed: deposits.reduce((a, d) => a + d.internalizeFailed, 0),
    ancestryCompleted: deposits.filter((d) => d.ancestryCompleted > 0).length,
    ancestryMissing: deposits.filter((d) => d.ancestryMissing).length,
    oldestPendingSeconds: deposits.find((d) => d.pendingLines > 0)?.maxAgeSeconds ?? 0,
  }
}

/* ----------------------------------------------------- nft import facts */

const IMPORT_TAG = /^(chain-ingest|1sat|items|collectables|phrase-sweep|bsv21|tip-ingest|ordinal)/
const IMPORTING_RE = /^\[chain-ingest\] importing (\d+) 1sat tip\(s\) in chunks of (\d+)/
const IMPORTED_ITEMS_RE = /^\[chain-ingest\] imported (\d+) collectable tip\(s\)/
const IMPORTED_TOKENS_RE = /^\[chain-ingest\] imported (\d+) BSV-21 tip\(s\)/
const IMPORT_PARTIAL_RE = /^\[chain-ingest\] 1sat import partial/
const HELD_ONESAT_RE = /^\[chain-ingest\] holding (\d+) unrecognized one-sat/
const PHRASE_FAIL_RE = /^\[phrase-sweep\] (tip unreadable|item migrate failed)/

/**
 * Whether this window imported collectables, and which timed work sat inside
 * that import. The importer logs counts, not a duration, so a speed verdict
 * can only come from the `done Nms` spans whose tag is the import itself or
 * the lookups it performs.
 */
function nftImportFacts(events) {
  let importRuns = 0
  let tipsQueued = 0
  let chunkSize = null
  let collectablesImported = 0
  let tokensImported = 0
  let partialChunks = 0
  let heldUnrecognized = 0
  let heldUnrecognizedLines = 0
  let phraseSweepFailures = 0
  const byLabel = new Map()
  for (const e of events) {
    let m = IMPORTING_RE.exec(e.text)
    if (m) {
      importRuns += 1
      tipsQueued += Number(m[1])
      chunkSize = Number(m[2])
      continue
    }
    m = IMPORTED_ITEMS_RE.exec(e.text)
    if (m) {
      collectablesImported += Number(m[1])
      continue
    }
    m = IMPORTED_TOKENS_RE.exec(e.text)
    if (m) {
      tokensImported += Number(m[1])
      continue
    }
    if (IMPORT_PARTIAL_RE.test(e.text)) {
      partialChunks += 1
      continue
    }
    m = HELD_ONESAT_RE.exec(e.text)
    if (m) {
      // The same address reports this count on every pass. Keep the peak, not the sum.
      heldUnrecognized = Math.max(heldUnrecognized, Number(m[1]))
      heldUnrecognizedLines += 1
      continue
    }
    if (PHRASE_FAIL_RE.test(e.text)) phraseSweepFailures += 1
    const tag = TAG_RE.exec(e.text)
    if (!tag || !IMPORT_TAG.test(tag[1])) continue
    const d = DURATION_RE.exec(tag[2])
    if (!d) continue
    const ms = Number(d[2] ?? d[3])
    if (!Number.isFinite(ms) || ms <= 0) continue
    const row = byLabel.get(tag[1]) ?? { label: tag[1], runs: 0, totalMs: 0, longestMs: 0 }
    row.runs += 1
    row.totalMs += ms
    row.longestMs = Math.max(row.longestMs, ms)
    byLabel.set(tag[1], row)
  }
  const spans = [...byLabel.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 8)
  return {
    importRuns,
    tipsQueued,
    chunkSize,
    collectablesImported,
    tokensImported,
    partialChunks,
    heldUnrecognized,
    heldUnrecognizedLines,
    phraseSweepFailures,
    timedSpans: spans,
    longestSpanMs: spans.reduce((a, s) => Math.max(a, s.longestMs), 0),
  }
}

/* -------------------------------------------------------- bridge facts */

const HTTP_IN_RE = /^\[HTTP\] (GET|POST) (\/\S*)$/
const HTTP_TO_RENDERER_RE = /^\[HTTP\] → renderer request_id=(\d+) (?:GET|POST) (\/\S*)/
const HTTP_FROM_RENDERER_RE = /^\[HTTP\] ← renderer request_id=(\d+) status=(\d+)/
const HTTP_ERROR_RE = /^\[HTTP\] ← renderer request_id=(\d+) (?:GET|POST) (\/\S*) error: ([A-Z][A-Z0-9_]{2,}|\w+)/
const HTTP_NO_REPLY_RE = /no renderer reply|renderer-not-ready/i

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0)

/**
 * BRC-100 bridge facts from the Electron main log: what apps asked, how long
 * the renderer took to answer each request, and which errors came back. The
 * renderer ring never sees this side, so it is the only record of an app
 * waiting on the wallet.
 */
function bridgeFacts(events) {
  const byMethod = new Map()
  const methodFor = (m) => byMethod.get(m) ?? byMethod.set(m, { method: m, requests: 0, answered: 0, errors: 0, latencies: [] }).get(m)
  const open = new Map()
  const errorCodes = new Map()
  const slowest = []
  let noReply = 0
  let requests = 0
  const otherProblems = new Map()

  for (const e of events) {
    let m = HTTP_IN_RE.exec(e.text)
    if (m) {
      requests += 1
      methodFor(m[2]).requests += 1
      continue
    }
    m = HTTP_TO_RENDERER_RE.exec(e.text)
    if (m) {
      open.set(m[1], { method: m[2], at: e.at })
      continue
    }
    m = HTTP_ERROR_RE.exec(e.text)
    if (m) {
      methodFor(m[2]).errors += 1
      errorCodes.set(m[3], (errorCodes.get(m[3]) ?? 0) + 1)
      if (HTTP_NO_REPLY_RE.test(e.text)) noReply += 1
      continue
    }
    m = HTTP_FROM_RENDERER_RE.exec(e.text)
    if (m) {
      const started = open.get(m[1])
      if (!started) continue
      open.delete(m[1])
      const ms = e.at - started.at
      const row = methodFor(started.method)
      row.answered += 1
      row.latencies.push(ms)
      slowest.push({ method: started.method, ms, status: Number(m[2]) })
      continue
    }
    if (HTTP_NO_REPLY_RE.test(e.text)) noReply += 1
    if ((e.level === 'warn' || e.level === 'error') && !/^\[HTTP\]/.test(e.text)) {
      const key = family(e.text)
      const cur = otherProblems.get(key) ?? { level: e.level, message: key, occurrences: 0 }
      cur.occurrences += 1
      otherProblems.set(key, cur)
    }
  }

  const methods = [...byMethod.values()]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 14)
    .map((r) => {
      const sorted = [...r.latencies].sort((a, b) => a - b)
      return {
        method: r.method,
        requests: r.requests,
        answered: r.answered,
        errors: r.errors,
        p50ms: percentile(sorted, 0.5),
        p95ms: percentile(sorted, 0.95),
        maxMs: sorted.at(-1) ?? 0,
      }
    })

  return {
    lineCount: events.length,
    windowSeconds: events.length ? Math.round((events.at(-1).at - events[0].at) / 1000) : 0,
    requests,
    unanswered: open.size,
    rendererNotReady: noReply,
    methods,
    errorCodes: [...errorCodes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, count]) => ({ code, count })),
    slowest: slowest
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 6),
    otherProblems: [...otherProblems.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, 8),
  }
}

function splitUploads(text) {
  const parts = text
    .split(/^# \d{15}-[0-9a-f]+\.log$/m)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length <= 1) return parts.length ? parts : [text]
  return parts
    .map((body) => ({
      body,
      at: Date.parse(body.match(/^# uploaded (\S+)$/m)?.[1] ?? '') || 0,
    }))
    .sort((a, b) => b.at - a.at)
    .map((p) => p.body)
}

/* ------------------------------------------------------------------- jev */

/** Choice ids must be identifiers; workload labels carry spaces and dashes. */
const choiceId = (label) => label.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()

/**
 * Questions that depend on what code found: the freeze-owner candidates are
 * the workloads whose spans actually overlapped blocked time, so the model
 * chooses among real suspects instead of a fixed taxonomy.
 */
function forensicQuestions(latest) {
  const owners = {}
  for (const w of latest.workloads) {
    owners[choiceId(w.workload)] =
      `The \`${w.workload}\` work — see the \`latest.workloads\` row with workload "${w.workload}" for how much blocked time fell inside its runs.`
  }
  owners.storage_quota =
    'The origin store itself: `latest.storage` shows writes refused at quota, and every refusal or large-blob write is synchronous work on the same thread.'
  owners.startup_recompose =
    'Unlock-time recompose / legacy ingest running as a whole, rather than any single timed workload.'
  owners.unclear = 'Nothing in `latest.workloads`, `latest.precedingLines` or `latest.bursts` singles one out.'

  const custody = latest.custody
  const custodyQuestions =
    custody.arcadeRejections.warnings > 0 || custody.utxoHeal.quarantinedTotal > 0
      ? {
          rejected_chain_cause: {
            type: 'choice',
            instructions:
              'Why did the miner refuse the transactions in `latest.custody.arcadeRejections`? `roots` groups refusals by the ancestor at the bottom of each chain; `rootReasons` is the text the miner gave for that root; `maxAncestorDepth` is how many generations were chained on it. Read `latest.custody.utxoHeal` alongside: coins quarantined as "spent, spender unknown" are inputs that left through a transaction this wallet does not hold.',
            criteria: {
              dead_chain_outputs:
                '`utxoHeal.quarantinedFromRefusedTx` covers the quarantined coins: they are outputs of transactions the miner refused, so the chain reads them as gone because their funding tx never existed on chain.',
              competing_spend:
                'The root reason names a double spend, missing or already-spent inputs, or the heal quarantined coins that are not outputs of a refused tx — the same coins were spent from elsewhere and everything chained on them is dead.',
              root_never_propagated:
                'The root itself is not on chain and its inputs are still unspent: it was signed but never accepted, and children were chained before that showed.',
              policy_or_script:
                'The root reason names fees, script validation, size or a policy rule rather than its inputs.',
              cause_truncated:
                '`truncatedReasons` is most of the warnings and `rootReasons` is `<truncated>`: the wallet cut the chain text before the miner’s reason.',
            },
          },
          quarantine_next_step: {
            type: 'choice',
            instructions:
              'Given `latest.custody`, what should the wallet do about the quarantined coins and the rejected chain?',
            criteria: {
              write_off_rejected_chain:
                'The refusals are terminal and the quarantined inputs are spent elsewhere: mark every transaction in the chain failed, drop their outputs from the spendable set, and stop re-asking the miner.',
              release_and_rebroadcast_root:
                'The root is merely unpropagated: post its BEEF again and keep the chain sealed until the miner answers.',
              wait_for_chain_evidence:
                'Verdicts are still unknown or too fresh to act on; leave the quarantine in place and re-check later.',
              need_more_evidence:
                'The facts do not say — the root reason is missing or the heal and the refusals disagree.',
            },
          },
        }
      : {}

  const activity = latest.activity
  const activityQuestions =
    activity.stuckCensuses > 0 || activity.placeholderWrites.length > 0 || latest.ui.duplicateKeyErrors > 0
      ? {
          phantom_row_cause: {
            type: 'choice',
            instructions:
              'Why are pending "Signed / Approving" rows still on screen? `latest.activity.stuckRows` lists every txid-less pending spend older than 90s each time the wallet took its census, with its sats, whether it names an item, how many censuses it appeared in, whether its age ever shrank, and how many sweeps it survived. `censusesWhereSweepRan` vs `censusesWhereSweepYielded` says whether the expiry pass got to act. `placeholderWrites` are zero-sat txid-less spend rows being written. `latest.ui.duplicateKeys` are React list keys that collided, with the component owning the list — a list rendered under colliding keys can paint duplicated or stale rows that no store row explains.',
            criteria: {
              list_key_collision:
                '`latest.ui.duplicateKeyErrors` > 0 and no stuck store row explains the rows: the feed rendered two records under one key, so React duplicated or kept stale rows on screen. The store is clean; the projection is wrong.',
              placeholder_survives_sweep:
                '`placeholderRowsSurvivingSweep` > 0: a zero-sat, item-less row was listed again after a census where the sweep ran, so the sweep saw it and did not remove it — its shape escapes the placeholder test or the store refused the write (`refusedWrites`).',
              row_rewritten_fresh:
                '`rowsRewrittenFresh` > 0 or `placeholderWrites` keep recurring: something re-upserts the placeholder so its age resets and the read-time filter never sees it as stale.',
              priced_row_held_while_yielding:
                'The stuck rows carry sats > 0: they are real attempted sends the sweep keeps while a spend holds priority (`censusesWhereSweepYielded` dominates), not approval placeholders.',
              sweep_never_reached:
                'Stuck rows exist but there is no census at all in the window, so neither the feed refresh loop nor chain-ingest maintenance ran the expiry pass.',
              unclear: 'The activity facts do not favour one cause.',
            },
          },
        }
      : {}

  const ledger = latest.ledger
  const ledgerQuestions =
    ledger && ledger.receivedAboveTrusted > 0
      ? {
          balance_gap_cause: {
            type: 'choice',
            instructions:
              'The user received coins and the spendable balance did not rise. `latest.ledger.trustedSats` is the last spendable balance the wallet trusted, `trustedAgeSeconds` how long ago that read was, and `recentCoinReceives` are Activity rows for plain coin receives (sats, txid prefix, age). `receivedAboveTrusted` is how many sats the newest recent receive exceeds the trusted balance by. Activity recording a receive does not credit spendable balance — only an output in local state does.',
            criteria: {
              received_not_spendable:
                '`receivedAboveTrusted` is most of the receive and the trusted read is recent: history shows the coins arrived, spendable local state does not hold them.',
              trusted_already_includes:
                '`trustedSats` is at least the newest receive, so the balance did rise and a stale display is the remaining question.',
              receive_still_pending:
                'The newest receive row is still `pending`: ingest has not finished, so the balance is waiting on it.',
              unclear: 'The ledger facts do not say whether the output is missing or the display is stale.',
            },
          },
        }
      : {}

  const deposits = latest.tokenDeposits
  const depositQuestions =
    deposits && deposits.deposits.length > 0
      ? {
          stuck_token_deposit: {
            type: 'choice',
            instructions:
              'The user has a token deposit that has been stuck. `latest.tokenDeposits.deposits` groups ingest lines by txid prefix: `pendingLines` and `maxAgeSeconds` are how often and how old a tip stayed pending, `lastLookup` / `lastFate` are the last ingest verdict, `refused` is why settle refused it, `retired` is why ingest gave up, `internalizeFailed` / `beefFetchFailed` / `broadcastFailed` count those failures, `ancestryCompleted` is how many missing parents the wallet folded into the package before internalize, `ancestryMissing` names parents it could not find anywhere. A deposit is stuck when it stays pending or is refused/retired instead of landing in the token basket.',
            criteria: {
              waiting_on_body:
                'The oldest pending deposit has a lookup that is not a local body and has not been refused: ingest is waiting on the transaction body.',
              parent_unavailable:
                'A deposit has `ancestryMissing` set, or `refused` starts with `ancestry-incomplete`: the hop arrived but a parent transaction is neither local nor provable yet, so the wallet is retrying by name rather than refusing forever.',
              settle_refused:
                'A deposit has `refused` (not ancestry-incomplete) or `internalizeFailed`: the body arrived and internalize rejected it, so it will not land until that refusal is handled.',
              retired_as_invalid:
                'A deposit is `retired` and the reason says the spend is invalid, rejected, or missing: it should be hidden, not left as a deposit.',
              broadcast_only:
                '`broadcastFailed` is set and the deposit was otherwise accepted: the token is in the basket and only the public broadcast failed.',
              no_stuck_deposit:
                'Nothing is pending, refused, or retired. This window does not contain a stuck token deposit.',
              unclear: 'The deposit lines do not say whether it is waiting, refused, or already settled.',
            },
          },
        }
      : {}

  const nft = latest.nftImport
  const nftQuestions = nft
    ? {
        nft_import_speedup: {
          type: 'choice',
          instructions:
            'Can the NFT (1sat collectable) import in `latest.nftImport` be sped up, and where? `tipsQueued` / `chunkSize` is how many tips were taken serially in chunks. `collectablesImported` is how many landed. `partialChunks` and `phraseSweepFailures` are retries and unreadable tips. `heldUnrecognized` is the peak count of one-sat outputs the scan decided not to import, and `heldUnrecognizedLines` is how many passes reported that. `timedSpans` are the `done Nms` lines whose tag is the import or a lookup it performs (chain-ingest, 1sat, items, collectables, phrase-sweep, bsv21, tip-ingest); the importer itself does not log a duration, so an import with counts but empty `timedSpans` has no timing evidence. `longestSpanMs` is the slowest of those.',
          criteria: {
            no_import_in_window:
              '`tipsQueued`, `collectablesImported` and `timedSpans` are all empty: this window did not import NFTs, so it cannot say whether import is slow.',
            need_chunk_timing:
              'Tips were queued or imported, but `timedSpans` is empty: the log never says how long a chunk took, so changing the importer would be a guess. Time each chunk first.',
            serial_chunks:
              '`tipsQueued` is large relative to `chunkSize` and a timed span covers the chunk loop: fewer sequential round trips per chunk would shorten it.',
            per_tip_lookup:
              'The long spans are lookups (beef, listOutputs, provenance, content, tip-ingest) rather than the chunk loop: the speedup is fewer lookups per tip, not a bigger chunk.',
            retrying_failures:
              '`partialChunks` or `phraseSweepFailures` repeat: time is going into tips that fail and get tried again.',
            already_fine:
              'The import is a handful of tips, or the longest related span is under about a second.',
            skip_the_unrecognized:
              '`heldUnrecognized` is thousands and `heldUnrecognizedLines` shows that count reported again on later passes: the scan keeps walking one-sat outputs it has already decided not to import. Remembering that decision would shorten the next pass; the tips that did import are not the slow part.',
          },
        },
      }
    : {}

  const bridge = latest.bridge
  const bridgeQuestions =
    bridge && bridge.requests > 0
      ? {
          bridge_health: {
            type: 'choice',
            instructions:
              'From `latest.bridge` (BRC-100 local HTTP bridge, Electron main side): `methods[]` gives per-method request counts and renderer answer latency percentiles, `errorCodes` the error codes returned to apps, `rendererNotReady` how often the wallet window could not answer, `unanswered` requests with no reply at all. What best describes the bridge in this window?',
            criteria: {
              healthy: 'Requests are answered quickly and errors are the expected WALLET_LOCKED / permission denials.',
              renderer_unavailable: '`rendererNotReady` or `unanswered` is a meaningful share: apps were talking to a wallet window that could not answer.',
              slow_spends: 'createAction / signAction / internalizeAction p95 latency is many seconds while other methods are fast.',
              app_errors_dominate: 'Error codes other than WALLET_LOCKED and permission denials make up most replies.',
              unclear: 'Too few requests, or the facts do not favour one description.',
            },
          },
        }
      : {}

  return {
    ...custodyQuestions,
    ...activityQuestions,
    ...ledgerQuestions,
    ...depositQuestions,
    ...nftQuestions,
    ...bridgeQuestions,
    freeze_owner: {
      type: 'choice',
      instructions:
        'Which single piece of work most plausibly owns the blocked time in `latest`? Weigh `latest.workloads[].shareOfBlockedTime` (blocked time that fell inside that workload’s runs), `latest.precedingLines` (the last line logged before each freeze began — later lines were only queued behind it), and `latest.bursts[].overlappingWorkloads`. Overlapping shares can each be large; prefer the one that recurs across bursts.',
      criteria: owners,
    },
    storage_pressure_contributes: {
      type: 'noul',
      instructions:
        'Given `latest.storage` — origin storage near its quota, writes refused, the sizes of the largest keys — is the storage layer plausibly adding to the freezes, either through refused-write handling or by serialising those large values synchronously?',
      criteria: {
        true: 'The store is full or nearly full with multi-hundred-KB values, and freezes coincide with storage activity.',
        false: 'Storage has headroom or its activity does not line up with the freezes.',
      },
    },
    fix_first: {
      type: 'choice',
      instructions:
        'What single change should be made first to remove the freezes described by `latest`, given `freeze_owner` candidates, `latest.storage`, and the repeating problems?',
      criteria: {
        yield_or_offload_owner:
          'Slice the owning workload so it yields to the event loop between items, or move its decoding/verification into a worker. Stored data is unchanged.',
        shrink_stored_state:
          'Cap or relocate the largest stored keys so the origin store has headroom and large JSON values stop being serialised on the main thread.',
        dedupe_refreshes:
          'Stop starting the same read while one is already running — lines like "refresh still running" or "deferring listOutputs" show the work is repeated, not slow.',
        throttle_polling:
          'Run background checks (dependency health, header polls, backup probes) less often while the app is in the foreground.',
        need_more_evidence:
          'The facts do not single out a change; instrument the function inside the freeze first.',
      },
    },
  }
}

const QUESTIONS = {
  user_visible_freeze: {
    type: 'noul',
    instructions:
      'Would a person using this wallet during `latest.freezes` notice the app hanging — taps or scrolls not responding — rather than just slow background work?',
    criteria: {
      true: 'Freezes are long enough and frequent enough to interrupt normal interaction.',
      false: 'Background work is slow but the interface stays responsive.',
    },
  },
  primary_driver: {
    type: 'choice',
    instructions:
      'In `latest`, which subsystem is most responsible for the main-thread freezes? `latest.freezes.byActiveLayer` attributes each freeze to whatever wallet layer was running; `latest.idleFreezes` counts the ones no layer explains, and `latest.repeatingProblems[].shareOfUnattributedFreezesNearby` says which repeating problem coincides with those. Weigh how much of the blocked time each explains.',
    criteria: {
      chain_ingest:
        'Reading the chain into local state: chain-ingest, tip-ingest, legacy scans, proof or header fetches.',
      retry_loop:
        'A queue re-attempting the same failing work repeatedly — outbox retries, redelivery, re-encoding the same payload.',
      spend_preparation:
        'Preparing to sign: sealing spent inputs, promoting or restoring change, stale-output work before a send.',
      network_dependency:
        'Waiting on slow or failing external services rather than local computation.',
      rendering:
        'Drawing the interface itself: images, lists, feed rendering.',
      unclear: 'The evidence does not favour one subsystem.',
    },
  },
  custody_at_risk: {
    type: 'noul',
    instructions:
      'Does `latest` contain evidence that money or a token could be lost, stuck, or unreceivable — a payment the counterparty cannot complete, a transaction that cannot propagate, a balance that cannot be spent? Slowness alone is not custody risk.',
    criteria: {
      true: 'A value transfer cannot complete, or funds are unspendable or unaccounted for.',
      false: 'Performance or cosmetic problems only; transfers still complete.',
    },
  },
  regression_since_previous: {
    type: 'noul',
    instructions:
      'Comparing `latest` with `previous`, did this build get worse? Treat a freeze class or repeating error that appears in `latest` but not `previous` as strong evidence, and account for the differing `windowSeconds`.',
    criteria: {
      true: 'A failure mode is present or materially worse in `latest`.',
      false: 'Same as before, or improved.',
    },
  },
  severity: {
    type: 'score',
    instructions: 'How urgently does what `latest` shows need a fix?',
    criteria: [
      'Healthy — nothing worth acting on.',
      'Cosmetic or background noise a user would not notice.',
      'Degraded — usable but visibly worse than it should be.',
      'Blocking — a normal task cannot be completed.',
      'Critical — value is at risk or the wallet is unusable.',
    ],
  },
}

async function askJev(state, apiKey) {
  const questions = { ...QUESTIONS, ...forensicQuestions(state.latest) }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model: 'jev-latest', questions }),
    })
    if (res.ok) return res.json()
    if (res.status !== 429 && res.status !== 529) {
      throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
  }
  throw new Error('typesafe overloaded after retries')
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
      const when = b.secondsAfterLaunch != null ? `+${b.secondsAfterLaunch}s after launch` : 'launch unknown'
      console.log(
        `  ${when}: ${b.freezes} freeze(s), ${(b.blockedMs / 1000).toFixed(1)}s blocked over ${b.durationSeconds}s · ${b.activeLayers.join(' | ')}`,
      )
      if (b.overlappingWorkloads.length) console.log(`      during: ${b.overlappingWorkloads.join(', ')}`)
      if (b.lineBefore) console.log(`      preceded by: ${b.lineBefore}`)
    }
  }
  const st = latest.storage
  if (st.refusedWrites || st.slowOps) {
    console.log('\nOrigin storage:')
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
const positional = args.filter((a, i) => !a.startsWith('--') && (fileIdx < 0 || i !== fileIdx + 1))
const bucketArg = positional[0] ?? 'android'

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
