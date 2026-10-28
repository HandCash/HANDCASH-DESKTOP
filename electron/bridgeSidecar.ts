/**
 * Node sidecar for thin native shells (Mac / Windows / Linux): runs the
 * BRC-100 HTTP listeners and device-peer LAN server, talking to the native
 * host over stdio JSON.
 *
 * Protocol (one JSON object per line):
 *   sidecar → host: { v:1, type:'ready'|'log'|'to-renderer'|'fatal', ... }
 *   host → sidecar: { v:1, type:'from-renderer'|'renderer-ready'|'shutdown', ... }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createBridgeWindowSource, type BridgeWindowLike } from './bridgeWindow.js'
import {
  failPendingBridgeRequests,
  startHttpServer,
  type BridgeServerHandle,
  type HttpResponseEvent,
} from './httpServer.js'
import {
  startDevicePeerServer,
  type DevicePeerHttpResponseEvent,
} from './devicePeerServer.js'

type OutMsg =
  | {
      v: 1
      type: 'ready'
      httpUrl: string
      httpsUrl: string
      devicePeerPort: number
      devicePeerLanUrls: string[]
      devicePeerOnline: boolean
    }
  | { v: 1; type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { v: 1; type: 'to-renderer'; channel: string; payload: unknown }
  | { v: 1; type: 'fatal'; message: string }

type InMsg =
  | { v: 1; type: 'from-renderer'; channel: 'http-response'; payload: HttpResponseEvent }
  | {
      v: 1
      type: 'from-renderer'
      channel: 'device-peer-http-response'
      payload: DevicePeerHttpResponseEvent
    }
  | { v: 1; type: 'from-renderer'; channel: 'bridge:prompt-open'; payload: boolean }
  | { v: 1; type: 'renderer-ready' }
  | { v: 1; type: 'shutdown' }

const CONTENTS_ID = 1

function writeOut(msg: OutMsg): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function logLine(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
  const message = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ')
  writeOut({ v: 1, type: 'log', level, message })
}

function userDataPath(): string {
  if (process.env.HANDCASH_USER_DATA) return process.env.HANDCASH_USER_DATA
  const home = os.homedir()
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'HandCashDesktopNative')
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        'HandCashDesktopNative',
      )
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        'HandCashDesktopNative',
      )
  }
}

function ensureUserData(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

const responseHandlers = new Set<(response: HttpResponseEvent) => void>()
const devicePeerResponseHandlers = new Set<(response: DevicePeerHttpResponseEvent) => void>()
const promptHandlers = new Set<(open: boolean) => void>()

let bridge: BridgeServerHandle | null = null
let devicePeer: Awaited<ReturnType<typeof startDevicePeerServer>> | null = null
let shuttingDown = false

const fakeWindow: BridgeWindowLike = {
  isDestroyed: () => false,
  webContents: {
    id: CONTENTS_ID,
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => {
      writeOut({
        v: 1,
        type: 'to-renderer',
        channel,
        payload: args[0],
      })
    },
  },
}

const windows = createBridgeWindowSource({
  getWindow: () => fakeWindow,
  isQuitting: () => shuttingDown,
  reviveWindow: () => {
    // Host already has the WKWebView; readiness is `renderer-ready` from Swift.
  },
  onLog: (message) => logLine('info', message),
})

async function start(): Promise<void> {
  const dataDir = userDataPath()
  ensureUserData(dataDir)

  const log = {
    info: (...args: unknown[]) => logLine('info', ...args),
    warn: (...args: unknown[]) => logLine('warn', ...args),
    error: (...args: unknown[]) => logLine('error', ...args),
  }

  bridge = await startHttpServer(windows, {
    userDataPath: dataDir,
    log,
    onHttpResponse: (handler) => {
      responseHandlers.add(handler)
      return () => {
        responseHandlers.delete(handler)
      }
    },
    onPromptOpen: (handler) => {
      promptHandlers.add(handler)
      return () => {
        promptHandlers.delete(handler)
      }
    },
  })

  let devicePeerOnline = false
  let devicePeerLanUrls: string[] = []
  try {
    devicePeer = await startDevicePeerServer(windows, {
      log,
      onHttpResponse: (handler) => {
        devicePeerResponseHandlers.add(handler)
        return () => {
          devicePeerResponseHandlers.delete(handler)
        }
      },
    })
    devicePeerOnline = true
    devicePeerLanUrls = devicePeer.lanUrls
  } catch (err) {
    devicePeer = null
    log.warn(
      'Device peer server failed',
      err instanceof Error ? err.message : String(err),
    )
  }

  writeOut({
    v: 1,
    type: 'ready',
    httpUrl: bridge.httpUrl,
    httpsUrl: bridge.httpsUrl,
    devicePeerPort: 3340,
    devicePeerLanUrls,
    devicePeerOnline,
  })
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  failPendingBridgeRequests(reason)
  if (devicePeer) {
    await devicePeer.stop()
    devicePeer = null
  }
  if (bridge) {
    await bridge.stop()
    bridge = null
  }
}

function handleIn(msg: InMsg): void {
  switch (msg.type) {
    case 'renderer-ready':
      windows.markRendererReady(CONTENTS_ID)
      break
    case 'from-renderer':
      if (msg.channel === 'http-response') {
        for (const h of responseHandlers) h(msg.payload)
      } else if (msg.channel === 'device-peer-http-response') {
        for (const h of devicePeerResponseHandlers) h(msg.payload)
      } else if (msg.channel === 'bridge:prompt-open') {
        for (const h of promptHandlers) h(msg.payload === true)
      }
      break
    case 'shutdown':
      void shutdown('host requested shutdown').then(() => process.exit(0))
      break
    default:
      logLine('warn', `unknown inbound message: ${JSON.stringify(msg)}`)
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    handleIn(JSON.parse(trimmed) as InMsg)
  } catch (err) {
    logLine('warn', `bad inbound JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
})

process.on('SIGINT', () => {
  void shutdown('SIGINT').then(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM').then(() => process.exit(0))
})
process.stdin.on('end', () => {
  void shutdown('stdin closed').then(() => process.exit(0))
})

start().catch((err) => {
  writeOut({
    v: 1,
    type: 'fatal',
    message: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
