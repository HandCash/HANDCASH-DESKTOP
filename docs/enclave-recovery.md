# Enclave recovery (design)

Status: plan only, no code. Behind the "Secure enclave recovery is coming" line in Settings, HandCash Recovery.

Enclave recovery is the fallback for someone who has lost every signed-in device. It is not sign-in. A new device signs in with an email code plus approval from a device that is already signed in, and HandCash only relays. Enclave recovery is used only when no device is left to approve. The recovery phrase, the three BRC-140 slices and the emergency key stay available next to it.

## Goals

- A user who lost every device gets the wallet back without having saved a phrase or slices.
- No single party can recover the wallet: not HandCash, not Haste, not Google, and not someone who has taken over the user's email.
- Every release is slow, public and stoppable: it waits, alerts every device and the email address, can be cancelled, and is logged on Bitcoin SV before any share leaves a holder.
- Holders carry as little liability as possible. They keep one sealed share, see no balances, never co-sign and never hold the whole key.

## Non-goals

- Signing in on a new device (see `signin-separate-from-recovery`).
- Co-signing or spend limits. Holders never sign transactions.
- Replacing the recovery phrase, the slices or the emergency key.

## The split

The wallet's master key is split 2-of-3 with BRC-140 (`createBrc140Shares` in `src/wallet/brc140Backup.ts`, which already defaults to a threshold of 2 out of 3):

| Share | Holder | Released after |
| --- | --- | --- |
| A | HandCash's enclave | the user's passkey, then the wait |
| B | Haste's enclave | an email code, then the wait |
| C | the user's device, in the OS keychain apart from wallet data | the device being unlocked |

Recovery after losing every device uses A and B. Share C covers a device whose wallet data is gone but whose keychain survived. With C plus one enclave share, only that holder's check and wait apply.

Each enclave holder speaks BRC-154 (Pluggable Backup Services for BRC-140 Share Vaults). It stores at most one share per account, the wallet never sends one holder enough shares to reach the threshold, and the key is rebuilt only on the user's device.

What each holder keeps:

- One share, sealed to the enclave's own key, so the operator's database and staff only ever see ciphertext.
- Keyed hashes (HMAC under an enclave-held key) of the account's lookup values: the passkey credential ID or the email address, and the wallet's authority public key. These are used to find the record, never to read it.
- The alert email address, sealed to the enclave like the share, because alerts have to reach it.
- Nothing about balances, addresses, transactions or the wallet's identity key.

A release hands back the share encrypted to a key the recovering device makes for that release. The enclave never sees the other share, so it can never rebuild the key.

## Each holder's own check

Google sign-in alone never reaches the threshold. Under `recovery-check-independent-of-google`, at most one holder may release on Google sign-in alone, and every other holder needs a check of its own. This design goes further: neither enclave accepts Google sign-in as a release check.

- **HandCash's enclave: a passkey.** It is registered at enrollment, and the enclave checks the WebAuthn assertion itself. A passkey synced only through Google Password Manager is hosted by Google and doesn't count; see the open questions.
- **Haste's enclave: an email code.** The code is sent by Haste's own sender, reusing the logic in `BRC-CLOUD/src/emailOtp.js` and `src/otpChallenges.js`: a hashed code, 10 minutes to live, 5 tries, 3 sends per 10 minutes. An inbox hosted by Google (Gmail, or a domain whose mail goes through Google) doesn't count. If the user only has such an inbox, Haste asks for a second passkey instead, from a different provider than the one HandCash checks.

A single compromise can therefore reach at most one share: a Google account, an inbox, a passkey provider, HandCash or Haste.

## Release

1. The recovering device makes a fresh release key and asks both holders, sending a signed request (reusing `signedFetch` and `walletAuthorityKey` in `src/wallet/signedRequest.ts`, and the worker's `verifyRequestSignature` and `used_nonces` replay guard).
2. Each holder runs its own check, as described above.
3. Before anything else, each holder writes a release record to Bitcoin SV: holder ID, the keyed account hash, a hash of the release key and the release time. The share is not released unless the transaction is accepted.
4. Each holder alerts every signed-in device of the account (through the BRC-CLOUD message box and the device list) and the email address: "A recovery of your HandCash wallet starts on <date>. Not you? Cancel it."
5. The release waits. It starts at 7 days (`RELEASE_WAIT_MS` in today's worker). It never shortens on its own, and a device seen recently restarts the wait (today's worker answers `device-returned` in that case).
6. Any signed-in device, or the cancel link in the email, cancels the release on both holders. The cancellation is logged on Bitcoin SV too.
7. When the wait ends, each holder checks again that the release wasn't cancelled and that no device has been seen since. It then returns its share sealed to the release key (reusing `sealToPublicKey`, removed from `workers/brc250-google/src/protocol.js` in BRC-CLOUD 57e43b9 and recoverable from its parent: ECDH, HKDF, AES-GCM; the device opens it with `openSealedShare` in `src/wallet/sealedShare.ts`) and logs the release on Bitcoin SV.
8. The device rebuilds the key locally (`recoverRootKeyFromBrc140Shares`), shows the recovery on its Activity row from start to finish, and asks the user to move the funds to a new key (see the refresh limits below).

A release can't be approved twice. Each step moves the request forward once (the worker's guarded `UPDATE ... WHERE state = ...`), and a release key is good for one release only.

## Reproducible builds fingerprinted on Bitcoin SV

