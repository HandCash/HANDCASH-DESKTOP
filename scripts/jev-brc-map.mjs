#!/usr/bin/env node
/**
 * Map every wallet feature to the BRC it implements, and find the features
 * that have no BRC but should, with Jev (TypeSafe System One).
 *
 *   node scripts/jev-brc-map.mjs            # → docs/brc-coverage.md + .json
 *   node scripts/jev-brc-map.mjs --facts    # code facts only, no Jev call
 *   node scripts/jev-brc-map.mjs --limit 10 # first N modules (trial)
 *
 * **Code** collects the facts: every non-test module under src/wallet,
 * src/contracts, src/ports and electron (header comment, exports, the BRC
 * numbers its source names), the bridge's non-BRC-100 methods, and the BRC
 * catalog (bsv-blockchain/BRCs upstream master plus our draft branches beside
 * it). **Jev** judges: is a module a feature, which area, does it cross a
 * boundary another implementation must agree on, which BRCs it implements or
 * uses, and — for interoperable features with no BRC — whether one should
 * exist. Never ask the model to count; ranking, grouping and the report are code.
 *
 * Answers are cached by question hash in node_modules/.cache/brc-map, so a
 * re-run pays only for modules or questions that changed.
 * Needs JEV_API_KEY or JEV_KEY (environment, HandCash/.env, or this repo's .env).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.resolve(root, '..')
const BRCS_REPO = path.join(workspace, 'BRCs')
const CACHE_DIR = path.join(root, 'node_modules', '.cache', 'brc-map')
const OUT_MD = path.join(root, 'docs', 'brc-coverage.md')
const OUT_JSON = path.join(root, 'docs', 'brc-coverage.json')
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'
const CONCURRENCY = 8

const args = process.argv.slice(2)
const FACTS_ONLY = args.includes('--facts')
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || Infinity

/* ------------------------------------------------------------------ policy */

const POLICY = {
  feature: 0.5, // is_feature
  interop: 0.5, // crosses a boundary another implementation must agree on
  implements: 0.5, // P(implements) for a BRC the module's source names
  implementsUncited: 0.9, // P(implements) for a BRC the source never names (title overlap fools 0.8)
  uncovered: 0.5, // interoperable part no implemented BRC specifies
  uses: 0.5, // P(uses) for a BRC to count as relied on
  candidates: 6, // BRC candidates per module from the catalog choice
  candidateFloor: 0.02,
  needsBrc: 0.5,
  specified: 0.5, // full-text check: a proposed gap a BRC already specifies is not a gap
}

const AREAS = {
  payments: 'Paying and receiving BSV: BRC-29 payments, P2PKH sends, change, fees, payment delivery',
  items: '1Sat ordinals / collectables: inscriptions, provenance, item send and receive, item views',
  tokens: 'BSV-21 fungible tokens: balances, sends, issuance, token provenance',
  market: 'Marketplace: listings, purchases, settlement, adverts',
  identity: 'Identity: identity keys, certificates, issuer identities, public identity publishing, BAP, Sigma',
  handles: 'Handles and resolution: $handles, paymail-style lookup, contact directory',
  messaging: 'Messaging: BRC-33 messagebox, chat, notices, envelopes, inbox and outbox',
  peer_sessions: 'Live device-to-device or peer sessions: WebRTC data channels, session upgrade, vault link',
  app_bridge: 'App connection: the BRC-100 local bridge, origins, permission prompts, spending authorization',
  keys_crypto: 'Key derivation and cryptography: BRC-42/43 keys, signatures, encryption, HMAC, vault keys',
  chain: 'Chain access: SPV, BEEF, Merkle proofs, headers, broadcasting, miners, indexers',
  local_state: 'Local wallet state: toolbox storage, baskets, outputs, actions, healing and repair',
  backup_sync: 'Backup and history replication: BRC-39 history backups, journals, device sync',
  devices_accounts: 'Devices and accounts: vault sub-accounts, account holding across devices, moving accounts, handover',
  import_migration: 'Import and migration: legacy HandCash, phrase sweeps, other wallets, 1Sat import',
  recovery_login: 'Unlock, login and recovery: passwords, device login, recovery shares, wipe',
  diagnostics: 'Diagnostics: logs, log shipping, traces, health checks',
  shell: 'Application shell: Electron main process, updates, windows, native integration',
  ui_support: 'UI support: view models, formatting, charts that only drive screens',
  other: 'None of the above',
}

const BRC100_METHODS = new Set(
  'getVersion getNetwork isAuthenticated waitForAuthentication getPublicKey createAction signAction abortAction listActions internalizeAction listOutputs relinquishOutput encrypt decrypt createHmac verifyHmac createSignature verifySignature acquireCertificate listCertificates proveCertificate relinquishCertificate discoverByIdentityKey discoverByAttributes revealCounterpartyKeyLinkage revealSpecificKeyLinkage getHeight getHeaderForHeight'.split(
    ' ',
  ),
)

/* ------------------------------------------------------------------ facts */

