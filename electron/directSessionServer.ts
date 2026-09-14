/**
 * IPv6 session socket. The renderer holds the identity key and signs every
 * handshake. This process only binds, frames, and fails fast.
 *
 * Listens on one global unicast address after a local accept succeeds. It
 * does not publish that address. The renderer puts a signed offer in a
 * messagebox message.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import log from 'electron-log'
import net from 'node:net'
import os from 'node:os'

const RACE_MS = 300
const MAX_FRAME = 256 * 1024
const HELLO_MS = 2_000

type HelloEvent = { socketId: string; hello: string }
type MessageEvent = { socketId: string; sender: string; body: string }
type ClosedEvent = { socketId: string }

type LiveSocket = {
  id: string
  socket: net.Socket
  peer: string
  buf: Buffer
  handshake: boolean
}

let server: net.Server | null = null
let endpoint: { host: string; port: number } | null = null
let windowGetter: (() => BrowserWindow | null) | null = null
const sockets = new Map<string, LiveSocket>()
const pendingAcks = new Map<string, (ok: boolean) => void>()
let seq = 1

function isGlobalUnicastIpv6(address: string): boolean {
  const bare = address.split('%')[0]?.trim().toLowerCase() ?? ''
  if (!bare.includes(':') || bare === '::' || bare === '::1') return false
  if (bare.startsWith('::ffff:')) return false
  const head = bare.split(':')[0] ?? ''
  if (!/^[0-9a-f]{1,4}$/.test(head)) return false
  const first = Number.parseInt(head, 16)
  if (first >= 0xfe80 && first <= 0xfebf) return false
  if (first >= 0xfc00 && first <= 0xfdff) return false
  if (first >= 0xff00) return false
  return first >= 0x2000 && first <= 0x3fff
}

export function listGlobalIpv6(): string[] {
  const out: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    if (!entries) continue
    for (const entry of entries) {
      const family = entry.family as string | number
      const v6 = family === 'IPv6' || family === 6
      if (!v6 || entry.internal) continue
      if (isGlobalUnicastIpv6(entry.address)) out.push(entry.address.split('%')[0]!.toLowerCase())
    }
  }
  return out
}

function encodeFrame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8')
  if (body.length > MAX_FRAME) throw new Error('session frame too large')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

function takeFrames(buf: Buffer): { frames: string[]; rest: Buffer } {
  const frames: string[] = []
  let offset = 0
  while (buf.length - offset >= 4) {
    const len = buf.readUInt32BE(offset)
    if (len <= 0 || len > MAX_FRAME) throw new Error('session frame rejected')
    if (buf.length - offset - 4 < len) break
    frames.push(buf.subarray(offset + 4, offset + 4 + len).toString('utf8'))
    offset += 4 + len
  }
  return { frames, rest: buf.subarray(offset) }
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = windowGetter?.()
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function dropSocket(id: string): void {
  const live = sockets.get(id)
  if (!live) return
  sockets.delete(id)
  live.socket.destroy()
  const ack = pendingAcks.get(id)
  if (ack) {
    pendingAcks.delete(id)
    ack(false)
  }
  sendToRenderer('direct-session-closed', { socketId: id } satisfies ClosedEvent)
}

function immediateCode(err: NodeJS.ErrnoException | null): boolean {
  const code = err?.code
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'EADDRNOTAVAIL' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET'
  )
}

function drain(live: LiveSocket, onFrame: (json: string) => void): void {
  const next = takeFrames(live.buf)
  live.buf = Buffer.from(next.rest)
  for (const frame of next.frames) onFrame(frame)
}

function attachFrames(live: LiveSocket, onFrame: (json: string) => void): void {
  live.socket.on('data', (chunk: Buffer) => {
    live.buf = Buffer.concat([live.buf, chunk])
    try {
      const next = takeFrames(live.buf)
      live.buf = Buffer.from(next.rest)
      for (const frame of next.frames) onFrame(frame)
    } catch {
      dropSocket(live.id)
    }
  })
  live.socket.on('error', () => dropSocket(live.id))
  live.socket.on('close', () => dropSocket(live.id))
}

async function proveLocalAccept(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 6 })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 500)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

export function registerDirectSessionIpc(getWindow: () => BrowserWindow | null): void {
  windowGetter = getWindow

  ipcMain.handle('direct-session:listen', async () => {
    if (endpoint && server) return endpoint
    const host = listGlobalIpv6()[0]
    if (!host) return null
    const bound = await new Promise<net.Server>((resolve, reject) => {
      const created = net.createServer((socket) => acceptInbound(socket))
      created.once('error', reject)
      created.listen({ port: 0, host, ipv6Only: true }, () => resolve(created))
    }).catch((err: unknown) => {
      log.warn('[session] listen failed', err instanceof Error ? err.message : String(err))
      return null
    })
    if (!bound) return null
    const addr = bound.address()
    if (!addr || typeof addr === 'string') {
      bound.close()
      return null
    }
    const proved = await proveLocalAccept(host, addr.port)
    if (!proved) {
      bound.close()
      log.info('[session] local IPv6 accept failed; not advertising')
      return null
    }
    server = bound
    endpoint = { host, port: addr.port }
    log.info(`[session] listening on [${host}]:${addr.port}`)
    return endpoint
  })

  ipcMain.handle(
    'direct-session:connect',
    async (
      _event,
      args: { host: string; port: number; timeoutMs: number; hello: string },
    ) => {
      if (!isGlobalUnicastIpv6(args.host)) return { ok: false, immediate: true }
      const budget = Math.min(Math.max(args.timeoutMs || RACE_MS, 50), 1_000)
      return new Promise((resolve) => {
        const socket = net.connect({ host: args.host, port: args.port, family: 6 })
        let done = false
        const finish = (result: { ok: true; remoteHello: string; socketId: string } | { ok: false; immediate: boolean }) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(result)
        }
        const timer = setTimeout(() => {
          socket.destroy()
          finish({ ok: false, immediate: false })
        }, budget)
        socket.once('error', (err: NodeJS.ErrnoException) => {
          finish({ ok: false, immediate: immediateCode(err) })
        })
        socket.once('connect', () => {
          try {
            socket.write(encodeFrame(args.hello))
          } catch {
            socket.destroy()
            finish({ ok: false, immediate: true })
            return
          }
          const buf = { current: Buffer.alloc(0) }
          const onData = (chunk: Buffer) => {
            buf.current = Buffer.concat([buf.current, chunk])
            try {
              const next = takeFrames(buf.current)
              buf.current = Buffer.from(next.rest)
              const welcome = next.frames[0]
              if (!welcome) return
              socket.off('data', onData)
              const id = `s${seq++}`
              let peer = ''
              try {
                const hello = JSON.parse(args.hello) as { offer?: { identityKey?: string } }
                peer = hello.offer?.identityKey?.trim().toLowerCase() ?? ''
              } catch {
                peer = ''
              }
              const live: LiveSocket = {
                id,
                socket,
                peer,
                buf: buf.current,
                handshake: true,
              }
              sockets.set(id, live)
              attachFrames(live, (json) => onLiveFrame(live, json))
              drain(live, (json) => onLiveFrame(live, json))
              finish({ ok: true, remoteHello: welcome, socketId: id })
            } catch {
              socket.destroy()
              finish({ ok: false, immediate: true })
            }
          }
          socket.on('data', onData)
        })
      })
    },
  )

  ipcMain.handle(
    'direct-session:send',
    async (_event, args: { socketId: string; body: string; timeoutMs: number }) => {
      const live = sockets.get(args.socketId)
      if (!live || !live.handshake) return false
      const parsed = JSON.parse(args.body) as { id?: string }
      const id = typeof parsed.id === 'string' ? parsed.id : ''
      if (!id) return false
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingAcks.delete(ackKey(live.id, id))
          resolve(false)
        }, args.timeoutMs || RACE_MS)
        pendingAcks.set(ackKey(live.id, id), (ok) => {
          clearTimeout(timer)
          resolve(ok)
        })
        try {
          live.socket.write(encodeFrame(args.body))
        } catch {
          clearTimeout(timer)
          pendingAcks.delete(ackKey(live.id, id))
          resolve(false)
        }
      })
    },
  )

  ipcMain.handle('direct-session:close', async (_event, socketId: unknown) => {
    if (typeof socketId === 'string') dropSocket(socketId)
  })

  ipcMain.handle(
    'direct-session:accept',
    async (_event, args: { socketId: string; welcome: string }) => {
      const live = sockets.get(args.socketId)
      if (!live) return
      live.handshake = true
      try {
        live.socket.write(encodeFrame(args.welcome))
      } catch {
        dropSocket(args.socketId)
      }
    },
  )

  ipcMain.handle('direct-session:reject', async (_event, socketId: unknown) => {
    if (typeof socketId === 'string') dropSocket(socketId)
  })
}

function ackKey(socketId: string, id: string): string {
  return `${socketId}:${id}`
}

function onLiveFrame(live: LiveSocket, json: string): void {
  let parsed: { t?: string; id?: string; body?: string; speaker?: string }
  try {
    parsed = JSON.parse(json) as { t?: string; id?: string; body?: string; speaker?: string }
  } catch {
    dropSocket(live.id)
    return
  }
  if (parsed.t === 'ack' && typeof parsed.id === 'string') {
    const pending = pendingAcks.get(ackKey(live.id, parsed.id))
    if (pending) {
      pendingAcks.delete(ackKey(live.id, parsed.id))
      pending(true)
    }
    return
  }
  if (parsed.t === 'msg' && typeof parsed.body === 'string' && typeof parsed.id === 'string') {
    sendToRenderer('direct-session-message', {
      socketId: live.id,
      sender: live.peer,
      body: parsed.body,
    } satisfies MessageEvent)
    try {
      live.socket.write(encodeFrame(JSON.stringify({ t: 'ack', id: parsed.id })))
    } catch {
      dropSocket(live.id)
    }
  }
}

function acceptInbound(socket: net.Socket): void {
  const id = `s${seq++}`
  const live: LiveSocket = { id, socket, peer: '', buf: Buffer.alloc(0), handshake: false }
  sockets.set(id, live)
  const timer = setTimeout(() => {
    if (!live.handshake) dropSocket(id)
  }, HELLO_MS)
  const onFrame = (json: string) => {
    if (live.handshake) {
      onLiveFrame(live, json)
      return
    }
    clearTimeout(timer)
    let hello: { speaker?: string }
    try {
      hello = JSON.parse(json) as { speaker?: string }
    } catch {
      dropSocket(id)
      return
    }
    live.peer = typeof hello.speaker === 'string' ? hello.speaker.trim().toLowerCase() : ''
    sendToRenderer('direct-session-hello', { socketId: id, hello: json } satisfies HelloEvent)
    socket.off('data', onData)
    attachFrames(live, (frame) => onLiveFrame(live, frame))
    try {
      drain(live, (frame) => onLiveFrame(live, frame))
    } catch {
      dropSocket(id)
    }
  }
  const onData = (chunk: Buffer) => {
    live.buf = Buffer.concat([live.buf, chunk])
    try {
      const next = takeFrames(live.buf)
      live.buf = Buffer.from(next.rest)
      for (const frame of next.frames) onFrame(frame)
    } catch {
      dropSocket(id)
    }
  }
  socket.on('data', onData)
  socket.on('error', () => dropSocket(id))
  socket.on('close', () => dropSocket(id))
}
