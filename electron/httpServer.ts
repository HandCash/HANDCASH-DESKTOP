import express, { type Request, type Response } from 'express'
import cors from 'cors'
import http from 'node:http'
import https, { type Server } from 'node:https'
import { generateSelfSignedCert, ensureCertTrusted } from './sslCert.js'
import { type BridgeWindowSource } from './bridgeWindow.js'
import { ONE_SAT_APP_CAPABILITIES } from './oneSatAppCapabilities.js'
import { bridgeDeadlineMessage, bridgeDeadlineMs, isSpendMethodPath } from './bridgeDeadline.js'
import { SpendLedger, spendRequestKey, type BridgeReply } from './spendLedger.js'
import { jsonRequestErrors } from './requestErrors.js'
import { bridgeFailureDescription, walletFailureFor, withWalletFailure } from './walletFailure.js'
import {
  bridgeConnectUnavailableMessage,
  bridgeCorsHeaders,
} from './appConnectGuardrails.js'

export type HttpRequestEvent = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  request_id: number
}

export type HttpResponseEvent = {
  request_id: number
  status: number
  body: string
}

export type BridgeLog = {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export type StartHttpServerOptions = {
  userDataPath?: string
  log?: BridgeLog
  /** Sidecar/native: register response delivery without Electron ipcMain. */
  onHttpResponse?: (handler: (response: HttpResponseEvent) => void) => () => void
  onPromptOpen?: (handler: (open: boolean) => void) => () => void
}

const consoleLog: BridgeLog = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
}

type PendingRequest = {
  resolve: (response: HttpResponseEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
  path: string
}

let requestIdCounter = 1
const pendingRequests = new Map<number, PendingRequest>()
const spendLedger = new SpendLedger()

/**
 * A permission prompt is on screen. BRC-219: a request waiting on the user is
 * never aborted because time passed, so no deadline fires while this holds.
 */
let promptOpen = false

/**
 * Reject in-flight bridge calls when the renderer they were sent to goes away.
 * Called per window by main.ts — the bridge itself no longer owns a window.
 */
export function failPendingBridgeRequests(reason: string): void {
  promptOpen = false
  failAllPendingRequests(`WALLET_BRIDGE_UNAVAILABLE: ${reason}`)
}

function failAllPendingRequests(reason: string): void {
  spendLedger.loseAll(
    bridgeErrorReply(`WALLET_BRIDGE_PENDING: the wallet stopped (${reason}) while a spend was in it — it may have completed; reconcile before retrying`, ''),
  )
  if (pendingRequests.size === 0) return
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer)
    // A spend the wallet already had may have been broadcast before it went away.
    pending.reject(
      new Error(
        isSpendMethodPath(pending.path)
          ? `WALLET_BRIDGE_PENDING: ${pending.method} ${pending.path} was in the wallet when it stopped (${reason}) — it may have completed; reconcile before retrying`
          : reason,
      ),
    )
  }
  pendingRequests.clear()
}

/**
 * The JSON error body for a bridge failure, coded from its message prefix. The
 * message itself goes to the log; the body carries plain words (BRC-326).
 */
function bridgeErrorReply(message: string, path: string): BridgeReply {
  const isBridgeUnavailable = message.includes('WALLET_BRIDGE_UNAVAILABLE')
  const isPending = message.includes('WALLET_BRIDGE_PENDING')
  const isTimeout = message.includes('WALLET_BRIDGE_TIMEOUT')
  const code = isPending
    ? 'WALLET_BRIDGE_PENDING'
    : isTimeout
      ? 'WALLET_BRIDGE_TIMEOUT'
      : isBridgeUnavailable
        ? 'WALLET_BRIDGE_UNAVAILABLE'
        : 'HTTP_BRIDGE_ERROR'
  const status = isBridgeUnavailable || isPending || isTimeout ? 503 : 500
  return {
    status,
    body: JSON.stringify({
      status: 'error',
      code,
      description: bridgeFailureDescription(code, message, path),
      ...walletFailureFor(code, status, path),
    }),
  }
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
  for (const [key, value] of Object.entries(bridgeCorsHeaders())) {
    res.header(key, value)
  }
}

