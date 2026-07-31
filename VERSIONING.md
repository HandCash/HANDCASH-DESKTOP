# Versioning (HandCash Desktop)

Semver while **BETA**: `MAJOR.MINOR.PATCH` in root `package.json`.

| Bump | When |
|------|------|
| **patch** (`1.1.0` → `1.1.1`) | Fixes, updater/packaging, copy |
| **minor** (`1.1.0` → `1.2.0`) | New features (collectables, settings, Aeon shell, …) |
| **major** (`1.x` → `2.0.0`) | Breaking wallet/migrate/data changes |

`electron-builder` and `electron-updater` both read **`package.json` `version`**. Artifact names are `HandCash-${version}-…`.

## Release flow

```bash
# 1. Bump (creates commit + tag vX.Y.Z)
npm run version:minor   # or version:patch / version:major

# 2. Push commit + tag — Linux AppImage builds on GitHub Actions
git push && git push origin vX.Y.Z
# Workflow: .github/workflows/release-linux.yml → uploads AppImage + latest-linux.yml

# 3. Build + upload Mac (local or future macOS CI) to the same tag
npm run package:mac
# Upload DMG/zip + latest-mac.yml to the GitHub prerelease
```

**Backfill Linux onto an existing tag** (Actions → Release Linux → Run workflow → tag `v1.0.0`).

The migrate / wallet download site (`items-market` `/api/desktop-downloads`) resolves the **newest GitHub release automatically** (including prereleases). No manual version pin after publish. Optional emergency pin: `NEXT_PUBLIC_DESKTOP_VERSION` / `NEXT_PUBLIC_DESKTOP_RELEASE_TAG`.

Installed apps on **Update Mode: Default** still pick up the new GitHub release via auto-update.

Each platform needs its updater metadata on the release:

| Platform | Required artifact |
|----------|-------------------|
| macOS | `latest-mac.yml` (+ dmg/zip) |
| Linux | `latest-linux.yml` (+ AppImage) — **built on GitHub Actions** |
| Windows | `latest.yml` (+ NSIS) |

A Mac-only prerelease makes Linux **Check for Updates** report no update until an AppImage is published.

## Do not

- Rely on GitHub `/releases/latest/` for BETA downloads — that endpoint ignores **prerelease** tags. The website uses the GitHub Releases API instead (includes prereleases).
- Ship a higher `package.json` version without a matching GitHub release if you expect Check for Updates / download buttons to work for that version.
