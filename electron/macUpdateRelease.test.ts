import { describe, expect, it } from 'vitest'
import { compareVersions, selectMacUpdateRelease } from './macUpdateRelease.js'

describe('selectMacUpdateRelease', () => {
  const releases = [
    {
      tag_name: 'v1.2.242',
      prerelease: true,
      assets: [
        {
          name: 'HandCash-1.2.242-arm64-mac.dmg',
          browser_download_url: 'https://example.test/arm64-242.dmg',
        },
        {
          name: 'HandCash-1.2.242-x64-mac.dmg',
          browser_download_url: 'https://example.test/x64-242.dmg',
        },
      ],
    },
    {
      tag_name: 'v1.2.163',
      prerelease: false,
      assets: [
        {
          name: 'HandCash-1.2.163-arm64-mac.dmg',
          browser_download_url: 'https://example.test/arm64-163.dmg',
        },
      ],
    },
  ]

  it('selects the newest release with an architecture-matched DMG', () => {
    expect(selectMacUpdateRelease(releases, '1.2.239', 'arm64')).toEqual({
      version: '1.2.242',
      tag: 'v1.2.242',
      dmgUrl: 'https://example.test/arm64-242.dmg',
    })
  })

  it('does not offer the current or an older release', () => {
    expect(selectMacUpdateRelease(releases, '1.2.242', 'arm64')).toBeNull()
    expect(selectMacUpdateRelease(releases, '1.3.0', 'arm64')).toBeNull()
  })

  it('fails closed when the matching DMG asset is absent', () => {
    expect(selectMacUpdateRelease(releases, '1.2.239', 'x64')?.version).toBe('1.2.242')
    expect(selectMacUpdateRelease(releases.slice(1), '1.2.100', 'x64')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('compares numeric semver components', () => {
    expect(compareVersions('1.2.242', '1.2.99')).toBeGreaterThan(0)
    expect(compareVersions('v2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.2.242', '1.2.242')).toBe(0)
  })
})
