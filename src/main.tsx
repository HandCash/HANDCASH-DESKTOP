import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyBrandPalette } from '@aeon-ui/core'
import 'aeon-ui-engine/aeon.css'
import '@aeon-ui/panda/electron.css'
import './styles/handcash.css'
import { App } from './App'
import { appendAppLog, installAppLogCapture } from './wallet/appLog'
import { shipPreviousSessionLogs } from './wallet/logShip'
import { reconcileBackupWatchdog } from './wallet/backupWatchdog'

// Map HandCash brand tokens onto Aeon CSS vars (no parallel token sheet for Aeon).
applyBrandPalette(
  {
    bg: '#000000',
    surface: '#0a0a0a',
    surfaceRaised: '#141414',
    border: '#262626',
    text: '#fafafa',
    muted: '#a1a1aa',
    accent: '#57ff97',
    accentDim: 'rgba(87, 255, 151, 0.14)',
    danger: '#f87171',
    font: "'Archivo', ui-sans-serif, system-ui, sans-serif",
    fontDisplay: "'Syncopate', 'Archivo', ui-sans-serif, sans-serif",
    radius: '0.5rem',
  },
  { mode: 'dark', themeId: 'handcash' },
)

installAppLogCapture()

// Before anything can schedule another one: if the last BRC-39 backup never
// returned, it took the app down with it. Record that as a failure so the
// retry is delayed rather than repeated on every launch.
const backupCrash = reconcileBackupWatchdog()
if (backupCrash) appendAppLog('warn', `[cloud-backup] ${backupCrash}`)

// A crash log is only useful if it leaves the device on its own.
void shipPreviousSessionLogs()

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
