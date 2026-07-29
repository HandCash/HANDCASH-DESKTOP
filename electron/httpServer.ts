import express, { type Request, type Response } from 'express'
import cors from 'cors'
import { ipcMain, type BrowserWindow } from 'electron'
import https, { type Server } from 'node:https'
import log from 'electron-log'
import { generateSelfSignedCert, ensureCertTrusted } from './sslCert.js'

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

const REQUEST_TIMEOUT_MS = 120_000

let requestIdCounter = 1
const pendingRequests = new Map<number, PendingRequest>()

function failAllPendingRequests(reason: string): void {
  if (pendingRequests.size === 0) return
  const error = new Error(reason)
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  pendingRequests.clear()
}

function setCorsHeaders(res: Response): void {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Allow-Methods', '*')
  res.header('Access-Control-Expose-Headers', '*')
  res.header('Access-Control-Allow-Private-Network', 'true')
}

function canWriteResponse(res: Response): boolean {
  return !res.writableEnded && !res.destroyed && res.writable
}

export async function startHttpServer(mainWindow: BrowserWindow): Promise<{
  httpsUrl: string
  httpUrl: string
  stop: () => Promise<void>
}> {
  const app = express()

  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Private-Network', 'true')
    next()
  })

  app.use(
    cors({
      origin: '*',
      methods: '*',
      allowedHeaders: '*',
      exposedHeaders: '*',
      credentials: false,
      preflightContinue: true,
    }),
  )

  // Only one body parser may own a given Content-Type. Stacking
  // express.text({ type: '*/*' }) after json hangs POST bodies forever.
  app.use(express.json({ limit: '50mb', type: ['application/json', 'application/*+json'] }))
  app.use(express.text({ limit: '50mb', type: ['text/*', 'application/octet-stream'] }))
  app.use(express.urlencoded({ extended: true, limit: '50mb' }))

  app.use((req, _res, next) => {
    log.info(`[HTTP] ${req.method} ${req.url}`)
    next()
  })

  app.options('*', (_req, res) => {
    setCorsHeaders(res)
    res.sendStatus(200)
  })

  app.get('/manifest.json', (_req, res) => {
    setCorsHeaders(res)
    res.json({
      short_name: 'HandCash',
      name: 'HandCash Desktop',
      start_url: '.',
      display: 'standalone',
      theme_color: '#00d46a',
      background_color: '#07140f',
      icons: [{ src: 'favicon.ico', sizes: '64x64 32x32 24x24 16x16', type: 'image/x-icon' }],
      babbage: {
        trust: {
          name: 'HandCash',
          note: 'HandCash-themed BRC-100 wallet — keys stay on your machine',
          icon: 'https://localhost:2121/favicon.ico',
          publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        },
      },
    })
  })

  // Lightweight probe that does not need the renderer (proves the HTTP listener).
  app.get('/health', (_req, res) => {
    setCorsHeaders(res)
    res.json({ ok: true, service: 'handcash-brc100', bridge: 'http' })
  })

  const onHttpResponse = (_event: Electron.IpcMainEvent, response: HttpResponseEvent) => {
    const pending = pendingRequests.get(response.request_id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.resolve(response)
    pendingRequests.delete(response.request_id)
  }
  ipcMain.on('http-response', onHttpResponse)

  const onRendererUnavailable = (reason: string) => {
    failAllPendingRequests(`WALLET_BRIDGE_UNAVAILABLE: ${reason}`)
  }

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    onRendererUnavailable(`renderer process gone (${details.reason})`)
  })
  mainWindow.webContents.on('did-start-loading', () => {
    onRendererUnavailable('renderer reloading')
  })
  mainWindow.webContents.on('destroyed', () => {
    onRendererUnavailable('webContents destroyed')
  })
  mainWindow.on('closed', () => {
    onRendererUnavailable('window closed')
  })

  app.all('*', async (req: Request, res: Response) => {
    const request_id = requestIdCounter++
    try {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value
        else if (Array.isArray(value)) headers[key] = value[0]
      }

      let body = ''
      if (typeof req.body === 'string') body = req.body
      else if (req.body !== undefined && req.body !== null && req.body !== '') {
        body = JSON.stringify(req.body)
      }

      if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        throw new Error('WALLET_BRIDGE_UNAVAILABLE: window is not available')
      }

      const requestEvent: HttpRequestEvent = {
        method: req.method,
        path: req.path,
        headers,
        body,
        request_id,
      }

      const responsePromise = new Promise<HttpResponseEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pendingRequests.has(request_id)) return
          pendingRequests.delete(request_id)
          reject(
            new Error(
              `WALLET_BRIDGE_TIMEOUT: no renderer reply for ${req.method} ${req.path} within ${REQUEST_TIMEOUT_MS}ms`,
            ),
          )
        }, REQUEST_TIMEOUT_MS)

        pendingRequests.set(request_id, { resolve, reject, timer })

        // Prefer 'aborted' — IncomingMessage 'close' can fire after the body is
        // fully read (before we answer), which would drop every Wallet Connect call.
        const onClientGone = () => {
          if (!pendingRequests.has(request_id) || res.writableEnded || res.headersSent) return
          const pending = pendingRequests.get(request_id)
          if (pending) clearTimeout(pending.timer)
          pendingRequests.delete(request_id)
          reject(new Error('CLIENT_DISCONNECTED: HTTP client closed the connection'))
          try {
            if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.send('http-request-cancelled', {
                request_id,
                reason: 'CLIENT_DISCONNECTED',
              })
            }
          } catch {
            // ignore
          }
        }
        req.on('aborted', onClientGone)
        res.on('close', () => {
          if (!res.writableEnded) onClientGone()
        })
      })

      log.info(`[HTTP] → renderer request_id=${request_id} ${req.method} ${req.path}`)
      mainWindow.webContents.send('http-request', requestEvent)
      const httpResponse = await responsePromise
      log.info(`[HTTP] ← renderer request_id=${request_id} status=${httpResponse.status}`)

      if (!canWriteResponse(res)) return
      setCorsHeaders(res)
      res.status(httpResponse.status).send(httpResponse.body)
    } catch (error) {
      if (!canWriteResponse(res)) return
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('CLIENT_DISCONNECTED')) return
      setCorsHeaders(res)
      const isBridgeUnavailable = message.includes('WALLET_BRIDGE_UNAVAILABLE')
      const isTimeout = message.includes('WALLET_BRIDGE_TIMEOUT')
      log.warn(`[HTTP] bridge error: ${message}`)
      res.status(isBridgeUnavailable || isTimeout ? 503 : 500).send(
        JSON.stringify({
          status: 'error',
          code: isTimeout
            ? 'WALLET_BRIDGE_TIMEOUT'
            : isBridgeUnavailable
              ? 'WALLET_BRIDGE_UNAVAILABLE'
              : 'HTTP_BRIDGE_ERROR',
          description: message,
        }),
      )
    }
  })

  const { cert, key, certPath } = await generateSelfSignedCert()
  await ensureCertTrusted(certPath)

  let httpServer: ReturnType<typeof app.listen> | null = null

  const server: Server = await new Promise((resolve, reject) => {
    const srv = https.createServer({ cert, key }, app)

    const fail = (error: NodeJS.ErrnoException, port: number) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`BRC-100 port ${port} is already in use`))
        return
      }
      reject(error)
    }

    srv.once('error', (error: NodeJS.ErrnoException) => fail(error, 2121))
    srv.listen(2121, '127.0.0.1', () => {
      httpServer = app.listen(3321, '127.0.0.1', () => resolve(srv))
      httpServer.once('error', (error: NodeJS.ErrnoException) => fail(error, 3321))
    })
  })

  log.info('BRC-100 HTTPS on https://127.0.0.1:2121')
  log.info('BRC-100 HTTP  on http://127.0.0.1:3321')

  return {
    httpsUrl: 'https://127.0.0.1:2121',
    httpUrl: 'http://127.0.0.1:3321',
    stop: async () => {
      ipcMain.removeListener('http-response', onHttpResponse)
      failAllPendingRequests('WALLET_BRIDGE_UNAVAILABLE: HTTP server shutting down')
      await Promise.all([
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
        new Promise<void>((resolve) => {
          if (!httpServer) {
            resolve()
            return
          }
          httpServer.close(() => resolve())
        }),
      ])
    },
  }
}

export type BridgeServerHandle = Awaited<ReturnType<typeof startHttpServer>>
