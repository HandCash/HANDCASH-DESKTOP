/**
 * Render harness entry: `?fixture=<name>&mode=dark|light`. Same CSS, polyfills,
 * brand palette and compact-layout switch as `src/main.tsx`, then one fixture
 * inside the dashboard / WalletNav wrapper. Sets `data-render-ready` (or
 * `data-render-error`) on <html> for `scripts/render-states.mjs`.
 */
import { createRoot } from 'react-dom/client'
import 'aeon-ui-engine/aeon.css'
import '@aeon-ui/panda/electron.css'
import '../../src/styles/handcash.css'
import '../../src/styles/layout-compact.css'
import '../../src/wallet/browserPolyfills'
import { applyBrandPalette } from '@aeon-ui/core'
import { paletteForMode } from '../../src/wallet/handcashTheme'
import { startLayoutViewport } from '../../src/wallet/layoutViewport'
import { FIXTURES } from './fixtures'
import { installMockState } from './mockState'

const root = document.documentElement
const params = new URLSearchParams(location.search)
const name = params.get('fixture') ?? ''
const mode = params.get('mode') === 'light' ? 'light' : 'dark'

function fail(message: string) {
  root.dataset.renderError = message
  console.error(`[render] ${message}`)
}

window.addEventListener('error', (event) => fail(event.message))
window.addEventListener('unhandledrejection', (event) => fail(String(event.reason)))

const fixture = FIXTURES[name]
if (!fixture) {
  fail(`unknown fixture "${name}"; known: ${Object.keys(FIXTURES).join(', ')}`)
} else {
  applyBrandPalette(paletteForMode(mode), { mode, themeId: 'handcash' })
  startLayoutViewport()
  installMockState(fixture.state)
  const compact = root.classList.contains('layout-compact')
  createRoot(document.getElementById('root')!).render(
    <div className="app-shell" data-aeon-scope="app" data-aeon-state="ready">
      <section className="dashboard" data-aeon-scope="dashboard" data-aeon-state="ready">
        <div className="dashboard-main">
          <div className="panel wallet-hero" data-aeon-scope="wallet-hero" data-aeon-shell={compact ? 'compact' : 'wide'} />
          <section className="wallet-nav-shell panel" data-aeon-scope="wallet-nav" data-aeon-state="ready">
            <div className="wallet-nav">
              <div className="wallet-nav-stage">
                <div className="wallet-nav-panel">
                  <div className="wallet-nav-slot">{fixture.render()}</div>
                </div>
              </div>
            </div>
          </section>
        </div>
        {compact ? null : <aside className="dashboard-side" aria-hidden />}
      </section>
    </div>,
  )
  const started = performance.now()
  const poll = () => {
    if (root.dataset.renderError) return
    if (fixture.waitFor.every((selector) => document.querySelector(selector))) {
      requestAnimationFrame(() => requestAnimationFrame(() => (root.dataset.renderReady = '1')))
    } else if (performance.now() - started > 10_000) {
      fail(`timed out waiting for ${fixture.waitFor.join(', ')}`)
    } else {
      setTimeout(poll, 50)
    }
  }
  poll()
}
