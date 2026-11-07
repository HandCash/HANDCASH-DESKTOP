# Desktop / Android launch verification

## Release and installation are different evidence

GitHub Latest was verified as public Android v0.1.777, published 2026-11-07.
Neither this chat nor Mobile chat `cmw4kv8ia4` (242) has established the installed
phone build, its embedded UI-core pin, or a real-phone screenshot/WebView session.
Do not call browser geometry fixtures a phone test. Preserve wallet data: no data
clear, reinstall, key movement or downgrade to obtain this evidence.

## Integration blockers

The isolated Desktop worktree starts at `9932b46f`. The earlier shared worktree
had uncommitted header/settings and signed-receipt changes; they are not included
here. Do not replace those changes with the older isolated sources.

Confirmed header defects in this baseline: compact identity spans all receive
flex growth (including the avatar), the metric grows into unused space, and later
compact panel rules add automatic left margins to hero pills. Pending fixes scope
ellipsis to the identity label, keep the avatar square, size the metric to content,
exclude hero pills from panel-action margins, and add symmetric balance padding.
Settings' currency dropdown and row-column alignment also await integration.
No claim is made that these pending changes are installed or visually accepted.

The baseline scan-login receiver returns transport success after emitting the
vault event. Transport success does not prove persistence or wallet runtime startup.
Mobile 0.1.777 does not include the pending signed-receipt fix, per chat 242.
Both devices must consume the same committed receipt-capable implementation.
Never silently downgrade this requirement to support an older peer.

## Preserve Git history

At the completed remote audit, Desktop was 29 commits ahead / 6 behind; all six
remote patches were equivalent to local patches (`git cherry`), not six missing
features. Mobile had distinct remote pin commits `efd79ab` and `f199863`, so its
history needs separate reconciliation. These are historical audit results, not
permission to reset, force-push or drop local commits. Preserve baseline `154682d`
and unrelated work. Recheck heads before integration.

## Owners and release gates

Mobile chat 242 owns Mobile integration, the actual APK UI-core pin, installed
build evidence and real-phone layout review. Desktop chat 183 owns Desktop receipt
capability; both owners coordinate the shared protocol. This ownership is from the
read-only cross-chat handoff, not evidence that integration has completed.

Before approval to push/publish a new update:

- Review and commit the shared UI/sign-in changes without unrelated dirty files;
  reconcile both histories without duplicating equivalent patches.
- Build both apps from the agreed immutable shared source pin.
- On real devices, scan in both directions; test wrong/expired codes, cancelled
  approval, failed receiver setup and missing/invalid receipts. Success requires
  persisted vault, usable session and a verified receipt bound to both peers and
  the exact ciphertext, not a successful HTTP response.
- Exercise account handoff with an active and idle holder, direct and fallback
  transports, and offline-holder recovery. Distinct devices hold distinct accounts;
  an account held elsewhere cannot sign or receive spendable state. Never enable
  same-key spendable parity to make this test pass.
- Inspect actual Android balance/header/settings layouts in both themes, with long
  identity labels and large balances. Record installed version, UI-core pin and
  screenshots; no overflow, stretched avatar, detached profile or clipped controls.

## Verification completed in the isolated worktree

Focused Vitest run: 9 files / 124 tests passed, covering scan-login, the pairing
chart, account release/holding/move/handover, vault account holding, holding
freshness and the spend guard. Renderer and Electron type checks passed.
These are synthetic protocol/chart/storage tests, not native two-device tests;
the baseline scan-login tests do not implement or verify signed receipts.

No new push/publication approval exists. No physical two-device, native persistence,
real-phone alignment or account-handoff end-to-end pass is established here.
