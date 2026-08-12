# `@handcash/wallet-ui` — HandCash UI core

This package **is** the shared wallet renderer (`HANDCASH-DESKTOP/src`).

| Sun | Repo / path | Role |
|-----|-------------|------|
| **UI core** | `@handcash/wallet-ui` → `HANDCASH-DESKTOP/src` | App, panels, wallet machines, styles |
| **Desktop shell** | `HANDCASH-DESKTOP/electron` + `src/main.tsx` | Electron, BRC-100 ports, auto-update |
| **Mobile shell** | `HANDCASH-MOBILE` | Capacitor bridge, APK, native plugins |

**Never fork the core into Mobile.** Mobile mounts this package; product differences live only in the shells (`window.handcash`, CSS overrides, native code).

Version of this package **must match** Desktop `package.json` (kept in sync by `scripts/bump-version.mjs`).
