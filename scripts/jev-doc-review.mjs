#!/usr/bin/env node
/**
 * Review BRC drafts for slop with Jev (TypeSafe System One): padding,
 * restatement, misplaced rationale / implementation / history, ambiguous
 * requirements, and emphasis standing in for definition.
 *
 *   node scripts/jev-doc-review.mjs                       # every HandCash-authored BRC draft
 *   node scripts/jev-doc-review.mjs --file ../BRCs-248/peer-to-peer/0248.md [--file …]
 *   node scripts/jev-doc-review.mjs --json                # facts + raw answers
 *   node scripts/jev-doc-review.mjs --facts               # code facts only, no Jev call
 *
 * Code splits each draft into sections and prose units (sentences, list items,
 * table rows), and computes every exact fact: word and sentence counts, RFC 2119
 * keywords, lowercase modals in normative text, bold runs, implementation paths,
 * draft-history phrases, broken relative links, and units that repeat another
 * draft. Jev judges each unit (keep, cut, merge, move, tighten) and each section
 * (padding, ambiguity, misplaced content, emphasis). Code composes the debt.
 *
 * Needs JEV_API_KEY or JEV_KEY (environment, HandCash/.env, or this repo's .env).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.resolve(root, '..')
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'

const DEFAULT_TARGETS = [
  'BRCs-247/peer-to-peer/0247.md',
  'BRCs-248/peer-to-peer/0248.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/peer/0246.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/wallet/0230.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/wallet/index-expansion-guide.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/tokens/0147.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/tokens/0150.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/tokens/0156.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/tokens/p1sat-permission-scheme.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/tokens/p1sat-listoutputs-guide.md',
  'HANDCASH-DESKTOP/docs/bsva/brcs/tokens/PR-200-RESPONSE.md',
]

/** Repos a relative BRC link may resolve into; drafts on PR branches link to each other. */
const LINK_ROOTS = ['BRCs', 'BRCs-247', 'BRCs-248']
/** Desktop mirrors use short category folder names. */
const CATEGORY_ALIAS = { peer: 'peer-to-peer' }

/* ------------------------------------------------------------------ policy */

const POLICY = Object.freeze({
  /** Noul probability treated as "yes". */
  noulYes: 0.65,
  /** Below this a unit verdict is reported but not counted. */
  unitConfidence: 0.45,
  /** Sections at or above this debt need an edit. */
  sectionAttention: 1,
  /** Containment of 5-word shingles that makes a unit a repeat of another draft. */
  duplicateContainment: 0.6,
  /** A sentence longer than this is a fact worth showing. */
  longSentenceWords: 38,
  /** Whole-draft context budget; Jev allows 32k tokens of state. */
  docChars: 40_000,
})

const WEIGHTS = Object.freeze({
  cutShare: 2.0, // share of units Jev would cut or merge, scaled by confidence
  moveShare: 1.0, // share of units that belong in another section or doc
  tightenShare: 0.75, // share of units that need a sharper requirement
  padding: 0.5,
  ambiguity: 0.75, // normative sections only
  misplaced: 0.5,
  emphasis: 0.25,
  brokenLink: 0.5, // proven, per section
  duplicateShare: 0.75, // proven cross-draft repeats
})

/* -------------------------------------------------------------------- args */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const values = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []))
const JSON_OUT = flag('--json')
const FACTS_ONLY = flag('--facts')
const FILES = values('--file')

