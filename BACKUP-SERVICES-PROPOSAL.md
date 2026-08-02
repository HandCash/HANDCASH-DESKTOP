# Proposal: Pluggable Backup Services (Trustholder Evolution)

**Status:** Draft — implementation on branch `feat/backup-services` (not merged)  
**Audience:** Product, custody, cloud/backend, Desktop  
**Date:** 2026-08-02  
**Related:** HandCash Desktop self-custody (BRC-75 / BRC-140 / BRC-39 / BRC-100); legacy web/mobile trustholder + TSS  
**Defaults:** Curated backup-service URL list ships **empty**. Local OSS tool lives in `backup-service/`.

---

## Summary

Evolve “trustholders” from **spend-time co-signers** into optional **backup services**: independent providers that store Shamir recovery slices and release them only after the user authenticates.

Desktop remains self-custodial. Keys live on the user’s device. Backup services are disaster recovery aids — not required to send, connect, or use the wallet day to day.

**Target recovery rule (opt-in):** if the user enrolled three backup services under a 2-of-3 scheme, they can restore by authenticating to any two of those services — even if the device and all offline copies are gone.

---

## Problem

1. **Legacy model liability** — TSS / dual trustholder co-signing keeps HandCash in the spend path and creates long-term recovery expectations.
2. **Pure local backup friction** — Phrase / BRC-140 / emergency key are correct for self-custody, but many users will lose the only device and never finish offline backup.
3. **Babbage-shaped expectation** — Metanet users know “phone/OTP + provider helps me get back in.” We want that convenience without re-owning custody of every payment.
4. **Shutdown story** — If HandCash shuts down, users who only depended on our live services are stranded. Users with on-device keys + offline backup are not.

---

## Goals

| Goal | Intent |
|------|--------|
| Reduce company liability | Default path is BRC self-custody; company is not needed to spend |
| Optional convenience recovery | Users may enroll backup services for device-loss recovery |
| Pluggable providers | A **list** of backup service URLs — not a single hardcoded vendor |
| HandCash can participate later | Ship zero, then one, then two HandCash-operated services as curated defaults — still removable |
| Generic product language | User-facing copy does not say “us” / “HandCash recovers you” |
| Compatible crypto | Prefer BRC-140-style Shamir shares (`x.y.threshold.integrity`) already in Desktop |
| Operator lifecycle | Backup services can announce planned shutdown so users have time to rotate slices |

## Non-goals (v1)

- Replacing Desktop local vault with TSS co-signing
- Requiring backup services for send / BRC-100 connect
- Making HandCash the only recovery path
- Multi-device sync of full wallet history (that remains BRC-39 / storage — separate track)
- Mandating phone auth (email OTP is enough for v1 if the service supports it)

---

## Product framing

### User-facing terms

Prefer **backup service** / **recovery provider**. Reserve “trustholder” for internal/legacy docs.

Suggested copy (generic — no “we”):

- *Optional backup services can store recovery slices for you.*
- *If this device is lost, you can restore by authenticating with enough of the backup services you enrolled — for example any two of three.*
- *Your wallet keys stay on your device. Backup services only help you recover if you choose to use them.*
- *You can also recover with your own offline backup (phrase, key slices, or emergency key) without any service.*

### Mental model

| Legacy trustholder | Backup service |
|--------------------|----------------|
| Co-signs spends | Holds one recovery slice |
| Required for account use | Never required for day-to-day use |
| “Keyless” / company in the loop | Self-custody + optional disaster aid |
| HandCash recovers the account | User restores using services they enrolled |

---

## Cryptographic model

### Scheme

- Split the Desktop **root private key** with Shamir Secret Sharing.
- Default enrollment for service-backed recovery: **threshold = 2**, **total = 3**.
- Deposit **one share per backup service** (three services → three shares).
- Reconstruct locally in Desktop after fetching enough shares; then re-wrap into the normal password vault.

Share format: align with existing Desktop BRC-140 strings (`x.y.threshold.integrity`) so offline and service paths teach one concept.

### Recovery paths (priority order)

1. **Offline** — phrase (BRC-75), user-held BRC-140 slices, or emergency hex (already shipped).
2. **Backup services** — authenticate to ≥ threshold enrolled services; combine shares; restore vault.
3. **Hybrid** — one local slice + one service (nice-to-have; not required if 2-of-3 services is the opted-in plan).

### Security properties

| Property | Behavior |
|----------|----------|
| Single service compromised | Cannot reconstruct (1-of-3) |
| Two services collude / both breached after user auth | Can reconstruct — accepted tradeoff of 2-of-3 service recovery |
| User loses device + all offline backups | Still recoverable if they can auth to any two enrolled services |
| HandCash shuts down all its services | Users with offline backup or non-HC services remain recoverable; HC-only enrollees are not |
| Day-to-day spend | Never talks to backup services |

### Auth to release a share (open decision)

