# Versioning (HandCash Desktop)

Semver while **BETA**: `MAJOR.MINOR.PATCH` in root `package.json`.

| Bump | When |
|------|------|
| **patch** (`1.1.0` → `1.1.1`) | Fixes, updater/packaging, copy |
| **minor** (`1.1.0` → `1.2.0`) | New features (collectables, settings, Aeon shell, …) |
| **major** (`1.x` → `2.0.0`) | Breaking wallet/migrate/data changes |

Artifact names are `HandCash-${version}-…`. Linux ships the **thin native shell** zip (`npm run package:linux`); Mac still uses its host packager. Electron AppImage/NSIS paths remain under `package:electron:*` for legacy only.

## Release flow

```bash
# 1. Bump (creates commit + tag vX.Y.Z)
npm run version:minor   # or version:patch / version:major

# 2. Push commit + tag — Linux thin-shell zip builds on GitHub Actions
git push && git push origin vX.Y.Z
# Workflow: .github/workflows/release-linux.yml → uploads HandCash-*-linux.zip

# 3. Build + upload Mac (local or future macOS CI) to the same tag
npm run package:mac
# Upload DMG/zip (+ latest-mac.yml while Mac auto-update is live)
```

**Backfill Linux onto an existing tag** (Actions → Release Linux → Run workflow → tag `v1.0.0`).

The migrate / wallet download site (`items-market` `/api/desktop-downloads`) resolves the **newest GitHub release automatically** (including prereleases). No manual version pin after publish. Optional emergency pin: `NEXT_PUBLIC_DESKTOP_VERSION` / `NEXT_PUBLIC_DESKTOP_RELEASE_TAG`.

| Platform | Ship artifact (Actions / package script) |
|----------|------------------------------------------|
| macOS | DMG/zip via `package:mac` (+ `latest-mac.yml` while updater is live) |
| Linux | `HandCash-*-linux.zip` — **built on GitHub Actions** (thin shell; auto-update stubbed) |
| Windows | zip via `package:win` (NSIS/Electron path still `package:electron:win`) |

## Do not

- Rely on GitHub `/releases/latest/` for BETA downloads — that endpoint ignores **prerelease** tags. The website uses the GitHub Releases API instead (includes prereleases).
- Ship a higher `package.json` version without a matching GitHub release if you expect Check for Updates / download buttons to work for that version.