function jevApiKey() {
  for (const name of ['JEV_API_KEY', 'JEV_KEY', 'TYPESAFE_API_KEY']) {
    if (process.env[name]?.trim()) return process.env[name].trim()
  }
  for (const envFile of [path.join(root, '.env'), path.join(workspace, '.env')]) {
    if (!fs.existsSync(envFile)) continue
    const hit = fs.readFileSync(envFile, 'utf8').match(/^\s*(?:JEV_API_KEY|JEV_KEY|TYPESAFE_API_KEY)\s*=\s*["']?([^"'\n]+)/m)
    if (hit) return hit[1].trim()
  }
  throw new Error('JEV_API_KEY / JEV_KEY is not set (env, HandCash/.env or HANDCASH-DESKTOP/.env)')
}

function targets() {
  const list = FILES.length ? FILES.map((f) => path.resolve(process.cwd(), f)) : DEFAULT_TARGETS.map((t) => path.join(workspace, t))
  return list.filter((abs) => {
    if (fs.existsSync(abs)) return true
    console.error(`skip (missing): ${path.relative(workspace, abs)}`)
    return false
  })
}

/* ------------------------------------------------------------------- parse */

const SECTION_KIND = [
  [/abstract|summary/i, 'abstract'],
  [/motivation|problem|why/i, 'motivation'],
  [/rationale|design notes|alternatives/i, 'rationale'],
  [/security|privacy|threat/i, 'security'],
  [/^references$|relationship|related|terminology|vocabulary/i, 'references'],
  [/implementation|reference (?:implementation|profile)|shipping reference/i, 'implementation'],
  [/compatib|migration|history|changelog|withdrawn/i, 'history'],
  [/non-goals|out of scope|what this is not/i, 'scope'],
]

function sectionKind(heading, inSpec) {
  for (const [re, kind] of SECTION_KIND) if (re.test(heading)) return kind
  return inSpec ? 'specification' : 'other'
}

/** Split markdown into `##`/`###` sections; `###` under Specification inherit its normative kind. */
function sections(lines) {
  const out = []
  let current = { heading: '(preamble)', level: 1, startLine: 1, lines: [] }
  let inSpec = false
  let fence = false
  lines.forEach((line, i) => {
    if (/^```/.test(line)) fence = !fence
    const h = !fence && line.match(/^(#{1,4})\s+(.*)$/)
    if (h && h[1].length >= 2) {
      out.push(current)
      const level = h[1].length
      if (level === 2) inSpec = /specification|protocol|wire format|normative/i.test(h[2])
      current = { heading: h[2].trim(), level, startLine: i + 1, lines: [] }
      current.kind = sectionKind(current.heading, inSpec)
      return
    }
    current.lines.push({ n: i + 1, text: line })
  })
  out.push(current)
  for (const s of out) s.kind ??= 'other'
  return out.filter((s) => s.lines.some((l) => l.text.trim()))
}

const words = (s) => s.split(/\s+/).filter(Boolean)

/** Prose units: sentences of paragraphs and list items, and whole table rows. Code blocks are skipped. */
function units(section) {
  const out = []
  let fence = false
  let para = []
  const flush = () => {
    if (!para.length) return
    const text = para.map((l) => l.text.trim()).join(' ')
    const line = para[0].n
    const parts = text.split(/(?<=[.!?][)\]"'`*]*)\s+(?=[A-Z0-9`*[(])/)
    for (const p of parts) if (p.trim()) out.push({ line, kind: 'sentence', text: p.trim() })
    para = []
  }
  for (const l of section.lines) {
    if (/^```/.test(l.text.trim())) {
      flush()
      fence = !fence
      continue
    }
    if (fence) continue
    const t = l.text.trim()
    if (!t || /^(-{3,}|\*{3,})$/.test(t)) {
      flush()
      continue
    }
    if (/^\|/.test(t)) {
      flush()
      if (/^\|[\s|:-]+\|$/.test(t)) {
        if (out.at(-1)?.kind === 'table-row') out.pop().kind = 'table-header'
        continue
      }
      out.push({ line: l.n, kind: 'table-row', text: t })
      continue
    }
    if (/^([-*]|\d+\.)\s+/.test(t)) {
      flush()
      para = [{ n: l.n, text: t.replace(/^([-*]|\d+\.)\s+/, '') }]
      continue
    }
    para.push(l)
  }
  flush()
  return out.map((u, i) => ({ i, ...u, words: words(u.text).length }))
}

/* ------------------------------------------------------------------- facts */

const RFC2119 = ['MUST NOT', 'MUST', 'SHOULD NOT', 'SHOULD', 'MAY', 'REQUIRED', 'OPTIONAL']
const HISTORY_RE = /\b(earlier draft|withdrawn|previously|formerly|no longer|used to|was cancelled|replaces? the)\b/gi
const IMPL_RE = /`?(?:src|electron|packages)\/[\w./-]+`?|\bHandCash (?:Desktop|uses|wallet)\b/g

function resolveLink(abs, target) {
  if (/^(https?:|mailto:|#)/.test(target)) return true
  const clean = target.split('#')[0]
  if (!clean) return true
  if (fs.existsSync(path.resolve(path.dirname(abs), clean))) return true
  const rel = path.relative(workspace, abs).split(path.sep)
  let category
  if (LINK_ROOTS.includes(rel[0])) category = rel[1]
  else {
    const i = rel.indexOf('brcs')
    if (i < 0) return false
    category = CATEGORY_ALIAS[rel[i + 1]] ?? rel[i + 1]
  }
  return LINK_ROOTS.some((repo) => fs.existsSync(path.resolve(workspace, repo, category, clean)))
}

function shingles(text) {
  const w = words(text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' '))
  const set = new Set()
  for (let i = 0; i + 5 <= w.length; i += 1) set.add(w.slice(i, i + 5).join(' '))
  return set
}

function sectionFacts(abs, section, sectionUnits) {
  const text = section.lines.map((l) => l.text).join('\n')
  const prose = sectionUnits.map((u) => u.text).join(' ')
  const rfc = {}
  let rest = prose
  for (const k of RFC2119) {
    const n = (rest.match(new RegExp(`\\b${k}\\b`, 'g')) ?? []).length
    if (n) rfc[k] = n
    rest = rest.replace(new RegExp(`\\b${k}\\b`, 'g'), '')
  }
  const normative = section.kind === 'specification'
  const lowercaseModals = normative ? (prose.match(/\b(?:must|should|shall|required to)\b/g) ?? []).length : 0
  const brokenLinks = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !resolveLink(abs, t))
  const sentences = sectionUnits.filter((u) => u.kind === 'sentence')
  return {
    words: words(prose).length,
    units: sectionUnits.length,
    meanSentenceWords: sentences.length ? Math.round(sentences.reduce((a, u) => a + u.words, 0) / sentences.length) : 0,
    longSentences: sentences.filter((u) => u.words > POLICY.longSentenceWords).map((u) => u.line),
    rfc2119: rfc,
    lowercaseModals,
    boldRuns: (text.match(/\*\*[^*]+\*\*/g) ?? []).length,
    implementationRefs: normative ? [...new Set(prose.match(IMPL_RE) ?? [])] : [],
    historyPhrases: [...new Set((prose.match(HISTORY_RE) ?? []).map((s) => s.toLowerCase()))],
    brokenLinks,
  }
}

function loadDoc(abs) {
  const raw = fs.readFileSync(abs, 'utf8')
  const lines = raw.split('\n')
  const name = path.relative(workspace, abs)
  const title = lines.find((l) => /^#\s/.test(l))?.replace(/^#\s+/, '') ?? name
  const secs = sections(lines).map((s) => {
    const u = units(s)
    return { ...s, units: u, facts: sectionFacts(abs, s, u) }
  })
  return { abs, name, title, raw, sections: secs }
}

/** Author lines and link lists repeat by design. */
const DUPLICATE_EXEMPT = new Set(['references'])

/** Mark units that repeat a unit in another draft — proven by shingle containment. */
function markDuplicates(docs) {
  const index = []
  for (const d of docs) {
    for (const s of d.sections) {
      if (s.heading === '(preamble)' || DUPLICATE_EXEMPT.has(s.kind)) continue
      for (const u of s.units) index.push({ d, s, u, sh: shingles(u.text) })
    }
  }
  for (const a of index) {
    if (a.sh.size < 3) continue
    let best = null
    for (const b of index) {
      if (b.d === a.d || b.sh.size < 3) continue
      let hit = 0
      for (const x of a.sh) if (b.sh.has(x)) hit += 1
      const containment = hit / a.sh.size
      if (containment >= POLICY.duplicateContainment && (!best || containment > best.containment)) {
        best = { containment, doc: path.basename(b.d.name), heading: b.s.heading, line: b.u.line }
      }
    }
    if (best) a.u.dupOf = best
  }
  for (const d of docs) {
    for (const s of d.sections) s.facts.duplicateUnits = s.units.filter((u) => u.dupOf).map((u) => u.line)
  }
}

/** Preamble (title, author, status) is boilerplate; judge it only for facts. */
const judgeable = (s) => s.heading !== '(preamble)' && s.units.length > 0

/* --------------------------------------------------------------- questions */

const UNIT_VERDICTS = Object.freeze({
  keep: 'The unit states a requirement, definition, value, data format, decision, or fact a reader needs, and says it once in about as few words as it can.',
  cut: 'Delete it without loss: it restates something said elsewhere in the draft, narrates, hedges, sells, previews what follows, or justifies something no implementer or reviewer needs.',
  merge: 'Its one useful fact belongs inside a neighbouring unit; on its own it repeats setup or splits one rule across two sentences.',
  move_rationale: 'It argues why the design is right. Useful, but it belongs in Rationale or Motivation, not here.',
  move_implementation: 'It describes one product, codebase, file path, or internal policy (for example what HandCash does) inside text that should hold for every implementation.',
  move_history: 'It narrates earlier drafts, withdrawn designs, or what changed. That belongs in a changelog or PR description, not the spec.',
  tighten: 'It carries a needed rule, but two implementers could read it differently: vague quantifiers, undefined terms, a lowercase must or should, or a missing value, bound, or actor.',
})

function questionsFor(section) {
  const kind = section.kind
  const qs = {}
  for (const u of section.units) {
    const instructions = {
      unit: u.text,
      section_kind: kind,
      ...(u.dupOf ? { repeats: `Nearly the same text appears in ${u.dupOf.doc} under "${u.dupOf.heading}".` } : {}),
      question:
        'You are a strict standards editor cutting slop from a BRC draft. Read `unit` in the context of `section.text` and the whole `draft`. What should happen to `unit`? A table row or a short list item that defines a field or value is usually keep. If `repeats` is present, prefer cut or merge unless this draft is the one that should own the rule.',
    }
    qs[`u${u.i}`] = { type: 'choice', instructions, criteria: UNIT_VERDICTS }
  }
  qs.padding = {
    type: 'noul',
    instructions:
      'Read `section.text` against the whole `draft`. Is this section noticeably longer than its content needs — restating earlier sections, previewing later ones, narrating, or wrapping each rule in justification?',
    criteria: {
      true: 'A careful editor would remove at least a fifth of the words without losing any rule, value, or decision.',
      false: 'Nearly every sentence carries a rule, definition, value, or fact the reader needs.',
    },
  }
  qs.ambiguity = {
    type: 'noul',
    instructions:
      'Read `section.text`. Could two competent implementers follow these requirements and build incompatible behaviour, because of undefined terms, lowercase must/should, missing bounds, unstated actors (who MUST do it), or conflicting statements? `facts.lowercaseModals` counts lowercase must/should in normative text.',
    criteria: {
      true: 'At least one requirement is underspecified or contradicted enough that interop could break.',
      false: 'Requirements are precise, or the section is not normative.',
    },
  }
  qs.misplaced = {
    type: 'choice',
    instructions: `This section is a "${kind}" section. Which kind of content most clearly does not belong in it?`,
    criteria: {
      rationale: 'Design justification inside normative text.',
      implementation: 'Product-specific behaviour, file paths, or one wallet’s policy stated as if it were the protocol.',
      history: 'Draft history, withdrawn designs, or change narration.',
      duplicate: 'Rules that another section or companion draft already owns.',
      marketing: 'Persuasive or promotional voice rather than specification.',
      none: 'The content fits this section.',
    },
  }
  qs.emphasis = {
    type: 'noul',
    instructions:
      'Does the section lean on bold text, capitals, "not" in bold, or stacked prohibitions against designs nobody proposed, in place of stating the rule once plainly? `facts.boldRuns` counts bold runs.',
    criteria: {
      true: 'Emphasis or defensive prohibitions stand in for clear definitions.',
      false: 'Emphasis, if any, marks defined terms; rules are stated once.',
    },
  }
  return qs
}

async function askJev(state, questions, apiKey) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: MODEL, questions }),
    })
    if (res.ok) return res.json()
    if (res.status !== 429 && res.status !== 529) throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt))
  }
  throw new Error('typesafe overloaded after retries')
}