- Both enclaves run only HandCash's enclave image, built reproducibly from a tagged commit. Haste runs the same image that HandCash runs.
- For each release, HandCash publishes the image's measurement (the enclave platform's code hash) in a Bitcoin SV transaction signed by HandCash's release key. Anyone can rebuild from source and compare.
- Before sending a share or a release request, Desktop checks the enclave's attestation. The measurement must match an on-chain fingerprint, and the attested public key must be the key the share is sealed to. A holder that fails the check gets nothing.
- A new image can unseal old shares only through a migration that the old image allows. That migration is itself fingerprinted, so an operator can't swap in a build that hands shares out.

## Refresh limits

Refreshing re-splits the same key and replaces the holders' shares. It only voids leaked shares from past versions that fell short of the threshold. It can't undo:

- a version leaked at threshold (for example, A and B both taken);
- the recovery phrase or the emergency key;
- BRC-140 slices the user downloaded;
- a device that was removed but kept its copy.

Only a new key, with the funds moved to it, fixes those. Desktop says so whenever it offers a refresh, and moving funds is the next step after every completed recovery.

## What exists today

| Piece | Where | Reuse |
| --- | --- | --- |
| 2-of-3 split and local rebuild | `src/wallet/brc140Backup.ts` | as is |
| BRC-154 server shape, `/info` lifecycle block | `BRC-CLOUD/src/trustholder.mjs` | rewrite routes to the published profile |
| Email codes, hashed, rate limited | `BRC-CLOUD/src/emailOtp.js`, `src/otpChallenges.js` | Haste's check; `sendNoticeEmail` for alerts |
| Signed requests, replay guard | `workers/brc250-google/src/protocol.js`, `index.js` | as is |
| Signed requests from the wallet, authority key | `src/wallet/signedRequest.ts` | as is |
| Seal a share to the device | `sealToPublicKey` (in `protocol.js` before 57e43b9) | restore from history |
| Open a sealed share on the device | `openSealedShare` in `src/wallet/sealedShare.ts` | as is |
| Saved Google recovery enrollments | `src/wallet/legacyGoogleRecovery.ts` | find users to move off the Google worker |
| Release wait, device presence, refuse | `workers/brc250-google/src/index.js` (`release`, `presence`, `refuse`) | basis for wait and cancel |
| Signed-in device list | `src/wallet/deviceSignin`, `src/wallet/scanLogin` | alert targets and cancel |

Gaps in today's code that this design closes:

- **The Google worker reaches the threshold through Google.** It holds share 0, releases it after Google sign-in and the wait, and share 1 is emailed to the user's inbox, which is usually Gmail. Google sign-in plus a Google-hosted inbox then makes 2 of 3.
- **The Google worker stores its share in plain text.** `host_share` is a plain D1 column, with no enclave and no sealing.
- **No release is logged on-chain, and the only alert is to the device that started the release.** Signed-in devices see pending requests only when they poll, and nothing is emailed.
- **`trustholder.mjs` predates the published BRC-154 profile.** It serves `GET/PUT/DELETE /share`, not `POST /share/enroll|retrieve|rotate|delete`, keeps a JSON file store, and accepts `dev-token` auth. BRC-CLOUD answers 410 on these routes (`ENABLE_LEGACY_TRUSTHOLDERS` is `false`).

## Steps

1. The lawyer reviews this design and confirms it is non-custodial. Nothing below ships before that.
2. Bring `trustholder.mjs` to the published BRC-154 routes, with `webauthn` and `email-otp` auth, sealed storage and keyed lookups. Test it against the spec's invariants: one share per account, BRC-140 strings only, the bearer token bound to the account.
3. Build the enclave image reproducibly, publish its fingerprint on Bitcoin SV, and add attestation checks to Desktop.
4. Add the release log on Bitcoin SV, alerts to every device and the email address, and cancel from any device or the email link, each with tests that fail first.
5. Desktop enrollment: replace "Secure enclave recovery is coming" with set-up, saved status per holder, and recovery shown on its Activity row.
6. Bring on Haste: the same image, its own email sender and its own domain, and an operating agreement.
7. Retire the Google worker: set its lifecycle to `sunset`, ask enrolled users to move to enclave recovery and then move their funds to a new key, and delete the stored host shares at `retireAt`.

## Open questions

- **Lawyer:** is this setup non-custodial, given that HandCash and Haste each run a holder and together hold the threshold, even if only inside enclaves that release after the user's checks? Is Haste's role a custodian, a service provider or neither, and in which countries?
- **Collusion:** A and B together reach the threshold. Is the protection from attestation, on-chain logs and the wait enough, or should a third, independent enclave raise the split to 2-of-3 without HandCash?
- **Passkeys hosted by Google:** passkeys synced through Google Password Manager are hosted by Google. Do we refuse them, require a hardware key, or require that HandCash's and Haste's checks use different providers?
- **Inbox detection:** how do we tell that a custom domain's mail goes through Google (MX records at enrollment, rechecked at release)?
- **Enclave platform:** AWS Nitro, Intel TDX or another platform? Each has a different attestation format, vendor trust and cost, and Haste has to be able to run the same one.
- **Wait length:** is 7 days right, can the user choose a longer wait at enrollment, and what happens when one holder's wait has ended and the other's hasn't?
- **Alerts without HandCash:** if HandCash's servers are down, how do Haste's alerts reach the user's devices? Its own email only, or its own message box?
- **On-chain record:** who pays the fees, what exactly is written so the account can't be linked across releases, and what happens to a release while Bitcoin SV can't be reached?
- **Share C:** is the keychain copy worth having, given that losing every device usually means losing the keychain too?
- **Live Google users:** how long a sunset window do they get, and what happens to users who never return?
