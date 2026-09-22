import type { EmbeddedAppBrowser } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { AppAvatar } from './AppAvatar'
import { CloseIcon } from './icons'

type Props = {
  tabs: readonly EmbeddedAppBrowser[]
  activeOrigin: string | null
  appName: (origin: string) => string
  onSelect: (origin: string) => void
  onClose: (origin: string) => void
  onDone: () => void
}

export function AppBrowserTabSwitcher({
  tabs,
  activeOrigin,
  appName,
  onSelect,
  onClose,
  onDone,
}: Props) {
  return (
    <section
      className="app-browser-tab-switcher"
      data-aeon-scope="app-browser-tabs"
      data-aeon-state="open"
      aria-label="Open app tabs"
    >
      <header className="app-browser-tab-switcher-head">
        <div>
          <span>Open apps</span>
          <strong>{tabs.length} tabs</strong>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Done
        </button>
      </header>

      <div className="app-browser-tab-grid">
        {tabs.map((tab) => {
          const name = appName(tab.origin)
          const active = tab.origin === activeOrigin
          return (
            <article
              key={tab.origin}
              className="app-browser-tab-card"
              data-active={active ? '' : undefined}
            >
              <button
                type="button"
                className="app-browser-tab-card-main"
                aria-label={`Open ${name}`}
                onClick={() => {
                  playWalletSound('soft')
                  onSelect(tab.origin)
                }}
              >
                <div className="app-browser-tab-preview" aria-hidden>
                  <AppAvatar origin={tab.origin} name={name} size="md" />
                  <span>{name}</span>
                </div>
                <span className="app-browser-tab-copy">
                  <strong>{name}</strong>
                  <small>{tab.url}</small>
                </span>
              </button>
              <button
                type="button"
                className="app-browser-tab-close"
                aria-label={`Close ${name} tab`}
                onClick={() => {
                  playWalletSound('soft')
                  onClose(tab.origin)
                }}
              >
                <CloseIcon size={16} />
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}