| Option | UX | Risk |
|--------|----|------|
| **A. OTP only** (email/phone) | Closest to Babbage convenience | Inbox / SIM-swap → share release |
| **B. OTP + wallet password / recovery PIN** | Slightly harder | Stolen inbox alone insufficient |
| **Recommendation** | **B for HandCash-operated services**; allow A for third-party services that choose it | Document per-service in `/info` |

---

## Comparison: Babbage WAB vs this proposal

| | Babbage WAB (typical) | This proposal |
|--|----------------------|---------------|
| Role of server | Presentation key and/or one Shamir share | One Shamir share only |
| Provider count | Usually one configured WAB URL | **List** of backup services |
| Non-custodial Shamir constraint | Often: user must hold ≥ threshold shares | **Opt-in path:** 2-of-3 **services** may meet threshold without user-held shares |
| Spend path | Unrelated once unlocked | Unrelated always |
| Positioning | Wallet auth backend | **Backup service** |

Legacy HandCash TSS remains a separate (declining) model: partial signatures at spend time. This proposal does **not** extend TSS to Desktop.

---

## On-device keys (baseline this builds on)

Desktop already:

- Password-wraps the root key (AES-256-GCM, PBKDF2 ~210k SHA-256)
- OS-seals the vault blob when Electron `safeStorage` is available
- Supports offline backup: BRC-140, phrase, emergency hex; history via BRC-39
- Gates spend until keys + history backup are confirmed (evidence-based UX)

Backup services complement that stack; they do not replace password, OS seal, or offline backup.

**Honest limits of on-device keys:** strong against casual disk theft and other local accounts (when sealed); weak against weak passwords, malware on an unlocked session, and total device loss without any backup path enrolled.

---

## Architecture

```
┌────────────────────────────────────────────────────┐
│ HandCash Desktop                                   │
│  • Local vault (password + OS seal)                │
│  • BRC-140 split / restore                         │
│  • Settings: list of backup service URLs           │
│  • Enroll: deposit one share per service after auth│
│  • Recover: fetch ≥2 shares → reconstruct → vault  │
└───────────────┬────────────────────┬───────────────┘
                │                    │
                ▼                    ▼
     ┌──────────────────┐ ┌──────────────────┐
     │ Backup service A │ │ Backup service B │ …
     │ /info            │ │ OTP → release    │
     │ /share/enroll    │ └──────────────────┘
     │ /share/retrieve  │
     │ /share/rotate    │
     │ /share/delete    │
     └──────────────────┘
```

### Desktop responsibilities

- Maintain durable prefs: `backupServices: [{ url, label, enrolledAt, shareIndex? }]`
- Mint shares; never send the root key or more than one share to a given service
- Confirm “service backup ready” only after successful deposits meeting the chosen scheme
- Recovery UI: pick services → auth → combine → restore
- Keep existing offline backup UX as first-class

### Backup service API (sketch)

Each provider exposes a small HTTP API (names illustrative):

| Method | Purpose |
|--------|---------|
| `GET /info` | Display name, auth methods, pubkey, policy flags, **lifecycle** (see below) |
| `POST /share/enroll` | After auth: store exactly one share for `userIdHash` |
| `POST /share/retrieve` | After auth: return that share |
| `POST /share/rotate` | Replace share (re-enroll after recovery) |
| `POST /share/delete` | User-initiated deletion |
| Auth | Reuse email/phone OTP patterns familiar from current trustholder clients |

**Invariant:** a service stores at most one share per user and never receives enough shares to meet threshold alone.

### Operator lifecycle / shutdown signaling

Backup services (trustholders) **communicate planned shutdown** so enrolled users can rotate slices to other providers before the service goes dark.

`GET /info` includes a lifecycle block (illustrative):

```json
{
  "name": "Example Backup",
  "status": "active",
  "lifecycle": {
    "status": "active" | "sunset" | "retired",
    "sunsetAt": "2027-03-01T00:00:00Z",
    "retireAt": "2027-06-01T00:00:00Z",
    "message": "This provider is shutting down. Rotate your backup slice before retireAt.",
    "successorUrl": "https://other-backup.example.com"
  }
}
```

| Status | Meaning |
|--------|---------|
| `active` | Normal enroll + retrieve |
| `sunset` | Still serving; **no new enrolls** (or warn-only); Desktop urges rotate before `retireAt` |
| `retired` | Gone or read-only final window; Desktop treats as dead after `retireAt` |

**Desktop behavior**

1. Periodically refresh `/info` for each enrolled URL (on launch + daily is enough).
2. If `sunset` / approaching `retireAt`: toast + Settings badge — *“A backup service is shutting down. Rotate your recovery slices.”*
3. One-click **Rotate**: retrieve from the sunsetting service (while it still answers) → deposit to a replacement from the user’s list (or `successorUrl`) → delete old enrollment.
4. If two of three are healthy, recovery remains possible during the grace window even if the user is slow — the point of threshold.

