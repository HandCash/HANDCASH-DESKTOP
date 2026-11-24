#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsDir = path.join(root, 'src', 'components')
const rustDir = path.join(root, 'native-desktop', 'crates', 'handcash-app', 'src')
const fixtureDir = path.join(root, 'native-desktop', 'fixtures', 'ui')
const parityFile = path.join(rustDir, 'parity.rs')
const WEB_ONLY = new Set(['ModalPortal', 'KeepAliveSlot', 'RenderProbe', 'FitSlot', 'MermaidDiagram'])

function walk(dir, pred, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, pred, acc)
    else if (pred(full)) acc.push(full)
  }
  return acc
}

function hasWord(text, word) {
  let idx = text.indexOf(word)
  const isId = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_'
  while (idx !== -1) {
    const b = idx === 0 ? '' : text[idx - 1]
    const a = idx + word.length >= text.length ? '' : text[idx + word.length]
    if (!isId(b) && !isId(a)) return true
    idx = text.indexOf(word, idx + 1)
  }
  return false
}

const tsFiles = walk(tsDir, (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && !f.endsWith('.spec.tsx') && !f.endsWith('.stories.tsx') && fs.statSync(f).size > 0).sort()
const rustFiles = walk(rustDir, (f) => f.endsWith('.rs'))
const rustCorpus = rustFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const paritySource = fs.existsSync(parityFile) ? fs.readFileSync(parityFile, 'utf8') : ''
const fixtureFiles = walk(fixtureDir, (f) => f.endsWith('.html')).map((f) => path.relative(fixtureDir, f).split(path.sep).join('/')).sort()
const fixtureFolders = [...new Set(fixtureFiles.map((f) => f.split('/')[0]))].sort()

const replayedFixtures = new Set()
const re = /assert_parity\(\s*"([^"]+)"/g
for (const m of paritySource.matchAll(re)) replayedFixtures.add(m[1])
const replayedFolders = new Set([...replayedFixtures].map((f) => f.split('/')[0]))

const components = tsFiles.map((file) => {
  const rel = path.relative(tsDir, file).split(path.sep).join('/')
  const name = path.basename(file, '.tsx')
  return { rel, name, webOnly: WEB_ONLY.has(name), referencedInRust: hasWord(rustCorpus, name) }
})
const portable = components.filter((c) => !c.webOnly)
const referenced = portable.filter((c) => c.referencedInRust)
const unreferenced = portable.filter((c) => !c.referencedInRust)
const unreplayedFixtures = fixtureFiles.filter((f) => !replayedFixtures.has(f))
const unreplayedFolders = fixtureFolders.filter((d) => !replayedFolders.has(d))
const summary = {
  tsTotal: components.length,
  webOnly: components.length - portable.length,
  portableTotal: portable.length,
  referencedInRust: referenced.length,
  unreferencedInRust: unreferenced.length,
  fixtureFilesTotal: fixtureFiles.length,
  fixtureFilesReplayed: replayedFixtures.size,
  fixtureFoldersTotal: fixtureFolders.length,
  fixtureFoldersReplayed: replayedFolders.size,
  unreplayedFixtures,
  unreplayedFolders,
  unreferencedComponents: unreferenced.map((c) => c.rel),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`TS components: ${summary.tsTotal} (${summary.portableTotal} portable, ${summary.webOnly} web-only)`)
  console.log(`Referenced in Rust: ${summary.referencedInRust}/${summary.portableTotal} (${summary.unreferencedInRust} unreferenced)`)
  console.log(`DOM fixtures replayed: ${summary.fixtureFilesReplayed}/${summary.fixtureFilesTotal} files (${summary.fixtureFoldersReplayed}/${summary.fixtureFoldersTotal} folders)`)
  if (unreplayedFixtures.length) {
    console.log('Unreplayed fixtures:')
    for (const f of unreplayedFixtures) console.log(`  - ${f}`)
  }
  if (unreferenced.length) {
    console.log(`Unreferenced portable components (${unreferenced.length}):`)
    for (const c of unreferenced) console.log(`  - ${c.rel}`)
  }
}
