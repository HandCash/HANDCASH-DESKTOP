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

# 2. Build + publish GitHub prerelease assets
npm run package:mac     # (and win/linux as needed)
# Upload DMG/zip to GitHub release matching the tag (prerelease)

# 3. Point the download site at the new tag
npm run version:sync-market
# then deploy items-market (pre-prod / prod)
```

Until step 3, the website keeps linking the previous published build. Installed apps on **Update Mode: Default** still pick up the new GitHub release via auto-update.

## Do not

- Point the site at `/releases/latest/` while assets are **prerelease** (GitHub ignores them).
- Ship a higher `package.json` version without a matching GitHub release if you expect Check for Updates / download buttons to work for that version.
