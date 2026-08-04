/**
 * Serve packaged renderer over http://localhost:5173 when the Vite-era
 * IndexedDB partition has the wallet UTXO set. file:// cannot see that DB.
 */
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log'

export const UI_ORIGIN = 'http://localhost:5173'
const UI_PORT = 5173

let server: http.Server | null = null

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

  const ex = express()
  ex.use(express.static(distRoot, { index: 'index.html', fallthrough: true }))
  ex.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distRoot, 'index.html'))
  })

  await new Promise<void>((resolve, reject) => {
    const next = http.createServer(ex)
    next.once('error', (err) => {
      reject(err)
    })
    next.listen(UI_PORT, 'localhost', () => {
      server = next
      log.info('Packaged UI on', UI_ORIGIN, '(localhost IDB partition)')
      resolve()
    })
  })

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
