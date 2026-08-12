# HandCash three parts

Desktop and Mobile must **never** drift into two wallet UIs. The clever cut is not a giant monorepo move — it is a named core plus thin shells, with a pin every APK proves.

```
                    ┌─────────────────────────┐
                    │  @handcash/wallet-ui    │
                    │  HANDCASH-DESKTOP/src   │
                    │  (App, wallet, Aeon UI) │
                    └───────────┬─────────────┘
                     mounts │           │ mounts
            ┌───────────────┘           └───────────────┐
            ▼                                           ▼
┌───────────────────────┐                 ┌───────────────────────┐
│ Desktop shell         │                 │ Mobile shell          │
│ electron/ + main.tsx  │                 │ Capacitor + bridge    │
│ BRC-100, auto-update  │                 │ APK, native plugins   │
└───────────────────────┘                 └───────────────────────┘
```

## What belongs where

| Change | Put it in |
|--------|-----------|
| Send / Collect / Activity / Settings UX | UI core (`HANDCASH-DESKTOP/src`) |
| Wallet machines, remittance, collectables | UI core |
| Electron IPC, updater, HTTPS bridge ports | Desktop shell |
| Capacitor keyboard, biometrics, APK build | Mobile shell |
| Platform tweaks that must stay in shared CSS | UI core + `isMobileWalletPlatform()` |

## Coupling mechanism

1. Mobile `package.json` depends on `"@handcash/wallet-ui": "file:../HANDCASH-DESKTOP/packages/wallet-ui"`.
2. Vite aliases `@handcash/wallet-ui/*` and legacy `@desktop/*` to the same `src` tree.
3. `bash scripts/build-apk.sh` runs `node scripts/assert-ui-core.mjs` before build — fails if Desktop is missing, versions disagree, or the Desktop worktree is dirty.
4. Release assets include `ui-core-pin.json` next to the APK so support can see exactly which Desktop SHA the phone is running.

## What we deliberately did *not* do (yet)

Moving `src/` into a third git repo would make decoupling *easier* during the migration. The package boundary + pin keeps one SSoT today; a physical extract can wait until shells are thinner.