function canWriteResponse(res: Response): boolean {
  return !res.writableEnded && !res.destroyed && res.writable
}

function sendReply(res: Response, reply: BridgeReply, path: string): void {
  if (!canWriteResponse(res)) return
  setCorsHeaders(res)
  // The renderer hands us a serialized JSON body. Express would label a bare
  // string `text/html`, which a BRC-100 client is entitled to reject before
  // it ever parses the answer.
  res.status(reply.status).type('application/json').send(withWalletFailure(reply.status, reply.body, path))
}

/** Wait on a spend run another request started, under this request's own deadline. */
function waitOnRun(
  join: { reply: Promise<BridgeReply>; leave: () => void },
  req: Request,
  res: Response,
): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      join.leave()
      reject(new Error(bridgeDeadlineMessage(req.method, req.path)))
    }, bridgeDeadlineMs(req.path))
    res.on('close', () => {
      if (res.writableEnded) return
      clearTimeout(timer)
      join.leave()
      reject(new Error('CLIENT_DISCONNECTED: HTTP client closed the connection'))
    })
    void join.reply.then((reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
  })
}

/**
 * Add ::1 listeners for both bridge ports, skipping any that will not bind.
 *
 * Failure here is never fatal: the IPv4 listeners are already serving, so a
 * host with IPv6 disabled (EADDRNOTAVAIL) or something else already on the
 * IPv6 port must not take the wallet down with it.
 */
async function bindIpv6Loopback(
  app: express.Express,
  tls: { cert: string; key: string },
  log: BridgeLog,
): Promise<Array<{ port: number; server: http.Server }>> {
  const bound: Array<{ port: number; server: http.Server }> = []
  const attempts: Array<{ port: number; make: () => http.Server }> = [
    { port: 2121, make: () => https.createServer(tls, app) },
    { port: 3321, make: () => http.createServer(app) },
  ]
  for (const { port, make } of attempts) {
    await new Promise<void>((resolve) => {
      const server = make()
      server.once('error', (error: NodeJS.ErrnoException) => {
        log.warn(`BRC-100 [::1]:${port} unavailable (${error.code ?? error.message})`)
        resolve()
      })
      server.listen(port, '::1', () => {
        bound.push({ port, server })
        resolve()
      })
    })
  }
  return bound
}