const words = (s) => s.split(/\s+/).filter(Boolean)
const capWords = (s, n) => {
  const w = words(s)
  return w.length > n ? `${w.slice(0, n).join(' ')} …` : w.join(' ')
}
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12)
const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })

function brcAbstract(md) {
  const body = md.replace(/\r/g, '')
  const abs = body.match(/^##+\s*Abstract\s*\n+([\s\S]*?)(?=\n##+\s|$)/im)
  const text = abs
    ? abs[1]
    : body
        .split(/\n{2,}/)
        .slice(1)
        .find((p) => words(p).length > 20 && !p.startsWith('#')) ?? ''
  return capWords(text.replace(/[`*_>#]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'), 140)
}

/** Every section heading, so a judge can see what a spec covers beyond its abstract. */
function brcSections(md) {
  return [...md.matchAll(/^#{2,4}\s+(.+)$/gm)].map((m) => m[1].replace(/[`*_]/g, '').trim()).slice(0, 60)
}

/** bsv-blockchain/BRCs upstream master, then our draft branches (`../BRCs-<n>`) override by number. */
function brcCatalog() {
  if (!fs.existsSync(BRCS_REPO)) throw new Error(`BRC catalog repo not found at ${BRCS_REPO}`)
  try {
    git(BRCS_REPO, 'fetch', '-q', 'upstream')
  } catch {
    console.error('[brc-map] could not fetch upstream BRCs; using the last fetched upstream/master')
  }
  const ref = 'upstream/master'
  const catalog = new Map()
  for (const file of git(BRCS_REPO, 'ls-tree', '-r', '--name-only', ref).split('\n')) {
    const m = file.match(/\/(\d{4})\.md$/)
    if (!m) continue
    const md = git(BRCS_REPO, 'show', `${ref}:${file}`)
    const title = (md.match(/^#\s+(?:BRC-\d+:\s*)?(.+)$/m)?.[1] ?? file).trim()
    catalog.set(Number(m[1]), { n: Number(m[1]), title, file, status: /withdrawn/i.test(title) ? 'withdrawn' : 'merged', abstract: brcAbstract(md), sections: brcSections(md), text: md })
  }
  for (const dir of fs.readdirSync(workspace).filter((d) => /^BRCs-\d+$/.test(d))) {
    const n = Number(dir.slice(5))
    const file = execFileSync('find', [path.join(workspace, dir), '-name', `${String(n).padStart(4, '0')}.md`, '-not', '-path', '*/.git/*'], { encoding: 'utf8' })
      .split('\n')
      .find(Boolean)
    if (!file) continue
    const md = fs.readFileSync(file, 'utf8')
    const title = (md.match(/^#\s+(?:BRC-\d+:\s*)?(.+)$/m)?.[1] ?? dir).trim()
    const merged = catalog.has(n)
    catalog.set(n, { n, title, file: path.relative(workspace, file), status: merged ? 'merged, revision on branch' : 'draft', abstract: brcAbstract(md), sections: brcSections(md), text: md })
  }
  return catalog
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'fixtures') walk(p, out)
    } else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.(test|fixture|fixtures|testFixtures|d)[.-]/.test(e.name)) out.push(p)
  }
  return out
}

function header(source) {
  const src = source.replace(/^(\s*\/\/\/[^\n]*\n)+/, '')
  const top = src.match(/^\s*((?:\/\/[^\n]*\n\s*)+|\/\*[\s\S]*?\*\/)/)
  const block = top?.[1] ?? src.match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? ''
  return capWords(
    block
      .replace(/^\s*\/\*\*?|\*\/\s*$/g, '')
      .replace(/^\s*(\*|\/\/)\s?/gm, '')
      .trim(),
    320,
  )
}

/** "sendBrc29Payment" → "Send BRC-29 payment". */
function featureName(file) {
  const base = path.basename(file).replace(/\.(ts|tsx|mjs)$/, '')
  const spaced = base
    .replace(/[-_.]/g, ' ')
    .replace(/[Bb]rc(\d+)/g, ' BRC-$1 ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/brc-(\d+)/g, 'BRC-$1')
    .replace(/\b(spv|beef|bsv|ui|qr|p2pkh|ipc|rtc|bap|utxo|hd|wif|nft|ord|api|idb|url|uri|http|json|mnee|sdk)\b/g, (s) => s.toUpperCase())
  const dir = path.relative(root, path.dirname(file)).split(path.sep).slice(2).join('/')
  const name = spaced.charAt(0).toUpperCase() + spaced.slice(1)
  return dir && base === 'index' ? dir : dir && !['import', 'token'].includes(dir) ? `${name} (${dir})` : name
}

function moduleFacts(catalog) {
  const files = ['src/wallet', 'src/contracts', 'src/ports', 'electron'].flatMap((d) => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : []))
  return files.sort().map((abs) => {
    const src = fs.readFileSync(abs, 'utf8')
    const rel = path.relative(root, abs)
    const mentions = [...new Set([...src.matchAll(/\bBRC[- ]?(\d{1,3})\b/gi)].map((m) => Number(m[1])))].filter((n) => catalog.has(n)).sort((a, b) => a - b)
    const exports = [...new Set([...src.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+(\w+)/gm)].map((m) => m[1]))].slice(0, 40)
    const doc = header(src)
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(import\s|\/\/|\*|\/\*)/.test(l) && l.trim())
      .slice(0, doc ? 30 : 70)
      .join('\n')
    const withoutImports = src
      .replace(/^(\s*\/\/\/[^\n]*\n)+/, '')
      .replace(/^\s*import\s[\s\S]*?\bfrom\s*['"][^'"]+['"];?[ \t]*$/gm, '')
      .replace(/^\s*import\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    const hasTopHeader = /^\s*(\/\/|\/\*)/.test(withoutImports)
    return { id: rel, kind: 'module', name: featureName(rel), path: rel, lines: src.split('\n').length, header: doc, hasTopHeader, exports, mentions, code: capWords(code, doc ? 260 : 600) }
  })
}

