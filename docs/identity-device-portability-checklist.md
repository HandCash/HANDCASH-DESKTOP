# Manual checklist — one-way device backup

**Three separate things (do not mix in your head):**

| Path | What it is |
|------|------------|
| **Backup device** | A known device id + public key, used only to address a sealed recovery copy. No identity, balance, history, or spend link. |
| **Sealed recovery copy** | Cold EncryptedMessage of one wallet’s custody secret (BRC-78), held by one device. One direction only; never in the spend path. |
| **History backup URL** | Optional BRC-39 replica of **this** identity’s localState. Only same-key installs use it for Sync / spend-lease. |

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

1. Phrase/shares → same identity → **one BSV pot** on both.
2. Set the **same** History backup URL if you want Sync + spend-lease.
3. The row reads `Same wallet · no copy needed`; sealed recovery is skipped.
4. UTXO truth is still the chain; Refresh after the other device spends.

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
- BRC-232 / key slices remain offline key recovery — orthogonal to device backup.
