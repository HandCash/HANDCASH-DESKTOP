import express, { type Request, type Response } from 'express'
import cors from 'cors'
import { ipcMain } from 'electron'
import https, { type Server } from 'node:https'
import log from 'electron-log'
import { generateSelfSignedCert, ensureCertTrusted } from './sslCert.js'
import { type BridgeWindowSource } from './bridgeWindow.js'
import { ONE_SAT_APP_CAPABILITIES } from './oneSatAppCapabilities.js'
import { bridgeDeadlineMessage, bridgeDeadlineMs } from './bridgeDeadline.js'

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

let requestIdCounter = 1
const pendingRequests = new Map<number, PendingRequest>()

/**
 * Reject in-flight bridge calls when the renderer they were sent to goes away.
 * Called per window by main.ts — the bridge itself no longer owns a window.
 */
export function failPendingBridgeRequests(reason: string): void {
  failAllPendingRequests(`WALLET_BRIDGE_UNAVAILABLE: ${reason}`)
}

function failAllPendingRequests(reason: string): void {
  if (pendingRequests.size === 0) return
  const error = new Error(reason)
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  pendingRequests.clear()
}

/**
 * Turn a renderer error body into a one-line, bounded log summary. Prefers the
 * wallet's `code` / `description`, falls back to raw text, and never emits more
 * than a few hundred chars so a BEEF-sized payload can't flood support logs.
 */
function summarizeErrorBody(body: string): string {
  const raw = typeof body === 'string' ? body : ''
  if (!raw) return '(empty body)'
  try {
    const parsed = JSON.parse(raw) as {
      code?: unknown
      description?: unknown
      message?: unknown
    }
    const code = typeof parsed.code === 'string' ? parsed.code : undefined
    const description =
      typeof parsed.description === 'string'
        ? parsed.description
        : typeof parsed.message === 'string'
          ? parsed.message
          : undefined
    const parts = [code, description].filter(Boolean) as string[]
    if (parts.length > 0) return truncateForLog(parts.join(': '))
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return truncateForLog(raw)
}

function truncateForLog(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > 300 ? `${flattened.slice(0, 300)}…` : flattened
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

const REFUSAL_DESCRIPTION: Record<string, string> = {
  'app-quitting': 'wallet is quitting',
  'window-unavailable': 'wallet window could not be opened',
  'renderer-not-ready': 'wallet window is still loading',
}

export async function startHttpServer(windows: BridgeWindowSource): Promise<{
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
          note: 'Official HandCash Desktop — keys stay on your machine',
          icon: 'https://localhost:2121/favicon.ico',
          publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        },
        oneSat: ONE_SAT_APP_CAPABILITIES,
      },
    })
  })

  // Lightweight probe that does not need the renderer (proves the HTTP listener).
  app.get('/health', (_req, res) => {
    setCorsHeaders(res)
    res.json({
      ok: true,
      service: 'handcash-brc100',
      bridge: 'http',
      oneSat: ONE_SAT_APP_CAPABILITIES,
    })
  })

  const onHttpResponse = (_event: Electron.IpcMainEvent, response: HttpResponseEvent) => {
    const pending = pendingRequests.get(response.request_id)
    if (!pending) {
      // The HTTP call was already answered (deadline or client hang-up). Say so:
      // for a spend this is the record that the wallet finished an action the
      // caller was told nothing about.
      log.warn(
        `[HTTP] late renderer reply request_id=${response.request_id} status=${response.status} — HTTP call already answered`,
      )
      return
    }
    clearTimeout(pending.timer)
    pending.resolve(response)
    pendingRequests.delete(response.request_id)
  }
  ipcMain.on('http-response', onHttpResponse)

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

      const acquired = await windows.acquire()
      if (acquired.kind === 'refuse') {
        throw new Error(
          `WALLET_BRIDGE_UNAVAILABLE: ${REFUSAL_DESCRIPTION[acquired.reason] ?? acquired.reason} (${acquired.reason})`,
        )
      }
      const target = acquired.window

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
          // The renderer may be suspended in a permission promise. Once the
          // HTTP deadline has elapsed there is no caller left to receive that
          // decision, so release the prompt instead of leaving an orphaned
          // Approving/Cancel panel on screen.
          try {
            windows.peek()?.webContents.send('http-request-cancelled', {
              request_id,
              reason: 'WALLET_BRIDGE_TIMEOUT',
            })
          } catch {
            // Window teardown races the deadline — pending work is already dead.
          }
          reject(new Error(bridgeDeadlineMessage(req.method, req.path)))
        }, bridgeDeadlineMs(req.path))

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
            windows.peek()?.webContents.send('http-request-cancelled', {
              request_id,
              reason: 'CLIENT_DISCONNECTED',
            })
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
      target.webContents.send('http-request', requestEvent)
      const httpResponse = await responsePromise
      log.info(`[HTTP] ← renderer request_id=${request_id} status=${httpResponse.status}`)
      // A bare status hides why a tx failed. Surface the wallet's reason
      // (code/description) on non-2xx so remote support logs are diagnosable,
      // truncated so a large BEEF/error payload never floods the log.
      if (httpResponse.status >= 400) {
        log.warn(
          `[HTTP] ← renderer request_id=${request_id} ${req.method} ${req.path} error: ${summarizeErrorBody(httpResponse.body)}`,
        )
      }

      if (!canWriteResponse(res)) return
      setCorsHeaders(res)
      // The renderer hands us a serialized JSON body. Express would label a bare
      // string `text/html`, which a BRC-100 client is entitled to reject before
      // it ever parses the answer.
      res.status(httpResponse.status).type('application/json').send(httpResponse.body)
    } catch (error) {
      if (!canWriteResponse(res)) return
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('CLIENT_DISCONNECTED')) return
      setCorsHeaders(res)
      const isBridgeUnavailable = message.includes('WALLET_BRIDGE_UNAVAILABLE')
      const isPending = message.includes('WALLET_BRIDGE_PENDING')
      const isTimeout = message.includes('WALLET_BRIDGE_TIMEOUT')
      log.warn(`[HTTP] bridge error: ${message}`)
      res
        .status(isBridgeUnavailable || isPending || isTimeout ? 503 : 500)
        .type('application/json')
        .send(
          JSON.stringify({
            status: 'error',
            code: isPending
              ? 'WALLET_BRIDGE_PENDING'
              : isTimeout
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
