import type { AppBrowserHost } from '../wallet/appBrowserSurface'

export type GuestHistory = { back: boolean; forward: boolean }

export type GuestEvent =
  | { type: 'loading' }
  | { type: 'loaded'; history: GuestHistory }
  | { type: 'navigated'; url: string; history: GuestHistory }
  | { type: 'failed'; description: string }

/** What draws an app tab's page. The panel's toolbar drives it on every shell. */
export type AppBrowserGuest = {
  goBack(): void
  goForward(): void
  reload(): void
  /** JPEG/PNG data URL for the tab switcher, or null. */
  capture(width: number): Promise<string | null>
  /** Keep the page off screen while the panel shows its own failure card. */
  setSuppressed(suppressed: boolean): void
  destroy(): void
}

type GuestArgs = {
  host: HTMLElement
  /** The whole panel; wallet UI inside it does not count as covering the page. */
  panel: HTMLElement
  url: string
  emit: (event: GuestEvent) => void
}

export function createAppBrowserGuest(kind: AppBrowserHost, args: GuestArgs): AppBrowserGuest {
  const bridge = window.handcash?.appBrowserGuest
  if (kind === 'native' && bridge) return createNativeGuest(bridge, args)
  return createWebviewGuest(args)
}

type CapturedImage = {
  resize: (options: { width: number; quality?: 'good' | 'better' | 'best' }) => CapturedImage
  toDataURL: () => string
}

type WebviewElement = HTMLElement & {
  src: string
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
  capturePage: () => Promise<CapturedImage>
}

function createWebviewGuest({ host, url, emit }: GuestArgs): AppBrowserGuest {
  const view = document.createElement('webview') as WebviewElement
  view.className = 'app-browser-webview'
  view.setAttribute('partition', 'persist:handcash-app-browser')
  view.src = url

  // Electron upgrades `<webview>` only once it is attached. A runtime with no
  // such element leaves an inert node that never loads and never errors.
  const attachCheck = window.setTimeout(() => {
    if (typeof view.reload !== 'function') {
      emit({ type: 'failed', description: 'This device cannot open apps inside HandCash.' })
    }
  }, 1_200)

  const history = (): GuestHistory => ({ back: view.canGoBack(), forward: view.canGoForward() })
  const start = () => emit({ type: 'loading' })
  const stop = () => emit({ type: 'loaded', history: history() })
  const navigated = (event: Event) => {
    const url = (event as Event & { url?: string }).url
    if (url) emit({ type: 'navigated', url, history: history() })
  }
  // Sub-frame failures are normal on real sites; only the main document
  // failing means the tab has nothing to show.
  const fail = (event: Event) => {
    const detail = event as Event & {
      isMainFrame?: boolean
      errorCode?: number
      errorDescription?: string
    }
    if (detail.isMainFrame === false) return
    // -3 is ERR_ABORTED, which a redirect raises on the way to a good page.
    if (detail.errorCode === -3) return
    emit({ type: 'failed', description: detail.errorDescription || 'This app could not be loaded.' })
  }

  view.addEventListener('did-start-loading', start)
  view.addEventListener('did-stop-loading', stop)
  view.addEventListener('did-fail-load', fail)
  view.addEventListener('did-navigate', navigated)
  view.addEventListener('did-navigate-in-page', navigated)
  host.replaceChildren(view)

  return {
    goBack: () => view.goBack(),
    goForward: () => view.goForward(),
    reload: () => view.reload(),
    capture: (width) =>
      view
        .capturePage()
        .then((image) => image.resize({ width, quality: 'better' }).toDataURL())
        .catch(() => null),
    setSuppressed: () => undefined,
    destroy: () => {
      window.clearTimeout(attachCheck)
      view.removeEventListener('did-start-loading', start)
      view.removeEventListener('did-stop-loading', stop)
      view.removeEventListener('did-fail-load', fail)
      view.removeEventListener('did-navigate', navigated)
      view.removeEventListener('did-navigate-in-page', navigated)
      view.remove()
    },
  }
}

let nextGuestId = 0

/**
 * The shell's WebView sits above the wallet's, over the panel's content box.
 * Anything the wallet draws on top of that box — a permission prompt, a menu,
 * the tab switcher — would be hidden under the page, so the page is moved off
 * screen whenever wallet UI from outside the panel covers any probe point.
 * Live regions (toasts) are allowed to sit under it.
 */
function createNativeGuest(
  bridge: AppBrowserGuestBridge,
  { host, panel, url, emit }: GuestArgs,
): AppBrowserGuest {
  const id = `guest-${Date.now().toString(36)}-${(nextGuestId++).toString(36)}`
  let suppressed = false
  let destroyed = false
  let frame = 0
  let sent = ''

  const measure = (): AppBrowserGuestBounds => {
    const rect = host.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: !suppressed && unobstructed(rect),
    }
  }

  const unobstructed = (rect: DOMRect): boolean => {
    if (document.visibilityState === 'hidden') return false
    if (rect.width < 2 || rect.height < 2) return false
    if (host.closest('[data-parked], [aria-hidden="true"], [inert]')) return false
    const inset = 6
    const points: Array<[number, number]> = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + inset, rect.top + inset],
      [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset],
      [rect.right - inset, rect.bottom - inset],
    ]
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y)
      if (!hit || panel.contains(hit)) continue
      if (hit.closest('[aria-live], [role="status"]')) continue
      return false
    }
    return true
  }

  const sync = () => {
    if (destroyed) return
    const bounds = measure()
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height},${bounds.visible}`
    if (key !== sent) {
      sent = key
      void bridge.setBounds({ id, ...bounds }).catch(() => undefined)
    }
    frame = window.requestAnimationFrame(sync)
  }

  const stop = bridge.onEvent((event) => {
    if (event.id !== id || destroyed) return
    switch (event.type) {
      case 'loading':
        emit({ type: 'loading' })
        return
      case 'loaded':
        emit({
          type: 'loaded',
          history: { back: event.canGoBack, forward: event.canGoForward },
        })
        return
      case 'navigated':
        emit({
          type: 'navigated',
          url: event.url,
          history: { back: event.canGoBack, forward: event.canGoForward },
        })
        return
      case 'failed':
        emit({ type: 'failed', description: event.description || 'This app could not be loaded.' })
        return
    }
  })

  const initial = measure()
  sent = `${initial.x},${initial.y},${initial.width},${initial.height},${initial.visible}`
  bridge.create({ id, url, ...initial }).then(
    () => {
      if (!destroyed) frame = window.requestAnimationFrame(sync)
    },
    (err: unknown) => {
      if (destroyed) return
      emit({
        type: 'failed',
        description: err instanceof Error ? err.message : 'This device cannot open apps inside HandCash.',
      })
    },
  )

  const navigate = (action: 'back' | 'forward' | 'reload') => {
    void bridge.navigate({ id, action }).catch(() => undefined)
  }

  return {
    goBack: () => navigate('back'),
    goForward: () => navigate('forward'),
    reload: () => navigate('reload'),
    capture: (width) =>
      bridge.capture({ id, width }).then(
        (result) => result.dataUrl,
        () => null,
      ),
    setSuppressed: (next) => {
      suppressed = next
    },
    destroy: () => {
      destroyed = true
      window.cancelAnimationFrame(frame)
      stop()
      void bridge.destroy({ id }).catch(() => undefined)
    },
  }
}
