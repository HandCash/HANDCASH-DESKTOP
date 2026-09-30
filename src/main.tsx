import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'aeon-ui-engine/aeon.css'
import '@aeon-ui/panda/electron.css'
import './styles/handcash.css'
import './styles/layout-compact.css'
import './wallet/browserPolyfills'
import { App } from './App'
import { installAppLogCapture } from './wallet/appLog'
import { startHandCashTheme } from './wallet/handcashTheme'
import { startLayoutViewport } from './wallet/layoutViewport'
import { shipPreviousSessionLogs, startAutoLogShip } from './wallet/logShip'
// Brand palette from Settings appearance (system / light / dark). Must run before
// first paint so --hc-* / Aeon vars match the sheet.
startHandCashTheme()

// Portrait / narrow tiles (Omarchy, etc.) use the phone shell CSS without
// faking android/ios — keep this before first paint to avoid a layout flash.
startLayoutViewport()

installAppLogCapture()

// A crash log is only useful if it leaves the device on its own.
void shipPreviousSessionLogs().finally(() => {
  startAutoLogShip()
})

const platform = window.handcash?.platform
if (platform === 'darwin') {
  document.documentElement.classList.add('platform-darwin')
  document.documentElement.dataset.aeonPlatform = 'darwin'
} else if (platform) {
  document.documentElement.dataset.aeonPlatform = platform
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
