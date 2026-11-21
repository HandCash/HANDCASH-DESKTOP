# HandCash thin Mac shell

Minimal AppKit + WKWebView host for the existing Desktop wallet UI. Pattern and
cutover notes: [`../docs/thin-desktop-shell.md`](../docs/thin-desktop-shell.md).

This is the **Mac production host** (`npm run dev` on darwin → `dev:native`;
`npm run package:mac`). Electron is not used on Mac.

BRC-100 HTTP and device-peer LAN (`:3340`) run in the Rust `handcash-sidecar`
(`../native-desktop`, built by `npm run package:mac` / `cargo build --bin handcash-sidecar`). Vault sealing uses the Mac Keychain; device unlock
uses LocalAuthentication. Updates open the GitHub DMG. App tabs use
`appBrowserGuest` WKWebView overlays.

**Still stubbed:** screen share / call-recording source picker.

Packaged `.app` (`npm run package:mac`) puts UI in `Contents/Resources/app`,
the Rust `handcash-sidecar`, and `handcash-page.js`. No Node ships.
The shell serves `:5173` via `handcash-sidecar --ui` then loads that origin (IndexedDB).

```bash
# from HANDCASH-DESKTOP
npm run dev             # Vite + this shell
# or:
npm run dev:vite        # terminal A
npm run dev:native      # terminal B
npm run package:mac     # .app + dmg/zip under release/
```
