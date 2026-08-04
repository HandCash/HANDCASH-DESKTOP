# HandCash Desktop

Official HandCash **desktop wallet (BETA)** — self-custodial, built on the BSV Association open [BRC-100](https://brc.dev/100) wallet interface (same protocol surface as [bsv-desktop](https://github.com/bsv-blockchain/bsv-desktop)).

> **BETA** — early open-source release. **Not Apple-notarized yet.**
>
> If macOS says the app is **“damaged and can’t be opened”**, that is Gatekeeper
> rejecting an **unsigned** download (quarantine), not a corrupt DMG. Fix:
>
> ```bash
> xattr -cr /Applications/HandCash.app
> # or, before install: xattr -cr ~/Downloads/HandCash-*-mac.dmg
> ```
>
> Then open the app again. Right-click → Open sometimes works; `xattr` always does.

## What you get

- Self-custodial vault (AES-GCM + PBKDF2) stored on device
- HandCash UI driven by **Aeon UI / XState** machines (`UI = f(state)`)
- Local BRC-100 HTTPS bridge on `https://127.0.0.1:2121` (+ HTTP `:3321`) for compliant apps
- Installers via **electron-builder**: AppImage, deb, NSIS, DMG, portable

## Develop

```bash
npm install
npm run dev
```

## Package (Exodus-style distributables)

```bash
# current platform
npm run package

# explicit targets
npm run package:linux      # AppImage → release/ (primary Linux ship format)
npm run package:linux:all  # AppImage + deb (deb needs host fpm/libcrypt)
npm run package:mac        # DMG + zip
npm run package:win        # NSIS installer + portable
```

Artifacts land in `release/`. On Linux, ship the AppImage the way Exodus ships a single downloadable binary.

### Releases / auto-update

Installers publish to **GitHub Releases** on `HandCash/HANDCASH-DESKTOP` (electron-builder `publish.provider = github`). Migrate page download buttons default to:

`https://github.com/HandCash/HANDCASH-DESKTOP/releases/latest/download/…`

```bash
# after packaging
gh release create v1.0.0 release/HandCash-* release/latest-mac.yml --title "HandCash Desktop 1.0.0"
```

Mac production needs **Apple Developer ID Application** signing + notarization before
Squirrel.Mac (ShipIt) in-app replace is safe. Until then, Mac “updates” open the
arch-matched DMG from GitHub Releases instead of ShipIt (unsigned ShipIt installs
corrupt `HandCash.app`).

Wire signing when the cert is available:

```bash
# CI / local secrets
export CSC_LINK=...                 # .p12
export CSC_KEY_PASSWORD=...
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...

# package.json build.mac — remove identity: null, set hardenedRuntime: true
# then remove macShipItUnsafe() guard in electron/autoUpdate.ts
```

### Fedora Atomic / Wayblue (no FUSE)

If you see `error loading libfuse.so.2`, skip mounting the AppImage:

```bash
# easiest — unpacked Electron binary
/home/spidercorp/Projects/handcash-brc100/release/linux-unpacked/handcash-brc100

# or AppImage without FUSE
APPIMAGE_EXTRACT_AND_RUN=1 /home/spidercorp/Projects/handcash-brc100/release/HandCash-1.0.0-x86_64.AppImage

# or the helper script
/home/spidercorp/Projects/handcash-brc100/release/run-handcash.sh
```


## Architecture

| Layer | Role |
|-------|------|
| `electron/` | Window, auto-updater hooks, SSL cert, BRC-100 HTTP(S) server (BSVA pattern) |
| `src/machines/` | Named statecharts before JSX |
| `src/wallet/` | Encrypted vault + `@bsv/wallet-toolbox-client` IDB wallet + method dispatch |
| `src/components/` | Surfaces that project `data-aeon-state` |

### Migration methods (HandCash extensions on the BRC bridge)

After a site connects via `waitForAuthentication`, HandCash migrate hosts (`handcash.io`, `market.handcash.io`, `preprod-market.handcash.io`, localhost) may call:

| Method | Returns |
|--------|---------|
| `getLegacyAddress` | `{ address, identityKey, handle, chain }` — Desktop P2PKH destination |
| `refreshLegacyAddress` | Optional `{ txids, items }` from cloud; 1Sats → basket `1sat`, other UTXOs → funds; **never sweeps satoshis===1** (held until classified); returns `{ address, satoshis, importedCount, importedItemsCount, txids }` |
| `listMigrationTxids` | `{ txids }` — persisted migration-related txids |

Product page: `https://handcash.io/migrate` (items-market).

## Notes

- Official HandCash Desktop product (`HandCash/HANDCASH-DESKTOP`).
- Based on BSVA open source patterns from `bsv-blockchain/bsv-desktop` (HTTP bridge, ports, manifest).
- Update feed URL in `package.json` → `build.publish` before shipping auto-updates.
