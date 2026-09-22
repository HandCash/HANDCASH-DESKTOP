import { useCallback, useEffect, useRef, useState } from 'react'
import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import { closeEmbeddedAppBrowser } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { BackIcon, CloseIcon, LaunchIcon, RefreshIcon } from './icons'

type Props = {
  name: string
  origin: string
  url: string
  previewRequested: boolean
  onPreview: (origin: string, dataUrl: string) => void
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

export function AppBrowserPanel({
  name,
  origin,
  url,
  previewRequested,
  onPreview,
}: Props) {
  const target = decideAppBrowserTarget(url)
  const safeUrl = target.kind === 'open' ? target.url : null
  const hostRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<WebviewElement | null>(null)
  const [currentUrl, setCurrentUrl] = useState(safeUrl ?? '')
  const [loading, setLoading] = useState(Boolean(safeUrl))
  const [history, setHistory] = useState({ back: false, forward: false })
  const captureTimerRef = useRef(0)
  const capturePreview = useCallback(() => {
    const view = webviewRef.current
    if (!view) return
    window.clearTimeout(captureTimerRef.current)
    captureTimerRef.current = window.setTimeout(() => {
      void view
        .capturePage()
        .then((image) =>
          onPreview(origin, image.resize({ width: 720, quality: 'better' }).toDataURL()),
        )
        .catch(() => undefined)
    }, 180)
  }, [onPreview, origin])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !safeUrl) return
    const view = document.createElement('webview') as WebviewElement
    view.className = 'app-browser-webview'
    view.setAttribute('partition', 'persist:handcash-app-browser')
    view.src = safeUrl

    const syncNavigation = (event?: Event) => {
      const navigated = event as Event & { url?: string }
      if (navigated?.url) setCurrentUrl(navigated.url)
      setHistory({
        back: view.canGoBack(),
        forward: view.canGoForward(),
      })
    }
    const start = () => setLoading(true)
    const stop = () => {
      setLoading(false)
      syncNavigation()
      capturePreview()
    }

    view.addEventListener('did-start-loading', start)
    view.addEventListener('did-stop-loading', stop)
    view.addEventListener('did-navigate', syncNavigation)
    view.addEventListener('did-navigate-in-page', syncNavigation)
    host.replaceChildren(view)
    webviewRef.current = view

    return () => {
      window.clearTimeout(captureTimerRef.current)
      view.removeEventListener('did-start-loading', start)
      view.removeEventListener('did-stop-loading', stop)
      view.removeEventListener('did-navigate', syncNavigation)
      view.removeEventListener('did-navigate-in-page', syncNavigation)
      webviewRef.current = null
      view.remove()
    }
  }, [capturePreview, safeUrl])

  useEffect(() => {
    if (previewRequested) capturePreview()
  }, [capturePreview, previewRequested])

  const openExternal = () => {
    if (!currentUrl) return
    playWalletSound('soft')
    void window.handcash?.openExternal?.(currentUrl)
  }

  if (!safeUrl) {
    return (
      <div className="nav-child-panel app-browser-panel app-browser-unavailable">
        <strong>App URL unavailable</strong>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => closeEmbeddedAppBrowser(origin)}
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <div
      className="nav-child-panel app-browser-panel"
      data-aeon-scope="app-browser"
      data-aeon-state={loading ? 'loading' : 'ready'}
    >
      <header className="app-browser-toolbar">
        <div className="app-browser-navigation">
          <button
            type="button"
            aria-label="Back"
            disabled={!history.back}
            onClick={() => webviewRef.current?.goBack()}
          >
            <BackIcon size={16} />
          </button>
          <button
            type="button"
            className="app-browser-forward"
            aria-label="Forward"
            disabled={!history.forward}
            onClick={() => webviewRef.current?.goForward()}
          >
            <BackIcon size={16} />
          </button>
          <button
            type="button"
            aria-label="Reload"
            onClick={() => webviewRef.current?.reload()}
          >
            <RefreshIcon size={16} />
          </button>
        </div>
        <div className="app-browser-location" title={currentUrl}>
          <strong>{name}</strong>
          <span>{currentUrl || origin}</span>
        </div>
        <div className="app-browser-navigation">
          <button type="button" aria-label="Open in system browser" onClick={openExternal}>
            <LaunchIcon size={16} />
          </button>
          <button
            type="button"
            aria-label={`Close ${name} tab`}
            onClick={() => closeEmbeddedAppBrowser(origin)}
          >
            <CloseIcon size={16} />
          </button>
        </div>
      </header>
      <div ref={hostRef} className="app-browser-content" aria-busy={loading} />
      {loading ? <span className="app-browser-loading" aria-hidden /> : null}
    </div>
  )
}