/** HandCash-only bridge methods (Layer 3) are features of their own, not just lines in brc100Handler. */
function bridgeFacts() {
  const src = fs.readFileSync(path.join(root, 'src/wallet/brc100Handler.ts'), 'utf8')
  const lines = src.split('\n')
  const families = {
    'Bridge: wallet balance (getBalance)': ['getBalance'],
    'Bridge: cloud handle claim (claimCloudHandle, getClaimedCloudHandle, clearClaimedCloudHandle)': ['claimCloudHandle', 'getClaimedCloudHandle', 'clearClaimedCloudHandle'],
    'Bridge: HandCash migrate (getLegacyAddress, refreshLegacyAddress, listMigrationTxids)': ['getLegacyAddress', 'refreshLegacyAddress', 'listMigrationTxids'],
    'Bridge: market methods (listing adverts, purchase intents, settlement receipts, token icons)': [],
    'Bridge: admin identity proof (createAdminIdentityProof)': ['createAdminIdentityProof'],
    'Bridge: key recovery (openKeyRecovery)': ['openKeyRecovery'],
  }
  const cases = [...src.matchAll(/^\s+case '([a-zA-Z]+)':/gm)].map((m) => m[1]).filter((m) => !BRC100_METHODS.has(m))
  families['Bridge: market methods (listing adverts, purchase intents, settlement receipts, token icons)'] = cases.filter((c) => /market|TokenIcon/i.test(c))
  return Object.entries(families).map(([name, methods]) => {
    const snippet = methods
      .flatMap((m) => {
        const i = lines.findIndex((l) => l.includes(`case '${m}':`))
        return i < 0 ? [] : lines.slice(i, i + 8)
      })
      .join('\n')
    return { id: `bridge:${methods.join(',')}`, kind: 'bridge', name, path: 'src/wallet/brc100Handler.ts', lines: 0, header: `HandCash-only BRC-100 bridge methods (not in BRC-100): ${methods.join(', ')}. Feature-detect with a 404 check.`, exports: methods, mentions: [], code: capWords(snippet, 500) }
  })
}

