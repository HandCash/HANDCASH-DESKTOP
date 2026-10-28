# HandCash thin desktop shell (Windows / Linux)

OS WebView host (tao + wry) for the existing Desktop wallet UI — same split as
[`native-macos/`](../native-macos/): UI stays Vite/Aeon; custody, BRC-100, and
device-peer run outside the renderer. **No Electron.**

Pattern and cutover notes: [`../docs/thin-desktop-shell.md`](../docs/thin-desktop-shell.md).

| Piece | Where |
| --- | --- |
| Window + WebView | this crate (`handcash-shell`) |
| `window.handcash` | `handcash-page.js` via wry `window.ipc` |
| Sync durable store | loopback HTTP + OS keyring AES-GCM (`sealed:native:v1:`) |
| BRC-100 + device-peer `:3340` | Node sidecar `../electron/bridgeSidecar.ts` → `../dist-sidecar/bridgeSidecar.cjs` |

## Run (on Windows or Linux)

```bash
# from HANDCASH-DESKTOP
npm run build:sidecar   # once
npm run dev              # win32/linux → vite + this shell
# or split:
npm run dev:vite         # terminal A
npm run dev:native       # terminal B (cargo build + launch)
```

Requires: Rust toolchain, platform WebView (WebView2 Evergreen on Windows;
WebKitGTK 4.1 + GTK on Linux).

## Package

```bash
npm run package:win    # or package:linux → release/HandCash-*-{win|linux}.zip
```

Zip layout only (NSIS / AppImage / `.deb` stubbed — see `STUBS.txt` in the folder).

## Stubs (explicit — do not pretend online)

- **Auto-update** — `UpdateStatus` idle stub (same shape as Mac); `installUpdate` errors. Titlebar pill stays hidden until a real channel is wired.
- **Embedded app-browser tabs** — `embeddedAppBrowser: false`
- **Screen share / call recording** — not hosted here
- **Device unlock (biometrics)** — `available: false`
- **Installers** — zip only until NSIS/AppImage land

Vault **OS seal** (keyring-backed AES-GCM) is real when the OS credential store works.
