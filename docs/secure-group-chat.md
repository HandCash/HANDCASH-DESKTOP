# Secure HandCash group chat — design gate

Status: design only; no group capability, UI, membership changes or keys enabled.
Equal members are confirmed. A mandatory host was explicitly retracted.
This feature is separate from Desktop 1.3.667 / Mobile 0.1.780 release work.
The interrupted peer-call presentation work remains preserved under
`.feature-peer-chat/`; it is not a completed call UI.

## Evidence from this checkout

- `messageEnvelope.ts` seals one sender-to-recipient BRC-78 body inside a
  BRC-169 envelope. Its signature covers envelope metadata, not a group
  transcript. It has no group ID, membership epoch or group replay log.
- `messageTransport.ts` uses BRC-33 or live draft-BRC-246 pairwise channels.
  `plaintextFromPeer` also accepts legacy unsealed input. A secure group
  handler must not inherit that compatibility exception.
- `messageStore.ts` models threads by peer ID; it has no authenticated
  sender/epoch record for a group thread.
- `calls/callWire.ts` supports a six-seat mesh with an initiating host's
  roster. This is live call coordination, not persistent group membership,
  invitation consent, removal authorization or group key rotation.
- `calls/mediaKeys.ts` derives pairwise call keys. It is not a group-chat
  key schedule and must not be repurposed as one.
- Draft BRC-246 §§2–6 defines endpoints and message delivery, not group
  authorization. The dependent peer-messaging proposal leaves groups to
  implementers. No secure group membership/key-management protocol was
  found in these inspected paths.

## Confirmed boundary

All members have equal rights by default. Creating a group does not confer
an owner role. A transport coordinator may route opaque ciphertext or order
candidate commits; it cannot authorize membership, decrypt anything that
its own membership does not allow, alter history or override approvals.
Its failure or replacement cannot change permissions. No host succession
is needed; coordinator replacement must preserve the verified transcript.

Chat authentication signatures authorize communication only. Never route
group events into payment cards, signing approvals, account selection,
account holding, release, handover or ownership transfer. No Telegram
credentials or local Telegram data are involved.

## Open product decisions — do not choose implicitly

1. Additions: unanimous current-member consent, majority consent, or any
   member's invitation? The invitee must explicitly accept in every case.
   Unanimity preserves everyone's consent but can stall on an offline
   member; majority improves availability but permits overruled members;
   any-member additions expose future conversation to that member's choice.
2. Removals: consent of all remaining members, a defined majority of them,
   or no removal (create a new group instead)? Self-leave needs no vote.
   Define electorate, threshold, expiry and concurrent-vote handling before
   implementation; never let a coordinator break ties.
3. History: proposed privacy default is no earlier messages for new members.
   Any deliberate history sharing needs a separate explicit action and
   policy decision, not an automatic key export.

Choices must be recorded in authenticated group configuration, not just
local Settings. Policy changes themselves require a defined approval rule;
no policy change is implemented while that rule remains unresolved.

## Required security contract (not implemented)

- **Authenticated membership:** use identity-bound, dedicated communication
  credentials and per-client keys. Define credential verification, expiry,
  revocation and device recovery. A display name, handle, install ID,
  backup pairing or account-holding record is not membership proof.
- **Explicit invitations:** bind group ID, inviter, intended invitee,
  proposed roster, policy digest, current epoch/transcript, unique nonce and
  expiry to the authenticated invitation and acceptance. Acceptance cannot
  be simulated by delivery ACK, opening a chat, focus or a keyboard default.
  Show the roster and applicable policy before acceptance. Existing members
  receive verifiable membership-change notices; no silent addition.
- **Membership commits:** validate the chosen approval policy against the
  prior committed roster. Each commit binds its predecessor and new roster.
  Reject replay, expired consent, unknown credentials, duplicate members,
  forged approvals, wrong-group proofs and rollback. Detect conflicting
  commits; stop sending until resolved instead of accepting both branches.
- **Removal and rotation:** every accepted join, leave or removal advances
  the epoch with fresh secrets. A removed member receives no new secrets or
  future plaintext. Do not send during an unresolved local membership/key
  transition. Offline clients apply and verify missed commits before sending.
  Queued messages must not leak to newly removed recipients on retry.
  Define delayed old-epoch delivery limits; old ciphertext must not bypass
  current admission/removal rules.
- **Delivery:** authenticate group ID, epoch, transcript binding, sender,
  content type and message ID as well as content. Enforce bounded sizes,
  replay tracking, rate limits and durable deduplication across direct and
  box paths. Unknown/future epochs wait in bounded quarantine, never become
  plaintext fallback. Attachments use equally protected keys and references.
- **Limits of secrecy:** authorized members can copy what they can read.
  Removal cannot retract past plaintext, screenshots or exported keys.
  Messagebox operators can observe routing/timing metadata; encryption is
  not anonymity. Neither a coordinator nor an administrator gains access to
  separate one-to-one threads.
- **Durability:** commit membership state and ratchet state atomically with
  anti-rollback protection before acknowledging. Define crash recovery,
  multi-device membership, old-secret deletion and backup behavior; wallet
  BRC-39 recovery must not silently restore stale chat membership or keys.

## Key-management options to evaluate

**Pairwise fan-out:** fits current BRC-33 routing, but creates one ciphertext
per recipient. Signed group context and consistent membership commits are
still required. The existing static identity-derived envelope alone does
not establish forward secrecy or post-compromise recovery. Do not label
fan-out as equivalent to a secure group ratchet.

**MLS:** RFC 9420 defines asynchronous group key establishment, epoch
changes, forward secrecy and post-compromise security. It does not choose
the application's membership permissions. Evaluate a maintained, reviewed,
license-compatible implementation and its browser/Mobile bindings rather
than implementing cryptography here. Define credential binding to HandCash,
commit ordering, delivery integration, persistent state and recovery first.
No dependency or wire-format choice is made in this document.

Reference: [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html),
especially §§5.3, 12, 14, 16.6 and 16.11.

## Chart and verification plan

After policy and crypto-adapter decisions, build and register an executable
chart before JSX:
`unsupported → invited → validating → joining → active`, with
`changingMembership/rekeying`, `resyncing`, `conflicted`, `left`,
`removed` and named `failed` states. These are proposed states, not a claim
that an executable machine exists. Sending is allowed only from a verified
active epoch; UI renders that snapshot through Aeon. Keep delivery and
membership consensus separate from wallet coordination charts.

Drive the real actor with fake crypto/delivery actors. Cover explicit
acceptance, unauthorized adds/removals, spoofed sender, wrong group/epoch,
replay, conflicting commits, offline approval, stale outbox, removal before
retry, fresh keys excluding removed members, crash rollback, bounded
quarantine and voluntary leave. Add assertions that no wallet signing,
payment or ownership operation is invoked. Use reviewed crypto test vectors
for the selected implementation; fake-actor tests do not prove encryption.
Then run focused communication/security tests, Aeon adherence, both
typechecks and a synthetic-data UI fixture. Physical peer/Mobile/NAT checks
remain separate, approval-gated where paid probes are involved.