/** BRCs ranked by distinctive words shared with a module (IDF-weighted), for the full-text check. */
function lexicalIndex(catalog) {
  const tokens = (s) => new Set(s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])
  const docs = [...catalog.values()].map((b) => ({ n: b.n, t: tokens(b.text) }))
  const df = new Map()
  for (const d of docs) for (const t of d.t) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = (t) => Math.log(docs.length / (df.get(t) ?? docs.length))
  return (u, k = 3) => {
    const m = tokens(`${u.header} ${u.exports.join(' ')} ${u.code}`)
    return docs
      .map((d) => {
        let s = 0
        for (const t of m) if (d.t.has(t)) s += idf(t)
        return { n: d.n, s: s / Math.log(d.t.size + 10) }
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((d) => d.n)
  }
}

/* ------------------------------------------------------------------ jev */

function envSecret(names) {
  for (const name of names) if (process.env[name]?.trim()) return process.env[name].trim()
  for (const envFile of [path.join(root, '.env'), path.join(root, '..', '.env')]) {
    if (!fs.existsSync(envFile)) continue
    const hit = fs.readFileSync(envFile, 'utf8').match(new RegExp(`^\\s*(?:${names.join('|')})\\s*=\\s*(.+)$`, 'm'))
    if (hit) return hit[1].trim().replace(/^["']|["']$/g, '')
  }
  return null
}

const usage = { requests: 0, tokens: 0, models: new Set() }

async function ask(state, questions) {
  const key = envSecret(['JEV_API_KEY', 'JEV_KEY', 'TYPESAFE_API_KEY'])
  if (!key) throw new Error('JEV_API_KEY / JEV_KEY is not set (env, HandCash/.env or HANDCASH-DESKTOP/.env)')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: AbortSignal.timeout(120_000),
    })
    if (res.ok) {
      const body = await res.json()
      usage.requests += 1
      usage.tokens += body.usage?.input_tokens ?? 0
      if (body.model) usage.models.add(body.model)
      return body.answers
    }
    const text = await res.text()
    const transient = res.status === 429 || res.status === 499 || res.status >= 500
    if (!transient || attempt === 5) throw new Error(`typesafe ${res.status}: ${text.slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt))
  }
  throw new Error('unreachable')
}

async function pool(items, n, fn) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        await fn(items[i], i)
      }
    }),
  )
}

function cache(name) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const file = path.join(CACHE_DIR, `${name}.jsonl`)
  const map = new Map()
  if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l)
    map.set(r.key, r)
  }
  return {
    get: (key) => map.get(key)?.answers,
    set(key, answers) {
      map.set(key, { key, answers })
      fs.appendFileSync(file, `${JSON.stringify({ key, answers })}\n`)
    },
    compact(keep) {
      fs.writeFileSync(file, [...map.values()].filter((r) => keep.has(r.key)).map((r) => `${JSON.stringify(r)}\n`).join(''))
    },
  }
}

const unitState = (u) => ({
  module: { path: u.path, header_comment: u.header || '(none)', exports: u.exports, brc_numbers_named_in_source: u.mentions, code_excerpt: u.code },
})

/* ---------------------------------------------------------------- questions */

function classifyQuestions(catalog) {
  const brcCriteria = Object.fromEntries([...catalog.values()].map((b) => [`brc${b.n}`, `BRC-${b.n}: ${b.title}`]))
  brcCriteria.none = 'No BRC specification describes what this module does'
  return {
    is_feature: {
      type: 'noul',
      instructions:
        'Does `module` carry a wallet capability of its own — something a user, a connected app, another wallet or another device relies on, such as a payment or item path, a protocol endpoint or transport (the app bridge server, a peer channel), a backup or message format, a recovery or account flow — rather than being an internal helper, cache, retry wrapper, type definition, test support, or screen glue?',
      criteria: { true: 'Carries a wallet capability or protocol behaviour', false: 'Internal plumbing or support code' },
    },
    area: {
      type: 'choice',
      instructions: 'Which area of a Bitcoin wallet does `module` belong to?',
      criteria: AREAS,
    },
    interop: {
      type: 'noul',
      instructions:
        'Does `module` produce or consume something another implementation must interpret the same way — a wire message, an on-chain script or data format, a signed record, a file or backup format, an HTTP or bridge API, or a protocol between devices or parties? Internal storage, UI and local policy do not count.',
      criteria: { true: 'Crosses a boundary another implementation must agree on', false: 'Local to this wallet' },
    },
    brc: {
      type: 'choice',
      instructions:
        'Which BRC specification does `module` most directly implement or follow? `brc_numbers_named_in_source` lists BRCs the file text names; a name alone is not proof. Choose `none` when no BRC describes what it does.',
      criteria: brcCriteria,
    },
  }
}

function mappingQuestions(candidates) {
  return Object.fromEntries(
    candidates.map((n) => [
      `brc${n}`,
      {
        type: 'choice',
        instructions: `How does \`module\` relate to \`brcs.brc${n}\`? Read its title, abstract and \`sections\` — a module may implement one section of a broader BRC (a header comment citing a section number is strong evidence).`,
        criteria: {
          implements: 'It implements part of that specification: it builds, parses, verifies or enforces what the BRC defines',
          uses: 'It relies on that specification through other code (calls a wallet method or library that implements it) without implementing it',
          mentions: 'It only names or refers to the BRC; its behaviour does not depend on it',
          unrelated: 'Unrelated',
        },
      },
    ]),
  )
}

function gapQuestions(candidates) {
  const closest = Object.fromEntries(candidates.map((b) => [`brc${b.n}`, `Extend BRC-${b.n}: ${b.title}`]))
  closest.none = 'No existing BRC is a reasonable home'
  return {
    uncovered: {
      type: 'noul',
      instructions:
        '`module` crosses a boundary other implementations must agree on. Does it define or depend on an interoperable part — a message type, record or file format, signed statement, endpoint, script, or protocol rule between parties or devices — that none of `implemented_brcs` specifies? Use each BRC\'s `sections` to see what it covers; a draft BRC counts as specifying what its sections cover. If `implemented_brcs` is empty, judge whether any such part exists at all.',
      criteria: { true: 'Has an interoperable part no implemented BRC specifies', false: 'Fully covered by the BRCs it implements' },
    },
    needs_brc: {
      type: 'noul',
      instructions:
        "Should the interoperable part of `module` that `implemented_brcs` does not specify be written up as a BRC, so another wallet, app, server or device could interoperate with it? Answer false if it is HandCash-internal policy, a private HandCash service contract, or already fully covered by a general standard.",
      criteria: { true: 'It should be specified as a BRC', false: 'No BRC is needed' },
    },
    gap_kind: {
      type: 'choice',
      instructions: 'What is the right way to specify the interoperable part of `module`?',
      criteria: {
        new_brc: 'A new BRC of its own',
        extend_existing: 'An extension or new section of an existing BRC',
        covered: 'An existing BRC already covers it; the module just does not cite or follow it',
        not_needed: 'No specification needed: internal, private, or HandCash-specific',
      },
    },
    closest: {
      type: 'choice',
      instructions: 'If the interoperable part of `module` were specified, which existing BRC in `candidate_brcs` would be its natural home?',
      criteria: closest,
    },
    priority: {
      type: 'score',
      instructions: 'How valuable would specifying the interoperable part of `module` be for wallets and apps beyond HandCash?',
      criteria: [
        'None: nobody else needs to interoperate with it',
        'Low: a nicety for documentation',
        'Medium: another wallet or app would plausibly implement it',
        'High: interop breaks or users get locked in without it',
        'Critical: it is a core user path that cannot be portable without a spec',
      ],
    },
  }
}

