import { useEffect, useRef } from 'react'
import type { EmbeddedAppBrowser } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { AppAvatar } from './AppAvatar'
import { DeferredImage } from './DeferredImage'
import { BackIcon, CloseIcon } from './icons'

/** Shown until a tab's screenshot decodes, and in place of one that never does. */
function tabFallback(origin: string, name: string) {
  return (
    <span className="app-browser-tab-preview-fallback">
      <AppAvatar origin={origin} name={name} size="md" />
      <span>{name}</span>
    </span>
  )
}

type Props = {
  tabs: readonly EmbeddedAppBrowser[]
  activeOrigin: string | null
  appName: (origin: string) => string
  previews: Readonly<Record<string, string>>
  onSelect: (origin: string) => void
  onClose: (origin: string) => void
  onDone: () => void
}

export function AppBrowserTabSwitcher({
  tabs,
  activeOrigin,
  appName,
  previews,
  onSelect,
  onClose,
  onDone,
}: Props) {
  const carouselRef = useRef<HTMLDivElement>(null)
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.origin === activeOrigin))

  useEffect(() => {
    carouselRef.current
      ?.querySelector<HTMLElement>('[data-active]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [activeOrigin])

  const move = (direction: -1 | 1) => {
    const next = tabs[Math.max(0, Math.min(tabs.length - 1, activeIndex + direction))]
    if (!next || next.origin === activeOrigin) return
    playWalletSound('soft')
    onSelect(next.origin)
  }

  return (
    <section
      className="app-browser-tab-switcher"
      data-aeon-scope="app-browser-tabs"
      data-aeon-state="open"
      aria-label="Open app tabs"
    >
      <header className="app-browser-tab-switcher-head">
        <div>
          <span>Open web pages</span>
          <strong>{tabs.length} {tabs.length === 1 ? 'page' : 'pages'}</strong>
        </div>
        <div className="app-browser-tab-switcher-actions">
          <button
            type="button"
            aria-label="Previous page"
            disabled={activeIndex === 0}
            onClick={() => move(-1)}
          >
            <BackIcon size={18} />
          </button>
          <button
            type="button"
            aria-label="Next page"
            disabled={activeIndex >= tabs.length - 1}
            onClick={() => move(1)}
          >
            <BackIcon size={18} />
          </button>
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            Done
          </button>
        </div>
      </header>

      <div ref={carouselRef} className="app-browser-tab-carousel">
        {tabs.map((tab) => {
          const name = appName(tab.origin)
          const active = tab.origin === activeOrigin
          const preview = previews[tab.origin]
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
                  if (active) onDone()
                }}
              >
                <div className="app-browser-tab-preview" aria-hidden>
                  {preview ? (
                    <DeferredImage
                      src={preview}
                      alt=""
                      retainDecoded
                      fallback={tabFallback(tab.origin, name)}
                    />
                  ) : (
                    tabFallback(tab.origin, name)
                  )}
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
