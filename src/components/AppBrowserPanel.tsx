import { useCallback, useEffect, useRef, useState } from 'react'
import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import {
  closeEmbeddedAppBrowser,
  noteEmbeddedAppBrowserUrl,
} from '../wallet/navStore'
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
  /**
   * The URL this guest was built with. Tabs are keyed by origin in the nav, so
   * a new tab remounts and captures afresh. Keying the guest on the live `url`
   * prop instead would tear the webview down and reload the page every time
   * the store learned where the user had browsed to.
   */
  const [entryUrl] = useState(safeUrl)
  const hostRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<WebviewElement | null>(null)
  const [currentUrl, setCurrentUrl] = useState(safeUrl ?? '')
  const [loading, setLoading] = useState(Boolean(safeUrl))
  const [failure, setFailure] = useState<string | null>(null)
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
    if (!host || !entryUrl) return
    const view = document.createElement('webview') as WebviewElement
    view.className = 'app-browser-webview'
    view.setAttribute('partition', 'persist:handcash-app-browser')
    view.src = entryUrl

    // Electron upgrades `<webview>` only once it is attached. A runtime with no
    // such element (Android) leaves an inert node that never loads and never
    // errors, so say so rather than spin on the loading bar forever.
    const attachCheck = window.setTimeout(() => {
      if (typeof view.reload !== 'function') {
        setFailure('This device cannot open apps inside HandCash.')
        setLoading(false)
      }
    }, 1_200)

    const syncNavigation = (event?: Event) => {
      const navigated = event as Event & { url?: string }
      if (navigated?.url) {
        setCurrentUrl(navigated.url)
        // Remember it on the tab so closing and reopening resumes here.
        noteEmbeddedAppBrowserUrl(origin, navigated.url)
      }
      setHistory({
        back: view.canGoBack(),
        forward: view.canGoForward(),
      })
    }
    const start = () => {
      setFailure(null)
      setLoading(true)
    }
    const stop = () => {
      setLoading(false)
      syncNavigation()
      capturePreview()
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
      setFailure(detail.errorDescription || 'This app could not be loaded.')
      setLoading(false)
    }

    view.addEventListener('did-start-loading', start)
    view.addEventListener('did-stop-loading', stop)
    view.addEventListener('did-fail-load', fail)
    view.addEventListener('did-navigate', syncNavigation)
    view.addEventListener('did-navigate-in-page', syncNavigation)
    host.replaceChildren(view)
    webviewRef.current = view

    return () => {
      window.clearTimeout(captureTimerRef.current)
      window.clearTimeout(attachCheck)
      view.removeEventListener('did-start-loading', start)
      view.removeEventListener('did-stop-loading', stop)
      view.removeEventListener('did-fail-load', fail)
      view.removeEventListener('did-navigate', syncNavigation)
      view.removeEventListener('did-navigate-in-page', syncNavigation)
      webviewRef.current = null
      view.remove()
    }
  }, [capturePreview, entryUrl, origin])

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
      data-aeon-state={failure ? 'failed' : loading ? 'loading' : 'ready'}
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
      {failure ? (
        <div className="app-browser-failure" role="alert">
          <strong>{name} could not be opened</strong>
          <span>{failure}</span>
          <button type="button" className="btn btn-ghost" onClick={openExternal}>
            Open in browser
          </button>
        </div>
      ) : null}
      {loading && !failure ? <span className="app-browser-loading" aria-hidden /> : null}
    </div>
  )
}