export async function startHttpServer(
  windows: BridgeWindowSource,
  opts?: StartHttpServerOptions,
): Promise<{
  httpsUrl: string
  httpUrl: string
  stop: () => Promise<void>
}> {
  const log = opts?.log ?? consoleLog
  const unsubscribers: Array<() => void> = []
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

  const deliverHttpResponse = (response: HttpResponseEvent) => {
    spendLedger.settle(response.request_id, { status: response.status, body: response.body })
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
  const setPromptOpen = (open: unknown) => {
    promptOpen = open === true
  }
  if (opts?.onHttpResponse) {
    unsubscribers.push(opts.onHttpResponse(deliverHttpResponse))
  } else {
    const { ipcMain } = await import('electron')
    const onHttpResponse = (_event: Electron.IpcMainEvent, response: HttpResponseEvent) =>
      deliverHttpResponse(response)
    const onPromptOpen = (_event: Electron.IpcMainEvent, open: unknown) => setPromptOpen(open)
    ipcMain.on('http-response', onHttpResponse)
    ipcMain.on('bridge:prompt-open', onPromptOpen)
    unsubscribers.push(() => {
      ipcMain.removeListener('http-response', onHttpResponse)
      ipcMain.removeListener('bridge:prompt-open', onPromptOpen)
    })
  }
  if (opts?.onPromptOpen) {
    unsubscribers.push(opts.onPromptOpen((open) => setPromptOpen(open)))
  }

  app.all('*', async (req: Request, res: Response) => {
    const request_id = requestIdCounter++
    let dispatched = false
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

      if (req.method === 'POST' && isSpendMethodPath(req.path)) {
        const begun = spendLedger.begin(spendRequestKey(headers.origin ?? headers.originator, req.path, body), request_id)
        if (begun.kind === 'replay') {
          log.warn(`[HTTP] request_id=${request_id} ${req.method} ${req.path} repeats a spend that already ran — answering with that run, not paying again`)
          sendReply(res, begun.reply, req.path)
          return
        }
        if (begun.kind === 'join') {
          log.warn(`[HTTP] request_id=${request_id} ${req.method} ${req.path} repeats a spend still in the wallet — waiting on that run, not paying again`)
          sendReply(res, await waitOnRun(begun, req, res), req.path)
          return
        }
      }

      const acquired = await windows.acquire()
      if (acquired.kind === 'refuse') {
        throw new Error(bridgeConnectUnavailableMessage(acquired.reason))
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
        let heldForPrompt = false
        const arm = (): ReturnType<typeof setTimeout> => setTimeout(() => {
          const pending = pendingRequests.get(request_id)
          if (!pending) return
          if (promptOpen) {
            if (!heldForPrompt) {
              heldForPrompt = true
              log.info(`[HTTP] request_id=${request_id} ${req.path} deadline held — a permission prompt is open`)
            }
            pending.timer = arm()
            return
          }
          pendingRequests.delete(request_id)
          spendLedger.orphan(request_id)
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

        pendingRequests.set(request_id, { resolve, reject, timer: arm(), method: req.method, path: req.path })

        // Prefer 'aborted' — IncomingMessage 'close' can fire after the body is
        // fully read (before we answer), which would drop every Wallet Connect call.
        const onClientGone = () => {
          if (!pendingRequests.has(request_id) || res.writableEnded || res.headersSent) return
          const pending = pendingRequests.get(request_id)
          if (pending) clearTimeout(pending.timer)
          pendingRequests.delete(request_id)
          spendLedger.orphan(request_id)
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
      dispatched = true
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

      if (!canWriteResponse(res)) {
        spendLedger.orphan(request_id)
        return
      }
      sendReply(res, httpResponse, req.path)
      spendLedger.done(request_id)
    } catch (error) {
      if (!dispatched) spendLedger.done(request_id)
      if (!canWriteResponse(res)) return
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('CLIENT_DISCONNECTED')) return
      log.warn(`[HTTP] bridge error: ${message}`)
      sendReply(res, bridgeErrorReply(message, req.path), req.path)
    }
  })

  app.use(jsonRequestErrors(setCorsHeaders))

  const { cert, key, certPath } = await generateSelfSignedCert(opts?.userDataPath)
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

  /**
   * Answer on the IPv6 loopback too, best effort.
   *
   * `WalletClient('auto')` from `@bsv/sdk` dials `localhost`, which resolves to
   * ::1 before 127.0.0.1 on many hosts. Listening on IPv4 alone leaves this
   * wallet invisible to every SDK-based app there, and a third-party app has no
   * reason to retry by IP literal. Only the loopback is added — binding the
   * wildcard would put the bridge on the LAN — and a host without IPv6 simply
   * keeps the two listeners above.
   */
  const ipv6Servers = await bindIpv6Loopback(app, { cert, key }, log)
  for (const { port } of ipv6Servers) {
    log.info(`BRC-100 also on [::1]:${port}`)
  }

  return {
    httpsUrl: 'https://127.0.0.1:2121',
    httpUrl: 'http://127.0.0.1:3321',
    stop: async () => {
      for (const unsub of unsubscribers) unsub()
      unsubscribers.length = 0
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
        ...ipv6Servers.map(
          ({ server: ipv6 }) =>
            new Promise<void>((resolve) => {
              ipv6.close(() => resolve())
            }),
        ),
      ])
    },
  }
}

export type BridgeServerHandle = Awaited<ReturnType<typeof startHttpServer>>
