#!/usr/bin/env node
import { initAeon } from './init.js'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'
const force = args.includes('--force') || args.includes('-f')

function help() {
  console.log(`aeon-ui — AI-optimized CLI for Aeon UI

Usage:
  npx aeon-ui init [--force]

Commands:
  init    Inject Cursor rules, JSON schemas, system prompt, and a starter component
  help    Show this message

Options:
  --force, -f   Overwrite existing generated files
`)
}

if (cmd === 'init') {
  const result = initAeon({ force })
  console.log(`Aeon UI init → ${result.cwd}`)
  for (const line of result.written) console.log(`  ${line}`)
  console.log('\nNext: npm install aeon-ui-engine react react-dom xstate @xstate/react')
  console.log('Docs: AEON_AI.md · paste aeon.cursorrules.md into your agent system prompt')
} else {
  help()
  if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
    process.exitCode = 1
  }
}
