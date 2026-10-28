# Thin Desktop shell (host WebView pattern)

Reusable shape for HandCash Desktop: a small native window + OS WebView loads
the existing wallet UI; money-moving and custody stay outside the renderer.
**Electron is not a host** — Mac uses `native-macos/`, Windows/Linux use
`native-desktop/`. Alignity (or another product) can copy the same split — do
not fold host duties into the UI bundle.

## Host vs UI

| Layer | Owns | Does not own |
| --- | --- | --- |
| **UI** (Vite / `@handcash/wallet-ui`, Aeon charts) | Panels, machines, `window.handcash` *calls* | Chromium, OS keychain, listening sockets |
| **Host** (`native-macos/` on Mac; `native-desktop/` on Windows/Linux) | Window, WebView, inject/bridge `window.handcash`, durable files, local HTTP | Wallet charts, spend logic |

The renderer origin stays `http://localhost:5173` (dev Vite, or the packaged UI
server). IndexedDB and remittance history stay on that origin; the host must not
invent a second partition.

## Native APIs sit outside the renderer

`window.handcash` is a **facade**. Implementations live in the host:

- **Sync custody I/O** — `storageGetSync` / `storageSetSync` cannot be real async
  postMessage. Mac uses Mobile-shaped `window.prompt` + `WKUIDelegate`
  (`native-macos/` DurableStore). Win/Linux use loopback sync HTTP to the host
  (`native-desktop/` durable server + `handcash-page.js`). Never put the vault in
  WebView localStorage.
- **Async host calls** — Mac: `webkit.messageHandlers.handcash`; Win/Linux: wry
  `window.ipc.postMessage`.
- **Local BRC-100 bridge + device-peer** — HTTP on `127.0.0.1:3321` / `:2121`
  and LAN `:3340` run in a **Node sidecar** (`electron/bridgeSidecar.ts` →
  `dist-sidecar/bridgeSidecar.cjs` via `npm run build:sidecar`), not inside the
  WebView. The folder name `electron/` is historical; it holds shared Node host
  code only (no Electron runtime).

## Size goal

| | Approx |
| --- | --- |
| Old Electron ship (Chromium + Node + app) | ~150 MB |
| Mobile (OS WebView + UI) | ~15 MB |
| **This shell** (native binary + UI assets + bundled Node for sidecar; WebView is the OS) | aim **≪** old Electron; debug `HandCashShell` binary is ~220 KB |

## What Mac production implements vs stubs

**In `native-macos/` (+ Node sidecar) — Mac production host:**

- NSWindow + WKWebView loading the wallet UI URL
- Inject `window.handcash` (platform, getAppInfo, open external, clipboard,
  focus, durable store, bridge subscribe/respond, device auth, updates)
- File-backed durable store via prompt; vault keys sealed with Keychain AES-GCM
  (`KeychainSeal`, prefix `sealed:native:v1:`)
- Touch ID / device-owner auth (`DeviceAuth` + LocalAuthentication)
- **BRC-100 + device-peer** via Node sidecar (`:3321` / `:2121` / LAN `:3340`)
- **Auto-update (Mac BETA):** GitHub HandCash releases → open arch-matched DMG
  (ShipIt-unsafe path). Titlebar pill UX matches Alignity’s check/download/install
  control (`UpdateControl` / `updateView`); channel stays HandCash’s own, never
  Alignity’s. No electron-updater.
- **Embedded app tabs:** `appBrowserGuest` overlays child WKWebViews; guests use
  the local BRC-100 HTTP bridge like a normal browser
- Packaged UI served on `localhost:5173` by `uiSidecar.cjs` when
  `Resources/app` is present

**Still stubbed on Mac (explicit — do not silently drop):**

- Screen share / call recording picker (`listScreenSources` /
  `chooseScreenSource`). Calls work; share stays unavailable until
  ScreenCaptureKit is wired. `screenShareAvailable()` is false.

## What Win/Linux implements vs stubs

**In `native-desktop/` (+ same Node sidecar):**

- tao window + wry WebView (WebView2 / WebKitGTK) loading the wallet UI URL
- Inject `window.handcash` via wry `window.ipc` (`handcash-page.js`)
- Sync durable store over loopback HTTP; vault seal via OS keyring AES-GCM
  (`sealed:native:v1:`)
- **BRC-100 + device-peer** via the same sidecar stdio protocol as Mac

**Still stubbed on Win/Linux (explicit):**

- Auto-update, embedded app-browser tabs, screen share/recording
- Device unlock biometrics (`available: false`)
- **Installers:** `npm run package:win` / `package:linux` produce a **zip** of the
  shell + sidecar + UI (see `STUBS.txt` in the folder). NSIS / AppImage / `.deb`
  are not produced yet — never pretend they are.

See `native-desktop/README.md`, `native-windows/`, `native-linux/`.

## Run (dev)

```bash
npm run build:sidecar   # once (or after electron/ sidecar changes)
npm run dev             # darwin/win32/linux: Vite + native shell
# or split:
npm run dev:vite              # terminal A
npm run dev:native            # terminal B (macOS)
npm run dev:native-desktop    # terminal B (Windows/Linux)
```

## Package

```bash
npm run package         # OS-native packager (mac → .app+dmg/zip; win/linux → zip)
npm run package:mac     # → release/mac-arm64|mac/HandCash.app + dmg/zip
npm run package:win     # → release/HandCash-*-win.zip
npm run package:linux   # → release/HandCash-*-linux.zip
npm run launch:mac      # package + open
```

See `native-macos/README.md` for Mac app layout.
