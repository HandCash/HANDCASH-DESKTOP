# HandCash pure-Rust desktop shell (Windows / Linux)

OS WebView host (`tao` + `wry`) and full native host runtime for the HandCash Desktop
wallet UI — **no Electron, no Node runtime, no sidecar processes.**

Pattern and cutover notes: [`../docs/thin-desktop-shell.md`](../docs/thin-desktop-shell.md).

| Piece | Where |
| --- | --- |
| Window + WebView + frameless drag | this crate (`handcash-shell`) |
| `window.handcash` | `handcash-page.js` via wry `window.ipc` |
| BRC-100 HTTP `:3321` + HTTPS `:2121` | built-in Rust server (`src/brc100_server.rs`, `src/tls_cert.rs`, `src/spend_ledger.rs`, `src/bridge_protocol.rs`) |
| LAN device-peer `:3340` | built-in Rust server (`src/brc100_server.rs` + `if-addrs`) |
| Packaged UI server `:5173` | built-in Rust static server (`src/ui_server.rs`) |
| Sync durable store | loopback HTTP + OS keyring AES-GCM (`sealed:native:v1:`, `src/durable.rs`, `src/seal.rs`) |
| Embedded app-browser tabs | isolated child WebViews (`src/app_browser.rs`, `appBrowserGuest`) |
| BRC-39 local UTXO archive | write-once snapshots under `<userData>/brc39-archive` (`src/brc39_archive.rs`) |
| Call recordings | write-once sealed parts under `<userData>/call-recordings` (`src/call_recordings.rs`) |
| Save dialogs & file upload | GTK `FileChooserNative` / Win32 `GetSaveFileNameW` (`src/dialogs.rs`, `src/file_chooser.rs`) |
| Clipboard & screenshot | `wl-copy` / `arboard` text + image, WebKitGTK snapshot (`src/clipboard.rs`) |
| Host logs & Omarchy theme | rotating `<userData>/logs/main.log` (`src/host_log.rs`), live `colors.toml` watcher (`src/omarchy_theme.rs`) |
| Release updates | GitHub releases check/download via `src/wallet/desktopReleaseUpdate.ts` |

## Run (on Windows or Linux)

```bash
# from HANDCASH-DESKTOP
npm run dev              # win32/linux → vite + this pure-Rust shell
# or split:
npm run dev:vite         # terminal A
npm run dev:native       # terminal B (cargo build + launch)
```

Requires: Rust toolchain, platform WebView (WebView2 Evergreen on Windows;
WebKitGTK 4.1 + GTK on Linux).

## Test & Package

```bash
cd native-desktop && cargo test
# from HANDCASH-DESKTOP:
npm run package:win    # or package:linux → release/HandCash-*-{win|linux}.zip
npm run launch         # Linux: package + launch pure-Rust shell
```

## Platform notes

- **Device unlock (biometrics)** — `available: false` on Linux/Windows (exact parity with Electron, which enables Touch ID on macOS only).
- **Screen share picker** (`listScreenSources` / `chooseScreenSource`) — omitted so `screenShareAvailable()` stays `false` until OS capture portals are wired.
- **Installers** — shipped as a self-contained portable zip (zero Node binary bundled).
- Vault **OS seal** (keyring-backed AES-GCM) is real when the OS credential store works.
