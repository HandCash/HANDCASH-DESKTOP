import type { FormEvent } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { appBrowserMachine, type AppBrowserOpener } from '../machines/appBrowserMachine'
import { chooseAppBrowserSurface } from '../wallet/appBrowserSurface'
import { openEmbeddedAppBrowser } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { useLab } from '../hooks/useLab'

const openTab: AppBrowserOpener = async (url) => {
  openEmbeddedAppBrowser(new URL(url).origin, url)
  return { ok: true }
}

/**
 * Type-an-address entry for the phone's in-app browser. Desktop reaches its
 * tabs from connected apps and the address bar of the system browser, so this
 * renders only where the native guest hosts tabs.
 */
export function AppBrowserLauncher() {
  const inAppBrowser = useLab('inAppBrowser')
  const surface = chooseAppBrowserSurface(window.handcash, inAppBrowser)
  if (surface.surface !== 'embedded' || surface.host !== 'native') return null
  return <Launcher />
}

function Launcher() {
  const [state, send] = useMachine(appBrowserMachine, { input: { open: openTab } })
  const { input, error, host } = state.context
  const busy = state.matches('opening')

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    playWalletSound('soft')
    send({ type: 'OPEN' })
  }

  return (
    <form
      className="app-browser-launcher"
      data-aeon-scope="app-browser"
      data-aeon-state={stateToAttr(state.value)}
      onSubmit={onSubmit}
    >
      <div className="field">
        <label htmlFor="app-browser-url">Open a web app</label>
        <input
          id="app-browser-url"
          className="mono"
          value={input}
          onChange={(e) => send({ type: 'TYPE', value: e.target.value })}
          placeholder="lilpoker.com"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
        />
      </div>
      {error ? (
        <p className="error" role="status">
          {error}
        </p>
      ) : (
        <p className="settings-row-desc" data-aeon-part="hint">
          {state.matches('handedOff') && host
            ? `${host} is open in a tab. Payment requests come back here for approval.`
            : 'Opens in a tab inside HandCash. Apps still ask here before anything moves.'}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>
          {busy ? 'Opening…' : 'Open'}
        </button>
      </div>
    </form>
  )
}
