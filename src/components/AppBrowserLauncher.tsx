import type { FormEvent } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { appBrowserMachine, type AppBrowserOpener } from '../machines/appBrowserMachine'
import { chooseAppBrowserSurface } from '../wallet/appBrowserSurface'
import { openEmbeddedAppBrowser } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'

const openTab: AppBrowserOpener = async (url) => {
  openEmbeddedAppBrowser(new URL(url).origin, url)
  return { ok: true }
}

/**
 * Type-an-address entry for the in-app browser: the phone's native guest and
 * Desktop's `<webview>` tabs alike. Without a wallet-hosted surface there is
 * nothing to open into, so it renders nothing.
 */
export function AppBrowserLauncher() {
  const surface = chooseAppBrowserSurface(window.handcash)
  if (surface.surface !== 'embedded') return null
  return <Launcher />
}

function Launcher() {
  const [state, send] = useMachine(appBrowserMachine, { input: { open: openTab } })
  const { input, error } = state.context
  const busy = state.matches('opening')

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    playWalletSound('soft')
    send({ type: 'OPEN' })
  }

  return (
    <form
      className="root-search friends-search app-browser-launcher"
      role="search"
      noValidate
      data-aeon-scope="app-browser"
      data-aeon-state={stateToAttr(state.value)}
      onSubmit={onSubmit}
    >
      <label className="sr-only" htmlFor="app-browser-url">
        Open a web app by URL
      </label>
      <input
        id="app-browser-url"
        type="url"
        value={input}
        onChange={(e) => send({ type: 'TYPE', value: e.target.value })}
        placeholder="Enter a URL"
        inputMode="url"
        enterKeyHint="go"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        disabled={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'app-browser-url-error' : undefined}
      />
      {error ? (
        <p id="app-browser-url-error" className="error" role="status" data-aeon-part="error">
          {error}
        </p>
      ) : null}
    </form>
  )
}
