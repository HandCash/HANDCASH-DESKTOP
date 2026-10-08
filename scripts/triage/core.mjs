/**
 * Triage core: every fact code can derive from an uploaded session log, the
 * questions Jev answers about them, and the Jev call itself.
 *
 * No Node built-ins, so the same extractor runs in the CLI
 * (`scripts/triage-logs.mjs`) and in the BRC-CLOUD log dashboard Worker.
 * Code counts; Jev judges. Never ask the model to count.
 */

export const KNOWN_BUCKETS = {
  phone: 'hc-2c00efc3249a742845a7',
  android: 'hc-a580a83ef98f5463f546',
  desktop: 'hc-ad7afbfaae0d01fffcb3',
}
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'

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

/** Collapse ids, hashes, sizes and timings so repeats group into one family.
 * A parenthesised HTTP status — `failed (503)`, `(429: rate-limit)` — stays:
 * a 500 and a 401 are different families with different fixes. */
function family(message) {
  return message
    .replace(/\b[0-9a-f]{12,64}\b/gi, '<id>')
    .replace(/\btrace-[0-9a-f-]+/gi, '<trace>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\b\d{3}\b/g, (n, at, s) => (s[at - 1] === '(' && /[):]/.test(s[at + 3] ?? '') ? n : '<n>'))
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

  // Mobile builds before 1.3.518 shipped the ring twice (once as the renderer
  // tail, once as the "electron main" tail). A repeated timestamp + line is
  // that copy, never a second event, and counting it doubled every freeze.
  const events = []
  const seen = new Set()
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trim())
    if (!m) continue
    const key = `${m[1]}\u0000${m[3]}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push({ at: Date.parse(m[1]), level: m[2], text: m[3] })
  }
  const facts = sessionFacts(header, events)
  Object.defineProperty(facts, 'events', { value: events, enumerable: false })
  return facts
}

/** Every event naming one transaction, in order — the per-txid story without reading the log. */
function traceTxid(session, prefix) {
  const needle = prefix.toLowerCase()
  const t0 = session.events?.[0]?.at ?? 0
  const seen = new Set()
  return (session.events ?? [])
    .filter((e) => {
      if (!e.text.toLowerCase().includes(needle)) return false
      const key = `${e.at}\u0000${e.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((e) => ({ s: Math.round((e.at - t0) / 1000), level: e.level, text: e.text.slice(0, 400) }))
}

/**
 * What the wallet did in the five minutes before `prefix` was first filed as
 * having left its basket: every tagged line in that window, deduped by shape
 * with a count. A row that vanishes is rarely named by whatever removed it.
 */
function beforeLeftBasket(session, prefix) {
  const needle = prefix.toLowerCase()
  const events = session.events ?? []
  const left = events.find(
    (e) => /^\[holdings\] \S+ \S+.* left-basket/.test(e.text) && e.text.toLowerCase().includes(needle),
  )
  if (!left) return null
  const t0 = events[0]?.at ?? 0
  const shapes = new Map()
  for (const e of events) {
    if (e.at < left.at - 300_000 || e.at >= left.at) continue
    if (!/^\[[\w-]+\]/.test(e.text) || /^\[(heartbeat|nav|images)\]/.test(e.text)) continue
    const shape = e.text.replace(/[0-9a-f]{12,}(\.\d+)?/g, '<id>').replace(/\d+/g, '<n>').slice(0, 160)
    const row = shapes.get(shape)
    if (row) row.times += 1
    else shapes.set(shape, { s: Math.round((e.at - t0) / 1000), shape, times: 1 })
  }
  return { leftAtS: Math.round((left.at - t0) / 1000), lines: [...shapes.values()] }
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
  const bursts = stallBursts(events, stalls, workloads.spans, workloads.waits)
  const custody = custodyFacts(events)
  const activity = activityFacts(events)
  const ui = uiFacts(events)
  const nftImport = nftImportFacts(events)
  const tagCensus = tagCensusFacts(events)
  const tokenDeposits = tokenDepositFacts(events)
  const tokenAttestation = tokenAttestationFacts(events)
  const tokenLedger = tokenLedgerFacts(events)
  const appFlow = appFlowFacts(events)
  const toolboxSteps = toolboxStepFacts(events)
  const spendPrep = spendPrepFacts(events)
  const notifications = notificationFacts(events)
  const deadCoins = deadCoinFacts(events)
  const receiptReplays = receiptReplayFacts(events)
  const serverWallet = serverWalletFacts(events)
  const tokenSends = tokenSendFacts(events)
  const chainIngest = chainIngestFacts(events)
  const holdings = holdingsFacts(events)
  const accountSwitches = accountSwitchFacts(events)
  const identityCards = identityCardFacts(events)
  const legacyImport = legacyImportFacts(events)
  const derivations = derivationFacts(events)
  const incomingFinality = incomingFinalityFacts(events)
  const incomingReceives = incomingReceiveFacts(events)
  const storageLock = storageLockFacts(events)
  const longFrames = longFrameFacts(events)
  const broadcast = broadcastFacts(events)
  const listingPhases = listingPhaseFacts(events)
  const listingOutcomes = listingOutcomeFacts(events)
  const historyReplica = historyReplicaFacts(events)
  const nativeCrashes = [
    ...new Set(
      events.flatMap((e) => {
        const m = NATIVE_CRASH_RE.exec(e.text)
        return m ? [m[1].slice(0, 600)] : []
      }),
    ),
  ]
  const bounceRefunds = events.flatMap((e) => {
    const m = BOUNCE_REFUND_RE.exec(e.text)
    return m ? [Number(m[1])] : []
  })

  const span =
    events.length > 0
      ? Math.round((events.at(-1).at - events[0].at) / 1000)
      : 0

  return {
    version: header.version ?? 'unknown',
    platform: header.platform ?? 'unknown',
    uploadReason: (header.reason ?? 'unknown').split('·')[0].trim(),
    windowSeconds: span,
    lastLineAt: events.length ? new Date(events.at(-1).at).toISOString() : null,
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
    // Connected-app action steps as the renderer answered them: wallet work,
    // user approval, and how long the page took to come back with its next
    // step. A page that only returns when the user re-opens the browser
    // shows up here as a page gap, never as wallet time.
    appFlow,
    // Wallet Toolbox steps inside createAction / signAction that ran past
    // 250ms (`[toolbox] <step> done <N>ms`), per step and page visibility.
    toolboxSteps,
    // What each payment did between entering the exclusive spend region and
    // createAction: the region-entry change promote (`[spend-guard] promote
    // <mode> done`), the flow's own `+<N>ms <phase>` marks, and the sends the
    // watchdog aborted before any mark was reached (stuck in the promote).
    spendPrep,
    // Mobile activity notifications: posted / skipped (with reason) / failed,
    // and hidden-WebView bridge value actions that raised none within 5s.
    notifications,
    // Resigns over coins a confirmed foreign tx spent, the background pool
    // sweeps (`[dead-coins] sweep`) that clear the rest, and `peerDevice`:
    // reads of another install's BRC-39 upload and the coins it had spent.
    deadCoins,
    // Old item receipts re-merged into Activity, and announced cards that left
    // and re-entered the inventory cache (`[collectables] re-entered`).
    receiptReplays,
    // Dev-key server wallet: funds, storage internalizes (landed / deferred
    // with reason), refresh and recover failures.
    serverWallet,
    tokenSends,
    chainIngest,
    holdings,
    accountSwitches,
    // BAP identity cards per peer key: sent, asked, kept, refused, ignored as
    // not a contact, and asks this account could not answer with a card.
    identityCards,
    // Settings → Import: HandCash hints asked / received, each scan phase with
    // its time and counts, the hinted verdict, and sweeps — in order.
    legacyImport,
    tagCensus,
    // BRC-29 change derivations: echoes written before a wipe/replace,
    // coins re-imported from them after, locking scripts rebuilt from keys,
    // and whether legacy deposits were proven by their own path or parents.
    // `journal`: custody-journal captures, refused writes, backup syncs.
    derivations,
    // Incoming packages refused before crediting because an unmined tx in
    // them is not final (BRC-67 step 4), or its lock time met no chain height.
    incomingFinality,
    // Receives whose Activity row was written more than once, with every line
    // naming the txid — what keeps a receive on "Verifying".
    incomingReceives,
    // Toolbox storage-lock holders (`[storage-lock] <op> held|waited|still
    // held`). A stuck entry is a hold that never released: every send behind
    // it times out with nothing broadcast.
    storageLock,
    // The scripts that actually held the main thread in long animation frames.
    // This outranks `freezes.byActiveLayer` and `workloads`, which only say
    // what was in flight: a phase awaiting a lock is never the freeze owner.
    longFrames,
    // Signed transactions and what miners said: per-txid outcome chain, how
    // many ever reached Arcade, and which never left the device.
    broadcast,
    listingPhases,
    // Market listings the overlay never indexed (and which came back), cancels
    // the wallet refused by code, and Arcade pins that did or did not find the
    // local tx row — `storageUserMoved` names a store rebuilt under a new user.
    listingOutcomes,
    // BRC-39 replace / merge restores, uploads and recomposes, in order, and
    // the Arcade pins that missed their local row after a localState write.
    historyReplica,
    // Android deaths JS never saw: uncaught Java exceptions (with stack) and
    // lost WebView renderers, written natively and replayed on next launch.
    nativeCrashes,
    bounceRefundMs: bounceRefunds,
    // React list-key collisions: which key, which component's list.
    ui,
    // 1sat / collectable import: how many tips, what failed, which timed spans
    // sat next to it. Empty means this window did not import.
    nftImport,
    // Token deposits that ingest kept pending, refused, or failed to internalize.
    tokenDeposits,
    // Held tokens per issuer shelf (bap / bap-unconfirmed / key) or the step
    // they lack (no-genesis / unbound / remittance-only / unsigned /
    // unsigned-mint), the token on each, plus heals.
    tokenAttestation,
    // Each token card split by tip kind beside its Activity net.
    tokenLedger,
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
  return { rows, spans, waits }
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
  // Mobile 0.1.592+: the wallet's durable store moved from WebView storage
  // (≈5MB cap) to app files. `store` stays null on builds that predate it.
  const MOVED_RE = /^\[durable\] origin move done (\d+)ms — (\d+) key\(s\) \((\d+)KB\) into the app file store · freed (\d+)KB/
  const NO_FILE_STORE_RE = /^\[durable\] native file store missing/
  // 1.3.446+: the core met the shell bridge after reading/writing origin storage.
  const LATE_ATTACH_RE = /^\[durable\] shell store attached after (\d+) early read\(s\) — handed it (\d+) early write\(s\)/
  // Mobile 0.1.604: one-time recovery from sessions that ran on WebView storage.
  const RECOVERED_RE = /^\[durable\] recovered (\d+) key\(s\) the file store held stale · dropped (\d+) drained queue\(s\)/
  const DEPLOY_EVICT_RE = /^\[bsv21\] deploy store evicted (\d+) deploy\(s\), (\d+) held/
  const PROOF_PURGE_RE = /^\[proof-purge\] purge done \d+ms — (\d+) completed proof request\(s\), (\d+)KB/
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
    store: null,
    originMove: null,
    // A boot move that freed large WebView values while moving none means the
    // previous session wrote WebView storage, not the file store.
    lateShellAttach: null,
    originRecovery: null,
    deployEvictions: 0,
    heldDeployEvictions: 0,
    proofRequestsPurged: 0,
    proofPurgedKB: 0,
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
    if (m) {
      out.reclaimedKB += Number(m[1])
      continue
    }
    m = MOVED_RE.exec(e.text)
    if (m) {
      out.store = 'app-files'
      out.originMove = {
        ms: Number(m[1]),
        keys: Number(m[2]),
        kb: Number(m[3]),
        freedKB: Number(m[4]),
        // The core mirrors at most 64KB values; anything larger in WebView
        // storage at boot was written there by a session that bypassed the file store.
        previousSessionOnWebView: Number(m[4]) > 0,
      }
      continue
    }
    m = PROOF_PURGE_RE.exec(e.text)
    if (m) {
      out.proofRequestsPurged += Number(m[1])
      out.proofPurgedKB += Number(m[2])
      continue
    }
    m = LATE_ATTACH_RE.exec(e.text)
    if (m) {
      out.lateShellAttach = { earlyReads: Number(m[1]), earlyWrites: Number(m[2]) }
      continue
    }
    m = RECOVERED_RE.exec(e.text)
    if (m) {
      out.originRecovery = { recovered: Number(m[1]), droppedQueues: Number(m[2]) }
      continue
    }
    m = DEPLOY_EVICT_RE.exec(e.text)
    if (m) {
      out.deployEvictions += Number(m[1])
      out.heldDeployEvictions += Number(m[2])
      continue
    }
    if (NO_FILE_STORE_RE.test(e.text)) out.store = 'webview'
  }
  out.refusedKeys = [...refusedKeys].slice(0, 6)
  return out
}

/** Cluster freezes closer than 3s and describe each cluster's surroundings. */
function stallBursts(events, stalls, spans, waits = []) {
  const GAP_MS = 3_000
  const launchEvents = events.filter((e) => /^App log capture started/.test(e.text))
  const launches = launchEvents.map((e) => e.at)
  const buildAt = (t) => {
    const launch = launchEvents.filter((e) => e.at <= t).at(-1)
    return launch ? (/— v(\S+)/.exec(launch.text)?.[1] ?? 'unknown') : 'unknown'
  }
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
      // What the wallet was logging while the thread was held — the owner
      // when no `done <N>ms` span covers the burst.
      const inside = new Map()
      for (const e of nonFreeze) {
        if (e.at < c.start || e.at > c.end) continue
        const f = family(e.text).slice(0, 120)
        inside.set(f, (inside.get(f) ?? 0) + 1)
      }
      return {
        build: buildAt(c.start),
        secondsAfterLaunch: launch != null ? Math.round((c.start - launch) / 1000) : null,
        durationSeconds: Math.round((c.end - c.start) / 1000),
        freezes: c.stalls.length,
        blockedMs: c.stalls.reduce((a, s) => a + s.ms, 0),
        activeLayers: [...new Set(c.stalls.map((s) => s.during))],
        overlappingWorkloads: [...overlapping.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([label, ms]) => `${label} (${Math.round(ms)}ms overlap)`),
        // Never owners on their own (see WAIT_SPAN_MS), but a long streaming
        // job that is mostly network can still do its per-chunk work inside
        // the burst — name it so the burst is not left ownerless.
        overlappingWaits: [
          ...new Set(
            waits
              .filter((sp) => overlapMs(sp.start, sp.end, c.start, c.end) > 0)
              .map((sp) => `${sp.label} (${Math.round(sp.ms / 1000)}s)`),
          ),
        ].slice(0, 4),
        lineBefore: before ? family(before.text) : null,
        linesBefore: [
          ...new Set(
            nonFreeze
              .filter((e) => e.at < c.start && e.at >= c.start - 15_000)
              .map((e) => family(e.text).slice(0, 120)),
          ),
        ].slice(-8),
        linesInside: [...inside.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([line, n]) => `${n}× ${line}`),
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
  const writesBy = new Map()
  const placeholderWrites = new Map()
  let orphanRemovals = 0
  let refusedWrites = 0
  const censuses = []
  const rows = new Map()

  for (const e of events) {
    let m = ACTIVITY_WRITE_RE.exec(e.text)
    if (m) {
      writes[m[1]] += 1
      const by = `${m[1]} ${m[2]}/${m[3]} · ${family(m[6])}`
      writesBy.set(by, (writesBy.get(by) ?? 0) + 1)
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
    writesBy: [...writesBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([write, count]) => ({ write, count })),
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
const TOKEN_CENSUS_RE = /^\[bsv21\] attestation census (\d+) token\(s\) — (.*)$/
const TOKEN_HEAL_RE = /^\[bsv21\] lineage heal ([0-9a-f]{12}) — (?:bound \((\S+)\)|refused (\S+))/
const TOKEN_OFF_SHELF_RE = /^\[bsv21\] off issuer shelf (.*)$/

/**
 * Why held BSV-21 tokens are or are not on their issuer's shelf: the last
 * attestation census (counts per shelf / missing step), which token sits on
 * each non-`bap` step, and every heal outcome.
 */
function tokenAttestationFacts(events) {
  let census = null
  let censusLines = 0
  let offShelf = []
  const heals = { bound: {}, refused: {} }
  const healedTips = new Set()
  for (const e of events) {
    let m = TOKEN_CENSUS_RE.exec(e.text)
    if (m) {
      censusLines += 1
      census = { tokens: Number(m[1]) }
      offShelf = []
      for (const part of m[2].split(',')) {
        const kv = /^\s*(\S+) (\d+)\s*$/.exec(part)
        if (kv) census[kv[1]] = Number(kv[2])
      }
      continue
    }
    m = TOKEN_OFF_SHELF_RE.exec(e.text)
    if (m) {
      offShelf = m[1].split(';').map((entry) => {
        const [sym, tokenId, step] = entry.trim().split(/\s+/)
        return { sym, tokenId, step }
      })
      continue
    }
    m = TOKEN_HEAL_RE.exec(e.text)
    if (m) {
      healedTips.add(m[1])
      const bucket = m[2] ? heals.bound : heals.refused
      const key = m[2] ?? m[3]
      bucket[key] = (bucket[key] ?? 0) + 1
    }
  }
  return { census, censusLines, offShelf, heals, tipsHealed: healedTips.size }
}

const TOKEN_LEDGER_RE =
  /^\[bsv21\] ledger (\S+) ([0-9a-f]{12}) holds (\d+) in (\d+) tip\(s\) — brc162 (\d+)\/(\d+), legacy-json (\d+)\/(\d+), remittance (\d+)\/(\d+); history in (\d+) out (\d+) over (\d+) row\(s\)(?:; tips (.*))?$/

/**
 * Each token card beside the history that should explain it: the last ledger
 * line per token, split by tip kind (BRC-162 = spendable by send, legacy JSON =
 * read-only, remittance = amount from row metadata alone), the Activity net,
 * and what the card shows beyond that net. Amounts stay strings — they exceed
 * 2^53.
 */
const REMITTANCE_ONLY_RE = /^\[bsv21\] remittance-only tip (\S+) amt=\d+ — (script absent|script \d+B (.+))$/

function tokenLedgerFacts(events) {
  const last = new Map()
  // Why each remittance tip is not spendable, by script state, per outpoint.
  const remittanceScripts = new Map()
  for (const e of events) {
    const m = TOKEN_LEDGER_RE.exec(e.text)
    if (m) last.set(m[2], m)
    const r = REMITTANCE_ONLY_RE.exec(e.text)
    if (r) remittanceScripts.set(r[1], r[3] ?? 'script absent')
  }
  const tokens = [...last.values()].map((m) => {
    const [held, brc162, legacy, remittance, historyIn, historyOut] = [3, 5, 7, 9, 11, 12].map((i) => BigInt(m[i]))
    const historyNet = historyIn - historyOut
    return {
      sym: m[1],
      tokenId: m[2],
      held: String(held),
      tips: Number(m[4]),
      spendable: String(brc162),
      byKind: {
        brc162: { amt: m[5], tips: Number(m[6]) },
        'legacy-json': { amt: m[7], tips: Number(m[8]) },
        remittance: { amt: m[9], tips: Number(m[10]) },
      },
      historyNet: String(historyNet),
      historyRows: Number(m[13]),
      heldBeyondHistory: String(held > historyNet ? held - historyNet : 0n),
      unspendable: String(legacy + remittance),
      tipList: m[14] ? m[14].split(' ') : [],
    }
  })
  const remittanceByScript = {}
  for (const state of remittanceScripts.values()) {
    remittanceByScript[state] = (remittanceByScript[state] ?? 0) + 1
  }
  return {
    tokens,
    beyondHistory: tokens.filter((t) => t.heldBeyondHistory !== '0').length,
    withUnspendable: tokens.filter((t) => t.unspendable !== '0').length,
    remittanceByScript,
  }
}

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
/**
 * What each wallet subsystem said, by shape: numbers, hex and outpoints become
 * placeholders, so a run of 300 "migrate 1 tip" lines reads as one shape × 300.
 * The tags we watch are the import path's; extend WATCHED_TAGS when triage
 * needs another subsystem's story without reading the log.
 */
const WATCHED_TAGS = /^(import|phrase-sweep|legacy|legacy-scan|recompose|cloud-backup|chain-ingest|coordinator|items?|collectables?|1sat|tip-ingest|utxo-heal|spv|minerSubmit|minerOutbox|landing|arcade|activity)$/
function shapeOf(text) {
  return text
    .replace(/[0-9a-f]{64}([._]\d+)?/gi, '<txid>')
    .replace(/[0-9a-f]{16,}…?/gi, '<hex>')
    .replace(/\b1[1-9A-HJ-NP-Za-km-z]{25,34}\b/g, '<addr>')
    .replace(/\d[\d,.]*/g, 'N')
    .slice(0, 160)
}
function tagCensusFacts(events) {
  const byTag = new Map()
  for (const e of events) {
    const tag = TAG_RE.exec(e.text)
    if (!tag || !WATCHED_TAGS.test(tag[1])) continue
    const shapes = byTag.get(tag[1]) ?? new Map()
    const shape = shapeOf(e.text)
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1)
    byTag.set(tag[1], shapes)
  }
  return Object.fromEntries(
    [...byTag].map(([tag, shapes]) => [
      tag,
      [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([shape, count]) => ({ shape, count })),
    ]),
  )
}

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

/* ------------------------------------------------------- app flow facts */

const ACTION_DONE_RE =
  /^\[brc100\] (\w+) (done|failed after) (\d+)ms — (.*)$/
const APPROVAL_RE = /approval (\d+)ms \(user\)/
const PAGE_GAP_RE = /page-gap (\d+)ms \(([^)]+)\)/
/** Longer than a page needs to hear our answer and ask its next step. */
const PAGE_GAP_STALL_MS = 20_000

/**
 * Connected-app steps from the renderer's `[brc100] <method> done` lines.
 * `pageGapMs` is the time between the wallet's previous answer to that origin
 * and this request arriving — the page's own time (its server, a frozen
 * background tab, the user reading) — kept apart from `approvalMs` and
 * `workMs` so a stalled page is never read as a slow approval.
 */
const BRIDGE_FAILED_RE = /^\[brc100\] failed (.*)$/
/** The market overlay's refusal, as the app reported it back through the bridge. */
const OVERLAY_REFUSED_RE = /^\[market-list\] publish failed (.*)$/
/** `key=value key=value…` where a value runs until the next ` key=` token (values are not quoted). */
const FIELD_RE = /(\w+)=(.*?)(?=\s+\w+=|$)/g

function logFields(text) {
  const out = {}
  for (const m of text.matchAll(FIELD_RE)) out[m[1]] = m[2]
  return out
}

const MARKET_LIST_MARK_RE = /^\[market-list\] \+(\d+)ms (.*)$/
const BOUNCE_REFUND_RE = /^\[brc100\] bounce-refund done (\d+)ms/

/** Cumulative `[market-list] +Nms phase` marks → the time each phase actually took. */
function listingPhaseFacts(events) {
  const runs = []
  let marks = []
  const flush = () => {
    if (marks.length < 2) {
      marks = []
      return
    }
    const phases = []
    for (let i = 1; i < marks.length; i += 1) {
      phases.push({
        phase: marks[i].phase,
        ms: marks[i].ms - marks[i - 1].ms,
      })
    }
    runs.push({
      totalMs: marks.at(-1).ms,
      slowest: [...phases].sort((a, b) => b.ms - a.ms)[0],
      phases,
    })
    marks = []
  }
  for (const e of events) {
    const m = MARKET_LIST_MARK_RE.exec(e.text)
    if (!m) continue
    const ms = Number(m[1])
    if (marks.length && ms < marks.at(-1).ms) flush()
    marks.push({ ms, phase: m[2] })
  }
  flush()
  return runs
}

const NATIVE_CRASH_RE = /^\[native-crash\] ([\s\S]+)$/
const KEPT_CHANGE_RE = /^\[stale-output\] kept (\d+) spendable output\(s\) of ([0-9a-f]{12})/
const BACKUP_MISS_RE = /^\[cloud-backup\] ((?:skip (?:push|upload|schedule)|auto-sync (?:skipped|failed)|refusing to encrypt|export rejected|deferral budget spent|defer(?:red)? )[\s\S]*)$/
const HISTORY_EVENTS = [
  ['replace', /^\[cloud-backup\] replace local history — wiping (\S+)/],
  ['restore', /^\[cloud-backup\] restored (\d+) bytes via (\S+) \(inserts=(\d+) updates=(\d+)\)/],
  ['afterReplace', /^\[cloud-backup\] after replace: managed=(\S+) defaultOuts=(\S+) actions=(\S+)/],
  ['emptyLocalPull', /^\[cloud-backup\] empty localState \+ remote BRC-39 — pulling/],
  ['upload', /^\[cloud-backup\] uploading (\d+) bytes → \S+ \(spendable=(\S+) actions=(\S+)\)/],
  ['archiveRestore', /^\[utxo-archive\] restored local snapshot (\S+)/],
  ['recompose', /^\[recompose\] ([\w-]+): history=(\S+) sats=(\S+)/],
  ['historyFailed', /^\[recompose\] history failed \(([\w-]+)\): ([\s\S]{0,240})/],
  ['chainFailed', /^\[recompose\] chain failed \(([\w-]+)\): ([\s\S]{0,240})/],
  ['undecryptable', /^\[cloud-backup\] history blob could not be decrypted/],
  ['noRemote', /^\[cloud-backup\] no remote BRC-39 yet/],
  ['remotePresent', /^\[cloud-backup\] remote BRC-39 present/],
]

/**
 * History-replica writes into localState, in order, beside every Arcade pin
 * that then found no local row. A replace wipes the toolbox store and merges
 * a snapshot that can predate recent sends; the lock overlay survives it, so a
 * pin miss after one names a send the snapshot never held.
 */
function historyReplicaFacts(events) {
  const t0 = events[0]?.at ?? 0
  const timeline = []
  const pinMisses = []
  for (const e of events) {
    const s = Math.round((e.at - t0) / 1000)
    const pin = PIN_MISS_RE.exec(e.text)
    if (pin && pin[1] === 'found no local row') {
      pinMisses.push({ s, txid: pin[2] })
      continue
    }
    for (const [kind, re] of HISTORY_EVENTS) {
      const m = re.exec(e.text)
      if (!m) continue
      const row = { s, at: new Date(e.at).toISOString(), kind }
      if (kind === 'replace') row.store = m[1]
      if (kind === 'restore') Object.assign(row, { bytes: Number(m[1]), crypto: m[2], inserts: Number(m[3]), updates: Number(m[4]) })
      if (kind === 'afterReplace') Object.assign(row, { managed: m[1], defaultOuts: m[2], actions: m[3] })
      if (kind === 'upload') Object.assign(row, { bytes: Number(m[1]), spendable: m[2], actions: m[3] })
      if (kind === 'archiveRestore') row.snapshot = m[1]
      if (kind === 'recompose') Object.assign(row, { reason: m[1], history: m[2], sats: m[3] })
      if (kind === 'historyFailed' || kind === 'chainFailed') Object.assign(row, { reason: m[1], error: m[2] })
      timeline.push(row)
      break
    }
  }
  // Promoting outputs spendable is only safe when nothing spent them; name the
  // caller (last lines before it) so a promotion over spent coins is traceable.
  const keptChange = []
  events.forEach((e, i) => {
    const m = KEPT_CHANGE_RE.exec(e.text)
    if (!m || keptChange.some((k) => k.txid === m[2])) return
    const before = events
      .slice(Math.max(0, i - 6), i)
      .filter((p) => !/^\[(images|stall|longtask|storage)\]/.test(p.text))
      .map((p) => p.text.slice(0, 200))
    keptChange.push({ s: Math.round((e.at - t0) / 1000), txid: m[2], outputs: Number(m[1]), before })
  })
  const writes = timeline.filter((r) => r.kind === 'replace' || r.kind === 'restore' || r.kind === 'archiveRestore')
  const firstWrite = writes[0]?.s
  // Every push that did not end in an upload, grouped by reason: a wallet with
  // zero uploads and no row here never attempted one.
  const pushMisses = new Map()
  for (const e of events) {
    const m = BACKUP_MISS_RE.exec(e.text)
    if (!m) continue
    const family = m[1].replace(/\d[\d.,]*(MB|ms|s)?/g, 'N').replace(/\s+/g, ' ').slice(0, 160)
    const row = pushMisses.get(family) ?? { reason: family, count: 0 }
    row.count++
    pushMisses.set(family, row)
  }
  return {
    replaces: timeline.filter((r) => r.kind === 'replace').length,
    restores: timeline.filter((r) => r.kind === 'restore').length,
    uploads: timeline.filter((r) => r.kind === 'upload').length,
    pushMisses: [...pushMisses.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    pinMissesAfterLocalStateWrite: firstWrite == null ? 0 : pinMisses.filter((p) => p.s >= firstWrite).length,
    pinMisses: [...new Map(pinMisses.map((p) => [p.txid, p])).values()].slice(0, 12),
    keptChange: keptChange.slice(0, 12),
    timeline: [...new Map(timeline.map((r) => [`${r.at}|${r.kind}`, r])).values()].slice(0, 40),
  }
}
const REPUBLISHED_RE = /^\[market-list\] republished txid=([0-9a-f]{64})/
const CANCEL_REFUSED_RE = /MARKET_CANCEL_REFUSED(?: detail=|[\s:]+)([\w-]+)/
const CANCEL_PROVEN_RE = /^\[market\] cancel offer \S+ missing from market-offers — proven by its signed listing/
const PIN_MISS_RE = /^\[stale-output\] pin (found no local row|could not read) for ([0-9a-f]{12})/
const PIN_HIT_RE = /^\[stale-output\] (?:pinned broadcast|restored Arcade-pinned) local tx ([0-9a-f]{12})/
const STORE_USER_MOVED_RE = /^\[stale-output\] storage user moved (\S+) → (\S+)/
const NEVER_SENT_RE = /^\[market-list\] never sent txid=([0-9a-f]{12})/

/**
 * Listings the overlay never indexed and whether each came back, cancels the
 * wallet refused (by code), and Arcade pins that found — or missed — the local
 * tx row. `stillUnpublished` is on chain, signed, and invisible to buyers;
 * `neverSent` listings no miner took, retired so the item is listable again.
 */
function listingOutcomeFacts(events) {
  const failed = new Map()
  const republished = new Set()
  const neverSent = new Set()
  const cancelRefused = {}
  let cancelProvenBySignedListing = 0
  const pins = { hit: 0, noLocalRow: 0, unreadable: 0, storageUserMoved: [] }
  for (const e of events) {
    const t = e.text
    let m = OVERLAY_REFUSED_RE.exec(t)
    if (m) {
      const f = logFields(m[1])
      if (f.txid) failed.set(f.txid, f.reason ?? '')
      continue
    }
    if ((m = REPUBLISHED_RE.exec(t))) {
      republished.add(m[1])
      continue
    }
    if ((m = NEVER_SENT_RE.exec(t))) {
      neverSent.add(m[1])
      continue
    }
    if ((m = CANCEL_REFUSED_RE.exec(t))) {
      cancelRefused[m[1]] = (cancelRefused[m[1]] ?? 0) + 1
      continue
    }
    if (CANCEL_PROVEN_RE.test(t)) {
      cancelProvenBySignedListing += 1
      continue
    }
    if ((m = PIN_MISS_RE.exec(t))) {
      if (m[1] === 'found no local row') pins.noLocalRow += 1
      else pins.unreadable += 1
      continue
    }
    if (PIN_HIT_RE.test(t)) {
      pins.hit += 1
      continue
    }
    if ((m = STORE_USER_MOVED_RE.exec(t))) pins.storageUserMoved.push(`${m[1]}→${m[2]}`)
  }
  return {
    publishFailed: [...failed].map(([txid, reason]) => ({ txid: txid.slice(0, 12), reason })),
    republished: republished.size,
    stillUnpublished: [...failed.keys()]
      .filter((t) => !republished.has(t))
      .map((t) => t.slice(0, 12))
      .filter((t) => !neverSent.has(t)),
    neverSent: [...neverSent],
    cancelRefused,
    cancelProvenBySignedListing,
    pins: { ...pins, storageUserMoved: [...new Set(pins.storageUserMoved)] },
  }
}

const LIFECYCLE_RE = /^\[lifecycle\] (hidden|visible)$/
const PHASE_MS_RE = /(\w+) (\d+)ms/g

/**
 * Page visibility over `[from, to]`: `visible` / `hidden` when it held the
 * whole window, `mixed` when it flipped inside it. Android runs a hidden
 * WebView on a background-priority CPU budget, so the same work is slower —
 * comparing the buckets says how much of a slow step is the platform.
 */
function visibilityTimeline(events) {
  const flips = []
  const seen = new Set()
  for (const e of events) {
    const m = LIFECYCLE_RE.exec(e.text)
    if (!m || seen.has(`${e.at}|${m[1]}`)) continue
    seen.add(`${e.at}|${m[1]}`)
    flips.push({ at: e.at, hidden: m[1] === 'hidden' })
  }
  flips.sort((a, b) => a.at - b.at)
  const hiddenAt = (at) => {
    let hidden = false
    for (const f of flips) {
      if (f.at > at) break
      hidden = f.hidden
    }
    return hidden
  }
  return (from, to) => {
    const start = hiddenAt(from)
    const flipped = flips.some((f) => f.at > from && f.at <= to && f.hidden !== start)
    if (flipped) return 'mixed'
    return start ? 'hidden' : 'visible'
  }
}

function medianOf(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Work and phase medians per `<method> <visibility>` for the answered actions. */
function workByVisibility(steps) {
  const buckets = {}
  for (const s of steps) {
    if (!s.ok || s.workMs < 50) continue
    const b = (buckets[`${s.method} ${s.visibility}`] ??= { steps: 0, work: [], phases: {} })
    b.steps += 1
    b.work.push(s.workMs)
    for (const m of (s.phases ?? '').matchAll(PHASE_MS_RE)) {
      ;(b.phases[m[1]] ??= []).push(Number(m[2]))
    }
  }
  return Object.fromEntries(
    Object.entries(buckets).map(([key, b]) => [
      key,
      {
        steps: b.steps,
        medianWorkMs: medianOf(b.work),
        worstWorkMs: Math.max(...b.work),
        medianPhaseMs: Object.fromEntries(
          Object.entries(b.phases).map(([phase, ms]) => [phase, medianOf(ms)]),
        ),
      },
    ]),
  )
}

const TOOLBOX_STEP_RE = /^\[(toolbox|spend)\] (\S+) done (\d+)ms(?: (\w+))?((?: \w+=\d+ms)*)$/
const STEP_PART_RE = / (\w+)=(\d+)ms/g

function toolboxStepFacts(events) {
  const visibilityOver = visibilityTimeline(events)
  const seen = new Set()
  const steps = new Map()
  for (const e of events) {
    const m = TOOLBOX_STEP_RE.exec(e.text)
    if (!m || seen.has(`${e.at}|${e.text}`)) continue
    seen.add(`${e.at}|${e.text}`)
    const name = m[1] === 'spend' ? `spend.${m[2]}` : m[2]
    const ms = Number(m[3])
    const visibility = visibilityOver(e.at - ms, e.at)
    const row =
      steps.get(name) ?? steps.set(name, { step: name, failed: 0, runs: {}, parts: {} }).get(name)
    if (m[4]) row.failed += 1
    for (const [, part, partMs] of (m[5] ?? '').matchAll(STEP_PART_RE)) {
      ;(row.parts[part] ??= []).push(Number(partMs))
    }
    ;(row.runs[visibility] ??= []).push(ms)
  }
  return [...steps.values()]
    .map(({ step, failed, runs, parts }) => {
      const all = Object.values(runs).flat()
      return {
        step,
        runs: all.length,
        failed,
        totalMs: all.reduce((a, ms) => a + ms, 0),
        worstMs: Math.max(...all),
        medianMsByVisibility: Object.fromEntries(
          Object.entries(runs).map(([visibility, ms]) => [visibility, medianOf(ms)]),
        ),
        ...(Object.keys(parts).length
          ? {
              medianPartMs: Object.fromEntries(
                Object.entries(parts).map(([part, ms]) => [part, medianOf(ms)]),
              ),
            }
          : {}),
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)
}

const SPEND_PROMOTE_RE = /^\[spend-guard\] promote (full|light) done (\d+)ms$/
const SPEND_PROMOTE_STOPPED_RE =
  /^\[stale-output\] promote stopped at (\d+)\/(\d+) live tx\(s\) after (\d+)ms/
const SPEND_PROMOTED_RE =
  /^\[stale-output\] promoted (\d+) pending local change output\(s\), sealed (\d+) input\(s\) from (\d+) live tx\(s\)/
const SEND_MARK_RE = /^\[(brc29|p2pkh|collectables|bsv21)\] \+(\d+)ms (.+)$/
const SEND_STUCK_RE = /^\[payment-progress\] stuck before signing — aborting \S+ (\w+)/
const SEND_REQUESTED_RE = /^\[tx-trace\] requested traceId=\S+ flow=(\S+)/
/** Wallet tags a payment passes through between `requested` and landing. */
const SEND_TRAIL_TAG_RE =
  /^\[(tx-trace|brc29|p2pkh|collectables|bsv21|bsv-send|spend|spend-guard|signed-send|minerSubmit|landing|arcade[\w-]*|self-send|tip-ingest|peer-deliver|remittance[\w-]*|messagebox[\w-]*|inbox[\w-]*|brc29-[\w-]+|payment-progress|send[\w-]*|internalize[\w-]*|activity[\w-]*)\]/
const SEND_TRAIL_MAX = 40
const SEND_TRAIL_WINDOW_MS = 120_000

function trailLine(text) {
  return text
    .replace(/\b[0-9a-f]{64}\b/g, (h) => `${h.slice(0, 12)}…`)
    .replace(/\b0[23][0-9a-f]{64}\b/g, (k) => `${k.slice(0, 10)}…`)
    .slice(0, 180)
}

/**
 * Per-payment prep timeline. A send that the watchdog aborts with no phase
 * mark after `requested` never left the region-entry promote: nothing of the
 * flow's own code ran, so the owner is the change-promotion walk.
 */
function spendPrepFacts(events) {
  const promotes = []
  const stopped = []
  const promoted = []
  const sends = []
  let open = null
  for (const e of events) {
    let m
    for (const s of sends) {
      if (s.trail.length < SEND_TRAIL_MAX && e.at - s.at <= SEND_TRAIL_WINDOW_MS && SEND_TRAIL_TAG_RE.test(e.text)) {
        s.trail.push(`+${e.at - s.at}ms ${trailLine(e.text)}`)
      }
    }
    if ((m = SEND_REQUESTED_RE.exec(e.text))) {
      open = { flow: m[1], at: e.at, marks: [], outcome: 'open', trail: [`+0ms ${trailLine(e.text)}`] }
      sends.push(open)
      continue
    }
    if ((m = SPEND_PROMOTE_RE.exec(e.text))) {
      promotes.push({ mode: m[1], ms: Number(m[2]) })
      if (open) open.marks.push({ phase: `promote ${m[1]}`, atMs: e.at - open.at, ms: Number(m[2]) })
      continue
    }
    if ((m = SPEND_PROMOTE_STOPPED_RE.exec(e.text))) {
      stopped.push({ walked: Number(m[1]), live: Number(m[2]), ms: Number(m[3]) })
      continue
    }
    if ((m = SPEND_PROMOTED_RE.exec(e.text))) {
      promoted.push({ promoted: Number(m[1]), sealed: Number(m[2]), liveTxs: Number(m[3]) })
      continue
    }
    if ((m = SEND_MARK_RE.exec(e.text))) {
      if (open) open.marks.push({ phase: m[3].slice(0, 60), atMs: e.at - open.at, ms: Number(m[2]) })
      if (open && /^createAction /.test(m[3])) open.outcome = 'signed'
      continue
    }
    if ((m = SEND_STUCK_RE.exec(e.text)) && open) {
      open.outcome = open.marks.length === 0 ? 'stuck-in-promote' : `stuck-after:${open.marks.at(-1).phase}`
      open.stuckAfterMs = e.at - open.at
      open = null
    }
  }
  const abortedInPromote = sends.filter((s) => s.outcome === 'stuck-in-promote').length
  return {
    sends: sends.length,
    signed: sends.filter((s) => s.outcome === 'signed').length,
    abortedInPromote,
    abortedAfterPhase: Object.fromEntries(
      sends
        .filter((s) => s.outcome.startsWith('stuck-after:'))
        .map((s) => [s.outcome.slice('stuck-after:'.length), 1])
        .reduce((acc, [k, v]) => acc.set(k, (acc.get(k) ?? 0) + v), new Map()),
    ),
    promotes: {
      runs: promotes.length,
      worstMs: promotes.reduce((a, p) => Math.max(a, p.ms), 0),
      byMode: Object.fromEntries(
        ['full', 'light'].map((mode) => [
          mode,
          promotes.filter((p) => p.mode === mode).map((p) => p.ms),
        ]),
      ),
      stoppedAtBudget: stopped,
      promoted,
    },
    timelines: sends.slice(-6).map((s) => ({
      flow: s.flow,
      outcome: s.outcome,
      ...(s.stuckAfterMs != null ? { stuckAfterMs: s.stuckAfterMs } : {}),
      marks: s.marks.map((mk) => `${mk.atMs}ms ${mk.phase}`),
      trail: s.trail,
    })),
  }
}

const NOTIFY_POSTED_RE = /^\[mobile-notifications\] posted channel=(\S+)/
const NOTIFY_SKIPPED_RE = /^\[mobile-notifications\] skipped kind=(\S+) reason=(\S+)/
const NOTIFY_FAILED_RE = /^\[mobile-notifications\] (\S+) failed: (.*)$/
const NOTIFY_GRACE_RE = /^\[mobile-notifications\] kind=(\S+) wallet left screen within grace$/
const BRIDGE_VALUE_OK_RE = /^\[brc100\] ok method=(createAction|internalizeAction) /
const BRIDGE_DELIVER_RE = /^\[spend\] bridge_deliver done (\d+)ms$/
/** A bridge reply and its notification land in the same task burst. */
const NOTIFY_WINDOW_MS = 5_000
/** An on-screen skip this close to a hide was never seen by the user. */
const SKIP_THEN_HIDDEN_MS = 3_000
/** A socket-to-WebView hop this slow was parked, not working. */
const PARKED_DELIVER_MS = 5_000
/** Log lines of one resume land within this of the `visible` flip. */
const RESUME_WINDOW_MS = 1_500

/**
 * Mobile activity notifications against the bridge actions that should have
 * raised one: every createAction / internalizeAction answered while the
 * WebView was hidden.
 */
function notificationFacts(events) {
  const visibilityOver = visibilityTimeline(events)
  const seen = new Set()
  const posted = []
  const postedByChannel = {}
  const skipped = {}
  const failed = {}
  const hiddenActions = []
  const onScreenSkips = []
  const skipAts = []
  const flips = []
  const delivers = []
  let postedWithinGrace = 0
  for (const e of events) {
    const key = `${e.at}|${e.text}`
    if (seen.has(key)) continue
    seen.add(key)
    const l = LIFECYCLE_RE.exec(e.text)
    if (l) {
      flips.push({ at: e.at, hidden: l[1] === 'hidden' })
      continue
    }
    const d = BRIDGE_DELIVER_RE.exec(e.text)
    if (d) {
      delivers.push({ at: e.at, ms: Number(d[1]) })
      continue
    }
    if (NOTIFY_GRACE_RE.test(e.text)) {
      postedWithinGrace += 1
      continue
    }
    const p = NOTIFY_POSTED_RE.exec(e.text)
    if (p) {
      posted.push(e.at)
      postedByChannel[p[1]] = (postedByChannel[p[1]] ?? 0) + 1
      continue
    }
    const s = NOTIFY_SKIPPED_RE.exec(e.text)
    if (s) {
      const k = `${s[1]} ${s[2]}`
      skipped[k] = (skipped[k] ?? 0) + 1
      if (s[2] === 'onScreen') onScreenSkips.push({ at: e.at, kind: s[1] })
      skipAts.push(e.at)
      continue
    }
    const f = NOTIFY_FAILED_RE.exec(e.text)
    if (f) {
      const k = `${f[1]}: ${f[2].slice(0, 80)}`
      failed[k] = (failed[k] ?? 0) + 1
      continue
    }
    const a = BRIDGE_VALUE_OK_RE.exec(e.text)
    if (a && visibilityOver(e.at, e.at) === 'hidden') {
      hiddenActions.push({ at: e.at, method: a[1] })
    }
  }
  // The log ring can drop a `[lifecycle] visible` line; the wallet's own skip
  // decision (logged in the same burst) outranks the reconstructed timeline.
  const answeredWithin = (ats, a) =>
    ats.some((at) => Math.abs(at - a.at) <= NOTIFY_WINDOW_MS)
  const silent = hiddenActions.filter(
    (a) => !posted.some((at) => at >= a.at && at - a.at <= NOTIFY_WINDOW_MS) && !answeredWithin(skipAts, a),
  )
  const skippedThenHidden = onScreenSkips.filter((s) =>
    flips.some((f) => f.hidden && f.at >= s.at && f.at - s.at <= SKIP_THEN_HIDDEN_MS),
  )
  const parked = delivers.filter((d) => d.ms >= PARKED_DELIVER_MS)
  const parkedUntilResume = parked.filter((d) =>
    flips.some((f) => !f.hidden && Math.abs(d.at - f.at) <= RESUME_WINDOW_MS),
  )
  return {
    posted: posted.length,
    postedByChannel,
    skipped,
    failed,
    hiddenValueActions: hiddenActions.length,
    hiddenValueActionsWithoutNotification: silent.length,
    silentExamples: silent.slice(0, 5).map((a) => ({
      method: a.method,
      at: new Date(a.at).toISOString(),
    })),
    onScreenSkipsThenHidden: skippedThenHidden.length,
    postedWithinGrace,
    bridgeDeliversParked: parked.length,
    bridgeDeliversParkedUntilResume: parkedUntilResume.length,
    parkedWorstMs: parked.length ? Math.max(...parked.map((d) => d.ms)) : null,
  }
}

const RESIGN_RE =
  /^\[(?:brc100\] createAction|certainty\] [0-9a-f]{12}) signing again with live coins$/
const DEAD_SWEEP_RE =
  /^\[dead-coins\] sweep checked=(\d+) hidden=(\d+) unknown=(\d+) done (\d+)ms$/
const SPENDER_TALLY_RE = /^\[dead-coins\] spenders (.*)$/
const PEER_READ_RE =
  /^\[peer-device\] snapshot \d+ (\w+)(?: spent=(\d+) withdrawn=(\d+))? txs=\d+ done (\d+)ms$/
const PEER_UNREAD_RE = /^\[peer-device\] snapshot \d+ unread\b/

/**
 * Resigns over coins a confirmed foreign tx spent, the pool sweeps they set
 * off, and coins another install of this key spent (read from its BRC-39 upload).
 */
const SERVER_WALLET_RE = /^\[(?:server-wallet|dev-key)\] (.*)$/

/**
 * Dev key wallets: funds recorded, internalizes into its storage that
 * landed or were deferred (with the reason), refresh failures, open time.
 */
function serverWalletFacts(events) {
  const facts = {
    funded: 0,
    internalized: 0,
    deferred: {},
    refreshFailed: {},
    recovered: 0,
    recoverFailed: {},
    openMs: [],
  }
  // Failures carry the build that hit them: an upload spans launches, and a
  // fix is only proven absent in the launches running it.
  let build = 'unknown'
  const bump = (bucket, reason) => {
    const key = `${reason.replace(/[0-9a-f]{12,}/g, '<id>').slice(0, 160)} [v${build}]`
    bucket[key] = (bucket[key] ?? 0) + 1
  }
  for (const e of events) {
    const launch = /^App log capture started — v(\S+)/.exec(e.text)
    if (launch) build = launch[1]
    const m = SERVER_WALLET_RE.exec(e.text)
    if (!m) continue
    const line = m[1]
    let r
    if (/^funded \d+ sats/.test(line)) facts.funded += 1
    else if (/^fund \S+ internalized/.test(line)) facts.internalized += 1
    else if ((r = /^fund \S+ internalize deferred — (.*)$/.exec(line))) bump(facts.deferred, r[1])
    else if ((r = /^refresh failed — (.*)$/.exec(line))) bump(facts.refreshFailed, r[1])
    else if (/^recovered \d+ sats/.test(line)) facts.recovered += 1
    else if ((r = /^recover failed — (.*)$/.exec(line))) bump(facts.recoverFailed, r[1])
    else if ((r = /^open done (\d+)ms$/.exec(line))) facts.openMs.push(Number(r[1]))
  }
  return facts
}

/**
 * BSV-21 sends: how far each attempt got (panel start → plan → createAction
 * → txid) and the named reason it stopped, tagged with the build that hit it.
 */
function tokenSendFacts(events) {
  const facts = {
    started: 0,
    planned: 0,
    signing: 0,
    signed: 0,
    sent: 0,
    failed: {},
    blocked: {},
    refused: {},
    lastPlan: null,
    // Combine tips: started / done, with every refusal and failure reason.
    combine: { started: 0, done: 0, failed: {} },
    // Every later line naming a signed send's txid, in order and deduped:
    // where the transfer went after the wallet signed it.
    trails: [],
    // Wallet lines after each `send start`, until it plans, ends or 20 lines:
    // where a send that never planned was waiting.
    starts: [],
    // Wallet lines from each `send plan` to its failure: where a planned
    // send died before it had a txid to trail.
    failedPlans: [],
    // A plan the upload ended on with no `sent` and no failure: where the
    // send was still waiting when the user gave up.
    stalledPlans: [],
    // Toolbox inputBEEF packaging: bodies dropped for missing parents, and
    // packages a chain tracker still refused (send then signs from storage).
    inputBeef: { framed: 0, dropped: 0, trackerRefused: 0 },
    // Asset rows the stale-output path set spendable again, by outpoint.
    restoredAssets: [],
  }
  let startTrail = null
  let planTrail = null
  let build = 'unknown'
  const bump = (bucket, reason) => {
    const key = `${reason.replace(/[0-9a-f]{12,}/g, '<id>').slice(0, 200)} [v${build}]`
    bucket[key] = (bucket[key] ?? 0) + 1
  }
  const open = new Map()
  for (const e of events) {
    const launch = /^App log capture started — v(\S+)/.exec(e.text)
    if (launch) build = launch[1]
    const t = e.text
    for (const [prefix, trail] of open) {
      if (!t.includes(prefix) || trail.lines.length >= 25) continue
      const line = `${t.replaceAll(prefix, '<send>').replace(/[0-9a-f]{12,}/g, '<id>').slice(0, 220)} [v${build}]`
      if (!trail.lines.includes(line)) trail.lines.push(line)
    }
    let r
    if (
      (r = /^\[bsv21\] createAction done txid=([0-9a-f]{64})/.exec(t)) &&
      !open.has(r[1].slice(0, 12))
    ) {
      const trail = { txid: r[1], build, lines: [] }
      facts.trails.push(trail)
      open.set(r[1].slice(0, 12), trail)
    }
    if (startTrail) {
      const ms = e.at - startTrail.atMs
      if (ms >= 0 && /^\[[\w-]+\]/.test(t)) {
        const shape = t.replace(/[0-9a-f]{12,}/g, '<id>').replace(/\d+/g, '<n>').slice(0, 200)
        const prior = startTrail.lines.find((l) => l.shape === shape)
        if (prior) prior.times += 1
        else startTrail.lines.push({ shape, first: `+${ms}ms ${t.replace(/[0-9a-f]{12,}/g, '<id>').slice(0, 200)}`, times: 1 })
      }
      startTrail.lastSeenMs = ms
      if (ms < 0 || /^\[bsv21\] send plan|^\[send-token\] (sent|send failed)/.test(t) || startTrail.lines.length >= 30) {
        startTrail.ended = t.slice(0, 120)
        startTrail = null
      }
    }
    if (planTrail) {
      const ms = e.at - planTrail.atMs
      if (ms >= 0 && /^\[[\w-]+\]/.test(t) && !/^\[nav\]/.test(t)) {
        const shape = t.replace(/[0-9a-f]{12,}/g, '<id>').replace(/\d+/g, '<n>').slice(0, 240)
        const prior = planTrail.lines.find((l) => l.shape === shape)
        if (prior) prior.times += 1
        else if (planTrail.lines.length < 30) planTrail.lines.push({ shape, first: `+${ms}ms ${t.replace(/[0-9a-f]{12,}/g, '<id>').slice(0, 240)}`, times: 1 })
      }
      if (ms < 0 || /^\[send-token\] sent$/.test(t)) planTrail = null
      else if (/^\[send-token\] send failed/.test(t)) {
        facts.failedPlans.push(planTrail)
        planTrail = null
      }
    }
    if ((r = /^\[bsv21\] send plan (.*)$/.exec(t))) {
      if (planTrail) facts.stalledPlans.push(planTrail)
      planTrail = { plan: r[1].replace(/[0-9a-f]{12,}/g, '<id>'), build, at: new Date(e.at).toISOString(), atMs: e.at, lines: [] }
    }
    if ((r = /^\[send-token\] send start (.*)$/.exec(t))) {
      facts.started += 1
      startTrail = { token: r[1], build, at: new Date(e.at).toISOString(), atMs: e.at, lines: [], ended: null, lastSeenMs: 0 }
      facts.starts.push(startTrail)
    }
    else if ((r = /^\[stale-output\] restore done .* restored proven-unspent asset ([0-9a-f]{64}\.\d+)/.exec(t))) {
      if (!facts.restoredAssets.includes(r[1])) facts.restoredAssets.push(r[1])
    }
    else if ((r = /^\[bsv21(?:-burn)?\] inputBEEF framed — dropped (\d+)/.exec(t))) {
      facts.inputBeef.framed += 1
      facts.inputBeef.dropped += Number(r[1])
    }
    else if (/^\[bsv21(?:-burn)?\] inputBEEF refused by the chain tracker/.test(t)) facts.inputBeef.trackerRefused += 1
    else if (/^\[send-token\] sent$/.test(t)) facts.sent += 1
    else if ((r = /^\[send-token\] send failed — (.*)$/.exec(t))) bump(facts.failed, r[1])
    else if ((r = /^\[send-token\] blocked — (.*)$/.exec(t))) bump(facts.blocked, r[1])
    else if ((r = /^\[bsv21\] send plan (.*)$/.exec(t))) {
      facts.planned += 1
      facts.lastPlan = `${r[1]} at ${new Date(e.at).toISOString()}`
    } else if (/^\[bsv21\] createAction start/.test(t)) facts.signing += 1
    else if (/^\[bsv21\] createAction done/.test(t)) facts.signed += 1
    else if ((r = /^\[bsv21\] send refused before sign: (.*)$/.exec(t))) bump(facts.refused, r[1])
    else if ((r = /^\[bsv21\] pre-sign refuse (.*)$/.exec(t))) bump(facts.refused, r[1])
    else if ((r = /^\[bsv21\] (tip restore after failed send skipped.*)$/.exec(t))) bump(facts.refused, r[1])
    else if (/^\[bsv21\] combine start/.test(t)) facts.combine.started += 1
    else if (/^\[bsv21\] combine done/.test(t)) facts.combine.done += 1
    else if ((r = /^\[bsv21\] combine (?:failed|refused) — (.*)$/.exec(t))) {
      bump(facts.combine.failed, r[1].replace(/[0-9a-f]{12,}/g, '<id>').slice(0, 200))
    }
  }
  if (planTrail) {
    planTrail.waitedMs = (events.at(-1)?.at ?? planTrail.atMs) - planTrail.atMs
    facts.stalledPlans.push(planTrail)
  }
  return facts
}

/**
 * Chain ingest and recovery as they ran: every address scan, token / ordinal
 * index answer, import outcome, wipe-gate verdict and recover-from-tx claim,
 * grouped. A recovered wallet missing an asset shows here as a scan that never
 * ran, an index that failed, a tip that never imported, or a wipe overridden.
 */
function chainIngestFacts(events) {
  const lines = {}
  let build = 'unknown'
  for (const e of events) {
    const launch = /^App log capture started — v(\S+)/.exec(e.text)
    if (launch) build = launch[1]
    if (!/^\[(chain-ingest|token-scan|ordinal-scan|wipe|recover-tx)\]/.test(e.text)) continue
    const key = `${e.text
      .replace(/[0-9a-f]{12,}(\.\d+)?/g, '<id>')
      .replace(/\b\d+\b/g, '<n>')
      .slice(0, 200)} [v${build}]`
    lines[key] = (lines[key] ?? 0) + 1
  }
  return Object.entries(lines)
    .sort((a, b) => b[1] - a[1])
    .map(([line, count]) => ({ line, count }))
}

const BSV21_LIST_DONE_RE = /^\[bsv21\] listOutputs done \d+ms — live (\d+) token\(s\) \/ (\d+) tip\(s\), showing (\d+)(?:, (\d+) tip\(s\) left the basket)?(?:, (\d+) tip\(s\) unstored)?/
const ITEMS_KEPT_RE = /^\[collectables\] kept (\d+) cached item\(s\) while basket listed (\d+)/
const ITEMS_RETIRED_RE = /^\[collectables\] retired (\d+) card\(s\)/
/** `[holdings] <asset> <txid.vout> [(label)] <event>` — one line per reconcile step. */
const HOLDINGS_RE = /^\[holdings\] (token|item) ([0-9a-f]{64}\.\d+)(?: \([^)]*\))? (.+)$/
const HOLDINGS_CLAIM_RE = /^\[holdings\] claim [0-9a-f]{12} — ours=(\d+) tokens=(\d+) items=(\d+)(?: unrecognized=\d+ spent=(\d+) skipped=(\d+))?(?: restored=(\d+))?/

/**
 * Cards painted vs what the wallet's basket actually holds, and the holdings
 * reconcile that settles every disagreement with one chain answer. Counts
 * reads, deferrals, what each reconcile step decided, and which outpoints are
 * still open at the end of the upload (filed, never closed).
 */
function holdingsFacts(events) {
  const tokens = {
    reads: 0,
    deferred: 0,
    timedOut: 0,
    busyMidRead: 0,
    readsShowingMore: 0,
    leftBasket: 0,
    last: null,
    // Per launch: how many token cards were painted at each read decision.
    // A launch whose first entry shows 0 painted nothing from the saved list.
    byLaunch: [],
  }
  let launch = null
  const tokenStep = (e, kind, cards) => {
    if (!launch) {
      launch = { build: null, at: new Date(e.at).toISOString(), steps: [] }
      tokens.byLaunch.push(launch)
    }
    if (launch.steps.length < 12) {
      launch.steps.push({ s: Math.round((e.at - Date.parse(launch.at)) / 1000), kind, cards })
    }
  }
  const items = { kept: 0, retired: 0, deferred: 0, busyMidRead: 0, idleRelists: 0, failed: 0, last: null }
  const reconcile = {
    filed: { 'left-basket': 0, 'off-chain-index': 0, unstored: 0, 'failed-send': 0 },
    closed: {},
    retiredSpent: 0,
    retiredByAsset: {},
    // A token retired as spent is a balance the wallet stopped counting: each
    // carries the same trail as an open entry.
    retiredTokens: [],
    restored: 0,
    restoreRefused: 0,
    // Unspent-on-chain rows the reconcile could not restore, by named reason.
    notRestored: {},
    claimsStarted: 0,
    claims: 0,
    claimedNothing: 0,
    // Outputs a claim found ours and unspent that the import guard passed over.
    claimSkipped: 0,
    claimSpent: 0,
    // Rows a claim left in storage that the same pass then made spendable.
    claimRestored: 0,
    claimFailed: 0,
    // Claims queued with no outcome line by the end of the upload, and how
    // long before the last line each was queued.
    claimsUnfinished: [],
    kept: {},
    open: [],
  }
  const open = new Map()
  const pendingClaims = new Map()
  for (const e of events) {
    const t = e.text
    const started = /^App log capture started — v(\S+)/.exec(t)
    if (started) {
      launch = { build: started[1], at: new Date(e.at).toISOString(), steps: [] }
      tokens.byLaunch.push(launch)
      continue
    }
    const cardsAt =
      /^\[bsv21\] deferring listOutputs — wallet busy, using (\d+) cached/.exec(t) ??
      /^\[bsv21\] listOutputs timed out after \S+ — keeping (\d+) cached/.exec(t)
    if (cardsAt) tokenStep(e, t.includes('deferring') ? 'deferred' : 'timed-out', Number(cardsAt[1]))
    const done = BSV21_LIST_DONE_RE.exec(t)
    if (done) {
      const [live, tips, showing] = done.slice(1, 4).map(Number)
      tokenStep(e, 'read', showing)
      tokens.reads += 1
      tokens.leftBasket += Number(done[4] ?? 0)
      if (showing > live) tokens.readsShowingMore += 1
      // Shown from our own signed bytes with no storage row — not spendable until claimed.
      const unstored = Number(done[5] ?? 0)
      tokens.last = { live, tips, showing, unstored, at: new Date(e.at).toISOString() }
      continue
    }
    if (/^\[bsv21\] deferring listOutputs/.test(t)) tokens.deferred += 1
    else if (/^\[bsv21\] listOutputs timed out/.test(t)) tokens.timedOut += 1
    else if (/^\[bsv21\] wallet went busy during the read/.test(t)) tokens.busyMidRead += 1
    const kept = ITEMS_KEPT_RE.exec(t)
    if (kept) {
      items.kept += 1
      items.last = { cached: Number(kept[1]), listed: Number(kept[2]), at: new Date(e.at).toISOString() }
      continue
    }
    const retired = ITEMS_RETIRED_RE.exec(t)
    if (retired) items.retired += Number(retired[1])
    else if (/^\[collectables\] deferring listOutputs/.test(t)) items.deferred += 1
    else if (/^\[collectables\] wallet went busy during the read/.test(t)) items.busyMidRead += 1
    else if (/^\[stale-output\] restore refused — \S+ reserved by/.test(t)) reconcile.restoreRefused += 1
    else if (/^\[collectables\] wallet idle — running the deferred listOutputs/.test(t)) items.idleRelists += 1
    else if (/^\[collectables\] listOutputs (timed out|failed)/.test(t)) items.failed += 1

    const ended = /^\[holdings\] claim ([0-9a-f]{12})/.exec(t)
    if (ended) pendingClaims.delete(ended[1])
    const claim = HOLDINGS_CLAIM_RE.exec(t)
    if (claim) {
      reconcile.claims += 1
      if (Number(claim[2]) + Number(claim[3]) === 0) reconcile.claimedNothing += 1
      reconcile.claimSkipped += Number(claim[5] ?? 0)
      reconcile.claimSpent += Number(claim[4] ?? 0)
      reconcile.claimRestored += Number(claim[6] ?? 0)
      continue
    }
    if (/^\[holdings\] claim \S+ failed/.test(t)) {
      reconcile.claimFailed += 1
      continue
    }
    const step = HOLDINGS_RE.exec(t)
    if (!step) continue
    const [, asset, outpoint, event] = step
    const at = new Date(e.at).toISOString()
    let m
    if ((m = /^(left-basket|off-chain-index) — checking chain/.exec(event))) {
      reconcile.filed[m[1]] += 1
      open.set(outpoint, { asset, outpoint, gap: m[1], last: 'filed', at })
    } else if (/^unstored — claiming/.test(event)) {
      reconcile.filed.unstored += 1
      open.set(outpoint, { asset, outpoint, gap: 'unstored', last: 'filed', at })
    } else if (/^returned by a failed send/.test(event)) {
      reconcile.filed['failed-send'] += 1
      open.set(outpoint, { asset, outpoint, gap: 'failed-send', last: 'filed', at })
    } else if ((m = /^closed — (\S+)/.exec(event))) {
      reconcile.closed[m[1]] = (reconcile.closed[m[1]] ?? 0) + 1
      open.delete(outpoint)
    } else if (/^retired — spent on chain/.test(event)) {
      reconcile.retiredSpent += 1
      reconcile.retiredByAsset[asset] = (reconcile.retiredByAsset[asset] ?? 0) + 1
      if (asset === 'token') reconcile.retiredTokens.push({ asset, outpoint, gap: open.get(outpoint)?.gap, last: 'retired', at })
      open.delete(outpoint)
    } else if (/^unspent on chain/.test(event)) {
      if (/row restored/.test(event)) reconcile.restored += 1
      const notRestored = /row not restored — (\S+)/.exec(event)
      if (notRestored) {
        reconcile.notRestored[notRestored[1]] = (reconcile.notRestored[notRestored[1]] ?? 0) + 1
      }
      if (/claiming/.test(event)) {
        reconcile.claimsStarted += 1
        if (!pendingClaims.has(outpoint.slice(0, 12))) pendingClaims.set(outpoint.slice(0, 12), e.at)
      }
      const row = open.get(outpoint)
      open.set(outpoint, { ...(row ?? { asset, outpoint }), last: 'unspent', at })
    } else if ((m = /^kept — (\S+)/.exec(event))) {
      reconcile.kept[m[1]] = (reconcile.kept[m[1]] ?? 0) + 1
      const row = open.get(outpoint)
      open.set(outpoint, { ...(row ?? { asset, outpoint }), last: m[1], at })
    }
  }
  reconcile.open = [...open.values()]
  const lastAt = events.at(-1)?.at ?? 0
  reconcile.claimsUnfinished = [...pendingClaims].map(([txid, at]) => ({
    txid,
    queuedSecondsBeforeEnd: Math.round((lastAt - at) / 1000),
  }))
  // Every line naming an open outpoint's txid, in order and deduped by shape:
  // what removed the row, and what each claim did with it.
  const trailed = [...reconcile.open, ...reconcile.retiredTokens]
  const trails = new Map(trailed.map((o) => [o.outpoint.slice(0, 12), []]))
  let build = 'unknown'
  for (const e of events) {
    const launch = /^App log capture started — v(\S+)/.exec(e.text)
    if (launch) build = launch[1]
    for (const [prefix, lines] of trails) {
      if (!e.text.includes(prefix)) continue
      const text = e.text.replace(new RegExp(`${prefix}[0-9a-f]*`, 'g'), '<this>')
      const shape = text.replace(/[0-9a-f]{12,}/g, '<id>').replace(/\d+/g, '<n>').slice(0, 200)
      const prior = lines.find((l) => l.shape === shape)
      if (prior) prior.times += 1
      else if (lines.length < 20) {
        lines.push({ shape, first: `${new Date(e.at).toISOString()} [v${build}] ${text.replace(/[0-9a-f]{12,}/g, '<id>').slice(0, 220)}`, times: 1 })
      }
    }
  }
  for (const o of trailed) o.trail = trails.get(o.outpoint.slice(0, 12)) ?? []
  return { tokens, items, reconcile }
}

const RECEIPT_MERGE_RE = /^\[activity\] merged earned\/(receive-collectable|receive-token) \d+ sat ([0-9a-f]{12})… — into row \d+ of \d+, first seen (\S+)/
const CARD_REENTRY_RE = /^\[collectables\] re-entered (\d+) announced card\(s\)/

/**
 * Receives replayed long after they landed: an item receipt merged again into
 * a row first seen before this upload began, and announced cards that dropped
 * out of the inventory cache and came back. Either one shows up as items
 * "arriving" that never did.
 */
function receiptReplayFacts(events) {
  const t0 = events[0]?.at ?? 0
  const byTxid = new Map()
  let reentries = 0
  let reenteredCards = 0
  for (const e of events) {
    const re = CARD_REENTRY_RE.exec(e.text)
    if (re) {
      reentries += 1
      reenteredCards += Number(re[1])
      continue
    }
    const m = RECEIPT_MERGE_RE.exec(e.text)
    if (!m) continue
    const firstSeen = Date.parse(m[3])
    if (!Number.isFinite(firstSeen) || firstSeen >= t0) continue
    const row = byTxid.get(m[2]) ?? { txid: m[2], method: m[1], firstSeen: m[3], merges: 0 }
    row.merges += 1
    byTxid.set(m[2], row)
  }
  const replayed = [...byTxid.values()].sort((a, b) => b.merges - a.merges)
  return {
    replayedReceipts: replayed.length,
    replayMerges: replayed.reduce((n, r) => n + r.merges, 0),
    replayed: replayed.slice(0, 10),
    reentries,
    reenteredCards,
  }
}

const SWITCH_DONE_RE =
  /^\[vault-account\] switch done (\d+)ms — (warm|cold) a(\d+), ingest drain (\d+)ms$/
const PREWARM_DONE_RE = /^\[vault-account\] prewarm a(\d+) done (\d+)ms$/

/** Sub-account switches: warm reuse vs cold Toolbox build, and the ingest fence. */
function accountSwitchFacts(events) {
  const switches = []
  const prewarms = []
  for (const e of events) {
    const s = SWITCH_DONE_RE.exec(e.text)
    if (s) {
      switches.push({ ms: Number(s[1]), kind: s[2], account: Number(s[3]), drainMs: Number(s[4]) })
      continue
    }
    const p = PREWARM_DONE_RE.exec(e.text)
    if (p) prewarms.push({ account: Number(p[1]), ms: Number(p[2]) })
  }
  const of = (kind) => switches.filter((s) => s.kind === kind)
  const max = (rows, key) => rows.reduce((m, r) => Math.max(m, r[key]), 0)
  return {
    switches: switches.length,
    warm: of('warm').length,
    cold: of('cold').length,
    slowestWarmMs: max(of('warm'), 'ms'),
    slowestColdMs: max(of('cold'), 'ms'),
    slowestDrainMs: max(switches, 'drainMs'),
    prewarms: prewarms.length,
    slowestPrewarmMs: max(prewarms, 'ms'),
  }
}

const IMPORT_LINES = [
  ['asked', /^\[import\] opened \/migrate for HandCash history/],
  ['hints', /^\[import\] HandCash recovery hints txids=(\d+) complete=(true|false) sats=(\d+) items=(\d+)(?: origins=(\d+))?/],
  ['arrived', /^\[import\] HandCash history arrived txids=(\d+)/],
  ['noHints', /^\[import\] key recovery opened without HandCash history/],
  ['mismatch', /^\[import\] HandCash history is for \$(\S+), these keys prove \$(\S+)/],
  ['utxoSet', /^\[import\] utxo set done (\d+)ms utxos=(\d+) pages=(\d+)/],
  ['utxoSetRefused', /^\[import\] utxo set refused reason=(\S+)(?: detail=(.*?))?(?: after (\d+)ms| rows=(\d+)|$)/],
  ['utxoSetVerified', /^\[import\] utxo set verified addresses=(\d+) cash=(\d+) itemAddresses=(\d+)(?: read=(\d+))? rejected=(\d+)(?: derived=(\d+))?(?: done (\d+)ms)?/],
  ['utxoSetCash', /^\[import\] utxo set cash done (\d+)ms outputs=(\d+) unspent=(\d+) unknown=(\d+) viaExplorer=(\d+)/],
  ['utxoSetItems', /^\[import\] utxo set items done (\d+)ms outpoints=(\d+) unspent=(\d+) failed=(\d+)/],
  ['itemOwners', /^\[import\] item owners done (\d+)ms origins=(\d+) located=(\d+) unspent=(\d+) owners=(\d+)(?: missing=(\d+))? failed=(\d+)/],
  ['history', /^\[import\] hinted history done (\d+)ms txs=(\d+) unknown=(\d+) failed=(\d+) addresses=(\d+)(?: upTo=(\d+)\/(\d+))?/],
  ['window', /^\[import\] hinted window txs=(\d+)\/(\d+) mayHold=(\d+) used=(\d+) verdict=(\S+)/],
  ['historyReadFailed', /^\[import\] hinted tx read failed for (\d+) tx/],
  ['discover', /^\[import\] discover done (\d+)ms checked=(\d+) used=(\d+) complete=(true|false)/],
  ['addressLookupFailed', /^\[import\] history lookup failed for (\d+) address/],
  ['holdings', /^\[import\] holdings done (\d+)ms addresses=(\d+)(?: read=(\d+))?/],
  ['settled', /^\[import\] hinted scan settled sats=(\d+) items=(\d+) of sats=(\d+) items=(\d+)/],
  ['refused', /^\[import\] hinted scan refused reason=(\S+)/],
  ['sweep', /^\[import\] sweep done (\d+)ms kind=(\S+) cash=(\d+)sats items=(\d+) tokens=(\d+) failed=(\d+)/],
  ['batchMoved', /^\[phrase-sweep\] moved (\d+) collectable\(s\) in (\d+) transaction/],
  ['bundleRejected', /^\[phrase-sweep\] bundleRejected: (\d+) tips → retrying (\d+) \((.*)\)$/],
  ['itemFailed', /^\[phrase-sweep\] item migrate failed (\S+) (.*)$/],
  ['abortRefused', /^\[phrase-sweep\] could not abort failed migrate of (\d+) input/],
  ['tipUnreadable', /^\[phrase-sweep\] tip unreadable (\S+) (.*)$/],
  ['cashSweep', /^\[legacy\] sweep coins=(\d+) tx=(\d+) done (\d+)ms/],
  ['cashBundleRefused', /^\[legacy\] sweep bundle of (\d+) refused — retrying (\d+)/],
  ['itemsSynced', /^\[import\] items synced (\d+) addresses=(\d+) complete=(true|false) stopped=(true|false) done (\d+)ms/],
  ['itemsChainChecked', /^\[import\] items chain-checked (\d+) spent=(\d+) unknown=(\d+) stopped=(true|false) done (\d+)ms/],
  ['utxoSetListed', /^\[import\] utxo set listed done (\d+)ms outputs=(\d+) unspent=(\d+) unknown=(\d+) viaExplorer=(\d+)/],
  ['queued', /^\[import\] queued (\d+) item/],
  ['itemsDone', /^\[import\] items done (\d+)ms chosen=(\d+) moved=(\d+) tx=(\d+) keys=(\d+)((?: refused\.\S+=\d+)*)(?: stopped=(\S+))?/],
  ['chosenDone', /^\[phrase-sweep\] chosen done (\d+)ms items=(\d+) keys=(\d+) moved=(\d+)(?: tx=(\d+))?/],
  ['runDone', /^\[import\] run done (\d+)ms items=(\d+) answered=(\d+) sources=(\d+) outcome=(\S+)/],
  ['migratePackage', /^\[phrase-sweep\] migrate package ([0-9a-f]{12}) inputs=(\d+) bytes=(\d+)(?: durable=(\d+))?(?: ef=(\d+))?(?: in=(\d+))?/],
  ['busyWait', /^\[phrase-sweep\] wallet busy — waiting to send (\d+) \((\d+)\/(\d+)\)(?: held=(.{0,160}))?/],
  ['busyWaitDone', /^\[phrase-sweep\] busy wait done (\d+)ms idle=(true|false)(?: held=(.{0,160}))?/],
  ['waitingForPayments', /^\[phrase-sweep\] waiting for payments (\d+)s — (.{0,160})/],
  ['migrateTimed', /^\[phrase-sweep\] migrate ([0-9a-f]{12}) done (\d+)ms create=(\d+)ms sign=(\d+)ms(?: pack=(\d+)ms)? post=(\d+)ms/],
  ['yieldedToPayments', /^\[phrase-sweep\] yielded to payments done (\d+)ms/],
  ['abandonedSettled', /^\[phrase-sweep\] abandoned migrate of (\d+) settled (posted|failed|unknown)(?: ([0-9a-f]{12}))? after (\d+)ms/],
  ['busyStopped', /^\[phrase-sweep\] stopped: wallet still busy after (\d+) wait/],
  ['prefetch', /^\[import\] prefetch done (\d+)ms items=(\d+) unread=(\d+)/],
  ['outboxRefused', /^\[minerOutbox\] refusing durable body ([0-9a-f]{12}) (\S+)(?: bytes=(\d+))?/],
  ['regionAbandoned', /^\[coordinator\] spend region abandoned \((\w+)\) after (\d+)s/],
  ['regionWaiting', /^\[coordinator\] waiting to acquire (\S+) — (.{0,160})/],
  ['priorityExpired', /^\[coordinator\] spend priority expired — "([^"]*)"/],
  ['abandonedLate', /^\[coordinator\] abandoned spend (finished|failed) late/],
  ['recompose', /^\[recompose\] (\S+): history=(\S+)/],
  ['stageStill', /^\[import\] still (.+?) after (\d+)s/],
  ['sweepFailed', /^\[import\] sweep failed after (\d+)ms: (.{0,160})/],
  ['sweepJoined', /^\[import\] sweep joined the run in flight callers=(\d+)/],
  ['outpointChunkFailed', /^\[import\] outpoint chunk failed (\d+)\+(\d+) after (\d+)ms/],
  ['outpointGaveUp', /^\[import\] outpoint check gave up after (\d+) failed chunks; (\d+) left/],
  ['savedListRead', /^\[import\] saved list prune\+read done (\d+)ms gone=(\d+) decided=(\d+)/],
  ['listReused', /^\[import\] sweep reuses the list synced (\d+)s ago complete=(\w+)/],
  ['scanReadReused', /^\[import\] items reuse the scan's set read (\d+)s ago/],
  ['phraseSweepOther', /^\[phrase-sweep\] (.{0,160})/],
  ['importOther', /^\[import\] (.{0,160})/],
]

/** Settings → Import steps in order, each with the numbers its log line carries. */
function legacyImportFacts(events) {
  const steps = []
  const counts = {}
  const seen = new Set()
  const visibilityOver = visibilityTimeline(events)
  for (const e of events) {
    const key = `${e.at}|${e.text}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const [step, re] of IMPORT_LINES) {
      const m = re.exec(e.text)
      if (!m) continue
      counts[step] = (counts[step] ?? 0) + 1
      const n = (i) => (m[i] == null ? null : /^\d+$/.test(m[i]) ? Number(m[i]) : m[i])
      const detail =
        step === 'utxoSet' ? { ms: n(1), utxos: n(2), pages: n(3) }
        : step === 'utxoSetRefused' ? { reason: m[1], detail: m[2] ?? null, ms: n(3) }
        : step === 'utxoSetVerified' ? { addresses: n(1), cashAddresses: n(2), itemAddresses: n(3), readAddresses: n(4), rejected: n(5), derived: n(6), ms: n(7) }
        : step === 'utxoSetCash' ? { ms: n(1), outputs: n(2), unspent: n(3), unknown: n(4), viaExplorer: n(5) }
        : step === 'utxoSetItems' ? { ms: n(1), outpoints: n(2), unspent: n(3), failed: n(4) }
        : step === 'hints' ? { txids: n(1), complete: m[2] === 'true', sats: n(3), items: n(4), origins: n(5) }
        : step === 'itemOwners' ? { ms: n(1), origins: n(2), located: n(3), unspent: n(4), owners: n(5), missing: n(6), failed: n(7) }
        : step === 'window' ? { txsRead: n(1), txsTotal: n(2), mayHold: n(3), used: n(4), verdict: m[5] }
        : step === 'arrived' ? { txids: n(1) }
        : step === 'mismatch' ? { hinted: m[1], saved: m[2] }
        : step === 'history' ? { ms: n(1), txs: n(2), unknown: n(3), failed: n(4), addresses: n(5), upTo: n(6), of: n(7) }
        : step === 'historyReadFailed' || step === 'addressLookupFailed' ? { count: n(1) }
        : step === 'discover' ? { ms: n(1), checked: n(2), used: n(3), complete: m[4] === 'true' }
        : step === 'holdings' ? { ms: n(1), addresses: n(2), networkReads: n(3) }
        : step === 'settled' ? { foundSats: n(1), foundItems: n(2), claimedSats: n(3), claimedItems: n(4) }
        : step === 'refused' ? { reason: m[1] }
        : step === 'sweep' ? { ms: n(1), kind: m[2], cashSats: n(3), items: n(4), tokens: n(5), failed: n(6) }
        : step === 'itemsSynced' ? { listed: n(1), addressesPaged: n(2), complete: m[3] === 'true', stopped: m[4] === 'true', ms: n(5) }
        : step === 'itemsChainChecked' ? { listed: n(1), spentDropped: n(2), unknown: n(3), stopped: m[4] === 'true', ms: n(5) }
        : step === 'utxoSetListed' ? { ms: n(1), outputs: n(2), unspent: n(3), unknown: n(4), viaExplorer: n(5) }
        : step === 'queued' ? { items: n(1) }
        : step === 'itemsDone' ? {
            ms: n(1), chosen: n(2), moved: n(3), transactions: n(4), keys: n(5),
            refused: Object.fromEntries([...(m[6] ?? '').matchAll(/refused\.(\S+)=(\d+)/g)].map((r) => [r[1], Number(r[2])])),
            stopped: m[7] ?? null,
          }
        : step === 'runDone' ? { ms: n(1), items: n(2), answered: n(3), sources: n(4), outcome: m[5] }
        : step === 'batchMoved' ? { moved: n(1), transactions: n(2) }
        : step === 'chosenDone' ? { ms: n(1), items: n(2), keys: n(3), moved: n(4), transactions: n(5) }
        : step === 'bundleRejected' ? { tips: n(1), retrying: n(2), reason: m[3] }
        : step === 'itemFailed' ? { outpoint: m[1], reason: m[2] }
        : step === 'abortRefused' ? { inputs: n(1) }
        : step === 'tipUnreadable' ? { outpoint: m[1], reason: m[2] }
        : step === 'cashSweep' ? { coins: n(1), transactions: n(2), ms: n(3) }
        : step === 'cashBundleRefused' ? { coins: n(1), retrying: n(2) }
        : step === 'migratePackage' ? { txid: m[1], inputs: n(2), bytes: n(3), ...(m[4] ? { durable: n(4) } : {}), ...(m[5] ? { ef: n(5) } : {}), ...(m[6] ? { inputBeef: n(6) } : {}) }
        : step === 'busyWait' ? { tips: n(1), wait: n(2), of: n(3), held: m[4] ?? null }
        : step === 'busyWaitDone' ? { waitedMs: n(1), idle: m[2] === 'true', held: m[3] ?? null }
        : step === 'waitingForPayments' ? { waitedS: n(1), holders: m[2] }
        : step === 'stageStill' ? { stage: m[1], afterS: n(2) }
        : step === 'sweepFailed' ? { afterMs: n(1), reason: m[2] }
        : step === 'sweepJoined' ? { callers: n(1) }
        : step === 'outpointChunkFailed' ? { offset: n(1), size: n(2), chunkMs: n(3) }
        : step === 'outpointGaveUp' ? { failedChunks: n(1), unchecked: n(2) }
        : step === 'savedListRead' ? { ms: n(1), gone: n(2), decided: n(3) }
        : step === 'listReused' ? { ageS: n(1), complete: m[2] === 'true' }
        : step === 'scanReadReused' ? { ageS: n(1) }
        : step === 'busyStopped' ? { waits: n(1) }
        : step === 'migrateTimed' ? { txid: m[1], ms: n(2), createMs: n(3), signMs: n(4), packMs: n(5), postMs: n(6) }
        : step === 'yieldedToPayments' ? { ms: n(1) }
        : step === 'abandonedSettled' ? { tips: n(1), outcome: m[2], txid: m[3] ?? null, waitMs: n(4) }
        : step === 'prefetch' ? { ms: n(1), items: n(2), unread: n(3) }
        : step === 'outboxRefused' ? { txid: m[1], reason: m[2], bytes: n(3) }
        : step === 'regionAbandoned' ? { cause: m[1], afterS: n(2) }
        : step === 'regionWaiting' ? { region: m[1], holders: m[2] }
        : step === 'priorityExpired' ? { reason: m[1] }
        : step === 'abandonedLate' ? { outcome: m[1] }
        : step === 'recompose' ? { reason: m[1], history: m[2] }
        : step === 'phraseSweepOther' || step === 'importOther' ? { line: m[1] }
        : {}
      const spanMs = typeof detail.ms === 'number' ? detail.ms : 0
      steps.push({ at: new Date(e.at).toISOString(), step, visibility: visibilityOver(e.at - spanMs, e.at), ...detail })
      break
    }
  }
  return {
    counts,
    steps: steps.slice(-40),
    background: backgroundCadence(events, steps),
    migrate: migrateThroughput(steps),
  }
}

/**
 * Where each migrate bundle's time went, from its `migrate package` and
 * `migrate … done` lines. `pack` is wallet-side BEEF work between signing and
 * the miner round; builds before 1.3.479 count it inside `sign`.
 */
function migrateThroughput(steps) {
  const timed = steps.filter((s) => s.step === 'migrateTimed')
  if (timed.length === 0) return null
  const packages = new Map(steps.filter((s) => s.step === 'migratePackage').map((s) => [s.txid, s]))
  const totals = { create: 0, sign: 0, pack: 0, post: 0 }
  const byVisibility = {}
  let tips = 0
  let totalMs = 0
  let slowest = null
  for (const t of timed) {
    const pkg = packages.get(t.txid)
    const inputs = pkg?.inputs ?? 0
    tips += inputs
    totalMs += t.ms
    totals.create += t.createMs ?? 0
    totals.sign += t.signMs ?? 0
    totals.pack += t.packMs ?? 0
    totals.post += t.postMs ?? 0
    const v = (byVisibility[t.visibility] ??= { bundles: 0, tips: 0, ms: 0 })
    v.bundles += 1
    v.tips += inputs
    v.ms += t.ms
    if (!slowest || t.ms > slowest.ms) slowest = { txid: t.txid, ms: t.ms, tips: inputs, visibility: t.visibility }
  }
  const share = (ms) => (totalMs > 0 ? Math.round((ms / totalMs) * 100) / 100 : 0)
  const sized = [...packages.values()]
  const sum = (key) => sized.reduce((acc, p) => acc + (p[key] ?? 0), 0)
  return {
    bundles: timed.length,
    tips,
    totalMs,
    tipsPerMinute: totalMs > 0 ? Math.round((tips / (totalMs / 60_000)) * 10) / 10 : 0,
    phaseShare: { create: share(totals.create), sign: share(totals.sign), pack: share(totals.pack), post: share(totals.post) },
    byVisibility: Object.fromEntries(
      Object.entries(byVisibility).map(([k, v]) => [k, { ...v, msPerTip: v.tips > 0 ? Math.round(v.ms / v.tips) : null }]),
    ),
    tipsPerBundle: Math.round((tips / timed.length) * 10) / 10,
    largestPackageBytes: sized.reduce((max, p) => Math.max(max, p.bytes ?? 0), 0),
    postedEfBytes: sum('ef') || null,
    packageBytes: sum('bytes'),
    largestInputBeefBytes: sized.reduce((max, p) => Math.max(max, p.inputBeef ?? 0), 0) || null,
    slowest,
  }
}

const HEARTBEAT_RE = /^\[heartbeat\] up (\d+)s .* · (hidden|visible)$/

/**
 * How the WebView ran while hidden. A 30s heartbeat that keeps its cadence
 * means timers were throttled at most; gaps of minutes mean Android froze the
 * renderer and nothing the wallet schedules can run until it is reopened.
 */
function backgroundCadence(events, steps) {
  const spans = []
  let hiddenFrom = null
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const m = LIFECYCLE_RE.exec(e.text)
    if (!m) continue
    if (m[1] === 'hidden' && hiddenFrom == null) hiddenFrom = e.at
    else if (m[1] === 'visible' && hiddenFrom != null) {
      spans.push([hiddenFrom, e.at])
      hiddenFrom = null
    }
  }
  const lastAt = events.reduce((max, e) => Math.max(max, e.at), 0)
  if (hiddenFrom != null) spans.push([hiddenFrom, lastAt])
  const beats = events
    .filter((e) => HEARTBEAT_RE.test(e.text))
    .map((e) => e.at)
    .sort((a, b) => a - b)
  const periods = spans.map(([from, to]) => {
    const inside = [from, ...beats.filter((at) => at > from && at < to), to]
    let longestGapMs = 0
    for (let i = 1; i < inside.length; i += 1) longestGapMs = Math.max(longestGapMs, inside[i] - inside[i - 1])
    const fromIso = new Date(from).toISOString()
    const toIso = new Date(to).toISOString()
    return {
      from: fromIso,
      ms: to - from,
      heartbeats: inside.length - 2,
      longestGapMs,
      importSteps: steps.filter((s) => s.at > fromIso && s.at <= toIso).length,
    }
  })
  return {
    hiddenMs: periods.reduce((sum, p) => sum + p.ms, 0),
    longestHiddenGapMs: periods.reduce((max, p) => Math.max(max, p.longestGapMs), 0),
    periods: periods.slice(-12),
  }
}

const CARD_SENT_RE = /^\[identity-card\] sent (card|withdrawal) to ([0-9a-f]{12}) via (\S+)( \(asked\))?/
const CARD_UNDELIVERED_RE = /^\[identity-card\] (card|withdrawal) to ([0-9a-f]{12}) not delivered \((\S+)\)/
const CARD_ASK_RE = /^\[identity-card\] (asked|could not ask) ([0-9a-f]{12}) for their card via (\S+)/
const CARD_ASKED_NO_IDENTITY_RE = /^\[identity-card\] asked by ([0-9a-f]{12}) but this account presents no identity/
const CARD_IGNORED_RE = /^\[identity-card\] request from ([0-9a-f]{12}) ignored — not a contact/
const CARD_KEPT_RE = /^\[identity-card\] kept (card|withdrawal) from ([0-9a-f]{12})(?:: (\S+))?/
const CARD_REFUSED_RE = /^\[identity-card\] refused card from ([0-9a-f]{12}): (.*)$/
const CARD_FAILED_RE = /^\[identity-card\] (share|exchange) failed (.*)$/
const CARD_TOO_BIG_RE = /^\[identity-card\] card exceeds the messagebox limit/

/** Identity cards per peer key prefix, so a missing card names its last step. */
function identityCardFacts(events) {
  const peers = {}
  const failures = []
  let oversized = 0
  const peer = (key) => (peers[key] ??= { sent: 0, undelivered: 0, asked: 0, askFailed: 0, askedNoIdentity: 0, ignored: 0, kept: 0, refused: [], last: null })
  const note = (key, step, at) => {
    peer(key).last = { step, at: new Date(at).toISOString() }
  }
  for (const e of events) {
    let m
    if ((m = CARD_SENT_RE.exec(e.text))) {
      peer(m[2]).sent += 1
      note(m[2], `sent ${m[1]} via ${m[3]}${m[4] ? ' (asked)' : ''}`, e.at)
    } else if ((m = CARD_UNDELIVERED_RE.exec(e.text))) {
      peer(m[2]).undelivered += 1
      note(m[2], `${m[1]} not delivered (${m[3]})`, e.at)
    } else if ((m = CARD_ASK_RE.exec(e.text))) {
      if (m[1] === 'asked') peer(m[2]).asked += 1
      else peer(m[2]).askFailed += 1
      note(m[2], `${m[1]} via ${m[3]}`, e.at)
    } else if ((m = CARD_ASKED_NO_IDENTITY_RE.exec(e.text))) {
      peer(m[1]).askedNoIdentity += 1
      note(m[1], 'asked, but this account presents no identity', e.at)
    } else if ((m = CARD_IGNORED_RE.exec(e.text))) {
      peer(m[1]).ignored += 1
      note(m[1], 'request ignored — not a contact', e.at)
    } else if ((m = CARD_KEPT_RE.exec(e.text))) {
      peer(m[2]).kept += 1
      note(m[2], m[1] === 'card' ? `kept card ${m[3] ?? ''}`.trim() : 'kept withdrawal', e.at)
    } else if ((m = CARD_REFUSED_RE.exec(e.text))) {
      const p = peer(m[1])
      if (!p.refused.includes(m[2])) p.refused.push(m[2])
      note(m[1], `refused: ${m[2]}`, e.at)
    } else if ((m = CARD_FAILED_RE.exec(e.text))) {
      failures.push({ step: m[1], error: m[2].slice(0, 120) })
    } else if (CARD_TOO_BIG_RE.test(e.text)) {
      oversized += 1
    }
  }
  return { peers, failures: failures.slice(0, 10), oversized }
}

function deadCoinFacts(events) {
  const seen = new Set()
  const found = new Map()
  let resigns = 0
  const sweeps = []
  // Outcome of adopting the named spenders of hidden coins: `restored` = this
  // wallet's own send, on chain but failed locally, whose change came back.
  const spenders = {}
  const peerDevice = { reads: 0, own: 0, spent: 0, withdrawn: 0, unread: 0, slowestMs: 0 }
  for (const e of events) {
    const key = `${e.at}|${e.text}`
    if (seen.has(key)) continue
    seen.add(key)
    if (RESIGN_RE.test(e.text)) {
      resigns += 1
      continue
    }
    const peer = PEER_READ_RE.exec(e.text)
    if (peer) {
      if (peer[1] === 'own') peerDevice.own += 1
      else peerDevice.reads += 1
      peerDevice.spent += Number(peer[2] ?? 0)
      peerDevice.withdrawn += Number(peer[3] ?? 0)
      peerDevice.slowestMs = Math.max(peerDevice.slowestMs, Number(peer[4]))
      continue
    }
    if (PEER_UNREAD_RE.test(e.text)) {
      peerDevice.unread += 1
      continue
    }
    const tally = SPENDER_TALLY_RE.exec(e.text)
    if (tally) {
      for (const [, k, n] of tally[1].matchAll(/(\w+)=(\d+)/g)) {
        spenders[k] = (spenders[k] ?? 0) + Number(n)
      }
      continue
    }
    const m = DEAD_SWEEP_RE.exec(e.text)
    if (m) {
      sweeps.push({
        checked: Number(m[1]),
        hidden: Number(m[2]),
        unknown: Number(m[3]),
        ms: Number(m[4]),
      })
      continue
    }
    const dead = SPENT_ELSEWHERE_RE.exec(e.text) ?? FUNDING_REBUILD_RE.exec(e.text)
    if (dead) {
      for (const [outpoint] of dead[1].matchAll(/[0-9a-f]{64}\.\d+/g)) {
        found.set(outpoint, (found.get(outpoint) ?? 0) + 1)
      }
    }
  }
  // A coin found dead more than once was hidden and then chosen again: the
  // hide did not stick, and every spend over it is refused or rebuilt.
  const reselected = [...found]
    .filter(([, times]) => times > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([outpoint, times]) => ({ outpoint, times, mentions: coinMentions(events, outpoint) }))
  return {
    resigns,
    sweeps,
    spenders,
    peerDevice,
    deadFound: { coins: found.size, sightings: [...found.values()].reduce((a, b) => a + b, 0), reselected },
    unscriptedChange: unscriptedChangeFacts(events),
  }
}

/**
 * Every line family that names a re-chosen coin — by full outpoint or by its
 * 12-char txid prefix — so whatever revives it between hides shows up by name.
 */
function coinMentions(events, outpoint) {
  const txid = outpoint.split('.')[0]
  const short = txid.slice(0, 12)
  const counts = new Map()
  const seen = new Set()
  for (const e of events) {
    if (!e.text.includes(short)) continue
    const key = `${e.at}|${e.text}`
    if (seen.has(key)) continue
    seen.add(key)
    const f = family(e.text)
    const row = counts.get(f) ?? { family: f, count: 0, first: e.at, last: e.at }
    row.count += 1
    row.last = e.at
    counts.set(f, row)
  }
  return [...counts.values()].sort((a, b) => a.first - b.first).slice(0, 14)
}

const SPENT_ELSEWHERE_RE = /^\[spend\] [0-9a-f]{12} inputs spent elsewhere count=\d+ — (.*)$/
const FUNDING_REBUILD_RE = /^\[certainty\] [0-9a-f]{12} funding spent elsewhere — building again over live coins \((.*)\)$/

const UNSCRIPTED_CHANGE_RE =
  /^\[stale-output\] (\d+) change output\(s\) of ([0-9a-f]{12}) have no locking script\b/
const CHANGE_REVIVED_RE = /^\[change-revive\] ([0-9a-f]{12}) revived=(\d+) sats=(\d+)/

/**
 * Change this wallet signed but could not spend: rows with no locking script
 * are never promoted, so every one of them is balance the user cannot see.
 */
function unscriptedChangeFacts(events) {
  const byTxid = new Map()
  const revived = new Map()
  for (const e of events) {
    const m = UNSCRIPTED_CHANGE_RE.exec(e.text)
    if (m) {
      const row = byTxid.get(m[2]) ?? { txid: m[2], outputs: 0, reports: 0 }
      row.outputs = Math.max(row.outputs, Number(m[1]))
      row.reports += 1
      byTxid.set(m[2], row)
      continue
    }
    const r = CHANGE_REVIVED_RE.exec(e.text)
    if (r) revived.set(r[1], { txid: r[1], outputs: Number(r[2]), sats: Number(r[3]) })
  }
  return {
    txids: [...byTxid.values()].map((row) => ({ ...row, revived: revived.has(row.txid) })),
    revived: [...revived.values()],
  }
}

const ECHOED_RE =
  /^\[derived-change\] echoed (\d+) derivation\(s\)(?:, journaled (\d+) recipe\(s\))? from (\d+) output row\(s\)(?: done (\d+)ms)?/
const ECHO_RECOVERY_RE =
  /^\[(?:derived-change\] echo|custody-journal\]) recovery checked=(\d+) live=(\d+) sats=(\d+) imported=(\d+) failed=(\d+) spent=(\d+) unknown=(\d+) done (\d+)ms/
const NO_ECHO_RE = /^\[derived-change\] ([0-9a-f]{12})… (\d+) output\(s\) live on chain with no toolbox row and no remittance echo/
const NO_RECIPE_RE = /^\[custody-journal\] (\d+) outpoint\(s\) live on chain with no recipe/
const JOURNAL_CAPTURED_RE = /^\[custody-journal\] captured (\d+) new recipe\(s\) from (\d+) output row\(s\) done (\d+)ms/
const JOURNAL_REFUSED_RE = /^\[custody-journal\] write refused — (\d+) recipe\(s\) held in memory only \((\d+) total\)/
const JOURNAL_WRITE_AHEAD_RE = /^\[custody-journal\] write-ahead failed after (\w+)/
const JOURNAL_BACKUP_RE =
  /^\[custody-journal\] backup (\S+) pulled=(\d+) pushed=(true|false) entries=(\d+) root=([0-9a-f]+) done (\d+)ms/
const JOURNAL_BACKUP_FAIL_RE = /^\[custody-journal\] backup (\S+) failed: (.*)$/
const JOURNAL_UNREADABLE_RE = /^\[custody-journal\] remote object unreadable/
const DERIVED_SCRIPT_RE = /^\[change-script\] derived (\d+) change locking script/
const LEGACY_BEEF_RE = /^\[legacy-beef\] ([0-9a-f]{12})… via=(proof|parents|tip)( FAIL)?(?: fetches=\d+)? (\d+)ms/
const REPLACE_RE = /^\[cloud-backup\] replace local history\b/

/** Change spendable only through its random BRC-29 prefix/suffix, and whether we still had it. */
function derivationFacts(events) {
  const seen = new Set()
  const facts = {
    replaces: 0,
    echoes: [],
    recoveries: [],
    noEcho: [],
    derivedScripts: 0,
    legacyProof: { proof: 0, parents: 0, tipFail: 0, ms: [] },
    // Custody journal: recipes captured, writes the store refused, off-device copy.
    journal: {
      captured: 0,
      sweeps: 0,
      slowestSweepMs: 0,
      refusedWrites: 0,
      heldInMemory: 0,
      writeAheadFailures: {},
      noRecipe: 0,
      backup: { syncs: 0, pushes: 0, pulled: 0, failures: [], unreadable: 0, lastEntries: null, lastRoot: null },
    },
  }
  for (const e of events) {
    const key = `${e.at}|${e.text}`
    if (seen.has(key)) continue
    seen.add(key)
    if (REPLACE_RE.test(e.text)) {
      facts.replaces += 1
      continue
    }
    let m = ECHOED_RE.exec(e.text)
    if (m) {
      facts.echoes.push({
        added: Number(m[1]),
        journaled: m[2] != null ? Number(m[2]) : null,
        rows: Number(m[3]),
        ms: m[4] ? Number(m[4]) : null,
      })
      continue
    }
    m = JOURNAL_CAPTURED_RE.exec(e.text)
    if (m) {
      facts.journal.captured += Number(m[1])
      facts.journal.sweeps += 1
      facts.journal.slowestSweepMs = Math.max(facts.journal.slowestSweepMs, Number(m[3]))
      continue
    }
    m = JOURNAL_REFUSED_RE.exec(e.text)
    if (m) {
      facts.journal.refusedWrites += 1
      facts.journal.heldInMemory = Math.max(facts.journal.heldInMemory, Number(m[2]))
      continue
    }
    m = JOURNAL_WRITE_AHEAD_RE.exec(e.text)
    if (m) {
      facts.journal.writeAheadFailures[m[1]] = (facts.journal.writeAheadFailures[m[1]] ?? 0) + 1
      continue
    }
    m = NO_RECIPE_RE.exec(e.text)
    if (m) {
      facts.journal.noRecipe += Number(m[1])
      continue
    }
    m = JOURNAL_BACKUP_RE.exec(e.text)
    if (m) {
      const b = facts.journal.backup
      b.syncs += 1
      b.pulled += Number(m[2])
      if (m[3] === 'true') b.pushes += 1
      b.lastEntries = Number(m[4])
      b.lastRoot = m[5]
      continue
    }
    m = JOURNAL_BACKUP_FAIL_RE.exec(e.text)
    if (m) {
      facts.journal.backup.failures.push({ reason: m[1], error: m[2].slice(0, 120) })
      continue
    }
    if (JOURNAL_UNREADABLE_RE.test(e.text)) {
      facts.journal.backup.unreadable += 1
      continue
    }
    m = ECHO_RECOVERY_RE.exec(e.text)
    if (m) {
      const [checked, live, sats, imported, failed, spent, unknown, ms] = m.slice(1).map(Number)
      facts.recoveries.push({ checked, live, sats, imported, failed, spent, unknown, ms })
      continue
    }
    m = NO_ECHO_RE.exec(e.text)
    if (m) {
      facts.noEcho.push({ txid: m[1], outputs: Number(m[2]) })
      continue
    }
    m = DERIVED_SCRIPT_RE.exec(e.text)
    if (m) {
      facts.derivedScripts += Number(m[1])
      continue
    }
    m = LEGACY_BEEF_RE.exec(e.text)
    if (m) {
      if (m[3]) facts.legacyProof.tipFail += 1
      else if (m[2] === 'proof') facts.legacyProof.proof += 1
      else if (m[2] === 'parents') facts.legacyProof.parents += 1
      facts.legacyProof.ms.push(Number(m[4]))
    }
  }
  // Per-source-tx read time: the item import's BEEF build is this, serially.
  const ms = facts.legacyProof.ms.sort((a, b) => a - b)
  const at = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]
  facts.legacyProof.timing = ms.length
    ? { reads: ms.length, p50: at(0.5), p90: at(0.9), max: ms[ms.length - 1], totalMs: ms.reduce((a, b) => a + b, 0) }
    : null
  delete facts.legacyProof.ms
  return facts
}

const LOAF_RE = /^\[loaf\] (\d+)ms(?: blocking (\d+)ms)? — (.+)$/
const LOAF_SCRIPT_RE = /^(\d+)ms (\S+)@([^\s:]+)(?::\d+)?(?: via (.+))?$/

/**
 * What actually ran during each long animation frame (`[loaf]`, 1.3.518+).
 * `[stall]` names the wallet phases in flight; this names the function and
 * file on the main thread. Scripts are summed by function@file across frames.
 */
function longFrameFacts(events) {
  const byScript = new Map()
  let frames = 0
  let frameMs = 0
  let unattributedFrames = 0
  let nonScriptMs = 0
  let worst = null
  for (const e of events) {
    const m = LOAF_RE.exec(e.text)
    if (!m) continue
    frames += 1
    const ms = Number(m[1])
    frameMs += ms
    const parts = m[3].split(' · ')
    if (/^no script attributed/.test(parts[0])) unattributedFrames += 1
    for (const part of parts) {
      const ns = /^non-script (\d+)ms$/.exec(part)
      if (ns) nonScriptMs += Number(ns[1])
      const s = LOAF_SCRIPT_RE.exec(part)
      if (!s) continue
      const key = `${s[2]}@${s[3]}`
      const row = byScript.get(key) ?? { script: key, frames: 0, totalMs: 0, worstMs: 0, invokers: {} }
      row.frames += 1
      row.totalMs += Number(s[1])
      row.worstMs = Math.max(row.worstMs, Number(s[1]))
      if (s[4]) row.invokers[s[4]] = (row.invokers[s[4]] ?? 0) + 1
      byScript.set(key, row)
    }
    if (!worst || ms > worst.ms) worst = { ms, line: e.text.slice(0, 400) }
  }
  return {
    frames,
    frameMs,
    unattributedFrames,
    // Rendering, layout, GC or native work — time inside frames no script owns.
    nonScriptMs,
    worst,
    scripts: [...byScript.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 12)
      .map((row) => ({ ...row, shareOfFrameTime: frameMs ? Number((row.totalMs / frameMs).toFixed(2)) : 0 })),
  }
}

const LOCK_HELD_RE = /^\[storage-lock\] (\S+) held (\d+)ms — (\d+) waiting/
const LOCK_WAIT_RE = /^\[storage-lock\] (\S+) waited (\d+)ms behind (.+)$/
const LOCK_STUCK_RE = /^\[storage-lock\] (\S+) still held (\d+)ms — (\d+) waiting/

/**
 * Who held the one Toolbox storage lock, and who waited behind them. Every
 * send, receive and closure pass queues on it, so a send that timed out with
 * nothing broadcast is explained here, not by its own trail.
 */
function storageLockFacts(events) {
  const holds = {}
  const waits = []
  const stuck = {}
  for (const e of events) {
    let m = LOCK_HELD_RE.exec(e.text)
    if (m) {
      const h = (holds[m[1]] ??= { count: 0, totalMs: 0, worstMs: 0, mostWaiting: 0 })
      h.count += 1
      h.totalMs += Number(m[2])
      h.worstMs = Math.max(h.worstMs, Number(m[2]))
      h.mostWaiting = Math.max(h.mostWaiting, Number(m[3]))
      continue
    }
    m = LOCK_WAIT_RE.exec(e.text)
    if (m) {
      waits.push({ op: m[1], ms: Number(m[2]), behind: m[3].slice(0, 200) })
      continue
    }
    m = LOCK_STUCK_RE.exec(e.text)
    if (m) {
      const s = (stuck[m[1]] ??= { reports: 0, longestMs: 0, mostWaiting: 0 })
      s.reports += 1
      s.longestMs = Math.max(s.longestMs, Number(m[2]))
      s.mostWaiting = Math.max(s.mostWaiting, Number(m[3]))
    }
  }
  return {
    holds,
    longestWaits: waits.sort((a, b) => b.ms - a.ms).slice(0, 8),
    // A hold reported here never released while the session was recorded.
    stuck,
  }
}

const RECEIVE_WRITE_RE = /^\[activity\] (new|merged) earned\/\S+ (\d+) sat ([0-9a-f]{12})/
const INGEST_MARK_RE = /^\[brc29-ingest ([0-9a-f]{12})…\] \+(\d+)ms (.+)$/
const RECEIVE_TRAIL_MAX = 24

/**
 * Incoming transactions whose Activity row is written more than once: how many
 * times, how many BRC-29 ingest attempts ran and finished, and every other
 * line that names the txid — so a receive stuck on "Verifying" names the code
 * that keeps touching it.
 */
function incomingReceiveFacts(events) {
  const byTxid = new Map()
  const entry = (id) => {
    let x = byTxid.get(id)
    if (!x) {
      x = { txid: id, writes: { new: 0, merged: 0 }, ingestAttempts: 0, ingestDone: 0, longestIngestMs: 0, lastIngestPhase: null, tags: {}, trail: [] }
      byTxid.set(id, x)
    }
    return x
  }
  for (const e of events) {
    const w = RECEIVE_WRITE_RE.exec(e.text)
    if (w) entry(w[3]).writes[w[1]] += 1
  }
  const watched = [...byTxid.values()].filter((x) => x.writes.new + x.writes.merged >= 2)
  if (watched.length === 0) return []
  const ids = new Set(watched.map((x) => x.txid))
  const idRe = /[0-9a-f]{12,64}/g
  for (const e of events) {
    const hits = new Set((e.text.match(idRe) ?? []).map((h) => h.slice(0, 12)).filter((h) => ids.has(h)))
    if (hits.size === 0) continue
    const ingest = INGEST_MARK_RE.exec(e.text)
    const tag = /^\[([\w-]+)/.exec(e.text)?.[1] ?? 'untagged'
    for (const id of hits) {
      const x = byTxid.get(id)
      x.tags[tag] = (x.tags[tag] ?? 0) + 1
      if (ingest && ingest[1] === id) {
        if (/^beef/.test(ingest[3])) x.ingestAttempts += 1
        if (ingest[3] === 'done') x.ingestDone += 1
        x.longestIngestMs = Math.max(x.longestIngestMs, Number(ingest[2]))
        x.lastIngestPhase = ingest[3].slice(0, 160)
      }
      if (!RECEIVE_WRITE_RE.test(e.text)) {
        x.trail.push(`${new Date(e.at).toISOString().slice(11, 19)} ${e.text.slice(0, 220)}`)
        if (x.trail.length > RECEIVE_TRAIL_MAX) x.trail.shift()
      }
    }
  }
  return watched
}

const INCOMING_REFUSED_RE =
  /^\[internalize\] (?:([0-9a-f]{12}) )?refused reason=(non-final|finality-unknown)\b/

function incomingFinalityFacts(events) {
  const seen = new Set()
  const facts = { nonFinal: 0, finalityUnknown: 0, txids: [] }
  for (const e of events) {
    const m = INCOMING_REFUSED_RE.exec(e.text)
    if (!m) continue
    const key = `${e.at}|${e.text}`
    if (seen.has(key)) continue
    seen.add(key)
    if (m[2] === 'non-final') facts.nonFinal += 1
    else facts.finalityUnknown += 1
    if (m[1] && !facts.txids.includes(m[1])) facts.txids.push(m[1])
  }
  return facts
}

/**
 * `[minerSubmit] <what happened> <txid12> [detail]` → the outcome name. Order
 * matters only where two phrasings share a prefix.
 */
const MINER_OUTCOMES = [
  ['accepted', /^\[minerSubmit\] Arcade accepted — tx pinned\s+([0-9a-f]{12})/],
  ['contacted', /^\[minerSubmit\] Arcade contacted \(no accept\/reject yet\)\s+([0-9a-f]{12})/],
  ['chainedAncestry', /^\[minerSubmit\] posting chained unconfirmed ancestry\s+([0-9a-f]{12})/],
  ['incompleteAncestry', /^\[minerSubmit\] posting with incomplete ancestry[^0-9a-f]*([0-9a-f]{12})/],
  ['missingInputsIncomplete', /^\[minerSubmit\] MissingInputs on incomplete BEEF[^0-9a-f]*([0-9a-f]{12})/],
  ['hardReject', /^\[minerSubmit\] Arcade hard-reject — dropping local spend\s+([0-9a-f]{12})/],
  ['transportFailed', /^\[minerSubmit\] postBeef transport failed[^0-9a-f]*([0-9a-f]{12})/],
  ['noAck', /^\[minerSubmit\] no miner ack[^0-9a-f]*([0-9a-f]{12})/],
  ['unprovenConflict', /^\[minerSubmit\] unproven (?:missing-inputs|doubleSpend)[^0-9a-f]*([0-9a-f]{12})/],
  ['rejectOnChain', /^\[minerSubmit\] hard reject — tx on chain[^0-9a-f]*([0-9a-f]{12})/],
  // Before 1.3.513 every hard reject released; since, only one with no named spender.
  ['rejectReleased', /^\[minerSubmit\] (?:hard reject — releasing seal|releasing seal — no input has a named spender)[^0-9a-f]*([0-9a-f]{12})/],
  ['offline', /^\[minerSubmit\] offline — signed cheque queued\s+([0-9a-f]{12})/],
  ['pinDidNotFree', /^\[minerSubmit\] post-Arcade pin did not free change\s+([0-9a-f]{12})/],
  // A fallback broadcaster settled the round without Arcade's verdict (1.3.486+).
  // Before that build the outbox dropped these as complete and nothing followed them.
  ['withoutArcade', /^\[minerSubmit\] ([0-9a-f]{12}) accepted without Arcade — kept queued\b/],
  ['arcadeAskedDirectly', /^\[minerSubmit\] ([0-9a-f]{12}) Arcade asked directly\b/],
  ['arcadeRestored', /^\[minerSubmit\] Arcade restored ahead of \S+\s+([0-9a-f]{12})/],
  ['rescueUnbuilt', /^\[landing\] rescue ([0-9a-f]{12}) could not rebuild its package\b/],
  ['rescueRefused', /^\[landing\] rescue ([0-9a-f]{12}) re-post refused\b/],
  // Broadcast a transaction local storage never held: its change and spent
  // marks are gone (Toolbox auto action batch dropped the signed `noSend`).
  ['pinNoLocalRow', /^\[stale-output\] pin found no local row for ([0-9a-f]{12})/],
  ['registered', /^\[signed-send\] registered\s+([0-9a-f]{12})/],
  ['funnelDeferred', /^\[brc100\] signed cheque funnel deferred\s+([0-9a-f]{12})/],
  ['postSignDeferred', /^\[brc100\] post-sign cheque\/seal deferred\s+([0-9a-f]{12})/],
  ['beefPrepDeferred', /^\[signed-send\] BEEF preparation deferred[^0-9a-f]*([0-9a-f]{12})/],
  ['outboxRefused', /^\[minerOutbox\] (?:refusing durable body|durable write refused)\s+([0-9a-f]{12})/],
  ['landed', /^\[landing\] ([0-9a-f]{12}) landed\b/],
  ['dead', /^\[landing\] ([0-9a-f]{12}) dead\b/],
  ['repostedOutsideArcade', /^\[landing\] ([0-9a-f]{12}) re-posted outside Arcade\b/],
  ['stillUnlanded', /^\[landing\] ([0-9a-f]{12}) still unlanded\b/],
  ['certaintyRetire', /^\[certainty\] ([0-9a-f]{12}) retire\b/],
  ['certaintyRefused', /^\[certainty\] ([0-9a-f]{12}) refused\b/],
  ['spvHeld', /^\[spv\] ([0-9a-f]{12}) held\b/],
  ['spvInvalid', /^\[spv\] ([0-9a-f]{12}) invalid\b/],
  // Local SPV refused a tx Arcade or a node already holds: the verdict, not the tx, is wrong.
  ['spvDisputed', /^\[spv\] ([0-9a-f]{12}) refused here but the network holds it\b/],
]
/** Stopped on this device by a pre-send gate (1.3.380+): unproven coins or a package that fails SPV. */
const MINER_GATED = new Set(['certaintyRefused', 'spvInvalid'])
/**
 * Outcomes after which a node holds the cheque. Arcade's 202 (`accepted`) is
 * only its queue: a night of dead-coin sends all logged `accepted` and none
 * reached the chain (hc-a580a 0.1.540, PENDING_RETRY "failed to validate").
 */
const MINER_LANDED = new Set(['landed', 'rejectOnChain'])
/** Outcomes that are a post attempt (the body left, or tried to leave, the device). */
const MINER_ATTEMPTED = new Set([
  'accepted', 'contacted', 'missingInputsIncomplete', 'hardReject', 'transportFailed',
  'noAck', 'unprovenConflict', 'rejectOnChain', 'rejectReleased', 'withoutArcade', 'arcadeAskedDirectly',
])
const APP_SIGN_OK_RE = /^\[brc100\] ok\b.*\bmethod=(createAction|signAction|processAction)\b/

/**
 * Did signed transactions reach a miner? Per txid (12-hex prefix as logged):
 * every miner outcome in order, the last one, and whether any post attempt
 * or accept was seen. Also counts app sign replies, so "signed but never
 * posted" is a number and not a guess.
 */
function broadcastFacts(events) {
  const byTxid = new Map()
  const details = new Map()
  let appSigned = 0
  for (const e of events) {
    if (APP_SIGN_OK_RE.test(e.text)) {
      appSigned += 1
      continue
    }
    for (const [outcome, re] of MINER_OUTCOMES) {
      const m = re.exec(e.text)
      if (!m) continue
      const id = m[1]
      const row = byTxid.get(id) ?? { txid: id, firstAt: e.at, outcomes: [] }
      row.outcomes.push(outcome)
      row.lastAt = e.at
      byTxid.set(id, row)
      const rest = e.text.slice(m.index + m[0].length).trim()
      if (rest && outcome !== 'registered') {
        const key = `${outcome}: ${family(rest)}`
        details.set(key, (details.get(key) ?? 0) + 1)
      }
      break
    }
  }
  const rows = [...byTxid.values()]
  // Outcome lines carry a 12-hex prefix; any line with the full id lets the
  // verdict be checked against the chain.
  const fullTxid = new Map()
  for (const e of events) {
    for (const [full] of e.text.matchAll(/\b[0-9a-f]{64}\b/g)) {
      const prefix = full.slice(0, 12)
      if (byTxid.has(prefix) && !fullTxid.has(prefix)) fullTxid.set(prefix, full)
    }
  }
  const lastOutcome = {}
  const everSeen = {}
  let landed = 0
  let dead = 0
  let arcadeQueuedOnly = 0
  let attemptedNeverLanded = 0
  let neverAttempted = 0
  let gated = 0
  for (const row of rows) {
    const last = row.outcomes.at(-1)
    lastOutcome[last] = (lastOutcome[last] ?? 0) + 1
    for (const o of new Set(row.outcomes)) everSeen[o] = (everSeen[o] ?? 0) + 1
    if (row.outcomes.some((o) => MINER_LANDED.has(o))) landed += 1
    else if (row.outcomes.includes('dead')) dead += 1
    else if (row.outcomes.includes('accepted')) arcadeQueuedOnly += 1
    else if (row.outcomes.some((o) => MINER_ATTEMPTED.has(o))) attemptedNeverLanded += 1
    else if (row.outcomes.some((o) => MINER_GATED.has(o))) gated += 1
    else neverAttempted += 1
  }
  const unlanded = rows
    .filter(
      (row) =>
        !row.outcomes.some((o) => MINER_LANDED.has(o) || MINER_GATED.has(o) || o === 'dead'),
    )
    .sort((a, b) => b.outcomes.length - a.outcomes.length)
    .slice(0, 12)
    .map((row) => ({
      txid: row.txid,
      fullTxid: fullTxid.get(row.txid) ?? null,
      attempts: row.outcomes.filter((o) => MINER_ATTEMPTED.has(o)).length,
      outcomes: [...new Set(row.outcomes)].join(' → '),
      spanSeconds: Math.round((row.lastAt - row.firstAt) / 1000),
    }))
  return {
    deadTrails: deadTrails(events, rows.filter((row) => row.outcomes.includes('dead'))),
    appSignReplies: appSigned,
    txidsSeen: rows.length,
    // A node holds it (`[landing] … landed`, 1.3.380+) or it is on chain.
    landed,
    // The landing watch proved it can never land and failed it.
    dead,
    // Arcade 202 with no landing verdict in the window. On builds before the
    // landing watch this is every send — a 202 is a queue receipt, not the chain.
    arcadeQueuedOnly,
    attemptedNeverLanded,
    neverAttempted,
    // Refused before any miner saw it: a coin nobody could prove unspent, or
    // a package that fails local SPV. Nothing left the device.
    gated,
    // Pinned after broadcast with no local transaction row: the next spend of
    // its change (token, item or BSV) fails on this device.
    unstoredSends: rows.filter((row) => row.outcomes.includes('pinNoLocalRow')).map((row) => row.txid),
    gatedTxids: rows.filter((row) => row.outcomes.some((o) => MINER_GATED.has(o))).map((row) => row.txid),
    lastOutcome,
    everSeen,
    unlanded,
    details: [...details.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([detail, count]) => ({ detail, count })),
  }
}

const DEAD_RE = /^\[landing\] ([0-9a-f]{12}) dead cause=(\S+).*?already spent by ([0-9a-f]{12})/

/**
 * For each cheque the landing watch failed: every line naming it and every
 * line naming the transaction that spent its coin first, in order. `<dead>`
 * and `<winner>` mark the pair; other ids are masked. This is what tells a
 * stale cheque replayed after a newer send from two live sends racing.
 */
function deadTrails(events, deadRows) {
  const out = []
  for (const row of deadRows.slice(0, 4)) {
    let winner = null
    let cause = null
    for (const e of events) {
      const m = DEAD_RE.exec(e.text)
      if (m && m[1] === row.txid) {
        cause = m[2]
        winner = m[3]
        break
      }
    }
    const mask = (e) => {
      let line = e.text.replaceAll(row.txid, '<dead>')
      if (winner) line = line.replaceAll(winner, '<winner>')
      return `${new Date(e.at).toISOString().slice(11, 19)} ${line
        .replace(/<dead>[0-9a-f]+/g, '<dead>')
        .replace(/<winner>[0-9a-f]+/g, '<winner>')
        .replace(/[0-9a-f]{12,}/g, '<id>')
        .slice(0, 240)}`
    }
    const lines = []
    const seen = new Set()
    let firstIndex = -1
    for (const [i, e] of events.entries()) {
      const t = e.text
      if (!t.includes(row.txid) && !(winner && t.includes(winner))) continue
      if (firstIndex < 0) firstIndex = i
      const line = mask(e)
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
      if (lines.length >= 40) break
    }
    // The wallet lines just before the dead cheque first appears: which flow
    // signed it, when its own txid is only logged by the seal.
    const before = []
    for (let i = firstIndex - 1; i >= 0 && before.length < 15; i -= 1) {
      if (!/^\[[\w-]+\]/.test(events[i].text)) continue
      const line = mask(events[i])
      if (!before.includes(line)) before.unshift(line)
    }
    const after = []
    for (let i = firstIndex + 1; i < events.length && after.length < 20; i += 1) {
      if (events[i].at - events[firstIndex].at > 8_000) break
      if (!/^\[[\w-]+\]/.test(events[i].text)) continue
      const line = mask(events[i])
      if (!after.includes(line)) after.push(line)
    }
    out.push({ txid: row.txid, cause, winner, before, lines, after })
  }
  return out
}

function appFlowFacts(events) {
  const visibilityOver = visibilityTimeline(events)
  const steps = []
  // Replies the wallet refused, as the app saw them: method, code, and the
  // description the wallet attached. Grouped so the same refusal repeated by
  // a retrying page counts once with a tally.
  const refusals = new Map()
  const refuse = (at, row) => {
    const key = `${row.method}|${row.code ?? row.status}|${row.detail ?? ''}`
    const seen = refusals.get(key) ?? refusals.set(key, { ...row, count: 0, lastAt: 0 }).get(key)
    seen.count += 1
    seen.lastAt = at
  }
  for (const e of events) {
    const failed = BRIDGE_FAILED_RE.exec(e.text)
    if (failed) {
      const f = logFields(failed[1])
      refuse(e.at, {
        method: f.method ?? '?',
        origin: f.origin ?? '?',
        status: Number(f.status ?? 0),
        code: f.code ?? null,
        detail: f.detail ?? null,
      })
      continue
    }
    const overlay = OVERLAY_REFUSED_RE.exec(e.text)
    if (overlay) {
      const f = logFields(overlay[1])
      refuse(e.at, {
        method: 'market overlay /submit',
        origin: 'overlay',
        status: 400,
        code: f.reason ?? null,
        detail: f.txid ? `listing ${f.txid.slice(0, 12)}` : null,
      })
      continue
    }
    const m = ACTION_DONE_RE.exec(e.text)
    if (!m) continue
    const tail = m[4]
    const approval = APPROVAL_RE.exec(tail)
    const gap = PAGE_GAP_RE.exec(tail)
    const phaseTail = tail.split(' · approval')[0].split(' · page-gap')[0].trim()
    steps.push({
      at: e.at,
      method: m[1],
      ok: m[2] === 'done',
      workMs: Number(m[3]),
      approvalMs: approval ? Number(approval[1]) : 0,
      pageGapMs: gap ? Number(gap[1]) : null,
      origin: gap ? gap[2] : null,
      phases: phaseTail || null,
      visibility: visibilityOver(e.at - Number(m[3]), e.at),
    })
  }
  const unique = steps.filter(
    (s, i, all) => all.findIndex((o) => o.at === s.at && o.method === s.method) === i,
  )
  const gaps = steps.filter((s) => s.pageGapMs != null)
  const stalled = gaps.filter((s) => s.pageGapMs >= PAGE_GAP_STALL_MS)
  const byOrigin = new Map()
  for (const s of gaps) {
    const row =
      byOrigin.get(s.origin) ??
      byOrigin.set(s.origin, { origin: s.origin, steps: 0, stalledSteps: 0, longestPageGapMs: 0 }).get(s.origin)
    row.steps += 1
    if (s.pageGapMs >= PAGE_GAP_STALL_MS) row.stalledSteps += 1
    row.longestPageGapMs = Math.max(row.longestPageGapMs, s.pageGapMs)
  }
  return {
    steps: steps.length,
    stalledSteps: stalled.length,
    longestPageGapMs: gaps.reduce((a, s) => Math.max(a, s.pageGapMs), 0),
    longestApprovalMs: steps.reduce((a, s) => Math.max(a, s.approvalMs), 0),
    longestWorkMs: steps.reduce((a, s) => Math.max(a, s.workMs), 0),
    byOrigin: [...byOrigin.values()].sort((a, b) => b.longestPageGapMs - a.longestPageGapMs),
    stalled: stalled.slice(0, 8).map(({ at, ...s }) => s),
    slowest: [...steps]
      .sort((a, b) => b.workMs - a.workMs)
      .slice(0, 5)
      .map(({ at, ...s }) => s),
    actions: unique.map(({ method, ok, workMs, phases, visibility }) => ({
      method,
      ok,
      workMs,
      phases,
      visibility,
    })),
    workByVisibility: workByVisibility(unique),
    refusals: [...refusals.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 12)
      .map(({ lastAt, ...r }) => r),
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
  const errorFamilies = new Map()
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
      const reason = family(e.text.slice(e.text.indexOf(' error: ') + 8))
      const famKey = `${m[2]} ${reason}`
      const fam = errorFamilies.get(famKey) ?? { method: m[2], reason, count: 0, firstAt: e.at, lastAt: e.at }
      fam.count += 1
      fam.lastAt = e.at
      errorFamilies.set(famKey, fam)
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
    errorFamilies: [...errorFamilies.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 14)
      .map((f) => ({ ...f, firstAt: new Date(f.firstAt).toISOString(), lastAt: new Date(f.lastAt).toISOString() })),
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
function forensicQuestions(latest, previous) {
  const owners = {}
  for (const s of latest.longFrames?.scripts?.slice(0, 6) ?? []) {
    owners[choiceId(`script ${s.script}`)] =
      `The function \`${s.script}\` itself — the \`latest.longFrames.scripts\` row "${s.script}" is measured main-thread time inside long animation frames, so it outranks any workload that was merely in flight.`
  }
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
                'A deposit is `retired` and the reason says the spend is invalid, rejected, missing, or spends a transaction no provider has and the chain never saw: it has been hidden as it should be.',
              broadcast_only:
                '`broadcastFailed` is set and the deposit was otherwise accepted: the token is in the basket and only the public broadcast failed.',
              no_stuck_deposit:
                'Nothing is pending, refused, or retired. This window does not contain a stuck token deposit.',
              unclear: 'The deposit lines do not say whether it is waiting, refused, or already settled.',
            },
          },
        }
      : {}

  const attest = latest.tokenAttestation
  const attestationQuestions =
    attest?.census && attest.census.tokens > (attest.census.bap ?? 0)
      ? {
          token_off_issuer_shelf: {
            type: 'choice',
            instructions:
              'Some held BSV-21 tokens are not shelved under a verified BAP identity in Collect. `latest.tokenAttestation.census` is the last per-token count: `bap` are on a verified identity shelf, `bap-unconfirmed` are attested but this device holds no identity package for their BAP ID, `key` are attested with no BAP ID on the deploy, `no-genesis` lack the retained deploy transaction, `unbound` have no held tip whose BRC-176 walk reached the deploy, `remittance-only` have a deploy with neither issuer tape nor Sigma — only this wallet\'s local remittance names an issuer (minted before Sigma-signed issuance), `unsigned` have a deploy that names an issuer (tape or Sigma) its Sigma does not verify for, `unsigned-mint` have a deploy that names no issuer at all. `offShelf` names the token on each non-`bap` step. Uploads from before `remittance-only` existed count those tokens under `unsigned`, and carry no `offShelf`. `heals.bound` / `heals.refused` count background heal outcomes by source or reason (`no-tip-body`, `walk-failed`, `no-genesis`). Which step keeps the most tokens off a verified shelf?',
            criteria: {
              missing_identity_package:
                '`bap-unconfirmed` is the largest non-`bap` count: tokens are attested, but the identity package for their BAP ID never reached this device.',
              deploy_not_retained:
                '`no-genesis` is the largest non-`bap` count: the deploy transaction is not held, so the issuer Sigma cannot be read.',
              lineage_unbound:
                '`unbound` is the largest non-`bap` count, or `heals.refused` is dominated by `walk-failed` / `no-tip-body`: no tip has been walked back to its deploy.',
              signature_mismatch:
                '`unsigned` is the largest non-`bap` count and the census also carries a `remittance-only` count: the deploy names an issuer its Sigma does not verify for.',
              minted_unsigned:
                '`unsigned-mint`, `remittance-only` or `key` is the largest non-`bap` count, or `unsigned` is largest on an upload whose census has no `remittance-only` count: those tokens were minted without a BAP-stamped signature and can never join an identity shelf.',
              unclear: 'The census does not say which step is missing.',
            },
          },
        }
      : {}

  const tokenCards = latest.tokenLedger
  const tokenCardQuestions =
    tokenCards?.beyondHistory > 0 || tokenCards?.withUnspendable > 0
      ? {
          token_balance_beyond_history: {
            type: 'choice',
            instructions:
              'A token card shows more than its history explains, or holds tips send cannot spend. `latest.tokenLedger.tokens` lists each card: `held` is the card total, `byKind` splits it — `brc162` value locks are what send spends (`spendable`), `legacy-json` tips are read-only inscriptions, `remittance` tips are plain-script rows whose amount comes from row metadata alone, kept because the card held that outpoint before. `historyNet` is received minus sent/burned in this wallet\'s Activity for the token, `heldBeyondHistory` is `held` minus that net (0 when history covers it), `tipList` names the largest tips as `outpoint=amount:kind`. Amounts are raw units. What does the excess come from?',
            criteria: {
              remittance_claims:
                'For the token with the largest `heldBeyondHistory`, `remittance` amount is at least that excess: the card counts metadata claims on plain-script rows the chain does not carry as tokens.',
              legacy_read_only:
                'For that token, `legacy-json` amount is at least the excess and `remittance` is smaller: real legacy inscriptions the wallet shows but cannot send.',
              history_incomplete:
                'For that token the excess is carried by `brc162` tips: spendable value locks that reached the wallet without an Activity row (reconcile restore, claim, chain ingest), so the history is short, not the balance.',
              unspendable_only:
                'Every token has `heldBeyondHistory` 0 but some hold `legacy-json` or `remittance` tips: the balance matches history, part of it is simply not spendable.',
              unclear: 'The ledger does not separate the excess by kind.',
            },
          },
        }
      : {}

  const flow = latest.appFlow
  const appFlowQuestions =
    flow && flow.steps > 0
      ? {
          app_flow_stall: {
            type: 'choice',
            instructions:
              'A connected app ran a multi-step flow (createAction / internalizeAction) through the bridge. `latest.appFlow` lists each step as the wallet answered it: `workMs` is wallet work, `approvalMs` is the user approving, `pageGapMs` is the time between the wallet answering the previous step and the page sending this one — the page\'s own time. `stalled` are steps whose page gap exceeded 20s, with the origin. Who held the flow up?',
            criteria: {
              page_stalled:
                '`stalledSteps` > 0 and those steps carry small `approvalMs` and `workMs`: the wallet answered promptly and the page did not come back for a long time — the browser was frozen or waiting on its own server, not the wallet.',
              user_approval:
                'The longest waits are `approvalMs`, not `pageGapMs`: the user was reading the prompt.',
              wallet_work:
                '`longestWorkMs` dominates: the wallet itself was slow to sign, package or seal.',
              flow_ran_smoothly:
                'No step has a page gap over 20s, approvals are short, and work is under a few seconds.',
              unclear: 'The steps do not show where the time went.',
            },
          },
          slow_signing_owner: {
            type: 'choice',
            instructions:
              'Where does signing time go? `latest.appFlow.workByVisibility` is keyed `<method> <visibility>`, where visibility is the page state over the step (`visible`, `hidden` — the phone backgrounded the WebView the whole time — or `mixed`); each row gives the median wallet work and median of each phase: `preflight` is the pre-consent balance read, `spend` is funding + Toolbox createAction + signing, `ingest` / `seal` are internalize storage. `latest.toolboxSteps` splits Toolbox work into its own steps (`create_action.storage_plan` coin selection in IndexedDB, `create_action.complete_signing` ECDSA, `create_action.verify_unlock_scripts` script checks, `create_action.process` storage commit, `create_action.merge_result_beef` / `verify_result_beef` the session BEEF) with medians per visibility; it is empty on builds that predate that log line. Rows prefixed `spend.` are wallet work around the Toolbox inside the same phase: `spend.lease` the cross-device spend lock (removed in 1.3.376; only older builds log it), `spend.balance` the in-region balance gate, `spend.input_fate` the post-sign explorer probe of input spenders, `spend.retire` failing a sign that picked coins a confirmed foreign tx spent before signing again (`latest.deadCoins.resigns` counts those; `latest.deadCoins.sweeps` are the background pool sweeps that should stop them recurring), `spend.internalize` the Toolbox internalize call, `spend.bridge_deliver` the hop from the native :3321 socket into the WebView (Android, grows when the WebView is backgrounded). Which owns the time?',
            criteria: {
              balance_read:
                '`preflight` is a large share of work (around 1.5s or more): the balance read ran into its budget.',
              toolbox_storage:
                'The heaviest `toolboxSteps` rows are `storage_plan` or `process`: IndexedDB work inside the Toolbox, not cryptography.',
              session_beef:
                'The heaviest `toolboxSteps` rows are `merge_result_beef` or `verify_result_beef`: the in-memory session BEEF has grown large.',
              cryptography:
                'The heaviest `toolboxSteps` rows are `complete_signing` or `verify_unlock_scripts`: signature math dominates.',
              network_waits:
                'The heaviest `toolboxSteps` rows are `spend.lease`, `spend.input_fate` or `spend.retire`: round trips to the backup host or explorer, or a resign over dead coins, not the Toolbox.',
              background_penalty:
                'The same phases are much slower in `hidden` than in `visible`: Android deprioritised the backgrounded WebView, and the fix is less work per step rather than a different step.',
              need_toolbox_steps:
                '`spend` dominates but `toolboxSteps` is empty: the build does not log Toolbox steps yet, so the owner inside createAction is unknown.',
              unclear: 'The phases do not show where signing time went.',
            },
          },
          ...(flow.refusals.length > 0
            ? {
                app_flow_refusal: {
                  type: 'choice',
                  instructions:
                    'The same flow saw refusals: `latest.appFlow.refusals` lists each distinct one with the bridge `method` (or `market overlay /submit` when the app reported the overlay\'s refusal back), the `code`, the wallet\'s `detail`, and how many times it repeated. Which refusal is the one to fix first, and where does it live?',
                  criteria: {
                    wallet_bug:
                      'A `detail` reads like a program fault (`is not defined`, `undefined`, `Cannot read`, a stack) rather than a wallet rule: the wallet threw, and the code it was mapped to is misleading. Fix the wallet.',
                    wallet_rule_refused:
                      'The `code` names a wallet rule (`MARKET_LISTING_REFUSED`, `USE_P1SAT_SCOPE`, `INSUFFICIENT_OR_STALE_FUNDS` with a funds `detail`) and the detail explains which: the app asked for something the wallet does not allow — fix the app, or the rule if it is wrong.',
                    overlay_refused:
                      'A `market overlay /submit` row carries the overlay\'s reason code: the listing was signed and the index refused it — fix on the overlay or in what the wallet packaged, named by that code.',
                    cleanup_only:
                      'The only refusals are follow-ups to an earlier failure (`MARKET_CANCEL_REFUSED offer-not-held` after a refused publish, permission denials): nothing to fix on their own.',
                    unclear: 'The refusals do not say which side is wrong.',
                  },
                },
              }
            : {}),
        }
      : {}

  const migrateUpload = latest.legacyImport?.migrate ? 'latest' : previous?.legacyImport?.migrate ? 'previous' : null
  const migrateQuestions = migrateUpload
    ? {
        migrate_bottleneck: {
          type: 'choice',
          instructions:
            `What bounds item-migrate throughput? \`${migrateUpload}.legacyImport.migrate\` is code-computed over every migrate bundle: \`phaseShare\` splits bundle time into \`create\` (Toolbox createAction: argument validation, input BEEF verification, coin selection and record writes in IndexedDB), \`sign\` (our signatures plus Toolbox signAction, whose \`process\` step commits to IndexedDB), \`pack\` (wallet-side BEEF assembly after signing; 0 on builds that fold it into \`sign\`) and \`post\` (local SPV plus the miner round). \`byVisibility\` gives bundles, tips and \`msPerTip\` with the WebView \`visible\`, \`hidden\` or \`mixed\` over the bundle. \`tipsPerBundle\`, \`packageBytes\` (the full local package), \`postedEfBytes\` (what Arcade receives; null on older builds) and \`largestInputBeefBytes\` (the input BEEF handed to createAction; null on older builds) size the work. \`${migrateUpload}.toolboxSteps\` splits Toolbox time by step with medians per visibility (\`create_action.storage_plan\`, \`sign_action.process\`). Which owns the time?`,
          criteria: {
            toolbox_storage:
              '`create` and `sign` dominate and `toolboxSteps` puts the time in `create_action.storage_plan` or `sign_action.process`: IndexedDB work inside the Toolbox. The fix is less data per action (a smaller input BEEF) and fewer actions (more tips per bundle), not a faster network.',
            background_penalty:
              '`msPerTip` is several times higher `hidden` or `mixed` than `visible`: the backgrounded WebView ran the same work slower. The fix is keeping the app foreground-prioritised, or less work per step.',
            miner_post:
              '`post` dominates and grows with `packageBytes` or `postedEfBytes`: the upload to miners bounds throughput.',
            wallet_packing:
              '`pack` (or, on older builds, `sign` well beyond `toolboxSteps` `sign_action`) is a large share: wallet-side BEEF parsing and merging after signing.',
            per_bundle_overhead:
              '`tipsPerBundle` is small and per-bundle time is roughly constant regardless of tips: fixed cost per transaction dominates, so larger bundles would help most.',
            fine: '`msPerTip` while visible is under about 300ms and hidden time is not most of the run.',
            unclear: 'The phases do not show where migrate time went.',
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

  const notify = latest.notifications
  const notifyQuestions =
    notify && (notify.hiddenValueActions > 0 || notify.posted > 0)
      ? {
          missing_notifications: {
            type: 'choice',
            instructions:
              'From `latest.notifications` (Android activity notifications): `hiddenValueActions` counts createAction / internalizeAction replies sent while the WebView was hidden, and `hiddenValueActionsWithoutNotification` those with no `posted` line within 5s (`silentExamples` names them). `skipped` tallies deliberate skips by `kind reason` (`onScreen` = HandCash was judged on screen, `notPermitted` = no display permission or channel setup failed). `failed` tallies plugin errors. Builds before 0.1.539 skip silently, so on those a silent action with no `skipped` line can still be an on-screen skip. `onScreenSkipsThenHidden` counts on-screen skips followed by the WebView hiding within 3s (the user left before seeing the result; 0.1.544+ posts those after a 2.5s leave grace, counted in `postedWithinGrace`). `bridgeDeliversParked` counts BRC-100 requests that took ≥5s to get from the native socket into the WebView, and `bridgeDeliversParkedUntilResume` those released in the same second as a `visible` flip, meaning the hidden renderer was frozen (0.1.544+ keeps it at the app’s own priority). Why are notifications missing, if they are?',
            criteria: {
              none_missing:
                '`hiddenValueActionsWithoutNotification` is 0 and `failed` is empty: every hidden value action posted. Missing ones the user reports are the OS (bundling, cooldown, Do Not Disturb), not the wallet.',
              judged_on_screen:
                'Silent hidden actions line up with `skipped ... onScreen`: the on-screen check said HandCash was in front while the WebView was hidden.',
              not_permitted:
                '`skipped ... notPermitted` or a permission warning explains the gap.',
              plugin_failed: '`failed` has entries: the notification plugin threw.',
              left_during_skip:
                '`onScreenSkipsThenHidden` is above 0 with no matching `postedWithinGrace`: the result landed while the user was leaving HandCash, so it was skipped as on screen and never seen.',
              renderer_frozen:
                '`bridgeDeliversParkedUntilResume` is above 0: the hidden WebView was frozen, so wallet work — and the notification it would raise — waited for the user to reopen HandCash.',
              no_event:
                'Silent hidden actions have neither a skip nor a failure line: the wallet never raised a notification event for them.',
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
    ...attestationQuestions,
    ...tokenCardQuestions,
    ...appFlowQuestions,
    ...nftQuestions,
    ...migrateQuestions,
    ...notifyQuestions,
    ...bridgeQuestions,
    freeze_owner: {
      type: 'choice',
      instructions:
        'Which single piece of work most plausibly owns the blocked time in `latest`? When `latest.longFrames.scripts` is non-empty it is a direct measurement of the functions that ran during the long frames: pick its largest `totalMs` row unless `latest.longFrames.nonScriptMs` dominates `frameMs`. Otherwise weigh `latest.workloads[].shareOfBlockedTime` (blocked time that fell inside that workload’s runs), `latest.precedingLines` (the last line logged before each freeze began — later lines were only queued behind it), and `latest.bursts[].overlappingWorkloads`. Overlapping shares can each be large; prefer the one that recurs across bursts.',
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
      'Does `latest` contain evidence that money or a token could be lost, stuck, or unreceivable — a payment the counterparty cannot complete, a transaction that cannot propagate, a balance that cannot be spent? `latest.broadcast` counts signed transactions by what miners said: `landed` reached a node, `dead` was proven unlandable and failed, `arcadeQueuedOnly` got only Arcade\'s 202 queue receipt with no landing verdict. Slowness alone is not custody risk.',
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

/* ---------------------------------------------------------- error review */

/** Families Jev reviews one by one; the rest are counted, never shown. */
const ERROR_REVIEW_MAX = 20
const ERROR_SAMPLE_CHARS = 280

function problemFamilies(events) {
  const families = new Map()
  const t0 = events[0]?.at ?? 0
  for (const e of events) {
    if (e.level !== 'warn' && e.level !== 'error') continue
    if (FREEZE_LINE_RE.test(e.text)) continue
    const key = family(e.text)
    const row = families.get(key)
    if (row) {
      row.count += 1
      row.lastS = Math.round((e.at - t0) / 1000)
      if (e.level === 'error') row.level = 'error'
      continue
    }
    const s = Math.round((e.at - t0) / 1000)
    families.set(key, { family: key, level: e.level, count: 1, firstS: s, lastS: s, sample: e.text.slice(0, ERROR_SAMPLE_CHARS) })
  }
  return [...families.values()]
}

/**
 * Every distinct warning/error family in `latest`, deduplicated by code, for
 * Jev to sort signal from noise. Errors and families the previous upload did
 * not have go first; each carries one raw line so the verdict quotes the log,
 * not a paraphrase. `null` when the raw lines are not at hand.
 */
function errorReview(latest, previous) {
  if (!latest?.events) return null
  const all = problemFamilies(latest.events)
  const before = previous?.events ? new Set(problemFamilies(previous.events).map((f) => f.family)) : null
  for (const f of all) f.newSincePrevious = before ? !before.has(f.family) : null
  const rank = (f) => (f.level === 'error' ? 0 : 2) + (f.newSincePrevious ? 0 : 1)
  all.sort((a, b) => rank(a) - rank(b) || b.count - a.count)
  const candidates = all.slice(0, ERROR_REVIEW_MAX)
  const rest = all.slice(ERROR_REVIEW_MAX)
  return {
    families: all.length,
    lines: all.reduce((n, f) => n + f.count, 0),
    candidates,
    unreviewed: { families: rest.length, lines: rest.reduce((n, f) => n + f.count, 0) },
  }
}

const ERROR_ID = (i) => `error_${i}`
const ERROR_ROOT = 'error_root'

function errorQuestions(review) {
  if (!review?.candidates.length) return {}
  const questions = {}
  review.candidates.forEach((_, i) => {
    questions[ERROR_ID(i)] = {
      type: 'noul',
      instructions:
        `Is \`errorReview.candidates[${i}]\` a real problem an engineer should act on? Each candidate is one deduplicated warning/error family from a HandCash wallet session: \`sample\` is a raw log line, \`count\` how often the family repeated, \`firstS\`/\`lastS\` seconds into the session, \`newSincePrevious\` whether the previous upload lacked it. A failure that repeats across the session is still failing.`,
      criteria: {
        true: 'A defect or failure: an operation that errors and keeps erroring, a crash, a user task that could not complete, funds, tokens or items that may be stuck, missing or wrong, refused or lost data, or a server error (HTTP 4xx/5xx other than rate limiting) the wallet keeps hitting.',
        false: 'Noise: a slow-operation or performance note, an expected short wait (unmined parents, a deferral, a watchdog that cleared itself), a refusal by design (locked wallet, denied permission, user cancel), a one-off network blip, or the same failure a lower-indexed candidate already states in other words.',
      },
    }
  })
  const options = {}
  review.candidates.forEach((f, i) => {
    options[`c${i}`] = `\`errorReview.candidates[${i}]\`: ${f.family.slice(0, 120)}`
  })
  options.none = 'Every candidate is noise; nothing needs fixing.'
  questions[ERROR_ROOT] = {
    type: 'choice',
    instructions:
      'Which single family in `errorReview.candidates` is the root problem — the one the other real problems follow from, or the one that most needs fixing first?',
    criteria: options,
  }
  return questions
}

/** Jev's verdicts folded back onto the code-found families: the root, what matters, and how much was noise. */
function distillErrors(review, answers) {
  if (!review?.candidates.length) return null
  const judged = review.candidates.map((f, i) => ({ ...f, p: answers?.[ERROR_ID(i)]?.noul ?? null }))
  const relevant = judged.filter((f) => f.p != null && f.p >= 0.5).sort((a, b) => b.p - a.p)
  const noise = judged.filter((f) => f.p == null || f.p < 0.5)
  const pick = answers?.[ERROR_ROOT]
  const at = typeof pick?.choice === 'string' && /^c\d+$/.test(pick.choice) ? Number(pick.choice.slice(1)) : null
  // A root the per-family question called noise is not shown as the root.
  const root =
    at != null && judged[at]?.p != null && judged[at].p >= 0.5 ? { ...judged[at], confidence: pick.confidence ?? null } : null
  return {
    root,
    relevant,
    noise: {
      families: noise.length + review.unreviewed.families,
      lines: noise.reduce((n, f) => n + f.count, 0) + review.unreviewed.lines,
    },
    families: review.families,
    lines: review.lines,
  }
}

const isErrorQuestion = (key) => key === ERROR_ROOT || /^error_\d+$/.test(key)

/**
 * Jev judges from counts and a few trails. Every open holdings row carrying its
 * whole trail, for both uploads, overflows the model's context; the printed
 * report still reads the full state.
 */
const MODEL_TRAILED_ROWS = 4
const MODEL_TRAIL_LINES = 4
/** Send starts / trails the model sees; the full lists stay in `--state`. */
const MODEL_SEND_STARTS = 4
const MODEL_SEND_LINES = 8

function modelState(state) {
  const slimSends = (sends) =>
    sends && {
      ...sends,
      starts: (sends.starts ?? []).slice(-MODEL_SEND_STARTS).map((start) => ({
        ...start,
        lines: (start.lines ?? []).slice(-MODEL_SEND_LINES),
      })),
      trails: (sends.trails ?? []).map((trail) => ({
        ...trail,
        lines: (trail.lines ?? []).slice(-MODEL_SEND_LINES),
      })),
    }
  const slimBroadcast = (broadcast) =>
    broadcast?.deadTrails && {
      ...broadcast,
      deadTrails: broadcast.deadTrails.map(({ before, after, lines, ...trail }) => ({
        ...trail,
        lines: (lines ?? []).slice(-MODEL_TRAIL_LINES),
      })),
    }
  const slim = (session) => {
    if (!session) return session
    const withBroadcast = session.broadcast?.deadTrails
      ? { ...session, broadcast: slimBroadcast(session.broadcast) }
      : session
    const withSends = withBroadcast.tokenSends
      ? { ...withBroadcast, tokenSends: slimSends(withBroadcast.tokenSends) }
      : withBroadcast
    const rc = withSends.holdings?.reconcile
    if (!rc) return withSends
    const open = rc.open.map(({ trail, ...row }, i) =>
      i < MODEL_TRAILED_ROWS && trail?.length ? { ...row, trail: trail.slice(0, MODEL_TRAIL_LINES) } : row,
    )
    return { ...withSends, holdings: { ...withSends.holdings, reconcile: { ...rc, open } } }
  }
  return Object.fromEntries(Object.entries(state).map(([key, session]) => [key, slim(session)]))
}

/** Every array capped to its last few entries and every string shortened. */
function compactFacts(value, items, chars) {
  if (typeof value === 'string') return value.length > chars ? `${value.slice(0, chars)}…` : value
  if (Array.isArray(value)) return value.slice(-items).map((v) => compactFacts(v, items, chars))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compactFacts(v, items, chars)]))
  }
  return value
}

/**
 * States offered to the model, largest first. Counts survive every tier; only
 * example rows and trail lines shrink, and `previous` shrinks before `latest`.
 */
function modelStateTiers(fullState) {
  const slim = modelState(fullState)
  return [
    slim,
    { ...slim, previous: compactFacts(slim.previous, 3, 160) },
    { latest: compactFacts(slim.latest, 3, 160), previous: compactFacts(slim.previous, 1, 80) },
    { latest: compactFacts(slim.latest, 1, 120), previous: compactFacts(slim.previous, 0, 60) },
  ]
}

async function askJev(fullState, apiKey) {
  const review = errorReview(fullState.latest, fullState.previous)
  const questions = {
    ...QUESTIONS,
    ...forensicQuestions(fullState.latest, fullState.previous),
    ...errorQuestions(review),
  }
  for (const [tier, tierState] of modelStateTiers(fullState).entries()) {
    // The candidates are indexed by the questions, so no tier may trim them.
    const state = review ? { ...tierState, errorReview: { candidates: review.candidates } } : tierState
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await fetch(TYPESAFE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state, model: 'jev-latest', questions }),
      })
      if (res.ok) {
        if (tier > 0) console.error(`[triage] model state compacted to tier ${tier} to fit Jev's input`)
        const body = await res.json()
        return { ...body, questions, tier, errors: distillErrors(review, body.answers) }
      }
      const body = await res.text()
      if (res.status === 400 && body.includes('max_tokens_exceeded')) break
      if (res.status !== 429 && res.status !== 529) {
        throw new Error(`typesafe ${res.status}: ${body.slice(0, 300)}`)
      }
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
      if (attempt === 3) throw new Error('typesafe overloaded after retries')
    }
  }
  throw new Error('typesafe max_tokens_exceeded even with the smallest model state')
}

/** The Jev-distilled errors as plain lines: root, what matters (raw), and the noise as one count. */
function errorLines(errors) {
  if (!errors) return []
  const out = []
  const tag = (f) => `${f.count}× ${f.level}${f.newSincePrevious ? ' new' : ''}`
  if (errors.root) out.push(`root (${errors.root.confidence ?? '?'}): ${tag(errors.root)} ${errors.root.sample}`)
  for (const f of errors.relevant) {
    if (errors.root && f.family === errors.root.family) continue
    out.push(`${Math.round(f.p * 100)}% ${tag(f)} ${f.sample}`)
  }
  out.push(
    `${errors.relevant.length} of ${errors.families} families matter · noise: ${errors.noise.families} families, ${errors.noise.lines} lines`,
  )
  return out
}

export {
  askJev,
  beforeLeftBasket,
  bridgeFacts,
  errorLines,
  errorReview,
  isErrorQuestion,
  modelStateTiers,
  parseElectronLog,
  parseSession,
  ringEvents,
  sessionFacts,
  splitUploads,
  traceTxid,
}
