/**
 * LAN device-peer HTTP (0.0.0.0:3340). Restricted to /handcash-device/v1/*.
 * BRC-100 app bridge stays on 127.0.0.1:3321 / 2121.
 */
import express, { type Request, type Response } from 'express'
import cors from 'cors'
import { ipcMain } from 'electron'
import os from 'node:os'
import log from 'electron-log'
import { type BridgeWindowSource } from './bridgeWindow.js'

/** Keep in sync with src/wallet/deviceWallets.ts DEVICE_PEER_PORT */
const DEVICE_PEER_PORT = 3340

type HttpRequestEvent = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  request_id: number
}

type HttpResponseEvent = {
  request_id: number
  status: number
  body: string
}

type PendingRequest = {
  resolve: (response: HttpResponseEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 30_000
let requestIdCounter = 1
const pendingRequests = new Map<number, PendingRequest>()

function setCorsHeaders(res: Response): void {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Allow-Methods', '*')
}

export function listLanIpv4Addresses(): string[] {
  const out: string[] = []
  const ifaces = os.networkInterfaces()
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue
    for (const e of entries) {
      if (e.family === 'IPv4' && !e.internal) out.push(e.address)
    }
  }
  return out
}

export async function startDevicePeerServer(windows: BridgeWindowSource): Promise<{
  port: number
  lanUrls: string[]
  stop: () => Promise<void>
}> {
  const app = express()
  app.use(cors({ origin: '*' }))
  app.use(express.json({ limit: '2mb' }))

  app.options('*', (_req, res) => {
    setCorsHeaders(res)
    res.sendStatus(200)
  })

  const onHttpResponse = (_event: Electron.IpcMainEvent, response: HttpResponseEvent) => {
    const pending = pendingRequests.get(response.request_id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.resolve(response)
    pendingRequests.delete(response.request_id)
  }
  ipcMain.on('device-peer-http-response', onHttpResponse)

  app.all('/handcash-device/v1/*', async (req: Request, res: Response) => {
    const request_id = requestIdCounter++
    try {
      // Device peer is same-identity background sync — never open a window for it.
      const acquired = await windows.acquire('existing')
      if (acquired.kind === 'refuse') {
        throw new Error(`WALLET_BRIDGE_UNAVAILABLE: ${acquired.reason}`)
      }
      const target = acquired.window
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value
        else if (Array.isArray(value)) headers[key] = value[0]!
      }
      let body = ''
      if (typeof req.body === 'string') body = req.body
      else if (req.body != null && req.body !== '') body = JSON.stringify(req.body)

      const requestEvent: HttpRequestEvent = {
        method: req.method,
        path: req.path,
        headers,
        body,
        request_id,
      }

      const responsePromise = new Promise<HttpResponseEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(request_id)
          reject(new Error('DEVICE_PEER_TIMEOUT'))
        }, REQUEST_TIMEOUT_MS)
        pendingRequests.set(request_id, { resolve, reject, timer })
        target.webContents.send('device-peer-http-request', requestEvent)
      })

      const httpResponse = await responsePromise
      setCorsHeaders(res)
      res.status(httpResponse.status).send(httpResponse.body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`[device-peer] ${message}`)
      setCorsHeaders(res)
      res.status(503).json({
        status: 'error',
        code: 'DEVICE_PEER_UNAVAILABLE',
        description: message,
      })
    }
  })

  app.use((_req, res) => {
    setCorsHeaders(res)
    res.status(404).json({ status: 'error', description: 'Not a device-peer route' })
  })

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const srv = app.listen(DEVICE_PEER_PORT, '0.0.0.0', () => resolve(srv))
    srv.once('error', reject)
  })

  const lanUrls = listLanIpv4Addresses().map((ip) => `http://${ip}:${DEVICE_PEER_PORT}`)
  log.info(`[device-peer] listening on 0.0.0.0:${DEVICE_PEER_PORT}`, lanUrls)

  return {
    port: DEVICE_PEER_PORT,
    lanUrls,
    stop: async () => {
      ipcMain.removeListener('device-peer-http-response', onHttpResponse)
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('DEVICE_PEER_SHUTDOWN'))
      }
      pendingRequests.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
