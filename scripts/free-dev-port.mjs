#!/usr/bin/env node
/**
 * Free the Vite UI port before `npm run dev`.
 * A prior Electron exit (or an interrupted Alignity reload) can leave Vite
 * listening on :5173; strictPort then crashes the next start.
 * Same idea as scripts/launch-mac.sh / launch.sh for packaged launches.
 *
 * Kill the concurrently / scripts/dev.mjs supervisor that owns the listener,
 * not Vite alone — otherwise concurrently -k treats Vite's SIGTERM as a
 * failure and the old `npm run dev` exits 1 (looks like a crash).
 */
import { execSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const PORT = 5173

function listeningPids(port) {
  if (process.platform === 'win32') {
    try {
      const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' })
      const pids = new Set()
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue
        if (!new RegExp(`:${port}\\s`).test(line)) continue
        const parts = line.trim().split(/\s+/)
        const pid = parts[parts.length - 1]
        if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid)
      }
      return [...pids]
    } catch {
      return []
    }
  }
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out ? out.split(/\s+/).filter(Boolean) : []
  } catch {
    return []
  }
}

function commandFor(pid) {
  try {
    // -ww: full argv (macOS truncates `command=` without it in some contexts).
    return execSync(`ps -p ${pid} -ww -o command=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function ancestorPids(pid) {
  const chain = []
  let current = Number(pid)
  for (let i = 0; i < 24 && current > 1; i++) {
    chain.push(current)
    try {
      const ppid = Number(
        execSync(`ps -p ${current} -o ppid=`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      )
      if (!Number.isFinite(ppid) || ppid <= 1 || ppid === current) break
      current = ppid
    } catch {
      break
    }
  }
  return chain
}

const pathSep = process.platform === 'win32' ? '\\' : '/'

function isDevSupervisor(cmd) {
  if (!cmd) return false
  if (cmd.includes('scripts/dev.mjs')) return true
  // concurrently for this pair (path match survives mild argv truncation).
  if (cmd.includes('concurrently.js') && (cmd.includes('dev:vite') || cmd.includes('dev:native'))) {
    return true
  }
  if (cmd.includes('concurrently') && cmd.includes('dev:vite')) return true
  return false
}

/** Prefer scripts/dev.mjs, then concurrently for this package; else null (do not kill Vite alone). */
function supervisorPid(listenPid) {
  if (process.platform === 'win32') return Number(listenPid)
  const chain = ancestorPids(listenPid)
  // Two passes: concurrently sits closer to Vite than scripts/dev.mjs; killing it
  // alone leaves the supervisor to see concurrently -k exit 1 (looks like a crash).
  for (const pid of chain) {
    const cmd = commandFor(pid)
    if (cmd.includes('scripts/dev.mjs')) return pid
  }
  for (const pid of chain) {
    if (isDevSupervisor(commandFor(pid))) return pid
  }
  return null
}

/** Global fallback when the listen PID's ancestry does not reach the supervisor. */
function findSupervisorPids() {
  if (process.platform === 'win32') return []
  try {
    const out = execSync('ps -ax -ww -o pid= -o command=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pids = []
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      if (!m) continue
      if (isDevSupervisor(m[2])) pids.push(Number(m[1]))
    }
    return pids
  } catch {
    return []
  }
}

function orphanShellPids() {
  if (process.platform === 'win32') return []
  try {
    const marker = `${pathSep}native-macos${pathSep}.build${pathSep}debug${pathSep}HandCashShell`
    const out = execSync('ps -ax -ww -o pid= -o command=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pids = []
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      if (!m) continue
      if (m[2].includes(marker)) pids.push(Number(m[1]))
    }
    return pids
  } catch {
    return []
  }
}

function sigterm(pid) {
  if (Number(pid) === process.pid) return false
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
    } else {
      process.kill(Number(pid), 'SIGTERM')
    }
    return true
  } catch {
    return false
  }
}

export async function freeDevPort(port = PORT) {
  const listeners = listeningPids(port)
  const targets = new Set()

  for (const listenPid of listeners) {
    const sup = supervisorPid(listenPid)
    if (sup != null) targets.add(String(sup))
  }

  // Ancestor walk missed (odd process trees): still prefer a supervisor over Vite.
  if (targets.size === 0 && listeners.length > 0) {
    const found = findSupervisorPids()
    const devMjs = found.filter((pid) => commandFor(pid).includes('scripts/dev.mjs'))
    for (const pid of devMjs.length ? devMjs : found) targets.add(String(pid))
  }

  // Last resort: only kill the listener when no supervisor exists (stray Vite).
  if (targets.size === 0) {
    for (const listenPid of listeners) targets.add(String(listenPid))
  }

  for (const pid of targets) {
    if (sigterm(pid)) {
      console.log(`[free-dev-port] freed :${port} (pid ${pid})`)
    }
  }

  // Prior -k / npm SIGTERM often leaves HandCashShell GUI processes behind.
  for (const pid of orphanShellPids()) {
    if (sigterm(pid)) {
      console.log(`[free-dev-port] stopped orphan HandCashShell (pid ${pid})`)
    }
  }

  // Brief pause so the OS releases the socket before Vite binds again.
  await new Promise((r) => setTimeout(r, 400))
}

const ranAsCli =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href

if (ranAsCli) {
  await freeDevPort()
}
