#!/usr/bin/env node
/**
 * Vite for `npm run dev`, with clean SIGTERM/SIGINT exits.
 *
 * concurrently -k treats a SIGTERM'd child as failure (exit 1) under the default
 * --success all. Alignity then reports `npm run dev` as a crash when a reload
 * frees :5173 by signaling Vite, or when -k tears Vite down after the shell
 * closes. Exit 0 on intentional stop so the supervisor can stay green.
 *
 * When -k (or free-dev-port) stops Vite mid pre-transform, esbuild logs
 * "Pre-transform error: The service was stopped" for whatever files were in
 * flight. That is teardown, not a compile error — Alignity flags those lines,
 * so we drop them (and the indented Plugin/File follow-ups).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteJs = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')

const child = spawn(process.execPath, [viteJs, ...process.argv.slice(2)], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
})

/** Drop esbuild "service was stopped" blocks (shutdown race, not a real error). */
function forwardFiltered(src, dest) {
  let skipFollowUp = false
  let buf = ''
  src.setEncoding('utf8')
  src.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (/The service was stopped/.test(line)) {
        skipFollowUp = true
        continue
      }
      if (skipFollowUp && /^\s+(Plugin|File):/.test(line)) continue
      skipFollowUp = false
      dest.write(line + '\n')
    }
  })
  src.on('end', () => {
    if (!buf) return
    if (/The service was stopped/.test(buf)) return
    if (skipFollowUp && /^\s+(Plugin|File):/.test(buf)) return
    dest.write(buf)
  })
}

forwardFiltered(child.stdout, process.stdout)
forwardFiltered(child.stderr, process.stderr)

let stopping = false
function stop(sig = 'SIGTERM') {
  if (stopping) return
  stopping = true
  if (child.exitCode === null && !child.killed) child.kill(sig)
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))

child.on('error', (err) => {
  console.error('[dev:vite]', err)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (stopping || signal === 'SIGTERM' || signal === 'SIGINT') process.exit(0)
  if (code === 143 || code === 130) process.exit(0)
  process.exit(code ?? 1)
})
