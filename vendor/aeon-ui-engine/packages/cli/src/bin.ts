#!/usr/bin/env node
import { initAeon } from './init.js'
import { linkAeon } from './link.js'
import { migrateAeon } from './migrate.js'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'
const force = args.includes('--force') || args.includes('-f')
const checkOnly = args.includes('--check')
const quiet = args.includes('--quiet') || args.includes('-q')

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1]
  return undefined
}

const cwdArg = argValue('--cwd')

function help() {
  console.log(`aeon-ui — AI-optimized CLI for Aeon UI

Usage:
  npx aeon-ui init [--force]
  npx aeon-ui link [--quiet] [--force] [--cwd <dir>]
  npx aeon-ui migrate [--check]

Commands:
  init       Inject Cursor rules, JSON schemas, system prompt, and a starter component
  link       Symlink node_modules/@aeon-ui/* → aeon-ui-engine/packages/* (also runs on postinstall)
  migrate    Scan for known workarounds and write AEON_MIGRATION_CHECKLIST.md
  help       Show this message

Options:
  --force, -f   Overwrite existing generated files (init); replace existing @aeon-ui links (link)
  --check       Report findings only; do not write checklist (migrate)
  --quiet, -q   Suppress link output (link)
  --cwd <dir>   Project root for link (defaults to process.cwd())
`)
}

if (cmd === 'init') {
  const result = initAeon({ force, cwd: cwdArg })
  console.log(`Aeon UI init → ${result.cwd}`)
  for (const line of result.written) console.log(`  ${line}`)
  try {
    linkAeon({ cwd: result.cwd, quiet: true })
    console.log('  link @aeon-ui/* (scoped packages)')
  } catch {
    console.log('  link skipped (install aeon-ui-engine first, then: npx aeon-ui link)')
  }
  console.log('\nNext: npm install aeon-ui-engine react react-dom xstate @xstate/react')
  console.log('Docs: AEON_AI.md · paste aeon.cursorrules.md into your agent system prompt')
} else if (cmd === 'link') {
  try {
    const result = linkAeon({ quiet, force, cwd: cwdArg })
    if (quiet) console.log(`Aeon UI link → ${result.cwd}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
} else if (cmd === 'migrate') {
  const result = migrateAeon({ write: !checkOnly })
  console.log(`Aeon UI migrate → ${result.cwd}`)
  for (const line of result.written) console.log(`  ${line}`)
  if (result.findings.length === 0) {
    console.log('  (no known workarounds matched in quick scan)')
  } else {
    for (const f of result.findings) {
      console.log(`  [${f.severity}] ${f.id}: ${f.advice}`)
    }
  }
  console.log('\nInstall: npm install aeon-ui-engine@^1.4.0 xstate @xstate/react')
  console.log('Docs: https://aeon-ui.com · repo docs/MIGRATION.md')
} else {
  help()
  if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
    process.exitCode = 1
  }
}
