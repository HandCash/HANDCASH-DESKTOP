/**
 * Serve packaged renderer over http://localhost:5173 when the Vite-era
 * IndexedDB partition has the wallet UTXO set. file:// cannot see that DB.
 *
 * Origin must stay `localhost` (not 127.0.0.1) — Chromium IndexedDB is
 * origin-keyed and remittance history already lives under localhost:5173.
 */
import express from 'express'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log'

export const UI_ORIGIN = 'http://localhost:5173'
const UI_PORT = 5173

let server: http.Server | null = null

/** Drop foreign listeners on :5173 so we never load a stale Vite / old .app UI. */
function reclaimUiPort(): void {
  try {
    const out = execFileSync('lsof', ['-tiTCP:' + String(UI_PORT), '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 2_000,
    })
    for (const raw of out.trim().split(/\s+/)) {
      const pid = Number(raw)
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue
      try {
        process.kill(pid, 'SIGTERM')
        log.warn(`[ui-server] reclaimed :${UI_PORT} from pid ${pid}`)
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening / lsof missing */
  }
}

function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  for (const name of fs.readdirSync(dir)) {
    try {
      total += fs.statSync(path.join(dir, name)).size
    } catch {
      // ignore
    }
  }
  return total
}

function viteIdbDir(): string {
  return path.join(app.getPath('userData'), 'IndexedDB', 'http_localhost_5173.indexeddb.leveldb')
}

function fileIdbDir(): string {
  return path.join(app.getPath('userData'), 'IndexedDB', 'file__0.indexeddb.leveldb')
}

/** Prefer localhost origin when the Vite IDB looks like the live wallet store.
 * Isolates the file:// vs localhost IndexedDB edge case: packaged file:// must
 * not boot an empty-looking partition while remittance history lives on :5173.
 */
export function shouldLoadViaLocalhostOrigin(): boolean {
  try {
    const viteBytes = dirBytes(viteIdbDir())
    const fileBytes = dirBytes(fileIdbDir())
    // Dev-era wallets keep UTXOs here. Packaged file:// writes can inflate file__0
    // without restoring spendable outputs — never let a larger empty-ish file DB win.
    const preferVite = viteBytes > 200_000
    if (preferVite) {
      log.info(
        `IDB origin: prefer localhost (vite=${viteBytes}B file=${fileBytes}B) — remittance history partition`,
      )
    }
    return preferVite
  } catch (err) {
    log.warn('shouldLoadViaLocalhostOrigin failed', err)
    return false
  }
}

export async function startPackagedUiServer(distRoot: string): Promise<string> {
  if (server) return UI_ORIGIN

  reclaimUiPort()
  // Brief pause so the kernel releases TIME_WAIT / dual-stack sockets.
  await new Promise((r) => setTimeout(r, 150))

  const ex = express()
  ex.use(express.static(distRoot, { index: 'index.html', fallthrough: true }))
  ex.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distRoot, 'index.html'))
  })

  const listenOnce = (host: string) =>
    new Promise<http.Server>((resolve, reject) => {
      const next = http.createServer(ex)
      next.once('error', reject)
      next.listen(UI_PORT, host, () => resolve(next))
    })

  // Prefer IPv6 localhost — Chromium resolves `localhost` to ::1 first on macOS.
  // Fall back to 127.0.0.1 if ::1 is unavailable (older kernels / IPv6 off).
  let bound: http.Server
  try {
    bound = await listenOnce('::1')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : ''
    if (code === 'EADDRINUSE') {
      reclaimUiPort()
      await new Promise((r) => setTimeout(r, 200))
      try {
        bound = await listenOnce('::1')
      } catch {
        bound = await listenOnce('127.0.0.1')
      }
    } else if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
      bound = await listenOnce('127.0.0.1')
    } else {
      throw err
    }
  }

  server = bound
  log.info('Packaged UI on', UI_ORIGIN, '(localhost IDB partition)')
  return UI_ORIGIN
}

export async function stopPackagedUiServer(): Promise<void> {
  if (!server) return
  const current = server
  server = null
  await new Promise<void>((resolve) => {
    current.close(() => resolve())
  })
}
