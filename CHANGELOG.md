# Changelog

## [1.2.2] - 2026-08-02

### Changed

- Add the finalized, approved BRC-147/150 1Sat Ordinals specifications to the Desktop standards package.

## [1.2.1] - 2026-08-02

### Changed

- Remove Twonk support; keep item permission hardening (view/send/receive separate from Pay).

## [1.2.0] - 2026-08-01

### Added

- Item permissions: view (optional collection/creator), send, and receive — separate from Pay.

### Changed

- Pay and Auto-pay never cover NFT / collectable spends.

## [1.1.16] - 2026-08-01

### Changed

- Patch release (every push must ship a new version).

## [1.1.15] - 2026-07-31

### Changed

- BRC-125 PeerPay URIs on Receive (default QR) and Send (paste + optional sats).
- BRC-112 balance-basket fallback; BRC-114 time-label helpers for activity windows.

## [1.1.14] - 2026-07-31

### Changed

- BRC-140 key slices (2-of-3) for recovery; store slices in different places.
- BRC-38/39 wallet data backup (download/import wallet.brc39; optional custom URL — HandCash host left blank).
- Settings: open app logs folder for support.
- Restore via BRC-140 share paste on auth.

## [1.1.13] - 2026-07-31

### Changed

- Remove Chat (Lab chat, BRC-218 composer, in-thread pay cards, and related nav/settings).

## [1.1.12] - 2026-07-31

### Changed

- Surface sync / held 1-sat / migrate-style errors in the wallet UI (not console-only).
- Clarify identity key vs payment address on Identity, Receive, and Send.
- Require backup confirmation before first outbound send or app connect.
- Unlock nudge when the BRC-100 bridge is hit while the wallet is locked.
- Windows release CI workflow (`latest.yml` + installers on tag).
- Gate `encrypt` with other action methods; document migrate bridge hosts.

## [1.1.10] - 2026-07-31

### Changed

- Compact collectable details (side hero, scroll); Origin/Outpoint at bottom; traits via Aeon MetricStrip.
- Inventory Send affordance; Lab/About statecharts cleanup; settings chart id fix.
- Consume aeon-ui-engine ^1.3.5.

## [1.1.9] - 2026-07-31

### Changed

- In-chat pay/request confirm (no Send redirect); Lab Chat flag; quieter receive SFX on sync.
- Statecharts: stable fit/zoom, taller labels, click a linked state to open its chart.

## [1.1.8] - 2026-07-31

### Changed

- Chat (BRC-218 commands), opt-in wallet SFX, favicon retry, compact statecharts, desktop icon mark inset.

## [1.1.7] - 2026-07-31

### Changed

- Mac updates open the arch-matched GitHub DMG (ShipIt still blocked until Developer ID).
- Screenshot to clipboard (⌘⇧S) with version badge; About statecharts.

## [1.1.6] - 2026-07-31

### Changed

- Patch release (every push must ship a new version).

## [1.1.5] - 2026-07-31

### Changed

- Patch release (every push must ship a new version).

## [1.1.4] - 2026-07-31

### Changed

- Patch release (every push must ship a new version).

## [1.1.3] - 2026-07-31

### Changed

- Patch release (every push must ship a new version).

## [1.1.2] - 2026-07-30

### Changed

- Patch release (every push must ship a new version).

## [1.1.1] - 2026-07-30

### Changed

- Patch release (every push must ship a new version).

All notable changes to HandCash Desktop are documented here.

## [1.1.0] - 2026-07-30

### Added

- Cursor-style update mode (default / manual / none) with `appUpdate` statechart.
- Aeon 1.2.0 product shell: brand palette, StatusBanner, Prompt, `launch:mac`.
- Collectables send/detail flow; GitHub prerelease update feed wiring.

### Fixed

- Update Mode selectable without Electron bridge; durable prefs for mode.
- Missing `app-update.yml` on arm64 `dir` packages (feed URL + launch inject).

## [1.0.0] - 2026-07-30

### Added

- Initial BETA release — self-custodial BRC-100 Desktop wallet.
