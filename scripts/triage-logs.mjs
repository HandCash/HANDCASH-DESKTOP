#!/usr/bin/env node
/**
 * Triage a device's uploaded session logs with Jev (TypeSafe System One).
 *
 *   node scripts/triage-logs.mjs [bucket] [--all] [--json] [--state]
 *
 * Buckets default to the ones in `.cursor/rules/remote-support-logs.mdc`.
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
  if (process.env.JEV_API_KEY?.trim()) return process.env.JEV_API_KEY.trim()
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
    const hit = env.match(/^\s*JEV_API_KEY\s*=\s*(.+)$/m)
    if (hit) return hit[1].trim().replace(/^["']|["']$/g, '')
  } catch {
    /* no .env */
  }
  throw new Error('JEV_API_KEY is not set (env or HANDCASH-DESKTOP/.env)')
}

async function fetchLogs(bucket, all) {
  const url = `${LOG_BASE}/${bucket}/${all ? 'all' : 'latest'}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`log fetch ${res.status} ${url}`)
  return res.text()
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

  const events = []
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trim())
    if (m) events.push({ at: Date.parse(m[1]), level: m[2], text: m[3] })
  }

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

  const span =
    events.length > 0
      ? Math.round((events.at(-1).at - events[0].at) / 1000)
      : 0

  return {
    version: versionLine?.[1] ?? header.version ?? 'unknown',
    platform: versionLine?.[2] ?? 'unknown',
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

  return {
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
const bucketArg = args.find((a) => !a.startsWith('--')) ?? 'android'
const bucket = KNOWN_BUCKETS[bucketArg] ?? bucketArg

// `/all` is what makes "is this new?" answerable, so compare by default.
const text = await fetchLogs(bucket, true)
const uploads = splitUploads(text)
const latest = parseSession(uploads[0])
const previous = uploads[1] ? parseSession(uploads[1]) : null
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
