import { describe, expect, it, vi } from 'vitest'
import {
  classifyBridgeWindow,
  createBridgeWindowSource,
  isWindowGone,
  type BridgeWindowLike,
} from './bridgeWindow.js'

function fakeWindow(opts?: {
  id?: number
  destroyed?: boolean
  contentsDestroyed?: boolean
}): BridgeWindowLike & { sent: Array<{ channel: string; payload?: unknown }> } {
  const sent: Array<{ channel: string; payload?: unknown }> = []
  return {
    sent,
    isDestroyed: () => opts?.destroyed ?? false,
    webContents: {
      id: opts?.id ?? 1,
      isDestroyed: () => opts?.contentsDestroyed ?? false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  }
}

describe('classifyBridgeWindow', () => {
  it('is ready when the window is live and its renderer registered', () => {
    const window = fakeWindow({ id: 7 })
    expect(
      classifyBridgeWindow({ window, readyContentsId: 7, quitting: false }),
    ).toEqual({ kind: 'ready', window })
  })

  it('waits for the renderer when the ready id belongs to an older webContents', () => {
    const window = fakeWindow({ id: 9 })
    const fate = classifyBridgeWindow({ window, readyContentsId: 7, quitting: false })
    expect(fate.kind).toBe('awaitRenderer')
  })

  it('revives when there is no window', () => {
    expect(
      classifyBridgeWindow({ window: null, readyContentsId: null, quitting: false }).kind,
    ).toBe('revive')
  })

  it('revives when the captured window was destroyed — the connect bug', () => {
    const window = fakeWindow({ id: 1, destroyed: true })
    expect(
      classifyBridgeWindow({ window, readyContentsId: 1, quitting: false }).kind,
    ).toBe('revive')
  })

  it('revives when only the webContents was destroyed', () => {
    const window = fakeWindow({ id: 1, contentsDestroyed: true })
    expect(
      classifyBridgeWindow({ window, readyContentsId: 1, quitting: false }).kind,
    ).toBe('revive')
  })

  it('refuses while quitting even with a live window', () => {
    const window = fakeWindow({ id: 1 })
    expect(classifyBridgeWindow({ window, readyContentsId: 1, quitting: true })).toEqual({
      kind: 'refuse',
      reason: 'app-quitting',
    })
  })
})

describe('isWindowGone', () => {
  it('treats a throwing window as gone', () => {
    const hostile = {
      isDestroyed: () => {
        throw new Error('object has been destroyed')
      },
      webContents: { id: 1, isDestroyed: () => false, send: () => {} },
    }
    expect(isWindowGone(hostile)).toBe(true)
  })

  it('treats null as gone', () => {
    expect(isWindowGone(null)).toBe(true)
  })
})

describe('createBridgeWindowSource', () => {
  const immediateSleep = () => Promise.resolve()

  it('revives a window for a connect request and serves it once ready', async () => {
    let window: (BridgeWindowLike & { sent: unknown[] }) | null = null
    const source = createBridgeWindowSource({
      getWindow: () => window,
      isQuitting: () => false,
      reviveWindow: () => {
        window = fakeWindow({ id: 42 })
        source.markRendererReady(42)
      },
      sleep: immediateSleep,
    })

    const acquired = await source.acquire()
    expect(acquired).toEqual({ kind: 'ready', window })
  })

  it('replaces a destroyed window instead of refusing forever', async () => {
    let window: BridgeWindowLike | null = fakeWindow({ id: 1, destroyed: true })
    const source = createBridgeWindowSource({
      getWindow: () => window,
      isQuitting: () => false,
      reviveWindow: () => {
        window = fakeWindow({ id: 2 })
        source.markRendererReady(2)
      },
      sleep: immediateSleep,
    })

    const acquired = await source.acquire()
    expect(acquired.kind).toBe('ready')
    if (acquired.kind === 'ready') expect(acquired.window.webContents.id).toBe(2)
  })

  it('refuses with renderer-not-ready when the window never registers', async () => {
    let clock = 0
    const window = fakeWindow({ id: 5 })
    const source = createBridgeWindowSource({
      getWindow: () => window,
      isQuitting: () => false,
      reviveWindow: () => {},
      waitMs: 500,
      now: () => clock,
      sleep: async () => {
        clock += 100
      },
    })

    expect(await source.acquire()).toEqual({ kind: 'refuse', reason: 'renderer-not-ready' })
  })

  it('refuses with window-unavailable when revive produces nothing', async () => {
    let clock = 0
    const source = createBridgeWindowSource({
      getWindow: () => null,
      isQuitting: () => false,
      reviveWindow: () => {},
      waitMs: 500,
      now: () => clock,
      sleep: async () => {
        clock += 100
      },
    })

    expect(await source.acquire()).toEqual({ kind: 'refuse', reason: 'window-unavailable' })
  })

  it('never opens a window for background device-peer traffic', async () => {
    const reviveWindow = vi.fn()
    const source = createBridgeWindowSource({
      getWindow: () => null,
      isQuitting: () => false,
      reviveWindow,
      sleep: immediateSleep,
    })

    expect(await source.acquire('existing')).toEqual({
      kind: 'refuse',
      reason: 'window-unavailable',
    })
    expect(reviveWindow).not.toHaveBeenCalled()
  })

  it('survives a revive that throws', async () => {
    let clock = 0
    const source = createBridgeWindowSource({
      getWindow: () => null,
      isQuitting: () => false,
      reviveWindow: () => {
        throw new Error('window creation blew up')
      },
      waitMs: 300,
      now: () => clock,
      sleep: async () => {
        clock += 100
      },
    })

    expect(await source.acquire()).toEqual({ kind: 'refuse', reason: 'window-unavailable' })
  })

  it('refuses immediately while quitting', async () => {
    const source = createBridgeWindowSource({
      getWindow: () => fakeWindow({ id: 1 }),
      isQuitting: () => true,
      reviveWindow: () => {},
      sleep: immediateSleep,
    })

    expect(await source.acquire()).toEqual({ kind: 'refuse', reason: 'app-quitting' })
  })

  it('drops readiness when that renderer goes away and regains it on reload', async () => {
    const window = fakeWindow({ id: 3 })
    const source = createBridgeWindowSource({
      getWindow: () => window,
      isQuitting: () => false,
      reviveWindow: () => {},
      sleep: immediateSleep,
    })

    source.markRendererReady(3)
    expect(source.isRendererReady()).toBe(true)

    source.markRendererGone(3)
    expect(source.isRendererReady()).toBe(false)

    source.markRendererReady(3)
    expect((await source.acquire()).kind).toBe('ready')
  })

  it('ignores a stale renderer-gone from a previous webContents', () => {
    const window = fakeWindow({ id: 8 })
    const source = createBridgeWindowSource({
      getWindow: () => window,
      isQuitting: () => false,
      reviveWindow: () => {},
      sleep: immediateSleep,
    })

    source.markRendererReady(8)
    source.markRendererGone(7)
    expect(source.isRendererReady()).toBe(true)
  })

  it('peek returns null for a destroyed window and the window when live', () => {
    let window: BridgeWindowLike = fakeWindow({ id: 1, destroyed: true })
    const source = createBridgeWindowSource({
      getWindow: () => window,
      isQuitting: () => false,
      reviveWindow: () => {},
    })

    expect(source.peek()).toBeNull()
    window = fakeWindow({ id: 2 })
    expect(source.peek()).toBe(window)
  })
})
