/**
 * Which window (if any) a BRC-100 bridge request may be handed to.
 *
 * The bridge used to close over the BrowserWindow it was started with. On macOS
 * closing the window keeps the app alive, so that reference stayed destroyed for
 * the rest of the process lifetime and every connect attempt answered 503
 * `window is not available`. The window is now resolved per request, and a
 * request may revive a window instead of refusing.
 */

export type BridgeWindowLike = {
  isDestroyed: () => boolean
  webContents: {
    id: number
    isDestroyed: () => boolean
    send: (channel: string, payload?: unknown) => void
  }
}

export type BridgeWindowSnapshot = {
  window: BridgeWindowLike | null
  /** webContents id that reported it is listening for `http-request`. */
  readyContentsId: number | null
  quitting: boolean
}

/** Why the bridge will not serve a request at all. */
export type BridgeWindowRefusal = 'app-quitting' | 'window-unavailable' | 'renderer-not-ready'

export type BridgeWindowFate =
  | { kind: 'ready'; window: BridgeWindowLike }
  | { kind: 'awaitRenderer'; window: BridgeWindowLike }
  | { kind: 'revive' }
  | { kind: 'refuse'; reason: Extract<BridgeWindowRefusal, 'app-quitting'> }

export function isWindowGone(window: BridgeWindowLike | null): boolean {
  if (!window) return true
  try {
    return window.isDestroyed() || window.webContents.isDestroyed()
  } catch {
    return true
  }
}

export function classifyBridgeWindow(snapshot: BridgeWindowSnapshot): BridgeWindowFate {
  if (snapshot.quitting) return { kind: 'refuse', reason: 'app-quitting' }
  const { window } = snapshot
  if (isWindowGone(window) || !window) return { kind: 'revive' }
  if (snapshot.readyContentsId !== window.webContents.id) {
    return { kind: 'awaitRenderer', window }
  }
  return { kind: 'ready', window }
}

export type BridgeWindowAcquisition =
  | { kind: 'ready'; window: BridgeWindowLike }
  | { kind: 'refuse'; reason: BridgeWindowRefusal }

/**
 * `revive` — a user-facing app is connecting; opening the wallet window is expected.
 * `existing` — background traffic (device peer); wait for a window but never open one.
 */
export type BridgeWindowIntent = 'revive' | 'existing'

export type BridgeWindowSource = {
  acquire: (intent?: BridgeWindowIntent) => Promise<BridgeWindowAcquisition>
  /** Current window without waiting or reviving — for best-effort sends. */
  peek: () => BridgeWindowLike | null
  markRendererReady: (contentsId: number) => void
  markRendererGone: (contentsId: number) => void
  isRendererReady: () => boolean
}

export type BridgeWindowSourceDeps = {
  getWindow: () => BridgeWindowLike | null
  /** Create/show a window for an inbound request. Must be idempotent. */
  reviveWindow: () => void | Promise<void>
  isQuitting: () => boolean
  /** How long a request may wait for a window + a listening renderer. */
  waitMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onLog?: (message: string) => void
}

const DEFAULT_WAIT_MS = 20_000
const DEFAULT_POLL_MS = 100

export function createBridgeWindowSource(deps: BridgeWindowSourceDeps): BridgeWindowSource {
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  const now = deps.now ?? (() => Date.now())
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      }))

  let readyContentsId: number | null = null

  const snapshot = (): BridgeWindowSnapshot => ({
    window: deps.getWindow(),
    readyContentsId,
    quitting: deps.isQuitting(),
  })

  return {
    markRendererReady: (contentsId) => {
      if (readyContentsId === contentsId) return
      readyContentsId = contentsId
      deps.onLog?.(`[bridge] renderer ready (webContents ${contentsId})`)
    },
    markRendererGone: (contentsId) => {
      if (readyContentsId !== contentsId) return
      readyContentsId = null
      deps.onLog?.(`[bridge] renderer no longer listening (webContents ${contentsId})`)
    },
    isRendererReady: () => classifyBridgeWindow(snapshot()).kind === 'ready',
    peek: () => {
      const window = deps.getWindow()
      return isWindowGone(window) ? null : window
    },
    acquire: async (intent: BridgeWindowIntent = 'revive') => {
      const deadline = now() + waitMs
      let revived = intent !== 'revive'
      let lastFate: BridgeWindowFate = { kind: 'revive' }

      for (;;) {
        const fate = classifyBridgeWindow(snapshot())
        lastFate = fate

        if (fate.kind === 'ready') return { kind: 'ready', window: fate.window }
        if (fate.kind === 'refuse') return { kind: 'refuse', reason: fate.reason }

        if (fate.kind === 'revive') {
          // Background traffic must not open a window the user did not ask for.
          if (intent === 'existing') return { kind: 'refuse', reason: 'window-unavailable' }
          if (!revived) {
            revived = true
            deps.onLog?.('[bridge] no window for request — reviving')
            try {
              await deps.reviveWindow()
            } catch (err) {
              deps.onLog?.(
                `[bridge] revive failed: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
            continue
          }
        }

        if (now() >= deadline) break
        await sleep(pollMs)
      }

      return {
        kind: 'refuse',
        reason: lastFate.kind === 'awaitRenderer' ? 'renderer-not-ready' : 'window-unavailable',
      }
    },
  }
}
