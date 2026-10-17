import { useEffect, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import { Button } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import {
  appBrowserLocation,
  appBrowserPageHost,
  appBrowserPageMachine,
} from '../machines/appBrowserPageMachine'
import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import { chooseAppBrowserSurface } from '../wallet/appBrowserSurface'
import {
  closeEmbeddedAppBrowser,
  noteEmbeddedAppBrowserUrl,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { createAppBrowserGuest, type AppBrowserGuest } from './appBrowserGuest'
import {
  BackIcon,
  CloseIcon,
  LaunchIcon,
  LockIcon,
  RefreshIcon,
  WarningIcon,
} from './icons'

type Props = {
  name: string
  origin: string
  url: string
  previewRequested: boolean
  onPreview: (origin: string, dataUrl: string) => void
}

export function AppBrowserPanel(props: Props) {
  const target = decideAppBrowserTarget(props.url)
  if (target.kind !== 'open') {
    return (
      <div
        className="nav-child-panel app-browser-panel"
        data-aeon-scope="app-browser"
        data-aeon-state="unavailable"
      >
        <div data-aeon-part="notice" role="alert">
          <strong>{props.name} cannot open here</strong>
          <span>{target.message}</span>
          <Button.Root
            variant="ghost"
            className="btn btn-ghost"
            onClick={() => closeEmbeddedAppBrowser(props.origin)}
          >
            Close tab
          </Button.Root>
        </div>
      </div>
    )
  }
  return <AppBrowserTab {...props} entryUrl={target.url} />
}

function AppBrowserTab({
  name,
  origin,
  entryUrl: initialUrl,
  previewRequested,
  onPreview,
}: Props & { entryUrl: string }) {
  /**
   * The URL this guest was built with. Tabs are keyed by origin in the nav, so
   * a new tab remounts and captures afresh. Keying the guest on the live `url`
   * prop instead would tear the guest down and reload the page every time
   * the store learned where the user had browsed to.
   */
  const [entryUrl] = useState(initialUrl)
  const panelRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const guestRef = useRef<AppBrowserGuest | null>(null)
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview
  const captureTimerRef = useRef(0)

  const capturePreview = () => {
    const guest = guestRef.current
    if (!guest) return
    window.clearTimeout(captureTimerRef.current)
    captureTimerRef.current = window.setTimeout(() => {
      void guest.capture(720).then((dataUrl) => {
        if (dataUrl) onPreviewRef.current(origin, dataUrl)
      })
    }, 180)
  }

  const [state, send] = useMachine(
    appBrowserPageMachine.provide({
      actions: {
        goBack: () => guestRef.current?.goBack(),
        goForward: () => guestRef.current?.goForward(),
        reload: () => guestRef.current?.reload(),
        stop: () => guestRef.current?.stop(),
        // Remember it on the tab so closing and reopening resumes here.
        rememberUrl: ({ event }) => {
          if (event.type === 'NAVIGATED') noteEmbeddedAppBrowserUrl(origin, event.url)
        },
        capturePreview,
      },
    }),
    { input: { origin, url: entryUrl } },
  )
  const { url, history, failure, progress } = state.context
  const loading = state.matches('loading')
  const failed = state.matches('failed')

  useEffect(() => {
    const host = hostRef.current
    const panel = panelRef.current
    if (!host || !panel) return
    const surface = chooseAppBrowserSurface(window.handcash)
    const guest = createAppBrowserGuest(
      surface.surface === 'embedded' ? surface.host : 'webview',
      {
        host,
        panel,
        url: entryUrl,
        emit: (event) => {
          switch (event.type) {
            case 'loading':
              send({ type: 'LOADING' })
              return
            case 'progress':
              send({ type: 'PROGRESS', value: event.value })
              return
            case 'loaded':
              send({ type: 'LOADED', history: event.history })
              return
            case 'navigated':
              send({ type: 'NAVIGATED', url: event.url, history: event.history })
              return
            case 'failed':
              send({ type: 'FAILED', description: event.description })
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
  }, [entryUrl, origin, send])

  useEffect(() => {
    guestRef.current?.setSuppressed(failed)
  }, [failed])

  useEffect(() => {
    if (previewRequested) capturePreview()
    // capturePreview reads refs only; re-run on the request alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRequested])

  const openExternal = () => {
    playWalletSound('soft')
    void window.handcash?.openExternal?.(url)
  }

  const location = appBrowserLocation(origin, url)
  const pageHost = appBrowserPageHost(url)

  return (
    <div
      ref={panelRef}
      className="nav-child-panel app-browser-panel"
      data-aeon-scope="app-browser"
      data-aeon-state={stateToAttr(state.value)}
    >
      <header className="app-browser-toolbar">
        <div className="app-browser-navigation">
          <button
            type="button"
            aria-label="Back"
            title="Back"
            disabled={!history.back}
            onClick={() => send({ type: 'BACK' })}
          >
            <BackIcon size={16} />
          </button>
          <button
            type="button"
            className="app-browser-forward"
            aria-label="Forward"
            title="Forward"
            disabled={!history.forward}
            onClick={() => send({ type: 'FORWARD' })}
          >
            <BackIcon size={16} />
          </button>
          {loading ? (
            <button
              type="button"
              aria-label="Stop loading"
              title="Stop loading"
              onClick={() => send({ type: 'STOP' })}
            >
              <CloseIcon size={16} />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Reload"
              title="Reload"
              onClick={() => send({ type: 'RELOAD' })}
            >
              <RefreshIcon size={16} />
            </button>
          )}
        </div>
        <div
          className="app-browser-location"
          data-aeon-part="location"
          data-aeon-state={location}
          title={url}
        >
          <strong>
            {location === 'app' ? (
              <LockIcon size={11} aria-hidden />
            ) : (
              <WarningIcon size={11} aria-hidden />
            )}
            <span>{location === 'elsewhere' ? pageHost : name}</span>
          </strong>
          <span>
            {location === 'elsewhere'
              ? `Not ${name}`
              : location === 'insecure'
                ? `Not secure · ${pageHost}`
                : pageHost}
          </span>
        </div>
        <div className="app-browser-navigation">
          <button
            type="button"
            aria-label="Open in system browser"
            title="Open in system browser"
            onClick={openExternal}
          >
            <LaunchIcon size={16} />
          </button>
          <button
            type="button"
            aria-label={`Close ${name} tab`}
            title="Close tab"
            onClick={() => closeEmbeddedAppBrowser(origin)}
          >
            <CloseIcon size={16} />
          </button>
        </div>
      </header>
      <div className="app-browser-stage">
        <div ref={hostRef} className="app-browser-content" aria-busy={loading} />
        {failed ? (
          <div data-aeon-part="notice" role="alert">
            <strong>{name} could not be opened</strong>
            <span>{failure}</span>
            <div data-aeon-part="notice-actions">
              <Button.Root className="btn btn-primary" onClick={() => send({ type: 'RETRY' })}>
                Try again
              </Button.Root>
              <Button.Root variant="ghost" className="btn btn-ghost" onClick={openExternal}>
                Open in browser
              </Button.Root>
            </div>
          </div>
        ) : null}
        {loading ? (
          <span
            data-aeon-part="progress"
            data-aeon-state={progress == null ? 'indeterminate' : 'determinate'}
            style={progress == null ? undefined : { width: `${Math.max(progress, 8)}%` }}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  )
}
