/**
 * Electron IPC adapter. Missing in tests and in the browser shell — the
 * messagebox path is unchanged when this is absent.
 */

import {
  handleDirectClosed,
  handleDirectHello,
  handleDirectInbound,
  installDirectSessionPort,
  type DirectSessionPort,
} from './session'
import type { SessionHello } from './protocol'

type Bridge = {
  directSessionListen?: () => Promise<{ host: string; port: number } | null>
  directSessionConnect?: (args: {
    host: string
    port: number
    timeoutMs: number
    hello: string
  }) => Promise<
    | { ok: true; remoteHello: string; socketId: string }
    | { ok: false; immediate: boolean }
  >
  directSessionSend?: (args: {
    socketId: string
    body: string
    timeoutMs: number
  }) => Promise<boolean>
  directSessionClose?: (socketId: string) => Promise<void>
  directSessionAccept?: (args: { socketId: string; welcome: string }) => Promise<void>
  directSessionReject?: (socketId: string) => Promise<void>
  onDirectSessionHello?: (handler: (event: { socketId: string; hello: string }) => void) => () => void
  onDirectSessionMessage?: (
    handler: (event: { socketId: string; sender: string; body: string }) => void,
  ) => () => void
  onDirectSessionClosed?: (handler: (event: { socketId: string }) => void) => () => void
}

let wired = false

function bridge(): Bridge | null {
  if (typeof window === 'undefined') return null
  return (window.handcash as Bridge | undefined) ?? null
}

function messageFrame(body: string): string {
  const id = Math.random().toString(16).slice(2) + Date.now().toString(16)
  return JSON.stringify({ t: 'msg', id, body })
}

export function installElectronDirectSession(): void {
  const api = bridge()
  if (!api?.directSessionListen || wired) return
  wired = true
  const port: DirectSessionPort = {
    listen: () => api.directSessionListen!(),
    connect: (args) => api.directSessionConnect!(args),
    send: (socketId, body, timeoutMs) =>
      api.directSessionSend!({ socketId, body: messageFrame(body), timeoutMs }),
    close: (socketId) => api.directSessionClose!(socketId),
    accept: (socketId, welcome) => api.directSessionAccept!({ socketId, welcome }),
    reject: (socketId) => api.directSessionReject!(socketId),
  }
  installDirectSessionPort(port)
  api.onDirectSessionHello?.((event) => {
    let hello: SessionHello
    try {
      hello = JSON.parse(event.hello) as SessionHello
    } catch {
      void api.directSessionReject?.(event.socketId)
      return
    }
    void handleDirectHello(event.socketId, hello)
  })
  api.onDirectSessionMessage?.((event) => {
    if (!event.sender || !event.body) return
    handleDirectInbound(event.sender, event.body)
  })
  api.onDirectSessionClosed?.((event) => {
    handleDirectClosed(event.socketId)
  })
}