/* ------------------------------------------------------------ composition */

function compose(section, answers) {
  const verdicts = section.units.map((u) => {
    const a = answers[`u${u.i}`]
    let verdict = a && a.confidence >= POLICY.unitConfidence ? a.choice : 'keep'
    if (verdict === 'move_implementation' && section.kind === 'implementation') verdict = 'keep'
    return { line: u.line, verdict, confidence: a?.confidence ?? 0, text: u.text, dupOf: u.dupOf ?? null }
  })
  const share = (pred) => {
    const total = section.units.reduce((n, u) => n + u.words, 0) || 1
    return verdicts.reduce((n, v, i) => (pred(v.verdict) ? n + section.units[i].words * v.confidence : n), 0) / total
  }
  const f = section.facts
  let debt = 0
  debt += Math.min(1.5, WEIGHTS.cutShare * share((v) => v === 'cut' || v === 'merge'))
  debt += WEIGHTS.moveShare * share((v) => v.startsWith('move_'))
  debt += WEIGHTS.tightenShare * share((v) => v === 'tighten')
  if (answers.padding.noul >= POLICY.noulYes) debt += WEIGHTS.padding
  if (section.kind === 'specification' && answers.ambiguity.noul >= POLICY.noulYes) debt += WEIGHTS.ambiguity
  if (answers.misplaced.choice !== 'none') debt += WEIGHTS.misplaced * answers.misplaced.confidence
  if (answers.emphasis.noul >= POLICY.noulYes) debt += WEIGHTS.emphasis
  if (f.brokenLinks.length) debt += WEIGHTS.brokenLink
  if (section.units.length) debt += WEIGHTS.duplicateShare * (f.duplicateUnits.length / section.units.length)
  return {
    heading: section.heading,
    kind: section.kind,
    startLine: section.startLine,
    debt: Math.min(4, debt),
    words: f.words,
    padding: answers.padding.noul,
    ambiguity: answers.ambiguity.noul,
    misplaced: answers.misplaced,
    emphasis: answers.emphasis.noul,
    facts: f,
    flagged: verdicts.filter((v) => v.verdict !== 'keep'),
  }
}

