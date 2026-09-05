/**
 * Partner FAQ — HandCash BRC-100 bridge (Desktop + Mobile)
 *
 * Answers for app developers integrating against the local wallet bridge
 * (e.g. Lil Bit / Plinko). Protocol: https://brc.dev/100
 */

# HandCash BRC-100 partner FAQ

## Which bridge URL should we use?

| Shell | Prefer | Also |
|-------|--------|------|
| **Desktop** | `http://127.0.0.1:3321` | HTTPS `https://127.0.0.1:2121` (self-signed). Cert SAN includes `localhost`, `127.0.0.1`, and `::1`. OS trust is best-effort — prefer HTTP for reliability. |
| **Mobile (Android)** | `http://127.0.0.1:3321` only | No HTTPS `:2121` on Capacitor. The native plugin also answers `[::1]:3321` so `localhost` resolves. |

Do **not** hard-require HTTPS for HandCash Mobile. Dial the IPv4 loopback HTTP port.

## Why do we see “insufficient funds” while the wallet balance looks funded?

Displayed balance credits **unconfirmed change** from the user’s own recent sends (and internalized receives). `createAction` only selects toolbox rows with `spendable: true`.

HandCash now:

1. After each app `createAction`, seals spent inputs and **promotes that tx’s unspent change** so the next bet can chain immediately.
2. After app `internalizeAction`, **promotes received BSV outs** the same way.
3. Pre-gates with a small fee buffer and may return `CHANGE_CHAINING_REQUIRED` when pending change still needs one more promote/retry.

Apps doing rapid bets should **retry** on `CHANGE_CHAINING_REQUIRED` (short backoff). Prefer BRC-29 payments to the user’s **identity key** over sweeping `getLegacyAddress` so history and spendable state stay clean.

## Does HandCash honor `spendingAuthorization`?

Yes (BRC-73 / BRC-116). Declare in your web `manifest.json`:

```json
{
  "metanet": {
    "schemaVersion": 1,
    "groupPermissions": {
      "spendingAuthorization": {
        "amount": 100000,
        "description": "In-app bets for this calendar month"
      }
    }
  }
}
```

On Connect **Authorize**, HandCash stores that **monthly satoshis** cap (manifest is fetched in the background and never blocks the Connect prompt). **Auto-pay is still chosen on a payment approve prompt** (the Auto-pay checkbox). Once Auto-pay is on, silent `createAction` stays within the UTC calendar-month total from `spendingAuthorization` (instead of the default `$` / hours window). Disconnect clears the grant.

Settings still expose Auto-pay (`$` / rolling hours) when no spendingAuthorization grant is present.

## How do we detect double-spends?

Wallet Activity and ARC reject paths surface already-spent / competing spends. HandCash does **not** currently offer a partner webhook for double-spend events — poll your own receivers / chain watchers.

Stable BRC-100 error codes from `createAction` / `signAction` include:

| Code | Meaning |
|------|---------|
| `CHANGE_CHAINING_REQUIRED` | Pending change covers the ask; retry shortly |
| `INSUFFICIENT_FUNDS` | Confirmed + confirming still short |
| `DOUBLE_SPENT` | Input already spent / mempool conflict |
| `OFFLINE_PAYMENTS_DISABLED` | Device offline |
| `ACTION_DENIED` | User declined |

## Where is the changelog?

GitHub Releases for Desktop (`v1.3.x`) and Mobile (`v0.1.x`). Installers/APKs attach to those tags.

## When does HandCash leave beta?

**No leave-beta ETA** is published. Treat the product as beta until an official announcement says otherwise.
