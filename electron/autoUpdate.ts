/**
 * electron-updater — Cursor/VS Code-style update.mode:
 *   default → auto-check + auto-download, prompt restart
 *   manual  → only when user checks; still download then prompt restart
 *   none    → no update checks
 */
import type { BrowserWindow } from 'electron'
import log from 'electron-log'
import electronUpdater from 'electron-updater'
import { durableGet, durableSet } from './durableStore.js'

const { autoUpdater } = electronUpdater

export type UpdateMode = 'default' | 'manual' | 'none'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'ready'
  | 'error'

export type UpdateStatus = {
  phase: UpdatePhase
  mode: UpdateMode
  currentVersion: string
  availableVersion: string | null
  percent: number | null
  error: string | null
  canInstall: boolean
}

type GetWindow = () => BrowserWindow | null

const PREF_MODE = 'handcash.update.mode'
/** Background poll when mode is default (Cursor checks periodically). */
const AUTO_CHECK_MS = 4 * 60 * 60 * 1000

let status: UpdateStatus = {
  phase: 'idle',
  mode: 'default',
  currentVersion: '0.0.0',
  availableVersion: null,
  percent: null,
  error: null,
  canInstall: false,
}

let getWindow: GetWindow = () => null
let checkTimer: ReturnType<typeof setInterval> | null = null
let isDev = false
let wired = false

function readMode(): UpdateMode {
  const raw = durableGet(PREF_MODE)
  if (raw === 'manual' || raw === 'none' || raw === 'default') return raw
  return 'default'
}

function pushStatus() {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', status)
  }
}

function setStatus(patch: Partial<UpdateStatus>) {
  status = { ...status, ...patch }
  pushStatus()
}

function applyModeToUpdater(mode: UpdateMode) {
  autoUpdater.autoDownload = mode === 'default'
  autoUpdater.autoInstallOnAppQuit = mode !== 'none'
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export function setUpdateMode(mode: UpdateMode): UpdateStatus {
  durableSet(PREF_MODE, mode)
  setStatus({ mode })
  applyModeToUpdater(mode)
  scheduleAutomaticChecks()
  if (mode === 'default' && !isDev) {
    void checkForUpdates({ reason: 'auto' })
  }
  return status
}

function clearTimer() {
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
}

function scheduleAutomaticChecks() {
  clearTimer()
  if (isDev || readMode() !== 'default') return
  checkTimer = setInterval(() => {
    if (readMode() !== 'default') return
    void checkForUpdates({ reason: 'auto' })
  }, AUTO_CHECK_MS)
}

export function initAutoUpdater(opts: {
  getMainWindow: GetWindow
  currentVersion: string
  isDev: boolean
}) {
  getWindow = opts.getMainWindow
  isDev = opts.isDev
  const mode = readMode()
  setStatus({ currentVersion: opts.currentVersion, mode })

  if (!wired) {
    wired = true
    autoUpdater.logger = log
    autoUpdater.allowPrerelease = true
    autoUpdater.allowDowngrade = false
    applyModeToUpdater(mode)

    autoUpdater.on('checking-for-update', () => {
      setStatus({ phase: 'checking', error: null })
    })

    autoUpdater.on('update-available', (info) => {
      setStatus({
        phase: 'available',
        availableVersion: info.version,
        percent: autoUpdater.autoDownload ? 0 : null,
        error: null,
        canInstall: false,
      })
    })

    autoUpdater.on('update-not-available', () => {
      setStatus({
        phase: 'not-available',
        availableVersion: null,
        percent: null,
        canInstall: false,
        error: null,
      })
    })

    autoUpdater.on('download-progress', (progress) => {
      setStatus({
        phase: 'downloading',
        percent: Math.round(progress.percent),
        canInstall: false,
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      setStatus({
        phase: 'ready',
        availableVersion: info.version,
        percent: 100,
        canInstall: true,
        error: null,
      })
    })

    autoUpdater.on('error', (err) => {
      log.warn('autoUpdater error', err)
      setStatus({
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
        canInstall: false,
      })
    })
  }

  if (opts.isDev) {
    log.info('autoUpdater skipped in development')
    return
  }

  scheduleAutomaticChecks()
  if (mode === 'default') {
    void checkForUpdates({ reason: 'auto' })
  }
}

export async function checkForUpdates(opts?: {
  reason?: 'auto' | 'manual'
}): Promise<UpdateStatus> {
  if (isDev) {
    setStatus({
      phase: 'error',
      error: 'Updates are only checked in packaged builds.',
    })
    return status
  }

  const mode = readMode()
  const reason = opts?.reason ?? 'manual'
  if (reason === 'auto' && mode !== 'default') return status
  if (mode === 'none' && reason === 'manual') {
    setStatus({ phase: 'error', error: 'Updates are disabled (mode: none).' })
    return status
  }

  try {
    setStatus({ phase: 'checking', error: null })
    // Manual check always downloads when an update exists (Cursor “Check for Updates”)
    autoUpdater.autoDownload = reason === 'manual' || mode === 'default'
    await autoUpdater.checkForUpdates()
  } catch (err) {
    log.warn('checkForUpdates failed', err)
    setStatus({
      phase: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    applyModeToUpdater(readMode())
  }
  return status
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  try {
    setStatus({ phase: 'downloading', percent: 0, error: null })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    log.warn('downloadUpdate failed', err)
    setStatus({
      phase: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return status
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}
