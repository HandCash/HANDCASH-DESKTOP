# Manual checklist — linked devices + sealed spares

**Two models (do not mix in your head):**

| Path | What it is |
|------|------------|
| **Linked identities** | Different (or same) keys on two installs. Link via QR. Each device spends **only its own** coins. |
| **Sealed spare** | Cold EncryptedMessage of the other device’s custody secret (BRC-78). Not used for day-to-day spend. |
| **History backup URL** | Optional BRC-39 replica of **this** identity’s localState. Required only for legacy same-key Sync / spend-lease — **not** required to link. |

## Preferred: two devices, two keys

1. Create/restore a **separate** wallet on each device (own phrase).
2. Settings → **Use on another device** → show link QR on A; **Scan to link** on B (or Dashboard Scan).
3. **Exchange sealed spares** (unlock password seals your keys to their identity pubkey).
4. Confirm Settings status: linked · sealed spares ready.
5. Optional: still confirm **Key slices / phrase** offline for each device.
6. Optional: History backup URL for each identity’s own recovery — independent URLs are fine.

## Lose a device

1. On the survivor: linked list → **Recover** → unlock → copy phrase / emergency key.
2. On a **new** install: Restore → Phrase (or emergency key).
3. **Unlink** the lost device on the survivor; re-exchange spares with the replacement.

## Legacy: same phrase on two installs

1. Phrase/shares → same identity → **one BSV pot** on both.
2. Set the **same** History backup URL if you want Sync + spend-lease.
3. Link still works (v3 QR); sealed spare is skipped (same keys).
4. UTXO truth is still the chain; Refresh after the other device spends.

## Boundaries

- Identity link and sealed spare are **separate** contracts (wizard couples them; revoke can differ).
- Sealed spare never enters the hot spend path until explicit Recover.
- **No offline payments** (hard rule).
- LAN peer (:3340) is optional same-identity peek only — not how linked different-key devices sync.
- BRC-232 / key slices remain offline key recovery — orthogonal to sealed spares.
