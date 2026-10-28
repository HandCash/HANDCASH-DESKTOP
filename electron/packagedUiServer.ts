/**
 * Serve packaged renderer on http://localhost:5173 (IndexedDB origin).
 * Used by the thin-shell Node uiSidecar — no Chromium host imports.
 */
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { BridgeLog } from './httpServer.js'

export const UI_ORIGIN = 'http://localhost:5173'
const UI_PORT = 5173

let servers: http.Server[] = []

export async function startPackagedUiServer(
  distRoot: string,
  log?: BridgeLog,
): Promise<string> {
  if (servers.length > 0) return UI_ORIGIN
  if (!fs.existsSync(path.join(distRoot, 'index.html'))) {
    throw new Error(`packaged UI missing index.html under ${distRoot}`)
  }

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

  // Never kill an existing owner of the trusted localhost origin.
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
      log?.warn('[ui-server] IPv6 loopback unavailable; bound IPv4 only')
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
  log?.info(
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
