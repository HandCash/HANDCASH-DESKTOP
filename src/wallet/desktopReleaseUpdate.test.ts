import { describe, expect, it, vi } from 'vitest'
import {
  createReleaseUpdater,
  selectZipRelease,
  zipTargetFor,
  type Release,
} from './desktopReleaseUpdate'

const zip = (v: string, arch: string, os: string) => ({
  name: `HandCash-${v}-${arch}-${os}.zip`,
  browser_download_url: `https://dl/${v}/${arch}-${os}`,
})

const releases: Release[] = [
  { tag_name: 'v1.3.692', assets: [zip('1.3.692', 'arm64', 'mac')] },
  { tag_name: 'v1.3.691', assets: [zip('1.3.691', 'x64', 'linux'), zip('1.3.691', 'x64', 'win')] },
  { tag_name: 'v1.3.693', draft: true, assets: [zip('1.3.693', 'x64', 'linux')] },
  { tag_name: 'v1.3.690', assets: [zip('1.3.690', 'x64', 'linux'), zip('1.3.690', 'arm64', 'linux')] },
]

describe('selectZipRelease', () => {
  it('picks the newest published release carrying this platform zip', () => {
    expect(selectZipRelease(releases, '1.3.689', { os: 'linux', arch: 'x64' })).toEqual({
      version: '1.3.691',
      zipUrl: 'https://dl/1.3.691/x64-linux',
    })
    expect(selectZipRelease(releases, '1.3.689', { os: 'linux', arch: 'arm64' })?.version).toBe(
      '1.3.690',
    )
  })

  it('finds nothing at or above the running version', () => {
    expect(selectZipRelease(releases, '1.3.691', { os: 'win', arch: 'x64' })).toBeNull()
  })
})

describe('zipTargetFor', () => {
  it('maps thin shell platforms only', () => {
    expect(zipTargetFor('linux', 'X11; Linux aarch64')).toEqual({ os: 'linux', arch: 'arm64' })
    expect(zipTargetFor('linux', 'X11; Linux x86_64')).toEqual({ os: 'linux', arch: 'x64' })
    expect(zipTargetFor('win32', 'Windows NT 10.0; Win64; x64')).toEqual({ os: 'win', arch: 'x64' })
    expect(zipTargetFor('darwin', '')).toBeNull()
    expect(zipTargetFor('android', '')).toBeNull()
  })
})

describe('createReleaseUpdater', () => {
  const target = { os: 'linux', arch: 'x64' } as const

  it('reports an available zip and opens it on download', async () => {
    const openUrl = vi.fn(async () => {})
    const u = createReleaseUpdater({
      target,
      currentVersion: '1.3.690',
      fetchReleases: async () => releases,
      openUrl,
    })
    const seen: string[] = []
    u.onUpdateStatus((s) => seen.push(s.phase))
    const status = await u.checkForUpdates()
    expect(status).toMatchObject({ phase: 'available', availableVersion: '1.3.691', canInstall: true })
    expect(seen).toEqual(['checking', 'available'])
    await u.downloadUpdate()
    expect(openUrl).toHaveBeenCalledWith('https://dl/1.3.691/x64-linux')
  })

  it('never stays checking when GitHub hangs', async () => {
    const u = createReleaseUpdater({
      target,
      currentVersion: '1.3.690',
      fetchReleases: () => new Promise(() => {}),
      openUrl: async () => {},
      timeoutMs: 10,
    })
    expect(await u.checkForUpdates()).toMatchObject({ phase: 'error', error: 'Update check timed out' })
  })

  it('says up to date when no newer zip exists', async () => {
    const u = createReleaseUpdater({
      target,
      currentVersion: '1.3.691',
      fetchReleases: async () => releases,
      openUrl: async () => {},
    })
    expect((await u.checkForUpdates()).phase).toBe('not-available')
  })
})