/* ------------------------------------------------------------------ run */

const catalog = brcCatalog()
const units = [...moduleFacts(catalog), ...bridgeFacts()].slice(0, LIMIT)
console.log(`[brc-map] ${units.length} units · ${catalog.size} BRCs (${[...catalog.values()].filter((b) => b.status !== 'merged').map((b) => `${b.n} ${b.status}`).join(', ')})`)

if (FACTS_ONLY) {
  console.log(JSON.stringify({ catalog: [...catalog.values()].map(({ abstract, sections, text, ...b }) => b), units }, null, 2))
  process.exit(0)
}

const classifyQ = classifyQuestions(catalog)
const classifyCache = cache('classify')
const classifyKey = (u) => `${u.id}|${hash({ q: classifyQ, s: unitState(u) })}`
await pool(units, CONCURRENCY, async (u) => {
  if (classifyCache.get(classifyKey(u))) return
  try {
    const a = await ask(unitState(u), classifyQ)
    classifyCache.set(classifyKey(u), { is_feature: a.is_feature.noul, area: a.area.probabilities, interop: a.interop.noul, brc: a.brc.probabilities })
  } catch (err) {
    console.error(`[brc-map] ✗ classify ${u.id}: ${err.message}`)
  }
})
console.log(`[brc-map] classified · ${usage.requests} requests so far`)

const argmax = (p) => Object.entries(p).sort((a, b) => b[1] - a[1])[0]
for (const u of units) {
  const c = classifyCache.get(classifyKey(u))
  if (!c) continue
  u.isFeature = c.is_feature
  u.interop = c.interop
  u.area = argmax(c.area)[0]
  const fromChoice = Object.entries(c.brc)
    .filter(([k, p]) => k !== 'none' && p >= POLICY.candidateFloor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, POLICY.candidates)
    .map(([k]) => Number(k.slice(3)))
  u.noneP = c.brc.none ?? 0
  u.candidates = [...new Set([...fromChoice, ...u.mentions])].slice(0, 14)
}

const mapped = units.filter((u) => u.isFeature != null && (u.isFeature >= POLICY.feature || u.interop >= POLICY.interop || u.mentions.length))
const mapCache = cache('map')
const mapState = (u) => ({
  ...unitState(u),
  brcs: Object.fromEntries(u.candidates.map((n) => {
    const b = catalog.get(n)
    return [`brc${n}`, { title: `BRC-${n}: ${b.title}`, status: b.status, abstract: b.abstract, sections: b.sections }]
  })),
})
const mapKey = (u) => `${u.id}|${hash({ q: mappingQuestions(u.candidates), s: mapState(u) })}`
await pool(mapped.filter((u) => u.candidates.length), CONCURRENCY, async (u) => {
  if (mapCache.get(mapKey(u))) return
  try {
    const a = await ask(mapState(u), mappingQuestions(u.candidates))
    mapCache.set(mapKey(u), Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.probabilities])))
  } catch (err) {
    console.error(`[brc-map] ✗ map ${u.id}: ${err.message}`)
  }
})
for (const u of mapped) {
  const m = (u.candidates.length && mapCache.get(mapKey(u))) || {}
  u.implements = Object.entries(m)
    .map(([k, p]) => ({ n: Number(k.slice(3)), p: p.implements, cited: u.mentions.includes(Number(k.slice(3))) }))
    .filter((b) => b.p >= (b.cited ? POLICY.implements : POLICY.implementsUncited))
    .sort((a, b) => b.p - a.p)
  u.uses = Object.entries(m).filter(([, p]) => p.uses >= POLICY.uses).map(([k, p]) => ({ n: Number(k.slice(3)), p: p.uses })).sort((a, b) => b.p - a.p)
  u.staleMentions = u.mentions.filter((n) => m[`brc${n}`] && Math.max(m[`brc${n}`].implements, m[`brc${n}`].uses) < 0.5 && m[`brc${n}`].unrelated >= 0.5)
}
/** A unit that implements a BRC carries protocol behaviour, so it is a feature even when Jev called it plumbing. */
const features = mapped.filter((u) => u.isFeature >= POLICY.feature || u.implements.length)
console.log(`[brc-map] mapped · ${usage.requests} requests so far`)

