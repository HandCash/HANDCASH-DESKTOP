# BNT / IPT delivery gates

Checked 2026-11-18. This is a delivery plan, not a claim of protocol completion.
Tasks: `fec42551-0109-4e36-9033-db7002e2e675` (integration/market),
`e6a139e8-832a-4e55-a361-ce0e7beefc08` (IPT wallet),
`5e71459e-ef67-4d87-a630-b0292bd0bcd1` (step proofs).

## Current baseline

Source reviewed at origin/master `e4f411b0`; this chat's isolated worktree starts
at `df8c4729` (Activity isolation). Do not alter that worker's changes.
`38727d46` already carries the IPT key-namespace plumbing; do not redo it.
Local vendored drafts are not evidence that all current upstream requirements ship.

Update 2026-11-19: this plan and the step-1 slice first landed in `9d11bb7c`;
`f94ddedd` silently reverted them and they are restored on top of `dac85c1b`.
Since then `9f8742e4` added `beacon.ts` (beacon-chain discovery and a bounded
beacon package, `MAX_BEACON_CHAIN`) and a key-set release check in `release.ts`
which `validity.ts` now calls, and `dac85c1b` makes `carryBack` keep the issuer and
release clause for countersigned deploys. Beacon discovery is exercised only by
`beacon.test.ts`; no runtime receipt path calls it yet, and the receipt gates below
still stand.

