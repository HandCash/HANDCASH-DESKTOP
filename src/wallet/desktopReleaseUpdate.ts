/**
 * Linux / Windows thin shell updates: newest published GitHub release with this
 * platform's zip, opened in the system browser. The shell has no updater of its
 * own; Mac (MacUpdate.swift) and Mobile (mobileUpdate.ts) bring theirs.
 */
import { errorText } from './errorText'
import type { UpdateMode, UpdateStatus } from '../machines/updateMachine'
import { APP_VERSION } from '../version'
import { durableGetItem, durableSetItem } from './durableStorage'

export type ReleaseAsset = { name?: string; browser_download_url?: string }
export type Release = {
  tag_name?: string
  draft?: boolean
  assets?: ReleaseAsset[]
}
export type ZipTarget = { os: 'linux' | 'win'; arch: 'x64' | 'arm64' }
export type PendingZip = { version: string; zipUrl: string }

const MODE_KEY = 'handcash.update.mode'
const RELEASES = 'https://api.github.com/repos/HandCash/HANDCASH-DESKTOP/releases?per_page=20'
const AUTO_CHECK_MS = 4 * 60 * 60 * 1000
const FIRST_CHECK_MS = 4_000
const CHECK_TIMEOUT_MS = 25_000
const ZIP_HINT = 'Download opened — unzip it over this install, then reopen HandCash.'

function semver(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: string, b: string): number {
  const l = semver(a)
  const r = semver(b)
  if (!l || !r) return 0
  for (let i = 0; i < 3; i += 1) {
    const d = l[i]! - r[i]!
    if (d !== 0) return d
  }
  return 0
}

/** Thin shell zips are `HandCash-<v>-<arch>-<os>.zip` (scripts/package-native-desktop.mjs). */
export function selectZipRelease(
  releases: Release[],
  currentVersion: string,
  target: ZipTarget,
): PendingZip | null {
  let best: PendingZip | null = null
  for (const release of releases) {
    if (release.draft) continue
    const version = String(release.tag_name ?? '').trim().replace(/^v/, '')
    if (!semver(version) || compareVersions(version, currentVersion) <= 0) continue
    const name = `HandCash-${version}-${target.arch}-${target.os}.zip`
    const url = release.assets?.find((a) => a.name === name)?.browser_download_url
    if (!url) continue
    if (!best || compareVersions(version, best.version) > 0) best = { version, zipUrl: url }
  }
  return best
}

export function zipTargetFor(platform: string | undefined, userAgent: string): ZipTarget | null {
  if (platform === 'linux') {
    return { os: 'linux', arch: /aarch64|arm64/i.test(userAgent) ? 'arm64' : 'x64' }
  }
  if (platform === 'win32') return { os: 'win', arch: 'x64' }
  return null
}

function readMode(): UpdateMode {
  const raw = durableGetItem(MODE_KEY)
  return raw === 'manual' || raw === 'none' ? raw : 'default'
}

export type ReleaseUpdater = {
  getUpdateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<UpdateStatus>
  downloadUpdate: () => Promise<UpdateStatus>
  setUpdateMode: (mode: UpdateMode) => Promise<UpdateStatus>
  installUpdate: () => Promise<void>
  onUpdateStatus: (handler: (status: UpdateStatus) => void) => () => void
}

export function createReleaseUpdater(deps: {
  target: ZipTarget
  currentVersion?: string
  fetchReleases?: () => Promise<Release[]>
  openUrl: (url: string) => Promise<unknown>
  timeoutMs?: number
}): ReleaseUpdater {
  const fetchReleases =
    deps.fetchReleases ??
    (async () => {
      const res = await fetch(RELEASES, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`GitHub release check failed (${res.status})`)
      return (await res.json()) as Release[]
    })
  const listeners = new Set<(status: UpdateStatus) => void>()
  let pending: PendingZip | null = null
  let inFlight: Promise<UpdateStatus> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let status: UpdateStatus = {
    phase: 'idle',
    mode: readMode(),
    currentVersion: deps.currentVersion ?? APP_VERSION,
    availableVersion: null,
    percent: null,
    error: null,
    canInstall: false,
  }

  const set = (patch: Partial<UpdateStatus>): UpdateStatus => {
    status = { ...status, ...patch }
    for (const listener of listeners) listener({ ...status })
    return { ...status }
  }

  const check = (reason: 'auto' | 'manual'): Promise<UpdateStatus> => {
    const mode = readMode()
    status.mode = mode
    if (reason === 'auto' && mode !== 'default') return Promise.resolve({ ...status })
    if (mode === 'none') {
      return Promise.resolve(
        set({ phase: 'error', error: 'Updates are off.', canInstall: false, availableVersion: null }),
      )
    }
    if (inFlight) return inFlight
    inFlight = (async () => {
      set({ phase: 'checking', error: null })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const releases = await Promise.race([
          fetchReleases(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Update check timed out')),
              deps.timeoutMs ?? CHECK_TIMEOUT_MS,
            )
          }),
        ])
        pending = selectZipRelease(releases, status.currentVersion, deps.target)
        return pending
          ? set({ phase: 'available', availableVersion: pending.version, canInstall: true, error: null })
          : set({ phase: 'not-available', availableVersion: null, canInstall: false, error: null })
      } catch (err) {
        return reason === 'auto'
          ? set({ phase: 'idle', error: null })
          : set({
              phase: 'error',
              canInstall: false,
              error: errorText(err),
            })
      } finally {
        clearTimeout(timeout)
        inFlight = null
      }
    })()
    return inFlight
  }

  const schedule = () => {
    if (timer) clearInterval(timer)
    timer = null
    if (readMode() !== 'default') return
    timer = setInterval(() => void check('auto'), AUTO_CHECK_MS)
  }

  const download = async (): Promise<UpdateStatus> => {
    if (!pending) {
      return set({ phase: 'error', error: 'Check for updates first.', canInstall: false })
    }
    try {
      await deps.openUrl(pending.zipUrl)
      return set({ phase: 'available', availableVersion: pending.version, canInstall: true, error: ZIP_HINT })
    } catch (err) {
      return set({ phase: 'error', error: errorText(err) })
    }
  }

  return {
    getUpdateStatus: async () => ({ ...status }),
    checkForUpdates: () => check('manual'),
    downloadUpdate: download,
    installUpdate: async () => {
      await download()
    },
    setUpdateMode: async (mode) => {
      durableSetItem(MODE_KEY, mode)
      schedule()
      return set({ mode })
    },
    onUpdateStatus: (handler) => {
      if (listeners.size === 0) {
        schedule()
        setTimeout(() => void check('auto'), FIRST_CHECK_MS)
      }
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
}

let shared: ReleaseUpdater | null | undefined

/** Updater for a shell that brings none (Linux / Windows thin shell); null elsewhere. */
export function thinShellReleaseUpdater(): ReleaseUpdater | null {
  if (shared !== undefined) return shared
  const api = window.handcash
  const target = zipTargetFor(api?.platform, navigator.userAgent)
  shared =
    target && api && !api.checkForUpdates && api.openExternal
      ? createReleaseUpdater({ target, openUrl: (url) => api.openExternal!(url) })
      : null
  return shared
}
