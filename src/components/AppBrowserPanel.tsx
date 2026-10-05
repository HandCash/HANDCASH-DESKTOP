import { useCallback, useEffect, useRef, useState } from 'react'
import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import { chooseAppBrowserSurface } from '../wallet/appBrowserSurface'
import {
  closeEmbeddedAppBrowser,
  noteEmbeddedAppBrowserUrl,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { createAppBrowserGuest, type AppBrowserGuest } from './appBrowserGuest'
import { BackIcon, CloseIcon, LaunchIcon, RefreshIcon } from './icons'

type Props = {
  name: string
  origin: string
  url: string
  previewRequested: boolean
  onPreview: (origin: string, dataUrl: string) => void
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
   * prop instead would tear the guest down and reload the page every time
   * the store learned where the user had browsed to.
   */
  const [entryUrl] = useState(safeUrl)
  const panelRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const guestRef = useRef<AppBrowserGuest | null>(null)
  const [currentUrl, setCurrentUrl] = useState(safeUrl ?? '')
  const [loading, setLoading] = useState(Boolean(safeUrl))
  const [failure, setFailure] = useState<string | null>(null)
  const [history, setHistory] = useState({ back: false, forward: false })
  const captureTimerRef = useRef(0)
  const capturePreview = useCallback(() => {
    const guest = guestRef.current
    if (!guest) return
    window.clearTimeout(captureTimerRef.current)
    captureTimerRef.current = window.setTimeout(() => {
      void guest.capture(720).then((dataUrl) => {
        if (dataUrl) onPreview(origin, dataUrl)
      })
    }, 180)
  }, [onPreview, origin])

  useEffect(() => {
    const host = hostRef.current
    const panel = panelRef.current
    if (!host || !panel || !entryUrl) return
    const surface = chooseAppBrowserSurface(window.handcash, true)
    const guest = createAppBrowserGuest(
      surface.surface === 'embedded' ? surface.host : 'webview',
      {
        host,
        panel,
        url: entryUrl,
        emit: (event) => {
          switch (event.type) {
            case 'loading':
              setFailure(null)
              setLoading(true)
              return
            case 'loaded':
              setLoading(false)
              setHistory(event.history)
              capturePreview()
              return
            case 'navigated':
              setCurrentUrl(event.url)
              setHistory(event.history)
              // Remember it on the tab so closing and reopening resumes here.
              noteEmbeddedAppBrowserUrl(origin, event.url)
              return
            case 'failed':
              setFailure(event.description)
              setLoading(false)
              return
          }
        },
      },
    )
    guestRef.current = guest

    return () => {
      window.clearTimeout(captureTimerRef.current)
      guestRef.current = null
      guest.destroy()
    }
  }, [capturePreview, entryUrl, origin])

  useEffect(() => {
    guestRef.current?.setSuppressed(failure != null)
  }, [failure])

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
      ref={panelRef}
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
            onClick={() => guestRef.current?.goBack()}
          >
            <BackIcon size={16} />
          </button>
          <button
            type="button"
            className="app-browser-forward"
            aria-label="Forward"
            disabled={!history.forward}
            onClick={() => guestRef.current?.goForward()}
          >
            <BackIcon size={16} />
          </button>
          <button
            type="button"
            aria-label="Reload"
            onClick={() => guestRef.current?.reload()}
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
