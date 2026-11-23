# Device sign-in authorization review

## Evidence and scope

Reviewed shared Desktop/Mobile scan-login, Activity's pairing chart, native peer
HTTP dispatch and the BRC-CLOUD messagebox authentication path. No wallet keys,
QR secrets, codes or raw uploaded log lines are included here.

Latest known Android upload reports v0.1.774 and contains two "vault sent"
events. That old stage proved transport delivery, not usable installation.
The available Darwin Desktop upload reports v1.3.637 with no scan-login stages.
These uploads do not establish a matched two-device attempt or its receiver failure.
Mandatory typed-code support landed later, in 1f05396a (v1.3.659).
A repository source pin does not prove which binary a phone currently runs.

## Authorization chain

1. The signed-out receiver creates a fresh ephemeral key and QR secret, expiring
   after ten minutes. The QR includes its public key, not its private key or vault.
2. The approving, unlocked device creates its own ephemeral key. Hello proves
   possession of the QR secret and binds that key. Only the first approver pairs.
3. The receiver generates six random digits, shown only on its screen. The person
   types them on the approving device. The confirmation HMAC binds the QR secret,
   approver key, fresh nonce and digits. Three wrong attempts lock the session;
   codes expire after two minutes and consumed confirmations cannot be replayed.
   Names are self-reported labels, not verified device identities. The physical
   screen/code check is what ties the authorization to the intended device.
4. Local presence confirmation still gates vault release. Replacing/refusing the
   request or expiry while that prompt is open prevents release.
5. BRC-78 ciphertext targets only the receiver's ephemeral key. Account-holding
   protections remain: installation prepares a distinct held wallet; it does not
   turn the other install's account into a second spending instance.
6. The receiver reports success only after vault persistence, account setup and
   wallet runtime startup. Its ephemeral key signs a domain-separated receipt
   binding both peer keys and the exact ciphertext hash. The approving chart
   stays sending until that signature verifies. Missing, unrelated or unsigned
   receipts, failed setup and setup timeouts cannot record a successful device.
   Peers without code and receipt support fail closed and require an update.

LAN and cross-network mailbox delivery use the same authorization handler.
The mailbox is transport, not authorization to install a wallet. Relay requests
now sign the complete HTTP method, target, body and bound metadata with a fresh
nonce/timestamp, in addition to compatibility headers. BRC-CLOUD verifies those
proofs and consumes write nonces; metadata-only signatures are insufficient in
strict mode. This change does not enable the backend's legacy authentication flag.

A successful sign-in is not proof of an ongoing peer link, synchronized account
history, remote balances or network availability. Copy explicitly distinguishes
installation from devices staying connected.

## Verification and remaining limits

Regression coverage includes the real XState chart with real receiver/approver
protocol, pending and failed runtime setup, missing/incorrect/rebound receipt
signatures, wrong/expired/consumed codes, unauthorized peers, duplicate transfer,
presence-prompt cancellation, timeout, encryption and fake-mailbox delivery.
Backend tests independently exercise full-request binding and nonce replay rules.

Renderer and Electron type checks passed. Pairing checks passed (49 tests), as did
chart catalog/Aeon adherence checks (8 tests) and backend authentication checks
(19 tests). After the earlier 120-second run and concurrent catalog repair, the
complete renderer/Electron suite passed in eight bounded shards: 570 files and
4,586 tests passed; one file and three tests were skipped.

The opt-in scanLogin.live.test.ts passed against the deployed BRC-CLOUD Worker:
complete request proofs, wrong-code rejection, correct-code acceptance, and a
signed receipt after an intentionally delayed acknowledgement. This uses fresh
synthetic keys/data, no wallet or funds. The test itself acknowledges installation;
it does not prove native vault persistence or runtime startup on either device.
Run with HANDCASH_LIVE_PAIRING=1 and vitest.live.config.ts.

Real presentation components rendered without runtime errors or horizontal overflow
at 360px and 1440px, in both themes: migration entry, signed-out entry, scan, review,
transfer, results and pairing-code entry. Reproduce with
node scripts/check-migration-layout.mjs. Final screenshots are under
/tmp/migration-layout-I1ONCa. Phone and desktop review screenshots were inspected
using compact copies through the terminal when the image-view tool was unavailable.
This exposed unstyled totals: ImportSourceView now uses Aeon's styled MetricStrip
instead of its headless projection; geometry checks require stacked value/label
chips. No migration chart or behavior changed. The fixtures do not exercise native
upgrade storage, Settings sign-in navigation or real migration transactions.
Final focused checks passed: 47 pairing tests, 13 migration/onboarding tests,
renderer and Electron type checks (renderer rerun after the presentation fix),
and git diff --check. The full-suite result above predates the final styling-only
import change.

No physical two-device test has been completed. adb is unavailable on PATH and at
the checked SDK locations, so phone connection/installed version is unknown.
A current matching receiver upload is missing. Do not infer that no phone exists.
Mobile's checked source pin and the new v0.1.777 APK's embedded source-pin manifest
both report c57b4473 (shared UI v1.3.663), which does not include these uncommitted
receipt changes. The artifact is not evidence of an installed phone version. Both apps need the same receipt-capable shared
UI built and installed before a release test; no mixed dirty-tree package or
install was made as part of this review. Preserve unrelated edits when preparing
that release. Migration spacing is already shipped in 2e2d7a8f; the migration
plan's native credential reader, app-ID/install-over and real signed-upgrade tests
remain separate launch blockers.
