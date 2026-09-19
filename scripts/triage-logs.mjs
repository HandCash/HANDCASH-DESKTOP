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
      blockedMsTotal: stalls.reduce((a, s) => a + s.ms, 0),
      byActiveLayer: stallClasses,
      longtaskCount: longtasks.length,
    },
    // "layers idle" means nothing the wallet coordinator names was running.
    idleFreezes: stalls.filter((s) => /idle/i.test(s.during)).length,
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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model: 'jev-latest', questions: QUESTIONS }),
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

  const driver = answers.primary_driver
  console.log(`\nPrimary driver: ${driver.choice} (confidence ${driver.confidence.toFixed(2)})`)
  for (const [k, v] of Object.entries(driver.probabilities).sort((a, b) => b[1] - a[1])) {
    if (v >= 0.03) console.log(`  ${k.padEnd(20)} ${BAR(v)} ${(v * 100).toFixed(0)}%`)
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