**Operator norms (OSS README + HC-run services)**

- Announce `sunset` with a **minimum grace period** (recommend ≥ 90 days before `retireAt`).
- Keep **retrieve** working through the grace window even if enroll is disabled.
- Optional `successorUrl` for migrations; user must still authenticate to the successor and re-deposit (never silently move shares between operators).
- Abrupt death without signaling remains possible — offline BRC backup is still the backstop.

### HandCash cloud / backend

| Work | Needed? | Notes |
|------|---------|-------|
| Share-vault capability on trustholder (or new service) | **Yes** | Today’s trustholder is oriented to TSS + email login, not BRC-140 slice storage |
| Identity binding (email/handle ↔ `userIdHash`) | Likely | So enroll/recover is stable across devices |
| TSS `/sign` for Desktop recovery | **No** | Assemble root once locally |
| Operate 2–3 deployments for end state | For HC defaults | Can start with protocol + empty curated list |
| BRC-39 history hosting | Separate track | Key recovery ≠ transaction history |

No backend change is required for users who only use offline BRC backup.

---

## Liability and shutdown

| Scenario | Outcome |
|----------|---------|
| Company shuts down; user has device | Keys remain on device |
| Company shuts down; user has offline BRC backup | Fully recoverable elsewhere |
| Operator announces sunset | Users get time to rotate slices to other backup services |
| Operator vanishes with no signal | Enrolled slice is gone; other shares / offline backup must cover threshold |
| User only enrolled HC backup services; all retire without rotate | Recovery via those services fails — disclose at enroll + on sunset warnings |
| User enrolled mixed / third-party services | May still recover without HandCash |

**Positioning for counsel / support:** HandCash ships a self-custodial wallet. Backup services (including any HandCash-operated ones) are optional slice storage with disclosed trust assumptions — not a promise that “HandCash can always get your money back.” Planned shutdown is communicated so users can rotate; it is not a guarantee against sudden outage.

---

## Phased delivery

### Phase 0 — Now (done / in progress)

- Local vault, password policy, OS seal warning
- Offline keys backup (BRC-140 / phrase / hex) + history (BRC-39)
- Spend gates on confirmed backups
- No backup-service network dependency

### Phase 1 — Protocol + Desktop client

- Settings: **Backup services** list (add/remove URL)
- Enroll / retrieve / restore flows against a mock or staging service
- Generic copy and disclosure checklist at enroll
- Poll `/info` lifecycle; sunset warnings + rotate flow

### Phase 2 — HandCash backup service v1

- Evolve trustholder (or new deploy) to share-vault API + OTP
- Optional: password/PIN binding for retrieve
- Curated default entries (0–2) in Desktop; user can clear them
- Lifecycle fields on `/info`; practice a staged sunset in staging

### Phase 3 — Multi-provider defaults

- Second HandCash-operated service and/or partner-compatible endpoint
- Recommend 2-of-3 enrollment UX
- Rotate after recovery; support delete
- Open-source backup-service binary so anyone can run a provider (same lifecycle contract)

### Explicitly later

- Third-party directory / attestations
- Hardware-backed factors
- Formal BRC if BSVA wants a “backup service” interoperable profile

---

## Open questions

1. **Retrieve auth:** OTP-only vs OTP + password/PIN for HC-operated services?
2. **Default list:** ~~ship empty, or pre-seed staging URLs?~~ → **Ship empty** (decided).
3. **Account identity:** anonymous `userIdHash` only, or link to HandCash handle/email via cloud?
4. **History:** should “backup ready” for spend require BRC-39 offline/URL only, or also allow a future history backup service?
5. **Legal entity split:** should HC-operated services run as separate deploy/legal units for optics and blast-radius?
6. **Compatibility:** aim for wire compatibility with wallet-toolbox Shamir/WAB share APIs, or HandCash-defined v1 first?
7. **Sunset grace:** require ≥ 90 days in the OSS norm, or leave minimum to each operator with Desktop only warning on `retireAt`?

---

## Recommendation

1. **Frame as backup services** in all user-facing surfaces; keep “trustholder” internal/legacy.
2. **Keep BRC local backup as the default liability story** — keys on device; company not in the spend path.
3. **Offer opt-in 2-of-3 backup-service recovery** for users who want device-loss protection without babysitting paper shares.
4. **Build share-vault backend** (evolve trustholder); do not bring TSS co-signing into Desktop.
5. **HandCash’s two services** land as curated list entries later — replaceable, disclosed, never the only recovery story in marketing.

---

## Ask

1. Product sign-off on framing + 2-of-3 opt-in recovery rule.  
2. Custody/legal quick read on backup-service disclosure and retrieve-auth choice (A vs B).  
3. Backend ownership for share-vault API on trustholder vs greenfield.  
4. Greenlight Phase 1 Desktop list + mock enroll/recover against staging.
