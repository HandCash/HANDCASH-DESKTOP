# Moving from the old HandCash app

One path on Desktop and Mobile. It never reads, copies or trusts a login the
old app left behind, and the old account's keys reach this wallet only as an
encrypted export the user asked for.

## Flow

1. **Onboarding → Recover an old HandCash wallet.** Arms the
   `cloudMigrationIntent` checkpoint (`src/wallet/cloudMigrationIntent.ts`).
   If the checkpoint cannot be written, onboarding stops with an error.
2. **Create the new vault first.** The receiving wallet exists, protected,
   before anything from the old account arrives.
3. **Unlock consumes the checkpoint** once: Settings → Import opens on the
   HandCash two-key form, and handcash.io/migrate opens in the browser.
4. **The user signs in on handcash.io** (HandCash's own auth) and exports.
   Two ways in, both on the authenticated BRC-100 bridge from migration
   origins only (`handcash.io`, `market.handcash.io`, `preprod-market.handcash.io`):
   - `beginHandCashImport` / `completeHandCashImport`
     (`src/wallet/import/encryptedImport.ts`): a one-time receiver key,
     valid 5 minutes, seals the exported shares in transit. It never signs.
     The source is saved; decrypted shares are never returned.
   - `openKeyRecoveryPayload`: brings Import forward for a pasted export.
     Optional history hints only speed up the scan.
5. **Scan, preview, confirm.** Nothing moves until the user confirms a sweep
   on the preview.

## Deliberately absent

- No detection of a kept cloud login after install-over. The retired
  `handcash.cloud.priorSession.v1` record had no writer on any platform and is
  only reclaimed.
- No reading of another app's SharedPreferences, Keychain or tokens.
- No silent sweep, no key shown on screen, no migrate methods for other origins.
