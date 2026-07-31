/**
 * electron-updater — Cursor/VS Code-style update.mode:
 *   default → auto-check + auto-download, prompt restart
 *   manual  → only when user checks; still download then prompt restart
 *   none    → no update checks
 */
import { shell, type BrowserWindow } from 'electron'
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
/** Never leave Settings on “Checking…” forever (missing channel yml / hung HTTP). */
const CHECK_TIMEOUT_MS = 25_000

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
let checkInFlight: Promise<UpdateStatus> | null = null

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

/**
 * BETA Mac builds are ad-hoc signed (`identity: null`). Squirrel.Mac / ShipIt
 * cannot validate those updates and often leaves HandCash.app damaged
 * ("code has no resources…"). Until Developer ID + notarization exist, never
 * let ShipIt replace the app — open the arch-matched DMG instead.
 */
function macShipItUnsafe(): boolean {
  return process.platform === 'darwin'
}

const MAC_DMG_HINT =
  'Installer opened — drag HandCash into Applications to finish updating.'

/** Published GitHub DMG for this Mac arch (ShipIt-safe path). */
export function macDmgDownloadUrl(version: string): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const tag = version.startsWith('v') ? version : `v${version}`
  const semver = version.replace(/^v/, '')
  return `https://github.com/HandCash/HANDCASH-DESKTOP/releases/download/${tag}/HandCash-${semver}-${arch}-mac.dmg`
}

async function openMacDmgInstaller(version: string): Promise<void> {
  const url = macDmgDownloadUrl(version)
  log.info('Opening Mac DMG installer (ShipIt skipped)', { version, url })
  await shell.openExternal(url)
}

function applyModeToUpdater(mode: UpdateMode) {
  const allowShipIt = !macShipItUnsafe()
  autoUpdater.autoDownload = allowShipIt && mode === 'default'
  autoUpdater.autoInstallOnAppQuit = allowShipIt && mode !== 'none'
}

function isMacCodeSignatureFailure(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err)
  return (
    /code signature/i.test(raw) ||
    /did not pass validation/i.test(raw) ||
    /ShipIt/i.test(raw) ||
    /signature indicates they must be present/i.test(raw)
  )
}

/** electron-updater dumps HttpError + headers; keep Settings readable. */
function friendlyUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const firstLine = raw.split('\n')[0] ?? raw

  if (isMacCodeSignatureFailure(err)) {
    return MAC_DMG_HINT
  }
  if (/timed out|timeout/i.test(raw)) {
    return 'Update check timed out. Check your network and try again.'
  }
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
  return (
    /Cannot find latest-(linux|mac|windows)?\.?yml/i.test(raw) ||
    (/404/.test(raw) && /latest-.*\.yml/i.test(raw)) ||
    /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(raw)
  )
}

function applyCheckFailure(err: unknown) {
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
  if (isMacCodeSignatureFailure(err)) {
    // Keep availableVersion so Settings can still show “download site” context,
    // but never offer Restart/Install for unsigned BETA packages.
    setStatus({
      phase: 'error',
      error: friendlyUpdateError(err),
      canInstall: false,
      percent: null,
    })
    return
  }
  setStatus({
    phase: 'error',
    error: friendlyUpdateError(err),
    canInstall: false,
  })
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
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
      applyCheckFailure(err)
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

  if (checkInFlight) return checkInFlight

  checkInFlight = (async () => {
    const shouldDownload = reason === 'manual' || mode === 'default'
    try {
      setStatus({ phase: 'checking', error: null })
      // Always discover first without auto-download so a missing Linux channel
      // (or hung download) cannot pin Settings on “Checking…”.
      autoUpdater.autoDownload = false
      const result = await withTimeout(
        autoUpdater.checkForUpdates(),
        CHECK_TIMEOUT_MS,
        'Update check',
      )

      if (!result?.isUpdateAvailable) {
        if (status.phase === 'checking') {
          setStatus({
            phase: 'not-available',
            availableVersion: null,
            percent: null,
            canInstall: false,
            error: null,
          })
        }
        return status
      }

      if (macShipItUnsafe()) {
        // Never let ShipIt touch /Applications/HandCash.app — open the DMG.
        const version = result.updateInfo.version
        setStatus({
          phase: 'available',
          availableVersion: version,
          percent: null,
          error: null,
          canInstall: true,
        })
        if (shouldDownload) {
          try {
            await openMacDmgInstaller(version)
            setStatus({
              phase: 'available',
              availableVersion: version,
              percent: null,
              error: MAC_DMG_HINT,
              canInstall: true,
            })
          } catch (err) {
            log.warn('openMacDmgInstaller failed', err)
            setStatus({
              phase: 'error',
              availableVersion: version,
              error: err instanceof Error ? err.message : String(err),
              canInstall: true,
            })
          }
        }
      } else if (shouldDownload) {
        setStatus({
          phase: 'downloading',
          availableVersion: result.updateInfo.version,
          percent: 0,
          error: null,
          canInstall: false,
        })
        await withTimeout(autoUpdater.downloadUpdate(), CHECK_TIMEOUT_MS * 4, 'Update download')
      } else if (status.phase === 'checking') {
        setStatus({
          phase: 'available',
          availableVersion: result.updateInfo.version,
          percent: null,
          error: null,
          canInstall: false,
        })
      }
    } catch (err) {
      log.warn('checkForUpdates failed', err)
      applyCheckFailure(err)
    } finally {
      applyModeToUpdater(readMode())
      checkInFlight = null
    }
    return status
  })()

  return checkInFlight
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (macShipItUnsafe()) {
    const version = status.availableVersion
    if (!version) {
      setStatus({
        phase: 'error',
        error: 'No update version to download yet. Check for updates first.',
        canInstall: false,
        percent: null,
      })
      return status
    }
    try {
      setStatus({ phase: 'downloading', percent: null, error: null, canInstall: true })
      await openMacDmgInstaller(version)
      setStatus({
        phase: 'available',
        availableVersion: version,
        percent: null,
        error: MAC_DMG_HINT,
        canInstall: true,
      })
    } catch (err) {
      log.warn('Mac DMG open failed', err)
      applyCheckFailure(err)
    }
    return status
  }
  try {
    setStatus({ phase: 'downloading', percent: 0, error: null })
    await withTimeout(autoUpdater.downloadUpdate(), CHECK_TIMEOUT_MS * 4, 'Update download')
  } catch (err) {
    log.warn('downloadUpdate failed', err)
    applyCheckFailure(err)
  }
  return status
}

export function quitAndInstall(): void {
  if (macShipItUnsafe()) {
    const version = status.availableVersion
    log.warn('quitAndInstall blocked on unsigned Mac — opening DMG instead', { version })
    if (version) {
      void openMacDmgInstaller(version).then(() => {
        setStatus({
          phase: 'available',
          availableVersion: version,
          error: MAC_DMG_HINT,
          canInstall: true,
        })
      })
      return
    }
    setStatus({
      phase: 'available',
      error: 'Check for updates, then use Get update to open the installer.',
      canInstall: false,
    })
    return
  }
  autoUpdater.quitAndInstall(false, true)
}
