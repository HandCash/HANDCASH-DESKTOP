import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { appBrowserLocation, appBrowserPageMachine } from './appBrowserPageMachine'

function start() {
  const guest = {
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    rememberUrl: vi.fn(),
    capturePreview: vi.fn(),
  }
  const actor = createActor(
    appBrowserPageMachine.provide({
      actions: {
        goBack: guest.goBack,
        goForward: guest.goForward,
        reload: guest.reload,
        stop: guest.stop,
        rememberUrl: guest.rememberUrl,
        capturePreview: guest.capturePreview,
      },
    }),
    { input: { origin: 'https://app.example', url: 'https://app.example/' } },
  )
  actor.start()
  return { actor, guest }
}

describe('appBrowserPageMachine', () => {
  it('loads, measures progress, and captures a preview when ready', () => {
    const { actor, guest } = start()
    expect(actor.getSnapshot().value).toBe('loading')
    actor.send({ type: 'PROGRESS', value: 42.4 })
    expect(actor.getSnapshot().context.progress).toBe(42)
    actor.send({ type: 'LOADED', history: { back: true, forward: false } })
    expect(actor.getSnapshot().value).toBe('ready')
    expect(actor.getSnapshot().context.history.back).toBe(true)
    expect(guest.capturePreview).toHaveBeenCalledTimes(1)
  })

  it('stops a slow load from the toolbar', () => {
    const { actor, guest } = start()
    actor.send({ type: 'STOP' })
    expect(guest.stop).toHaveBeenCalled()
    expect(actor.getSnapshot().value).toBe('ready')
  })

  it('keeps the failure card through the guest’s trailing stop event, then retries', () => {
    const { actor, guest } = start()
    actor.send({ type: 'FAILED', description: 'net::ERR_NAME_NOT_RESOLVED' })
    actor.send({ type: 'LOADED', history: { back: false, forward: false } })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context.failure).toBe('net::ERR_NAME_NOT_RESOLVED')
    actor.send({ type: 'RETRY' })
    expect(guest.reload).toHaveBeenCalled()
    expect(actor.getSnapshot().value).toBe('loading')
    expect(actor.getSnapshot().context.failure).toBeNull()
  })

  it('only steps through history the guest says exists', () => {
    const { actor, guest } = start()
    actor.send({ type: 'BACK' })
    expect(guest.goBack).not.toHaveBeenCalled()
    actor.send({
      type: 'NAVIGATED',
      url: 'https://app.example/play',
      history: { back: true, forward: false },
    })
    actor.send({ type: 'BACK' })
    expect(guest.goBack).toHaveBeenCalledTimes(1)
    expect(guest.rememberUrl).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().context.url).toBe('https://app.example/play')
  })
})

describe('appBrowserLocation', () => {
  it('treats the app host and its subdomains as the app', () => {
    expect(appBrowserLocation('https://example.com', 'https://example.com/x')).toBe('app')
    expect(appBrowserLocation('https://example.com', 'https://play.example.com/')).toBe('app')
    expect(appBrowserLocation('example.com', 'https://example.com/')).toBe('app')
  })

  it('flags a page that left the app’s host', () => {
    expect(appBrowserLocation('https://example.com', 'https://evil-example.com/')).toBe('elsewhere')
    expect(appBrowserLocation('https://example.com', 'https://example.com.evil.io/')).toBe(
      'elsewhere',
    )
  })

  it('flags plain http (loopback only) as not secure', () => {
    expect(appBrowserLocation('http://localhost:5173', 'http://localhost:5173/')).toBe('insecure')
  })
})