const gapCandidates = features.filter((u) => u.interop >= POLICY.interop)
const gapCache = cache('gap')
const brcBrief = (b) => ({ title: `BRC-${b.n}: ${b.title}`, status: b.status, abstract: b.abstract })
const brcFull = (b) => ({ ...brcBrief(b), sections: b.sections })
const gapClosest = (u) => {
  const ns = [...new Set([...u.implements.map((b) => b.n), ...u.candidates])].slice(0, 14)
  return (ns.length ? ns : [100]).map((n) => catalog.get(n))
}
const gapState = (u) => ({
  ...unitState(u),
  implemented_brcs: Object.fromEntries(u.implements.map((b) => [`brc${b.n}`, brcFull(catalog.get(b.n))])),
  candidate_brcs: Object.fromEntries(gapClosest(u).map((b) => [`brc${b.n}`, brcBrief(b)])),
})
const gapKey = (u) => `${u.id}|${hash({ q: gapQuestions(gapClosest(u)), s: gapState(u) })}`
await pool(gapCandidates, CONCURRENCY, async (u) => {
  if (gapCache.get(gapKey(u))) return
  try {
    const a = await ask(gapState(u), gapQuestions(gapClosest(u)))
    gapCache.set(gapKey(u), { uncovered: a.uncovered.noul, needs: a.needs_brc.noul, kind: a.gap_kind.probabilities, closest: a.closest.probabilities, priority: a.priority.score })
  } catch (err) {
    console.error(`[brc-map] ✗ gap ${u.id}: ${err.message}`)
  }
})
for (const u of gapCandidates) {
  const g = gapCache.get(gapKey(u))
  if (!g) continue
  const [closest, cp] = argmax(g.closest)
  u.gap = { uncovered: g.uncovered, needs: g.needs, kind: argmax(g.kind)[0], kindP: argmax(g.kind)[1], closest: closest === 'none' ? null : Number(closest.slice(3)), closestP: cp, priority: g.priority }
}

// Abstracts and headings can hide a section that already specifies the "gap";
// check each proposed gap against the full text of the specs most likely to hold it.
const proposed = gapCandidates.filter((u) => u.gap && u.gap.uncovered >= POLICY.uncovered && u.gap.needs >= POLICY.needsBrc && u.gap.kind !== 'not_needed')
const lexical = lexicalIndex(catalog)
const VERIFY_WORDS = 18_000
const verifyBrcs = (u) => [...new Set([...u.implements.map((b) => b.n), ...(u.gap.closest ? [u.gap.closest] : []), ...u.mentions, ...lexical(u)])].slice(0, 4)
const verifyState = (u) => {
  const ns = verifyBrcs(u)
  const per = Math.floor(VERIFY_WORDS / ns.length)
  return { ...unitState(u), brc_texts: Object.fromEntries(ns.map((n) => [`brc${n}`, { title: `BRC-${n}: ${catalog.get(n).title}`, status: catalog.get(n).status, text: capWords(catalog.get(n).text, per) }])) }
}
const verifyQuestions = (u) => ({
  specified: {
    type: 'noul',
    instructions:
      'Read `brc_texts` in full. Is the interoperable part of `module` — its message, record or file format, signed statement, endpoint, script or protocol rule — already specified by one of them, well enough that another implementation could interoperate with it? A draft counts.',
    criteria: { true: 'Already specified in one of these texts', false: 'Not specified by any of them' },
  },
  where: {
    type: 'choice',
    instructions: 'Which text in `brc_texts` specifies it, if any?',
    criteria: { ...Object.fromEntries(verifyBrcs(u).map((n) => [`brc${n}`, `BRC-${n}`])), none: 'None of them' },
  },
  ...(u.gap.closest
    ? {
        fit: {
          type: 'choice',
          instructions: `Read \`brc_texts.brc${u.gap.closest}\` in full. Would the interoperable part of \`module\` fit as an extension of that BRC, or does \`module\` follow a different design that needs a BRC of its own?`,
          criteria: { extend: `Fits as an extension of BRC-${u.gap.closest}`, new: 'A different design that needs its own BRC' },
        },
      }
    : {}),
})
const verifyCache = cache('verify')
const verifyKey = (u) => `${u.id}|${hash({ q: verifyQuestions(u), s: verifyState(u) })}`
await pool(proposed, CONCURRENCY, async (u) => {
  if (verifyCache.get(verifyKey(u))) return
  try {
    const a = await ask(verifyState(u), verifyQuestions(u))
    verifyCache.set(verifyKey(u), { specified: a.specified.noul, where: a.where.probabilities, fitNew: a.fit?.probabilities.new ?? null })
  } catch (err) {
    console.error(`[brc-map] ✗ verify ${u.id}: ${err.message}`)
  }
})
for (const u of proposed) {
  const v = verifyCache.get(verifyKey(u))
  if (!v) continue
  const [where] = argmax(v.where)
  u.gap.specified = v.specified
  u.gap.specifiedBy = where === 'none' ? null : Number(where.slice(3))
  if (v.fitNew != null && v.fitNew >= 0.5 && u.gap.kind === 'extend_existing') u.gap.kind = 'new_brc'
}

if (LIMIT === Infinity) {
  classifyCache.compact(new Set(units.map(classifyKey)))
  mapCache.compact(new Set(mapped.filter((u) => u.candidates.length).map(mapKey)))
  gapCache.compact(new Set(gapCandidates.map(gapKey)))
  verifyCache.compact(new Set(proposed.map(verifyKey)))
}

/* ------------------------------------------------------------------ report */

