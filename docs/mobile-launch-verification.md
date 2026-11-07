# Pairing receipts and Android delivery verification

## Current local evidence — 2026-11-07

Desktop receipt implementation is committed in this worktree at `2d4f4e3882d4ce0c4f783ddbde010a1dd8ad71b4` (1.3.664). No receipt implementation edits are pending. Do not redo this change.

The receiver advertises `receiptVersion: 1`. The approver refuses older peers and requires a signature by the QR's one-time login key over `handcash-scan-login\ninstalled\n<loginKey>\n<approverKey>\n<sha256(sealedVault)>`. The receiver emits that receipt only after the installation callback acknowledges; AuthScreen calls it after `finishCreated` resolves. Failed or unacknowledged setup cannot approve pairing. LAN dispatch and the messagebox relay both await this completion. This is an application-level contract; the relay transports the same response body without interpreting the receipt.

Fresh automated verification in this worktree: 10 test files / 143 tests passed (scan-login, pairing chart, peer dispatch, account release/holding/move/handover, vault account holding, holding freshness and spend guard). Renderer and Electron type checks passed. These are synthetic tests, not physical two-device acceptance or a new live relay test.

## Matching Android source already exists

Read-only inspection of `/home/spider/Work/handcash/HANDCASH-MOBILE` found a clean worktree at `81a031a`, version/tag `0.1.779` / `v0.1.779`, pinning Desktop `8cce7b5d008589c0ddc4221fc75de09d91e664cf` / 1.3.666. This supersedes the old planned 0.1.778 delivery. A local tag is not proof of publication, APK contents or installation.

The pinned core has equivalent receipt code: comparison found no differences in scanLogin, DeviceSignInPanel, peer dispatch or Electron peer dispatch. Its AuthScreen additionally permits the scan-approved join's unrecorded-holder fallback and logs installation failures. It includes `9da1d091` (vault account mismatch fix) and `8cce7b5d` (phone spacing). Those newer changes are not imported into this older isolated branch or overwritten. The 143-test result above does not certify those newer changes.

The proper Android route remains Mobile's immutable shared-core pin and `release-apk.yml`; do not fork shared panels into Mobile or run the release script against this older core. No push, publication, deployment, installation or wallet-data changes were performed in this verification pass.

## Coordination and evidence limits

The currently open Mobile and BRC-CLOUD chats are new chats (`cmw6jt5w74`, `cmw6jt5wc6`), not the historical chats 242 and 314; both reported no inherited delivery evidence. Read-only coordination with the sign-in fix chat `cmw6finp15` confirmed prior type checks and 75 vault tests, but no demonstrated physical sign-in/unlock. Its earlier missing `MOBILE_RELEASE_TOKEN` report is historical, not a current credential check. No secrets were inspected.

## Exact remaining release gate

No attached phone evidence, installed UI-core pin, successful native two-device pairing, updater install-over, physical account handoff or accepted real-phone layout has been established here. `adb` was not found on PATH. Current CI/publication status is not verified. Do not declare launch-ready from the local tag or synthetic tests.

Ask the phone operator to provide:

1. Installed Android version and embedded shared-core pin, plus Desktop version. Use an approved install-over update only; never clear data, downgrade or move keys for testing.
2. Pair in both directions on LAN, then on separate networks. Record that the approver waits for receiver setup and both devices reach usable sessions. Wrong/expired codes and cancelled/failed setup must never show success. Capture any failure message and timestamp, without QR secrets, recovery material or keys.
3. Verify the new device holds a different account. Select an account held on the other device and check automatic active-holder and idle-holder release, then offline-holder recovery. The displaced device must not sign or receive spendable state; pending history must transfer without rebroadcasting displaced unbroadcast transactions. Use a test vault; do not spend production funds to prove this.
4. Provide Android balance/header/settings screenshots in both themes, with long identity labels and large balances: square avatar, balanced spacing, no clipped controls or overflow. Do not treat browser fixtures as phone evidence.

Any further publishing or deploying requires explicit approval naming the exact source pin, version and destination first. Separate-account custody is unchanged; same-key spendable parity is not an acceptable workaround.
