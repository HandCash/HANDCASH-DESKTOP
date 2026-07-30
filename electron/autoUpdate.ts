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

/** electron-updater dumps HttpError + headers; keep Settings readable. */
function friendlyUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const firstLine = raw.split('\n')[0] ?? raw

  if (/latest-linux\.yml/i.test(raw)) {
    return 'No Linux update package on GitHub yet (need AppImage + latest-linux.yml).'
  }
  if (/latest-mac\.yml/i.test(raw)) {
    return 'No Mac update package on GitHub yet (need latest-mac.yml).'
  }
  if (/latest-windows\.yml|latest\.yml/i.test(raw) && /win/i.test(process.platform)) {
    return 'No Windows update package on GitHub yet.'
  }
  if (/404/.test(raw) && /latest-.*\.yml/i.test(raw)) {
    return 'Update metadata missing from the GitHub release for this platform.'
  }
  if (/APPIMAGE env is not defined/i.test(raw)) {
    return 'Linux auto-update needs the AppImage build (not the unpacked dir).'
  }

  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
}

/** Missing platform artifacts should not look like a hard failure. */
function isMissingPlatformArtifact(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err)
  return /Cannot find latest-(linux|mac|windows)?\.?yml/i.test(raw) ||
    (/404/.test(raw) && /latest-.*\.yml/i.test(raw))
}

/**
 * Local `electron-builder --mac dir` (esp. arm64) often omits app-update.yml.
 * Pin the GitHub feed explicitly so Check for Updates works without that file.
 */
function configureUpdateFeed() {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'HandCash',
    repo: 'HANDCASH-DESKTOP',
    releaseType: 'prerelease',
  })
  autoUpdater.allowPrerelease = true
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
    configureUpdateFeed()
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
      if (isMissingPlatformArtifact(err)) {
        setStatus({
          phase: 'not-available',
          availableVersion: null,
          percent: null,
          canInstall: false,
          error: friendlyUpdateError(err),
        })
        return
      }
      setStatus({
        phase: 'error',
        error: friendlyUpdateError(err),
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
    if (isMissingPlatformArtifact(err)) {
      setStatus({
        phase: 'not-available',
        availableVersion: null,
        percent: null,
        canInstall: false,
        error: friendlyUpdateError(err),
      })
    } else {
      setStatus({
        phase: 'error',
        error: friendlyUpdateError(err),
      })
    }
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
      error: friendlyUpdateError(err),
    })
  }
  return status
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}