const brcLink = (n) => {
  const b = catalog.get(n)
  const label = `BRC-${n}`
  if (b.status === 'merged') return `[${label}](https://github.com/bsv-blockchain/BRCs/blob/master/${b.file})`
  return `${label}${b.status === 'draft' ? ' (draft)' : ''}`
}
const codeLink = (u) => (u.kind === 'bridge' ? `\`${u.path}\`` : `[\`${u.path}\`](../${u.path})`)
const firstSentence = (s) => (s.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? s).replace(/\s+/g, ' ').slice(0, 220)
const describe = (u) =>
  u.kind === 'module' && !u.hasTopHeader
    ? `No module header; exports ${u.exports.slice(0, 4).map((e) => `\`${e}\``).join(', ') || 'nothing'}${u.exports.length > 4 ? ', …' : ''}.`
    : firstSentence(u.header || '') || '—'
const areaName = (a) => AREAS[a].split(':')[0]
const byArea = Object.keys(AREAS).map((a) => [a, features.filter((u) => u.area === a)]).filter(([, l]) => l.length)

const implementedBy = new Map()
for (const u of features) for (const { n } of u.implements) implementedBy.set(n, [...(implementedBy.get(n) ?? []), u])
const usedBy = new Map()
for (const u of features) for (const { n } of u.uses) usedBy.set(n, [...(usedBy.get(n) ?? []), u])

const byPriority = (a, b) => b.gap.priority - a.gap.priority || b.gap.needs - a.gap.needs
const verifiedSpecified = (u) => (u.gap.specified ?? 0) >= POLICY.specified
const gaps = proposed.filter((u) => (u.gap.kind === 'new_brc' || u.gap.kind === 'extend_existing') && !verifiedSpecified(u)).sort(byPriority)
const coveredElsewhere = proposed.filter((u) => u.gap.kind === 'covered' || verifiedSpecified(u)).sort(byPriority)
const gapSet = new Set(gaps)
const uncited = features.filter((u) => u.implements.some((b) => !b.cited))
const PRIORITY = ['none', 'low', 'medium', 'high', 'critical']
const kindLabel = { new_brc: 'new BRC', extend_existing: 'extend existing', covered: 'already covered — cite it', not_needed: 'not needed' }

const out = [
  '# BRC coverage of the wallet',
  '',
  `Generated by \`node scripts/jev-brc-map.mjs\` on ${new Date().toISOString().slice(0, 10)} with Jev (\`${[...usage.models].join(', ') || MODEL}\`). Do not edit by hand.`,
  '',
  `**${units.length} units** scanned (${units.filter((u) => u.kind === 'module').length} non-test modules under \`src/wallet\`, \`src/contracts\`, \`src/ports\`, \`electron\`, plus ${units.filter((u) => u.kind === 'bridge').length} HandCash-only bridge method families) against **${catalog.size} BRCs** (bsv-blockchain/BRCs \`upstream/master\` plus our draft branches). Jev judged **${features.length} of them to be features**; ${features.filter((u) => u.implements.length).length} implement at least one BRC, ${features.filter((u) => u.interop >= POLICY.interop).length} cross a boundary another implementation must agree on, and **${gaps.length} have an interoperable part no BRC specifies but should** (${gaps.filter((u) => u.gap.kind === 'new_brc').length} new BRCs, ${gaps.filter((u) => u.gap.kind === 'extend_existing').length} extensions).`,
  '',
  `**How to read this.** Code collected every fact (headers, exports, BRC numbers named in source, the catalog); Jev made only judgments: feature or plumbing (≥ ${POLICY.feature}), area, interoperable (≥ ${POLICY.interop}), and for each candidate BRC whether the module *implements* it (builds, parses, verifies or enforces what it defines, ≥ ${POLICY.implements}) or only *uses* it through other code. Candidates are Jev's top catalog picks plus every BRC the file names. Mapping and gap questions see each BRC's abstract and section headings; every proposed gap is then checked against the full text of up to four specs (those it implements or names, the closest one, and the three sharing the most distinctive words) and dropped if one already specifies it. Feature names come from module names; descriptions are each module's own header comment.`,
  '',
  '## Features with no BRC that should have one',
  '',
  'Each row is a feature with an interoperable part — a message, record, endpoint or protocol rule another implementation would need — that none of the BRCs it implements specifies, and that Jev judged worth specifying.',
  '',
  '| Priority | Feature | Area | Recommendation | Extend | Already implements | Module |',
  '|---|---|---|---|---|---|---|',
  ...gaps.map((u) => `| ${PRIORITY[Math.round(u.gap.priority)]} (${u.gap.priority.toFixed(1)}) | **${u.name}** — ${describe(u)} | ${areaName(u.area)} | ${kindLabel[u.gap.kind]} | ${u.gap.kind === 'extend_existing' && u.gap.closest ? `${brcLink(u.gap.closest)} ${catalog.get(u.gap.closest).title}` : '—'} | ${u.implements.map((b) => brcLink(b.n)).join(', ') || '—'} | ${codeLink(u)} |`),
  '',
  '## BRCs the wallet implements',
  '',
  '| BRC | Title | Status | Implemented by | Also relied on by |',
  '|---|---|---|---|---|',
  ...[...implementedBy.keys()]
    .sort((a, b) => a - b)
    .map((n) => {
      const b = catalog.get(n)
      const impl = implementedBy.get(n)
      const used = (usedBy.get(n) ?? []).filter((u) => !impl.includes(u))
      return `| ${brcLink(n)} | ${b.title} | ${b.status} | ${impl.map((u) => u.name).join(', ')} | ${used.length ? `${used.length} feature${used.length === 1 ? '' : 's'}` : '—'} |`
    }),
  '',
  `BRCs the wallet relies on without implementing: ${[...usedBy.keys()].filter((n) => !implementedBy.has(n)).sort((a, b) => a - b).map((n) => `${brcLink(n)} (${usedBy.get(n).length})`).join(', ') || '—'}.`,
  '',
  '## Every feature, by area',
  '',
]
for (const [a, list] of byArea) {
  out.push(`### ${areaName(a)}`, '', '| Feature | What it does | Implements | Uses | Module |', '|---|---|---|---|---|')
  for (const u of list.sort((x, y) => x.name.localeCompare(y.name))) {
    const listed = u.implements.map((b) => `${brcLink(b.n)}${b.cited ? '' : ' (uncited)'}`).join(', ')
    const impl = [listed || (u.interop >= POLICY.interop ? 'none' : '— (local)'), gapSet.has(u) ? '**+ part with no BRC**' : ''].filter(Boolean).join(' ')
    out.push(`| ${u.name} | ${describe(u)} | ${impl} | ${u.uses.map((b) => brcLink(b.n)).join(', ') || '—'} | ${codeLink(u)} |`)
  }
  out.push('')
}
if (coveredElsewhere.length || uncited.length) {
  out.push(
    '## Covered by a BRC the code does not cite',
    '',
    'Jev judged these to follow a BRC their source never names (≥ ' + POLICY.implementsUncited + '), or to have an interoperable part an existing BRC already covers. Cite the BRC in the module header so the next reader and the next scan see it.',
    '',
    ...uncited.map((u) => `- ${codeLink(u)} — implements ${u.implements.filter((b) => !b.cited).map((b) => `${brcLink(b.n)} ${catalog.get(b.n).title} (${b.p.toFixed(2)})`).join('; ')}`),
    ...coveredElsewhere.map((u) => {
      const by = verifiedSpecified(u) ? u.gap.specifiedBy : u.gap.closest
      return `- ${codeLink(u)} — interoperable part already covered${by ? ` by ${brcLink(by)} ${catalog.get(by).title}` : ''}${verifiedSpecified(u) ? ' (full-text check)' : ''}`
    }),
    '',
  )
}
const stale = features.filter((u) => u.staleMentions?.length)
if (stale.length) {
  out.push(
    '## BRC names in source that Jev judged unrelated',
    '',
    'The file text names these BRCs, but the module neither implements nor uses them. Usually a stale comment or a cross-reference; worth a look when touching the file.',
    '',
    ...stale.map((u) => `- ${codeLink(u)}: ${u.staleMentions.map(brcLink).join(', ')}`),
    '',
  )
}
out.push('---', '', `Jev this run: ${usage.requests} requests · ${usage.tokens.toLocaleString('en-US')} input tokens · $${((usage.tokens / 1e6) * 0.042).toFixed(3)}. Cached answers: \`node_modules/.cache/brc-map/\`.`)