/* ----------------------------------------------------------------- report */

const BAR = (p) => '█'.repeat(Math.round(Math.min(1, p) * 20)).padEnd(20, '·')
const clip = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function reportFacts(docs) {
  for (const d of docs) {
    console.log(`\n${d.name} — ${d.title}`)
    for (const s of d.sections) {
      const f = s.facts
      const extras = [
        f.longSentences.length && `long@${f.longSentences.join(',')}`,
        f.lowercaseModals && `lowercase modals ${f.lowercaseModals}`,
        f.boldRuns && `bold ${f.boldRuns}`,
        f.implementationRefs.length && `impl ${f.implementationRefs.join(' ')}`,
        f.historyPhrases.length && `history "${f.historyPhrases.join('", "')}"`,
        f.brokenLinks.length && `BROKEN ${f.brokenLinks.join(' ')}`,
        f.duplicateUnits.length && `repeats@${f.duplicateUnits.join(',')}`,
      ].filter(Boolean)
      console.log(`  L${String(s.startLine).padEnd(4)} [${s.kind}] ${s.heading} · ${f.words}w · ${f.units}u${extras.length ? ` · ${extras.join(' · ')}` : ''}`)
    }
  }
}

function report(results, usage) {
  console.log(`\nBRC draft slop review — ${results.length} draft(s), ${MODEL}`)
  console.log(`policy: unit conf ≥ ${POLICY.unitConfidence}, noul yes ≥ ${POLICY.noulYes}, section attention ≥ ${POLICY.sectionAttention}`)
  for (const r of [...results].sort((a, b) => b.debt - a.debt)) {
    const flagged = r.sections.filter((s) => s.debt >= POLICY.sectionAttention)
    console.log(`\n${r.debt >= POLICY.sectionAttention ? '▲' : ' '} ${r.name} — ${r.title}`)
    console.log(`    debt ${BAR(r.debt / 4)} ${r.debt.toFixed(2)} · ${r.words} words · ${flagged.length}/${r.sections.length} sections need an edit`)
    for (const s of [...r.sections].sort((a, b) => b.debt - a.debt)) {
      if (s.debt < POLICY.sectionAttention && !s.flagged.length && !s.facts.brokenLinks.length) continue
      const notes = [
        s.padding >= POLICY.noulYes && `padding ${s.padding.toFixed(2)}`,
        s.kind === 'specification' && s.ambiguity >= POLICY.noulYes && `ambiguous ${s.ambiguity.toFixed(2)}`,
        s.misplaced.choice !== 'none' && `misplaced:${s.misplaced.choice} ${s.misplaced.confidence.toFixed(2)}`,
        s.emphasis >= POLICY.noulYes && `emphasis ${s.emphasis.toFixed(2)}`,
        s.facts.brokenLinks.length && `broken links ${s.facts.brokenLinks.join(' ')}`,
      ].filter(Boolean)
      console.log(`    ${s.debt >= POLICY.sectionAttention ? '▲' : '·'} L${s.startLine} ${s.heading} [${s.kind}] debt ${s.debt.toFixed(2)}${notes.length ? ` · ${notes.join(' · ')}` : ''}`)
      for (const v of s.flagged) {
        const dup = v.dupOf ? ` (repeats ${v.dupOf.doc} "${v.dupOf.heading}")` : ''
        console.log(`        L${String(v.line).padEnd(4)} ${v.verdict.padEnd(19)} ${v.confidence.toFixed(2)}  ${clip(v.text)}${dup}`)
      }
    }
  }
  const attention = results.filter((r) => r.debt >= POLICY.sectionAttention)
  console.log(`\n${attention.length} draft(s) need attention. Tokens: ${usage.input_tokens} in.`)
}

