# Manual checklist — one-way device backup

**Three separate things (do not mix in your head):**

| Path | What it is |
|------|------------|
| **Backup device** | A known device id + public key, used only to address a sealed recovery copy. No identity, balance, history, or spend link. |
| **Sealed recovery copy** | Cold EncryptedMessage of one wallet’s custody secret (BRC-78), held by one device. One direction only; never in the spend path. |
| **History backup URL** | Optional BRC-39 replica of **this** identity’s localState — backup and empty-local recovery. Never a live sync between installs. |

## Two devices, two wallets

1. Create/restore a **separate** wallet on each device (own phrase).
2. On A: Settings → **Device backup** → **Show my code**. On B: **Scan a device** (or Dashboard Scan).
3. Open that device on B and pick one direction — **Protect this wallet** or **Protect A**. The other direction is then refused.
4. Protected side taps **Create copy**; the recovery device scans or pastes it.
5. The device row should read the direction, e.g. `A → this device`.
6. Optional: **Key slices / phrase** offline for each wallet.
7. Optional: History backup URL per identity — independent URLs are fine.

A legacy v2 QR for a different identity creates the same narrow backup relationship. It
never links identities.

## Lose a device

1. On the survivor: open the device row → **Recover** → unlock → copy phrase / emergency key.
2. On a **new** install: Restore → Phrase (or emergency key).
3. **Remove** the lost device on the survivor, then set a direction with the replacement.

## Same phrase on two installs

One phrase is one vault, and every wallet in the wallet menu is a separate account with its own
identity (BRC-208). Two installs share the vault by **holding different wallets**:

1. On B: Restore → Phrase → **Keep both**. B checks which wallets A already uses, reserves the
   next one for itself and opens it. A's wallets show on B as `On another device · Move here`.
2. Move a wallet from A to B: on A open that wallet, wallet menu → **Move … to another device**.
   A backs up its history, marks it released and switches away. On B tap the wallet → it moves
   without a prompt and restores its history.
3. A lost device: on the survivor tap the wallet → **Take over**. The lost device, if it ever
   comes back, stops spending that wallet when it next connects.
4. **Replace old device** at restore takes every wallet; the old install gives them all up at
   its next check (unlock, switch, or within five minutes).
5. Holding is local: a wallet another install holds is refused before signing, with no network
   call on the spend path. Two installs never open one wallet at the same time; a live
   same-wallet setup (spend lease, history pull) is still not supported.
6. The device row reads `Same wallet · no copy needed`; sealed recovery is skipped.

## Boundaries

- Adding a device grants nothing until a direction is chosen and a sealed copy is transferred.
- Recovery is one-way. The wallet refuses creating or importing the opposite leg.
- Removing a device deletes the local copy but keeps the direction locked — a copy already
  handed over cannot be recalled.
- Older reciprocal copies cannot be revoked remotely. Delete both and move the exposed wallet
  to a new phrase.
- A sealed copy never enters the hot spend path until an explicit Recover.
- **No offline payments** (hard rule).
- LAN peer (:3340) is same-identity peek only.
- BRC-140 key slices remain offline key recovery — orthogonal to device backup.
- There is no hosted key deposit or release path. BRC-39 stores encrypted wallet
  history only; it never stores or releases custody keys.
