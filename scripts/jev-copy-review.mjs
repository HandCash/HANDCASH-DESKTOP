#!/usr/bin/env node
/**
 * Find UI copy that narrates instead of helping, with Jev (TypeSafe System One).
 *
 *   node scripts/jev-copy-review.mjs                # every component + toast
 *   node scripts/jev-copy-review.mjs --file src/components/WalletAccountMenu.tsx
 *   node scripts/jev-copy-review.mjs --json
 *   node scripts/jev-copy-review.mjs --facts        # extracted strings only, no Jev call
 *
 * The reference case is "Balances and sync stay separate." under an account
 * switcher: true, internal, and of no use to the person switching. **Code**
 * extracts every user-visible string with its file, line and the line it sits
 * on. **Jev** answers one narrow question per string: would removing it lose
 * anything the user needs to decide or act? Code applies the threshold.
 *
 * Needs JEV_API_KEY or JEV_KEY (environment, HandCash/.env, or this repo's .env).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'
const POLICY = Object.freeze({
  /** Noul at or above this is reported as removable. */
  removable: 0.6,
  /** Strings per request; each is one question over the shared state. */
  batch: 20,
  /** Shortest string worth judging, in words. Labels and buttons are shorter. */
  minWords: 3,
})

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
  for (const envFile of [path.join(root, '.env'), path.join(root, '..', '.env')]) {
    if (!fs.existsSync(envFile)) continue
    const hit = fs
      .readFileSync(envFile, 'utf8')
      .match(/^\s*(?:JEV_API_KEY|JEV_KEY|TYPESAFE_API_KEY)\s*=\s*["']?([^"'\n]+)/m)
    if (hit) return hit[1].trim()
  }
  throw new Error('JEV_API_KEY / JEV_KEY is not set (env, HandCash/.env or HANDCASH-DESKTOP/.env)')
}

/* ----------------------------------------------------------------- facts */

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

function targets() {
  if (FILES.length) return FILES.map((f) => path.resolve(root, f))
  return [...walk(path.join(root, 'src/components')), ...walk(path.join(root, 'src/features'))].filter(
    (p) => p.endsWith('.tsx') || /toast/.test(fs.readFileSync(p, 'utf8')),
  )
}

const words = (s) => s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length
const CODEISH =
  /=>|&&|\|\||===|;\s*$|^\s*[.)}\]]|\bconst\b|\breturn\b|className|import |\/\*|\*\/|\bvoid\b|\w+:\s*(?:\(|!|'|true|false|\w+\()|Readonly|^…|[a-z]+\.[a-z]+\)|\b[a-z]+[A-Z]\w*\(|\bnew [A-Z]|\bPromise\b|\w+:\s*(?:number|string|boolean)\b/
const PROP =
  /\b(description|body|hint|subtitle|caption|note|detail|helper|message|title|label|placeholder|text|aria-label)\s*[=:]\s*\{?\s*(['"`])((?:\\.|(?!\2).)*)\2/g
const TOAST = /\btoast(?:Success|Error|Info|Warning)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1(?:\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3)?/g

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function clean(text) {
  return text
    .replace(/\$\{[^}]*\}/g, '…')
    .replace(/\{[^}]*\}/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
}

function extract(file) {
  const source = fs.readFileSync(file, 'utf8')
  const rel = path.relative(root, file)
  const lines = source.split('\n')
  const found = []
  const push = (text, index, kind) => {
    const t = clean(text)
    if (words(t) < POLICY.minWords || CODEISH.test(t)) return
    const line = lineOf(source, index)
    found.push({ file: rel, line, kind, text: t, code: lines[line - 1]?.trim().slice(0, 200) ?? '' })
  }
  if (file.endsWith('.tsx')) {
    for (const m of source.matchAll(/>\s*([^<>]*?[A-Za-z][^<>]*?)\s*</g)) {
      if (/[;=]|\bfunction\b/.test(m[1]) && !/[.!?]$/.test(m[1].trim())) continue
      push(m[1], m.index + 1, 'jsx')
    }
  }
  for (const m of source.matchAll(PROP)) push(m[3], m.index, m[1])
  for (const m of source.matchAll(TOAST)) {
    push(m[2], m.index, 'toast')
    if (m[4]) push(m[4], m.index, 'toast')
  }
  const seen = new Set()
  return found.filter((f) => {
    const key = `${f.line}:${f.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/* --------------------------------------------------------------- question */

function question(i) {
  return {
    type: 'noul',
    instructions: {
      reference:
        'Under an account switcher the line "Balances and sync stay separate." is true and internal, and the person switching gains nothing from it: removable.',
      question: `Read \`strings[${i}]\`: its \`text\`, where it renders (\`file\`, \`kind\`) and the source line \`code\`. Would deleting this text lose nothing the user needs to decide, act, or avoid harm at that point in the wallet?`,
    },
    criteria: {
      true: 'Narration: it explains how the wallet works inside, restates what the surrounding UI already shows, describes architecture or protocol, or reassures without a decision attached. Removing it leaves the screen just as usable.',
      false:
        'Needed: a label, value, button, error, empty state, an instruction the user must follow, or a warning about a real consequence (money, keys, irreversibility) at the moment of a decision.',
    },
  }
}

async function askJev(state, questions, apiKey) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
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

/* ------------------------------------------------------------------ main */

const strings = targets().flatMap(extract)

if (FACTS_ONLY) {
  if (JSON_OUT) console.log(JSON.stringify(strings, null, 2))
  else for (const s of strings) console.log(`${s.file}:${s.line} [${s.kind}] ${s.text}`)
  console.log(`\n${strings.length} string(s)`)
  process.exit(0)
}

const apiKey = jevApiKey()
const usage = { input_tokens: 0 }
const judged = []
for (let start = 0; start < strings.length; start += POLICY.batch) {
  const chunk = strings.slice(start, start + POLICY.batch)
  const questions = Object.fromEntries(chunk.map((_, i) => [`s${i}`, question(i)]))
  const { answers, usage: u } = await askJev({ strings: chunk }, questions, apiKey)
  usage.input_tokens += u?.input_tokens ?? 0
  chunk.forEach((s, i) => judged.push({ ...s, removable: answers[`s${i}`].noul }))
}

const flagged = judged
  .filter((s) => s.removable >= POLICY.removable)
  .sort((a, b) => b.removable - a.removable)

if (JSON_OUT) {
  console.log(JSON.stringify({ policy: POLICY, flagged, judged: judged.length, usage }, null, 2))
} else {
  console.log(`\nUI copy review — ${judged.length} string(s), ${MODEL}, removable ≥ ${POLICY.removable}\n`)
  for (const s of flagged) {
    console.log(`${s.removable.toFixed(2)}  ${s.file}:${s.line}  ${s.text}`)
  }
  console.log(`\n${flagged.length} removable. Tokens: ${usage.input_tokens} in.`)
}