/* ------------------------------------------------------------------- main */

const docs = targets().map(loadDoc)
markDuplicates(docs)

if (FACTS_ONLY) {
  if (JSON_OUT) console.log(JSON.stringify(docs.map(({ raw, ...d }) => d), null, 2))
  else reportFacts(docs)
  process.exit(0)
}

const apiKey = jevApiKey()
const usage = { input_tokens: 0, output_tokens: 0 }
const results = []
const raw = []
for (const d of docs) {
  const draft = d.raw.length > POLICY.docChars ? `${d.raw.slice(0, POLICY.docChars)}\n… [draft truncated]` : d.raw
  const judged = await Promise.all(
    d.sections.filter(judgeable).map(async (s) => {
      const state = {
        draft,
        section: { heading: s.heading, kind: s.kind, text: s.lines.map((l) => l.text).join('\n') },
        facts: s.facts,
      }
      const { answers, usage: u } = await askJev(state, questionsFor(s), apiKey)
      usage.input_tokens += u?.input_tokens ?? 0
      usage.output_tokens += u?.output_tokens ?? 0
      raw.push({ doc: d.name, section: s.heading, answers })
      return compose(s, answers)
    }),
  )
  const words = judged.reduce((n, s) => n + s.words, 0) || 1
  results.push({
    name: d.name,
    title: d.title,
    words,
    debt: judged.reduce((n, s) => n + s.debt * s.words, 0) / words,
    sections: judged,
  })
}

if (JSON_OUT) console.log(JSON.stringify({ policy: POLICY, results, raw, usage }, null, 2))
else report(results, usage)
