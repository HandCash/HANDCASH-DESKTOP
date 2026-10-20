import { useEffect, type FormEvent } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { appBrowserMachine, type AppBrowserOpener } from '../machines/appBrowserMachine'
import { appHomepage } from '../wallet/appIdentity'
import { chooseAppBrowserSurface } from '../wallet/appBrowserSurface'
import { decideAppBrowserTarget } from '../wallet/appBrowserUrl'
import { openAppDetails, openEmbeddedAppBrowser } from '../wallet/navStore'
import { launchConnectedApp } from '../wallet/openAppInWalletBrowser'
import type { ConnectedApp } from '../wallet/permissions'
import { playWalletSound } from '../wallet/soundService'
import { LaunchIcon } from './icons'
import { SettingsNavRow } from './settings'
import { SearchField } from './SearchField'

const openTab: AppBrowserOpener = async (url) => {
  openEmbeddedAppBrowser(new URL(url).origin, url)
  return { ok: true }
}

/** Phones and compact windows open apps from Scan and deep links instead. */
export function canOpenAppAddresses(compact: boolean): boolean {
  return !compact && chooseAppBrowserSurface(window.handcash).surface === 'embedded'
}

/** Host the bar would open on Enter, or null when the text is a search. */
export function appsSearchAddress(query: string, canOpen: boolean): string | null {
  if (!canOpen) return null
  const target = decideAppBrowserTarget(query)
  return target.kind === 'open' ? target.host : null
}

type Props = {
  query: string
  onQueryChange: (next: string) => void
  /** Opened on Enter when the text is not an address. */
  topMatch: ConnectedApp | null
  canOpen: boolean
}

/**
 * The one field on Apps: typing filters connected apps, and a web address
 * opens in the wallet's own browser where there is one.
 */
export function AppsSearchBar({ query, onQueryChange, topMatch, canOpen }: Props) {
  const [state, send] = useMachine(appBrowserMachine, { input: { open: openTab } })
  const busy = state.matches('opening')
  const error = state.context.error
  const address = appsSearchAddress(query, canOpen)

  useEffect(() => {
    if (!state.matches('handedOff')) return
    onQueryChange('')
    send({ type: 'TYPE', value: '' })
  }, [state, onQueryChange, send])

  const openAddress = () => {
    playWalletSound('soft')
    send({ type: 'OPEN' })
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (address) return openAddress()
    if (topMatch) {
      playWalletSound('soft')
      const home = appHomepage(topMatch.origin)
      if (home) launchConnectedApp(topMatch.origin, home)
      else openAppDetails(topMatch)
      return
    }
    if (canOpen && query.trim()) send({ type: 'OPEN' })
  }

  return (
    <form
      className="root-search friends-search apps-search"
      role="search"
      noValidate
      data-aeon-scope="app-browser"
      data-aeon-state={stateToAttr(state.value)}
      onSubmit={onSubmit}
    >
      <SearchField
        id="apps-search-input"
        label={canOpen ? 'Search apps or open a web address' : 'Search connected apps'}
        value={query}
        onValueChange={(value) => {
          onQueryChange(value)
          if (canOpen) send({ type: 'TYPE', value })
        }}
        placeholder={canOpen ? 'App or web address' : 'App name'}
        enterKeyHint={address ? 'go' : 'search'}
        autoCapitalize="none"
        disabled={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'apps-search-error' : undefined}
      />
      {address ? (
        <ul className="settings-list apps-search-open">
          <SettingsNavRow
            label={`Open ${address}`}
            description="In the wallet browser"
            icon={<LaunchIcon size={20} />}
            onClick={() => send({ type: 'OPEN' })}
          />
        </ul>
      ) : null}
      {error ? (
        <p id="apps-search-error" className="error" role="status" data-aeon-part="error">
          {error}
        </p>
      ) : null}
    </form>
  )
}
