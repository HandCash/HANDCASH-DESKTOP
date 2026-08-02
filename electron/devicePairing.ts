/**
 * Short-lived LAN pairing host so a phone can scan Desktop QR and pull an encrypted vault package.
 */
import http from 'node:http'
import { networkInterfaces } from 'node:os'
import log from 'electron-log/main.js'

export type PairingHostSession = {
  sessionId: string
  port: number
  lanUrl: string
  expiresAt: number
  stop: () => void
}

type Active = {
  server: http.Server
  sessionId: string
  port: number
  expiresAt: number
  ivHex: string
  ciphertextHex: string
}

let active: Active | null = null

function pickLanIPv4(): string {
  const nets = networkInterfaces()
  for (const entries of Object.values(nets)) {
    if (!entries) continue
    for (const ent of entries) {
      if (ent.family === 'IPv4' && !ent.internal) return ent.address
    }
  }
  return '127.0.0.1'
}

export function stopDevicePairing(): void {
  if (!active) return
  try {
    active.server.close()
  } catch (err) {
    log.warn('pairing server close', err)
  }
  active = null
}

export async function startDevicePairing(args: {
  sessionId: string
  ivHex: string
  ciphertextHex: string
  ttlMs?: number
}): Promise<PairingHostSession> {
  stopDevicePairing()
  const ttlMs = args.ttlMs ?? 120_000
  const expiresAt = Date.now() + ttlMs
  const host = pickLanIPv4()

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (!active || Date.now() > active.expiresAt) {
      res.writeHead(410, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Pairing session expired' }))
      return
    }
    const url = new URL(req.url || '/', `http://${host}`)
    if (req.method === 'GET' && url.pathname === `/pair/${active.sessionId}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ivHex: active.ivHex,
          ciphertextHex: active.ciphertextHex,
        }),
      )
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, expiresAt: active.expiresAt }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('Could not bind pairing port'))
    })
    server.on('error', reject)
  })

  active = {
    server,
    sessionId: args.sessionId,
    port,
    expiresAt,
    ivHex: args.ivHex,
    ciphertextHex: args.ciphertextHex,
  }

  const timer = setTimeout(() => stopDevicePairing(), ttlMs)
  timer.unref?.()

  const lanUrl = `http://${host}:${port}`
  log.info('device pairing host started', { lanUrl, sessionId: args.sessionId, expiresAt })

  return {
    sessionId: args.sessionId,
    port,
    lanUrl,
    expiresAt,
    stop: () => stopDevicePairing(),
  }
}
