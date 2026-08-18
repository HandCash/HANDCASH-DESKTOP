export type GitHubReleaseAsset = {
  name?: string
  browser_download_url?: string
}

export type GitHubRelease = {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GitHubReleaseAsset[]
}

export type MacUpdateRelease = {
  version: string
  tag: string
  dmgUrl: string
}

function semverParts(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a: string, b: string): number {
  const left = semverParts(a)
  const right = semverParts(b)
  if (!left || !right) return 0
  for (let i = 0; i < left.length; i += 1) {
    const diff = left[i]! - right[i]!
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Pick the newest published release that has a DMG for this Mac architecture.
 *
 * Mac BETA builds are ad-hoc signed, so HandCash opens the DMG instead of using
 * electron-updater / ShipIt. Selecting from immutable versioned assets also
 * avoids stale latest-mac.yml and cached ZIP checksum mismatches.
 */
export function selectMacUpdateRelease(
  releases: GitHubRelease[],
  currentVersion: string,
  arch: 'arm64' | 'x64',
): MacUpdateRelease | null {
  const candidates: MacUpdateRelease[] = []
  for (const release of releases) {
    if (release.draft) continue
    const tag = String(release.tag_name ?? '').trim()
    const version = tag.replace(/^v/, '')
    if (!semverParts(version) || compareVersions(version, currentVersion) <= 0) continue
    const expectedName = `HandCash-${version}-${arch}-mac.dmg`
    const asset = release.assets?.find(
      (entry) => entry.name === expectedName && entry.browser_download_url,
    )
    if (!asset?.browser_download_url) continue
    candidates.push({ version, tag: tag || `v${version}`, dmgUrl: asset.browser_download_url })
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version))
  return candidates[0] ?? null
}