if (LIMIT === Infinity) {
  fs.writeFileSync(OUT_MD, `${out.join('\n')}\n`)
  fs.writeFileSync(
    OUT_JSON,
    `${JSON.stringify(
      {
        generated: new Date().toISOString(),
        model: [...usage.models],
        policy: POLICY,
        catalog: Object.fromEntries([...catalog.values()].map((b) => [b.n, { title: b.title, status: b.status }])),
        features: features.map((u) => ({ name: u.name, path: u.path, kind: u.kind, area: u.area, isFeature: u.isFeature, interop: u.interop, implements: u.implements, uses: u.uses, mentions: u.mentions, gap: u.gap ?? null })),
        notFeatures: units.filter((u) => u.isFeature != null && u.isFeature < POLICY.feature).map((u) => u.path),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`[brc-map] wrote ${path.relative(root, OUT_MD)} · ${features.length} features · ${gaps.length} gaps`)
} else {
  for (const u of units) console.log(`${(u.isFeature ?? 0).toFixed(2)} ${u.area ?? '?'} interop=${(u.interop ?? 0).toFixed(2)} ${u.path} impl=[${(u.implements ?? []).map((b) => b.n)}] uses=[${(u.uses ?? []).map((b) => b.n)}] cand=[${u.candidates ?? []}]${u.gap ? ` GAP needs=${u.gap.needs.toFixed(2)} ${u.gap.kind} p=${u.gap.priority.toFixed(1)}` : ''}`)
}
console.log(`[brc-map] ${usage.requests} requests · ${usage.tokens.toLocaleString('en-US')} tokens · $${((usage.tokens / 1e6) * 0.042).toFixed(3)}`)
