#!/usr/bin/env node
/**
 * Local Vite + native host pair. Frees :5173, then runs concurrently.
 * Mac → `dev:native` (native-macos); Win/Linux → `dev:native-desktop`.
 *
 * Exits 0 on SIGTERM/SIGINT so an Alignity reload (or free-dev-port replacing
 * this session) is not reported as a crash.
 *
 * --success command-0 (Vite): session is green when Vite exits 0. scripts/dev-vite.mjs
 * maps SIGTERM → 0, so a reload, free-dev-port, or shell close (-k SIGTERMs Vite)
 * no longer makes concurrently exit 1. A real Vite failure still exits non-zero.
 * Default --success all treated a SIGTERM'd sibling as a crash.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { freeDevPort } from './free-dev-port.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

await freeDevPort()

const hostScript =
  process.platform === 'darwin'
    ? 'npm:dev:native'
    : 'node scripts/dev-native-desktop.mjs'

const concurrentlyJs = path.join(
  root,
  'node_modules',
  'concurrently',
  'dist',
  'bin',
  'concurrently.js',
)
const child = spawn(
  process.execPath,
  [concurrentlyJs, '-k', '-s', 'command-0', 'npm:dev:vite', hostScript],
  { cwd: root, stdio: 'inherit', env: process.env },
)

let stopping = false
function stop(sig = 'SIGTERM') {
  if (stopping) return
  stopping = true
  if (child.exitCode === null && !child.killed) child.kill(sig)
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))

child.on('exit', (code, signal) => {
  if (stopping || signal === 'SIGTERM' || signal === 'SIGINT') process.exit(0)
  // 128+15 / 128+2 — child received an external stop
  if (code === 143 || code === 130) process.exit(0)
  process.exit(code ?? 1)
})
