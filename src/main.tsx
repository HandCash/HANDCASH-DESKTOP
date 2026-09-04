import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'aeon-ui-engine/aeon.css'
import '@aeon-ui/panda/electron.css'
import './styles/handcash.css'
import './styles/layout-compact.css'
import './wallet/browserPolyfills'
import { App } from './App'
import { appendAppLog, installAppLogCapture } from './wallet/appLog'
import { startHandCashTheme } from './wallet/handcashTheme'
import { startLayoutViewport } from './wallet/layoutViewport'
import { shipPreviousSessionLogs, startAutoLogShip } from './wallet/logShip'
import { reconcileBackupWatchdog } from './wallet/backupWatchdog'

// Brand palette from Settings appearance (system / light / dark). Must run before
// first paint so --hc-* / Aeon vars match the sheet.
startHandCashTheme()

// Portrait / narrow tiles (Omarchy, etc.) use the phone shell CSS without
// faking android/ios — keep this before first paint to avoid a layout flash.
startLayoutViewport()

installAppLogCapture()

// Before anything can schedule another one: if the last BRC-39 backup never
// returned, it took the app down with it. Record that as a failure so the
// retry is delayed rather than repeated on every launch.
const backupCrash = reconcileBackupWatchdog()
if (backupCrash) appendAppLog('warn', `[cloud-backup] ${backupCrash}`)

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
