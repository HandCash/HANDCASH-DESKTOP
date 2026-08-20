/**
 * Serve packaged renderer over http://localhost:5173 when the Vite-era
 * IndexedDB partition has the wallet UTXO set. file:// cannot see that DB.
 *
 * Origin must stay `localhost` (not 127.0.0.1) — Chromium IndexedDB is
 * origin-keyed and remittance history already lives under localhost:5173.
 */
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log'

export const UI_ORIGIN = 'http://localhost:5173'
const UI_PORT = 5173

let servers: http.Server[] = []

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
  if (servers.length > 0) return UI_ORIGIN

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

  // The localhost origin contains live wallet IndexedDB state. Never kill an
  // existing owner or wait and race it for the trusted port: an attacker could
  // win the bind and make BrowserWindow execute hostile content with our
  // preload bridge. Bind every available loopback family ourselves and fail
  // closed if either is already occupied.
  const bound: http.Server[] = []
  try {
    bound.push(await listenOnce('127.0.0.1'))
    try {
      bound.push(await listenOnce('::1'))
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : ''
      if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') throw err
      log.warn('[ui-server] IPv6 loopback unavailable; bound IPv4 only')
    }
  } catch (err) {
    await Promise.all(
      bound.map(
        (current) =>
          new Promise<void>((resolve) => {
            current.close(() => resolve())
          }),
      ),
    )
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : ''
    if (code === 'EADDRINUSE') {
      throw new Error(
        `Refusing to load the wallet: another process owns trusted UI port ${UI_PORT}.`,
      )
    }
    throw err
  }

  servers = bound
  log.info(
    'Packaged UI on',
    UI_ORIGIN,
    `(localhost IDB partition; ${servers.length} loopback listener${servers.length === 1 ? '' : 's'})`,
  )
  return UI_ORIGIN
}

export async function stopPackagedUiServer(): Promise<void> {
  const current = servers
  servers = []
  await Promise.all(
    current.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
}
