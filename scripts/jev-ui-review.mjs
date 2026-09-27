#!/usr/bin/env node
/**
 * Review wallet UI components against the Aeon design trajectory with Jev
 * (TypeSafe System One), so debt is caught as surfaces are built — not after.
 *
 *   node scripts/jev-ui-review.mjs                 # components changed vs HEAD (+ untracked)
 *   node scripts/jev-ui-review.mjs --all           # every component
 *   node scripts/jev-ui-review.mjs --file src/components/SendPanel.tsx [--file …]
 *   node scripts/jev-ui-review.mjs --base origin/master   # changed vs a ref
 *   node scripts/jev-ui-review.mjs --json          # machine-readable
 *   node scripts/jev-ui-review.mjs --facts         # code facts only, no Jev call
 *
 * Division of labour, per the TypeSafe building guide (docs.typesafe.ai):
 * **code** extracts every exact fact (`scripts/ui-facts.mjs`) — boolean state
 * twins, which charts a file binds, how `data-aeon-state` is projected,
 * hand-rolled chrome, list rendering, subscriptions, how much CSS keys on
 * classes vs `data-aeon-*`. **Jev** only makes the judgment calls that need a
 * semantic reading of the excerpt: are these booleans phases a chart should
 * name, which chart owns them, which Aeon compound replaces the chrome, does the
 * render path plausibly cost more than what it shows. Never ask the model to
 * count. Questions live in `questionsFor`; thresholds in `POLICY`; the debt
 * formula in `WEIGHTS` — the three things a reviewer needs to read.
 *
 * Needs JEV_API_KEY or JEV_KEY (environment, HandCash/.env, or this repo's .env).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allComponents, extractFacts, isComponentPath, loadCss } from './ui-facts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'

/** Layer ladder from `.cursor/rules/aeon-ui.mdc`; the report walks it in order. */
const LADDER = ['domain path', 'machine', 'projection', 'compound', 'CSS']

/* ------------------------------------------------------------------ policy */

/** Every threshold in one place. Debt is a code composite on a 0–4 legend. */
const POLICY = Object.freeze({
  /** Act on a judgment without a second look. */
  actConfidence: 0.6,
  /** Below this, the answer is shown but flagged for a human read. */
  reviewConfidence: 0.35,
  /** Noul probability treated as "yes". */
  noulYes: 0.65,
  /** Components at or above this debt score lead the report. */
  debtAttention: 2,
  /** Excerpt budget per component; Jev allows 32k tokens of state. */
  excerptChars: 18_000,
})

/* -------------------------------------------------------------------- args */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const values = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []))

const JSON_OUT = flag('--json')
const FACTS_ONLY = flag('--facts')
const ALL = flag('--all')
const BASE = values('--base')[0] ?? null
const FILES = values('--file')

/* --------------------------------------------------------------------- key */

