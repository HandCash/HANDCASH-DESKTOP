import { useMemo, type FormEvent } from 'react'
import { useMachine } from '@xstate/react'
import { appBrowserMachine, type AppBrowserOpener } from '../machines/appBrowserMachine'
import { playWalletSound } from '../wallet/soundService'

/**
 * Entry point for BRC-100 apps on a phone.
 *
 * Chrome cannot reach the wallet's bridge on loopback, so a web app opened from
 * here runs in the wallet's own in-app browser. Desktop has no such limit, so
 * this renders nothing when the shell exposes no in-app browser.
 */
export function AppBrowserLauncher() {
  const opener = useMemo<AppBrowserOpener | null>(() => {
    const open = window.handcash?.openAppBrowser
    return open ? (url: string) => open(url) : null
  }, [])

  if (!opener) return null
  return <Launcher open={opener} />
}

function Launcher({ open }: { open: AppBrowserOpener }) {
  const [state, send] = useMachine(appBrowserMachine, { input: { open } })
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
      data-aeon-state={String(state.value)}
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
            ? `${host} is open in the wallet browser. Payment requests come back here for approval.`
            : 'Apps only reach your wallet from inside the wallet browser.'}
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