Authoritative upstream documents checked on 2026-11-18, pinned to BRCs
`9150386334fe1411a295ee1f2e354f215f93339e`:
[BRC-252](https://github.com/bsv-blockchain/BRCs/blob/master/tokens/0252.md),
[BRC-253](https://github.com/bsv-blockchain/BRCs/blob/master/tokens/0253.md),
[BRC-254](https://github.com/bsv-blockchain/BRCs/blob/master/tokens/0254.md),
[BRC-255](https://github.com/bsv-blockchain/BRCs/blob/master/tokens/0255.md).
These are open proposals. The reviewed upstream SHA is recorded above; links use
master for discovery, not as a release pin. SHA-256 comparisons found all four
vendored files differ from this upstream revision; semantic reconciliation must
use the upstream text, not assume the vendored copies are current.

| Area | Current source evidence | Release status |
|---|---|---|
| Open BNT | `wallet.ts` issue/mint/transfer; `wallet.test.ts`; `validity.ts` walk | Existing implementation, mocked tests are not a live transcript |
| IPT keys/deploy fields | `keys.ts`, `payload.ts`, `iptKeys.test.ts`, `handleCard.test.ts` | Partial implementation, not an end-to-end IPT wallet |
| IPT signing | `wallet.ts` wraps planned signatures with `bntOpenUnlock`; `carryBack` keeps countersign clauses since `dac85c1b` | Must not advertise working countersigned mint/transfer |
| IPT receipt | `wallet.ts:1754,1764` returns retry for countersigned mode | Deliberately uncredited/unACKed; do not remove gates alone |
| Release validation | `release.ts` checks hash and key-set release; `beacon.ts` discovers and packages a beacon chain (`9f8742e4`) | Discovery and beacon packages not wired into receipt; no durable beacon service |
| Finality | `validity.ts` requires tracker-verified mining for shared issuer/released paths | Runtime does not supply the release context to its walk |
| Proof transport | `proof.ts` carries EF/deploy/backing; `store.ts` persists EF | Merkle paths, release disclosure and step proof transport still missing |
| Market | `marketListing.ts:1514`, `marketSettlement.ts:719` reject nonordinal filings | Ordinal flows only; BNT/IPT listing/buyback/direct offers unsupported |

## Dependency order and acceptance gates

### 1. Bound proof transport (integration task)

Keep the existing full-walk verdict. A partial package must fit both byte and
transaction limits and remain readable; missing history is fetched, never assumed
valid. This slice fixes the builder's missing combined transaction-count bound.
Test subject + deploys + ancestors at the limit, both cut paths and receiver refusal
over the limit. Do not interpret unknown `steps` as validation.

Next slice: transport and persist mined evidence and release chains with explicit
size/count limits, asset binding and tracker verification. Exercise restart,
missing/invalid proofs, wrong parent script/satoshis and offline retry. Never store
an unverified frontier as validated. Review storage-lock scope before adding network
work to the current `serveBntBox`/`runExclusiveSpend` receipt path.

### 2. Durable countersigning (IPT task; requires transport fixtures)

Implement BRC-253 §§3–8 as a request state machine and durable acceptor ledger,
not another signature appended to `signBntAction`. Bind requests, holder proofs,
outputs, reservations and terminal decisions. Enforce idempotency and restart-safe
conflict handling; verify decision signatures and linkage. Keep inputs reserved
until an authenticated terminal outcome; never abort a broadcast transaction.

Start with single-issuer, acceptor-funded transfers. Add shared issuers and
sender-funded trades only with their separate finality rules. Prove issue, mint,
change/authority preservation, burn, transfer, receipt and replacement using actual
script signatures. Test replay, altered outputs, cancellation/acceptance races,
duplicate inputs, missing response and restart. Preserve `iptft`/`iptnft` filing and
IPT labels. Only then remove each receipt gate with an end-to-end regression.

#### Local acceptor primitives (2026-11-19; not enabled)

`iptProposal.ts` now supplies `iptRequestId` (SHA-256 of exact bounded EF),
`validateIptProposal` and `signIptProposal`. Validation requires trusted deploy
facts and an accepted-outpoint map with exact source scripts and carrier values.
It checks real holder signatures against the original source script, scope 0xC1,
closure, duplicate inputs and unit conservation. The singleton signing helper
adds one caller-reserved fee input, no change, signs issuer/fee inputs with 0x41,
and executes every completed input script. It neither reserves nor broadcasts.
The caller must apply recipient linkage/policy and its fee policy first.

`iptReservations.ts` supplies an accept-once reservation projection over a
caller-provided atomic durable append journal. Replay retains pending requests
and returns stored signed bytes; conflicting requests remain refused after
restart. Failed writes do not release reservations. `iptJournal.ts` now binds
that projection to account + chain + issuer using the registered authoritative
durable store. Events occupy immutable bounded segments, with a small head;
an event saved before a failed head write is recovered on reopen. Missing or
corrupt committed segments fail closed. A failed writer must reopen; a stale
writer cannot overwrite a segment. This is NOT a multi-process transaction
manager: exactly one acceptor writer must own an account/issuer. The signed-record
method requires a validated final transaction; it is not transaction validation.

`verifyIptRecipients` opens actual SDK BRC-69/72 ciphertext using wallet decryption
and checks every output's identity-plus-linkage equation. The enclosing sender
must already be authenticated by BRC-78. `validateIptAcceptance` binds a completed
singleton transaction to the original request, checks unchanged outputs/holder
signatures, final sequences, the single fee input and all completed scripts.
It does not establish chain ancestry or that the fee input remains unspent.

Request chart (2026-11-19; not enabled): `src/machines/iptAcceptRequestMachine.ts`
runs one acceptor request as idle → accepting → signed | held | refused.
`createIptAcceptor` now throws `IptAcceptError` with `held`, false only when the
request failed before any reservation write. `held` has no cancel or timeout,
and there is no paid (host-funded) recovery (decided 2026-11-19): only REPLAY
of the same request can finish it, by finding its journaled signature; a
still-pending or failed replay stays held. `signed` is final. The default
accept actor refuses, so the chart signs nothing until a host wires it.

These primitives are not wired to wallet issue/mint/transfer, BRC-78 requests,
funding selection/recovery, decision authentication or receipt.
Shared issuer and sender-funded signing remain unsupported. Do not enable the
demo or remove receipt gates based on these tests. Dev-key-only remains unchanged;
no production key is generated, exported or persisted by these helpers.

### 3. Beacon and release (IPT task; requires durable service)

Local `signIptBeaconSpend` now constructs singleton issuer refresh and retirement
transactions with beacon input 0, one separate fee input, final sequences, exactly
one next beacon at output 0 and no change. Retirement adds the genesis-bound
`ipt retire` marker. It snapshots transaction sources and callback views, requires
issuer ALL|FORKID and executes both completed scripts. Shared quorum signing,
genesis creation, release spending, reservation/funding ownership, durable signed
recovery, broadcast and mined scheduling remain host/service work. The builder
must not be called as an automatic wallet operation yet.

Implement BRC-253 §9 refresh/discovery and custodian policy separately from the pure
chain reader. Add key-set disclosure verification, tracker-backed finality and
history traversal for released transfers. Test refresh chains, premature release,
wrong beacon, mismatched issuer/release parameters, forks and offline recovery.
A secret alone is never release authority. No automatic mainnet beacon creation,
refresh or custodian action without approved wallet operations.

### 4. Short proofs (proof task; port validation before freezing)

Reuse upstream `tokens/media/0252/bnt-proof`, existing commit `f337b3af`, Desktop
`proofVectors.test.ts` and published artifacts; do not create a replacement prover.
The upstream README still describes compressed proofs, not a completed Groth16
wallet integration. Reproduce vectors and Rust tests against the finished port;
check binary hash and vkey, then wrap the existing program and verify real bytes.
The reviewed ELF SHA-256 is
`cfece37e11595253ebdc1424d3574a603759ab5a2e30c88d0da334ded6139b73`;
`proofs/results.json` records compressed SP1 v6.1.0 proofs and vkey
`0x00743a85773cc14bbf0e2e494d6e199bab319550586afe0aba3185ea8aacd3e1`.
These identify the existing experiment, not a newly frozen normative program.
This machine has Cargo but neither `sp1up` nor `cargo-prove` on PATH; SP1-specific
verification/wrapping needs an approved toolchain setup or an existing proving host.

BRC-252 §4 still has no frozen program/key pin: no step proof may currently skip a
walk. A published experimental vkey is not a normative pin. Pin the reviewed program
and verifier only through an explicit specification revision. Then implement all
five stop conditions and real-proof negative fixtures (proof/key, txid/asset,
actual spent script/satoshis, finality, deploy). Unknown or invalid proofs fall back
to the ordinary walk. Proof generation is not a wallet spend-path dependency.

### 5. Market (integration task; BNT first, IPT after steps 2–3)

Implement BRC-254 compact BNT listings, settlement, cancellation and proceeds
collection with per-call approval, complete lot validation and exact bound outputs.
Test buyer/seller fixtures, tampered amounts/fees, stale lots and restored remittance.
Then add direct offers and buyback as ordinary validated purchases, not a privilege
that bypasses signatures. IPT sales require sender-funded countersigning; released
IPT sales require release evidence. Keep current unsupported errors until each flow
has its own fixtures. Do not revive BSV-20/21 under a BNT label.

Claim-by-signature is not specified by these documents; do not invent it as a
requirement or quietly implement a proprietary equivalent. Ordinal support does
not establish compact-token market support.

## Local verification, not release evidence

- Job `jr3`: 13 focused files / 130 tests pass; `tsc --noEmit` and
  `git diff --check` pass. Both edited TypeScript files have clean lints.
- Job `jsw`: reused upstream source at `9150386` in
  `/tmp/handcash-bnt-proof-5pHU5d/BRCs`; `f337b3af` is an ancestor. Regenerated
  `vectors/desktop.json` using this wallet's vector test (1 pass), then ran
  `cargo test --locked`: 23 Rust tests pass, including Desktop vectors and the
  archived mainnet fixture. These are offline fixture checks, not fresh chain
  queries, Groth16 verification or a live wallet transfer.
- Nothing committed, pushed, tagged, installed or issued by this chat. The local
  base includes another worker's unpublished Activity commit, so a broad master
  push is not an approved release scope for this bounded fix.

## Shipping evidence required

Each bounded slice: focused tests, typecheck, lints, diff review, exact commit and
approval-gated push/tag. Do not mark any of the three tasks done for a partial slice.
A release must record artifact SHA and CI result separately from local tests.
Two-install live fixtures must record versions, txids, filing, amounts, receipt and
restart outcomes; authorize any funds/issuance separately. Mobile inherits shared
`src/`, but still needs a separately pinned build and device verification. No live
wallet operation or deployment has been performed for this plan.