function jevApiKey() {
  for (const name of ['JEV_API_KEY', 'JEV_KEY', 'TYPESAFE_API_KEY']) {
    if (process.env[name]?.trim()) return process.env[name].trim()
  }
  for (const envFile of [path.join(root, '.env'), path.join(root, '..', '.env')]) {
    if (!fs.existsSync(envFile)) continue
    const env = fs.readFileSync(envFile, 'utf8')
    const hit = env.match(/^\s*(?:JEV_API_KEY|JEV_KEY|TYPESAFE_API_KEY)\s*=\s*["']?([^"'\n]+)/m)
    if (hit) return hit[1].trim()
  }
  throw new Error('JEV_API_KEY / JEV_KEY is not set (env, HandCash/.env or HANDCASH-DESKTOP/.env)')
}

/* ----------------------------------------------------------------- targets */

function changedComponents(base) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  const tracked = base ? git('diff', '--name-only', base) : git('diff', '--name-only', 'HEAD')
  const untracked = git('ls-files', '--others', '--exclude-standard')
  return [...new Set([...tracked, ...untracked])]
    .filter(isComponentPath)
    .filter((p) => fs.existsSync(path.join(root, p)))
    .sort()
}

function targets() {
  if (FILES.length) return FILES.map((f) => path.relative(root, path.resolve(root, f)))
  if (ALL) return allComponents(root)
  const changed = changedComponents(BASE)
  return changed.length ? changed : allComponents(root)
}

/* ----------------------------------------------------------------- excerpt */

/**
 * Focused source excerpt: the lines Jev needs to read to judge, with a little
 * context, capped by POLICY.excerptChars. Whole files exceed the state budget.
 */
function excerptFor(lines, facts) {
  const want = new Set()
  const mark = (idx, span = 2) => {
    for (let i = Math.max(0, idx - span); i <= Math.min(lines.length - 1, idx + span); i += 1) want.add(i)
  }
  lines.forEach((line, i) => {
    if (/useState\(|useMachine\(|useAeonMachine\(|useActorRef\(|useActivityAction\(|useReducer\(/.test(line)) mark(i, 1)
    if (/data-aeon-(?:scope|state|part)=/.test(line)) mark(i, 1)
    if (/disabled=\{/.test(line)) mark(i, 1)
    if (/window\.(?:confirm|alert)\(/.test(line)) mark(i, 3)
    if (/^\s*(?:import .*from ['"]@aeon-ui|import .*Machine)/.test(line)) mark(i, 0)
    if (/\bsubscribe\w*\(|useEffect\(/.test(line)) mark(i, 2)
    if (/\.map\(\(/.test(line)) mark(i, 1)
  })
  for (const b of facts.booleanStates) {
    lines.forEach((line, i) => {
      if (new RegExp(`\\b${b.name}\\b`).test(line)) mark(i, 1)
    })
  }
  const ordered = [...want].sort((a, b) => a - b)
  let out = ''
  let last = -2
  for (const i of ordered) {
    if (i !== last + 1) out += '…\n'
    out += `${String(i + 1).padStart(4)}| ${lines[i]}\n`
    last = i
    if (out.length > POLICY.excerptChars) {
      out += '… [excerpt truncated]\n'
      break
    }
  }
  return out
}


/* --------------------------------------------------------------- questions */

const choiceId = (label) => label.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()

/**
 * One request per component. Questions read `facts` and `excerpt`; option sets
 * are built from what code found (the charts this file actually binds), so Jev
 * chooses among real owners rather than a fixed taxonomy.
 */
function questionsFor({ facts }) {
  const owners = {}
  for (const m of facts.machines) {
    if (m.machine) owners[choiceId(m.machine)] = `The \`${m.machine}\` chart this file already binds via \`${m.hook}\`.`
  }
  owners.new_chart =
    'No chart in `facts.machines` names these phases: a new small machine in `src/machines/` should, registered in `machineManifest.ts`.'
  owners.none_needed =
    'The booleans are genuinely local presentation toggles (reveal a password, hover, mounted) with no sequencing, disabling, or error semantics — no chart is owed.'

  return {
    phases_beside_chart: {
      type: 'noul',
      instructions:
        'Read `facts.booleanStates` and their uses in `excerpt`. Do any of these `useState` booleans encode UI phases — an operation in flight, a confirm step, an overlay open, a mode — that are sequenced or mutually exclusive (one disables the others, set true before an await and false in `finally`, guarded by an early return)? Those are statechart states held as parallel flags. `facts.exclusiveBusySet` lists the ones code already proved gate a button and reset in `finally`; `facts.presentationOnlyBooleans` lists the ones with none of those semantics (show/hide a password, hover, mounted) — those are not phases. An empty `facts.booleanStates` is a clear no.',
      criteria: {
        true: 'At least two booleans behave as exclusive phases of one flow, or one boolean is the only thing modelling an async lifecycle the buttons read.',
        false: 'There are no booleans, or every boolean is a standalone presentation toggle with no sequencing, disabling, or lifecycle meaning.',
      },
    },
    chart_owner: {
      type: 'choice',
      instructions:
        'If `phases_beside_chart` holds, which chart should own those phases? Prefer a chart the file already binds (`facts.machines`) when its states plausibly cover the phases; choose `new_chart` when the phases are a distinct flow no bound chart names; choose `none_needed` when the booleans are pure presentation.',
      criteria: owners,
    },
    projection_risk: {
      type: 'noul',
      instructions:
        'Read `facts.aeon.stateExprs` and the matching lines in `excerpt`. Could any `data-aeon-state` value reach the DOM as something CSS cannot key on — a nested XState value object (`[object Object]`), `undefined`, or an expression that is not a stable token — because it bypasses `stateToAttr` or derives from ad-hoc booleans rather than a chart?',
      criteria: {
        true: 'A projection uses a raw machine `.value`, an object, or a boolean ternary that restates chart state instead of reading it.',
        false: 'Every projection is `stateToAttr(...)`, a literal token, or a plain string field from domain data.',
      },
    },
    compound_gap: {
      type: 'choice',
      instructions:
        'Read `facts.chrome`, `facts.aeon.compoundsUsed` and `excerpt`. Which Aeon compound from `@aeon-ui/react` / `@aeon-ui/ui` would replace chrome this component hand-rolls? `window.confirm` is a Prompt; a hand-built overlay is a Dialog; a persistent notice bar is a StatusBanner; a hand-built row list is ListRow; hand-built segmented controls are Tabs; anchored actions are Menu. Choose `none` when the chrome already composes Aeon parts or there is no such chrome.',
      criteria: {
        prompt: 'Confirmation or permission copy is delivered through `window.confirm` / `window.alert` or a bespoke confirm block.',
        dialog: 'A modal or sheet is built from divs and local open state instead of `Dialog`.',
        status_banner: 'A persistent status/notice strip is hand-rolled.',
        list_row: 'Repeated row chrome (avatar, title, meta, trailing action) is hand-built.',
        tabs: 'A segmented mode switcher is hand-built from buttons with a selected flag.',
        menu: 'An anchored action list or popover is hand-built.',
        none: 'Chrome is already Aeon parts, plain buttons styled by the brand sheet, or there is no such chrome.',
      },
    },
    render_cost_risk: {
      type: 'noul',
      instructions:
        'Read `facts.render` and the effect / subscription / map lines in `excerpt`. Does this component plausibly do main-thread work out of proportion to what it shows — unwindowed lists over wallet-scale data, several store subscriptions each triggering full re-renders, store reads recomputed every render, timers, image decoding without `DeferredImage`? Weigh `linesOfCode`, `subscriptions`, `jsxMaps` vs `windowed`, `storeReadsInRender`, `rawImg`.',
      criteria: {
        true: 'The render path has an unbounded or repeatedly-recomputed cost a user on a phone would feel as jank on this screen.',
        false: 'Work is windowed, memoised, deferred, or the screen is small enough that it does not matter.',
      },
    },
    render_cost_owner: {
      type: 'choice',
      instructions: 'If `render_cost_risk` holds, which single cause most plausibly owns it?',
      criteria: {
        subscriptions_rerender: 'Multiple `subscribe*` hooks re-render the whole component on every store tick.',
        unwindowed_list: 'A `.map` renders every row of a wallet-scale list without windowing.',
        store_reads_in_render: 'Store getters are called during render instead of subscribed once.',
        images: 'Bitmaps decode via raw `<img>` or without `DeferredImage` slots.',
        component_too_large: 'The file is large enough that any state change re-renders unrelated regions.',
        none: 'No single owner; the risk is low or diffuse.',
      },
    },
    debt_direction: {
      type: 'score',
      instructions:
        'Given all of `facts` and `excerpt`, where does this component sit on the Aeon trajectory (UI = f(statechart snapshot); chart before JSX; project with `stateToAttr`; compose Aeon compounds; brand only restyles `data-aeon-*`)? Rate the component as it is now. A component with no booleans, or only `facts.presentationOnlyBooleans`, and no hand-rolled chrome is level 0 or 1 regardless of whether it binds a chart — a small stateless component owes no chart. Only booleans in `facts.exclusiveBusySet` or judged as phases push it to level 2 or 3.',
      criteria: [
        'Aeon-native — chart-driven where there is a flow, projected with stateToAttr, composes compounds, CSS keys on data-aeon-* attributes; or stateless.',
        'Aligned with minor drift — a stray literal projection or one presentation toggle; nothing a chart is owed.',
        'Mixed — a chart is bound but booleans beside it still model phases, or one piece of chrome bypasses compounds.',
        'Component-local flow — an async or confirm flow lives only in exclusive useState booleans; no chart names it; confirms are window.confirm.',
        'Second UI system forming — parallel state model, bespoke widgets, and class-keyed CSS restating chart state.',
      ],
    },
    fix_first: {
      type: 'choice',
      instructions:
        'What single change should be made first to move this component toward Aeon-native with the least churn? Walk the layer ladder: domain path → machine → projection → compound → CSS. Choose the lowest layer that is actually broken.',
      criteria: {
        move_flags_to_chart: 'Replace exclusive boolean phases with a machine (new or the bound one) and read `snapshot`.',
        project_with_state_to_attr: 'Route `data-aeon-state` through `stateToAttr` / a chart snapshot instead of raw values or ternaries.',
        replace_confirm_with_prompt: 'Swap `window.confirm` / bespoke confirm blocks for the Aeon `Prompt` compound driven by a chart state.',
        compose_compound: 'Replace hand-rolled chrome with the Aeon compound named in `compound_gap`.',
        window_or_defer_render: 'Window the list, subscribe once, or defer images — the render cost, not the state model, is the debt.',
        split_component: 'The file mixes several flows; split by chart before anything else.',
        css_to_attr_selectors: 'Move class-keyed state styling to `data-aeon-state` selectors in handcash.css.',
        nothing: 'The component is already on trajectory; no change is owed.',
      },
    },
  }
}

/* -------------------------------------------------------------------- jev */

async function askJev(state, questions, apiKey) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: MODEL, questions }),
    })
    if (res.ok) return res.json()
    if (res.status !== 429 && res.status !== 529) {
      throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
  }
  throw new Error('typesafe overloaded after retries')
}

/* ------------------------------------------------------------ composition */

function gate(confidence) {
  if (confidence >= POLICY.actConfidence) return 'act'
  if (confidence >= POLICY.reviewConfidence) return 'review'
  return 'escalate'
}

/**
 * Debt weights — composite scoring per docs.typesafe.ai/patterns/composite-scoring.
 * Each term is an exact fact or one atomic Jev answer; the sum is capped at 4 to
 * share the `debt_direction` legend. Change a coefficient here, not a question.
 */
const WEIGHTS = Object.freeze({
  exclusiveBusySet: 1.5, // ≥2 proven busy booleans gating buttons
  phasesJudged: 1.0, // Jev: booleans model phases (when facts did not already prove it)
  phasesBesideBoundChart: 0.5, // …and a chart is already bound: the twin the rule names
  rawMachineProjection: 0.75, // data-aeon-state reads raw .value
  projectionJudged: 0.5, // Jev: projection may emit a non-token
  compoundGap: 0.75, // Jev: hand-rolled chrome, scaled by confidence
  windowConfirm: 0.25, // per call, capped at 0.75
  renderCost: 0.5, // Jev: render cost risk
  classKeyedStyling: 0.5, // ≥10 styled classes and no attr-keyed rule
})

/** Code composes the verdict; Jev's raw answers stay attached for review. */
function compose(facts, answers) {
  const debt = answers.debt_direction
  const phases = answers.phases_beside_chart.noul
  const findings = []

  let composite = 0
  const proven = facts.exclusiveBusySet.length >= 2
  if (proven) composite += WEIGHTS.exclusiveBusySet
  else if (phases >= POLICY.noulYes) composite += WEIGHTS.phasesJudged
  if ((proven || phases >= POLICY.noulYes) && facts.machines.length) composite += WEIGHTS.phasesBesideBoundChart
  if (facts.aeon.rawMachineValueProjections.length) composite += WEIGHTS.rawMachineProjection
  else if (answers.projection_risk.noul >= POLICY.noulYes) composite += WEIGHTS.projectionJudged
  if (answers.compound_gap.choice !== 'none') composite += WEIGHTS.compoundGap * answers.compound_gap.confidence
  composite += Math.min(0.75, facts.chrome.windowConfirm * WEIGHTS.windowConfirm)
  if (answers.render_cost_risk.noul >= POLICY.noulYes) composite += WEIGHTS.renderCost
  if (facts.css.styledClasses >= 10 && facts.css.attrKeyedRules === 0) composite += WEIGHTS.classKeyedStyling
  composite = Math.min(4, composite)

  // Exact facts first — these need no model.
  if (facts.aeon.rawMachineValueProjections.length) {
    findings.push({
      layer: 'projection',
      severity: 'act',
      proven: true,
      text: `data-aeon-state reads a raw machine value at line(s) ${facts.aeon.rawMachineValueProjections.join(', ')} — use stateToAttr.`,
    })
  }
  if (facts.exclusiveBusySet.length >= 2) {
    findings.push({
      layer: 'machine',
      severity: 'act',
      proven: true,
      text: `${facts.exclusiveBusySet.length} exclusive busy booleans (${facts.exclusiveBusySet.join(', ')}) gate buttons and reset in finally — one chart state each.`,
    })
  }
  if (facts.chrome.windowConfirm > 0) {
    findings.push({
      layer: 'compound',
      severity: 'review',
      text: `${facts.chrome.windowConfirm} window.confirm call(s) — Prompt compound driven by a chart state.`,
    })
  }

  // Judgments, gated by confidence.
  if (phases >= POLICY.noulYes) {
    const owner = answers.chart_owner
    findings.push({
      layer: 'machine',
      severity: gate(owner.confidence),
      text: `booleans model phases (p=${phases.toFixed(2)}); owner → ${owner.choice} (conf ${owner.confidence.toFixed(2)})`,
    })
  }
  if (answers.projection_risk.noul >= POLICY.noulYes && !facts.aeon.rawMachineValueProjections.length) {
    findings.push({
      layer: 'projection',
      severity: 'review',
      text: `projection may emit a non-token (p=${answers.projection_risk.noul.toFixed(2)})`,
    })
  }
  if (answers.compound_gap.choice !== 'none') {
    findings.push({
      layer: 'compound',
      severity: gate(answers.compound_gap.confidence),
      text: `hand-rolled chrome → ${answers.compound_gap.choice} (conf ${answers.compound_gap.confidence.toFixed(2)})`,
    })
  }
  if (answers.render_cost_risk.noul >= POLICY.noulYes) {
    findings.push({
      layer: 'projection',
      severity: gate(answers.render_cost_owner.confidence),
      text: `render cost risk (p=${answers.render_cost_risk.noul.toFixed(2)}) owned by ${answers.render_cost_owner.choice}`,
    })
  }

  // Below one unit of debt nothing is owed, whatever the model's low-confidence
  // pick was; above it, the ladder-lowest finding wins over a weak model pick.
  const sorted = findings.sort((a, b) => LADDER.indexOf(a.layer) - LADDER.indexOf(b.layer))
  const provenAct = sorted.find((f) => f.severity === 'act' && f.proven)
  const modelFix = answers.fix_first
  const modelFixHasFinding = sorted.some((f) => f.layer === layerForFix(modelFix.choice))
  const fix = provenAct
    ? { choice: fixForLayer(provenAct.layer), confidence: 1 }
    : composite < 1
      ? { choice: 'nothing', confidence: 1 }
      : modelFix.confidence >= POLICY.reviewConfidence && modelFixHasFinding
        ? modelFix
        : { choice: fixForLayer(sorted[0]?.layer), confidence: modelFix.confidence }
  // The generic compound fix is a Prompt when the chrome in question is window.confirm.
  if (fix.choice === 'compose_compound' && facts.chrome.windowConfirm > 0 && answers.compound_gap.choice === 'prompt') {
    fix.choice = 'replace_confirm_with_prompt'
  }

  return {
    file: facts.file,
    debtScore: composite,
    debtLabel: debt.legend[String(Math.min(4, Math.round(composite)))],
    modelRead: { score: debt.score, confidence: debt.confidence },
    gate: gate(debt.confidence),
    fixFirst: fix.choice,
    fixFirstConfidence: fix.confidence,
    findings: sorted,
  }
}

const FIX_LAYER = Object.freeze({
  move_flags_to_chart: 'machine',
  split_component: 'machine',
  project_with_state_to_attr: 'projection',
  window_or_defer_render: 'projection',
  replace_confirm_with_prompt: 'compound',
  compose_compound: 'compound',
  css_to_attr_selectors: 'CSS',
})

const layerForFix = (choice) => FIX_LAYER[choice] ?? null

function fixForLayer(layer) {
  return (
    {
      machine: 'move_flags_to_chart',
      projection: 'project_with_state_to_attr',
      compound: 'compose_compound',
      CSS: 'css_to_attr_selectors',
    }[layer] ?? 'nothing'
  )
}

/* ----------------------------------------------------------------- report */

const BAR = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '·')

function reportFacts(rows) {
  for (const { facts } of rows) {
    console.log(`\n${facts.file}`)
    console.log(
      `  ${facts.render.linesOfCode} lines · charts: ${facts.machines.map((m) => m.machine ?? m.hook).join(', ') || '—'} · booleans: ${facts.booleanStates.map((b) => b.name).join(', ') || '—'}`,
    )
    console.log(
      `  exclusive busy set: ${facts.exclusiveBusySet.join(', ') || '—'} · raw .value projections: ${facts.aeon.rawMachineValueProjections.join(', ') || '—'} · window.confirm: ${facts.chrome.windowConfirm}`,
    )
    console.log(
      `  css: ${facts.css.styledClasses}/${facts.css.classNames} classes styled · ${facts.css.attrKeyedRules} attr-keyed rules · ${facts.css.importantInOwnRules} !important · scopes ${JSON.stringify(facts.css.scopeRules)}`,
    )
  }
}

function report(results, usage) {
  const ranked = [...results].sort((a, b) => b.debtScore - a.debtScore)
  console.log(`\nAeon trajectory review — ${results.length} component(s), ${MODEL}`)
  console.log(`policy: act ≥ ${POLICY.actConfidence}, review ≥ ${POLICY.reviewConfidence}, attention ≥ debt ${POLICY.debtAttention}\n`)
  for (const r of ranked) {
    const attention = r.debtScore >= POLICY.debtAttention ? '▲' : ' '
    console.log(`${attention} ${r.file}`)
    console.log(
      `    debt ${BAR(r.debtScore / 4)} ${r.debtScore.toFixed(2)}  ${r.debtLabel}  (model read ${r.modelRead.score.toFixed(2)}, ${r.gate} @ ${r.modelRead.confidence.toFixed(2)})`,
    )
    console.log(`    fix first: ${r.fixFirst} (conf ${r.fixFirstConfidence.toFixed(2)})`)
    for (const f of r.findings) console.log(`    - [${f.layer}] ${f.severity.padEnd(8)} ${f.text}`)
  }
  const attention = ranked.filter((r) => r.debtScore >= POLICY.debtAttention)
  console.log(
    `\n${attention.length} component(s) need attention. Ladder: ${LADDER.join(' → ')}. Tokens: ${usage.input_tokens} in.`,
  )
}

/* ------------------------------------------------------------------- main */

const css = loadCss(root)
const rows = targets().map((rel) => {
  const { facts, lines } = extractFacts(root, rel, css)
  return { facts, excerpt: excerptFor(lines, facts) }
})

if (FACTS_ONLY) {
  if (JSON_OUT) console.log(JSON.stringify(rows.map((r) => r.facts), null, 2))
  else reportFacts(rows)
  process.exit(0)
}

const apiKey = jevApiKey()
const results = []
const usage = { input_tokens: 0, output_tokens: 0 }
const raw = []
for (const row of rows) {
  const state = { facts: row.facts, excerpt: row.excerpt }
  const { answers, usage: u, model } = await askJev(state, questionsFor(row), apiKey)
  usage.input_tokens += u?.input_tokens ?? 0
  usage.output_tokens += u?.output_tokens ?? 0
  results.push(compose(row.facts, answers))
  raw.push({ file: row.facts.file, model, answers })
}

if (JSON_OUT) console.log(JSON.stringify({ policy: POLICY, results, raw, usage }, null, 2))
else report(results, usage)
