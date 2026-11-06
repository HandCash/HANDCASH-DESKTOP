# Meridian Wallet Engine — working architecture

Working name only; trademark/name availability is not cleared. Target: a genuinely independently authored replacement for all BSVA implementation code and other BSV-restricted components, not a renamed Toolbox fork. BRC-100 remains the external compatibility boundary. No blanket originality, clean-room, legal-clearance or unrestricted-distribution claim is made. The contributor has examined legacy implementations.

## Architecture

One shared TypeScript domain engine serves Desktop and Mobile; shells supply secure storage, networking and lifecycle capabilities. UI remains a projection of existing state machines. BRC-100 remains supported unchanged; it is not the engine's only possible standards adapter.

### Scoped request language — design boundary, not implemented

The user's target is independently authored multicurrency behavior from first principles, not a Toolbox-shaped rewrite. Use a small internal, versioned request model behind standards adapters, not a competing public wallet protocol. BRC-100 preserves its own wire semantics/errors; other standards get explicit adapters only after revision, copyright and patent review. Do not infer BRC specification permissions from implementation licenses or unrelated TSC grants.

Every internal request must bind authenticated origin/session, account and generation, chain/network/asset, operation and validated typed parameters, permission scope, expiry and request/replay identity. Adapter-supplied origin is not trusted without host authentication. Authorization is per capability, never a generic arbitrary-method or cross-chain signing grant. Preserve standard-specific signing domains and responses; fail closed for unknown versions, operations, networks or unsupported semantics. Amounts use exact integers/units, not floating-point currency values. No keys or unrestricted executable scripts in the request language.

Next deliverable before runtime expansion: a revision/rights/provenance ledger and request-to-capability matrix for actual BRC-100 calls and the first non-BSV standard selected for a supported chain. Define independent positive/negative vectors for origin spoofing, wrong account/network, stale generations, replay, expiry and permission escalation. Review that contract before schema/adapters; do not invent compatibility claims for unspecified standards. This extends the earlier BRC-only architecture decision at the internal boundary, not the existing BRC-100 public contract.

| Domain | Responsibility and boundary |
| --- | --- |
| Custody | Narrow signing capability; secrets never enter UI, projections, logs or swap providers. Preserve existing vault/account derivation and recovery bytes, including legacy vault formats. Use audited permissively licensed crypto implementations, not home-grown cryptography. |
| Accounts/runtime | Captured account identity, storage namespace and generation own every task/cache. Switching disposes the old foreground runtime; independently held accounts may continue their own monitored transactions. No cross-account results or mutations. |
| Device holding | Preserve automatic authenticated handover, existing timeouts/fallback, freshness checks after gaps and displaced-holder guards. Accounts held elsewhere are never opened or signed with. No invented distributed spend lease; existing offline limitations remain explicit. |
| Chain adapters | Separate address/encoding, derivation, transaction planning/serialization, signing, broadcast tracking and validation per chain. Asset identifiers include chain/network. No shared assumption that UTXO, EVM nonce or fee/finality rules are interchangeable. |
| Local state | Account-scoped indexed records, bounded cursor pages and atomic reservation/journaling. Reads yield to waiting spends; no whole-wallet scan or network operation under the storage lock. Durable signed-send state survives restart; spend lock ends at broadcast. |
| Display projections | Versioned display-only summaries and item/activity views, tagged with account generation and freshness. Never fund, authorize or validate a spend from cached totals. Custody checks exact authoritative records. |
| Chain ingest | Network discovery and proof-backed reconciliation into local state only. Indexers find candidates, never establish proof or erase a live transaction through silence. Dashboard Refresh never restores history. |
| History replica | Separate BRC-38/39-compatible export/import and recovery domain, preserving remittance and custody recipes. Recompose restores history before ingest through the existing coordinator. Empty-state overwrite and displaced-holder upload guards remain. |
| Proofs/items | Chain-specific validation with explicit proven/unproven results. Preserve complete BRC-150 ancestry and exact spends; missing data never becomes proof. Recursive items remain in basket `1sat`; item/remittance identity must survive migration. |
| Payments | Existing BRC-100/BRC-29 contracts, permissions, intent/reservation/sign/journal/broadcast/verdict lifecycle and authenticated transport. Never abort a signed transaction queued for miners; recover/repost stalled transactions with parents and follow actual verdicts. |
| Liquidity/swaps | Separate quote/discovery from authorization and execution. Model chain-specific lock, spend/refund deadlines, fees, slippage and irreversible stages. Persist both legs and recovery/refund obligations. Providers cannot gain custody or substitute destinations; never promise atomicity across unsupported protocols. Preserve existing user-approved behavior, not a new swap protocol. |

Dependencies point from protocol adapters and host ports into domain contracts, not into legacy classes. Requirements describe behavior and safety properties, not the restricted implementation's class structure or internal algorithms. Legacy interoperability adapters stay outside the new implementation boundary and remain explicitly uncleared. A wrapper or directory split is not a license exemption.

## Provenance and acceptance gates

- Inventory every source/generated file and transitive dependency, including vendored archives, fixtures, native/WASM/runtime code and build tools that contribute shipped bytes. All BSVA implementation code is in replacement scope, even where its particular grant might be permissive; other third-party permissive primitives may remain with their notices.
- Each replacement records author/prior exposure, behavioral requirements, specification revision and permission, independently sourced test-vector origin/permission, exact dependencies and reviewer. Public availability alone is not permission; do not copy restricted code, prose, algorithm structure or translated implementations into new work. Distinguish elementary algorithm facts from protected expression.
- Use independent tests/oracles in addition to legacy compatibility tests. Legacy differential success proves compatibility, not authorship. No production shadow signing, duplicate broadcasts or dual-write custody migration.
- Independent contributors with documented exposure boundaries and legal review are needed for high-risk engine, signing and consensus work where prior exposure/derivation cannot be responsibly resolved. This is not a retrospective clean-room certification. Counsel must review specification grants, historical provenance, patents and ownership assignments.
- The user chooses a permissive license for verified-original code; no MIT/Apache decision or blanket relicensing is implied here. Retain every existing Open BSV and third-party notice until the corresponding material is absent from source, dependency graph, generated output and distributions.
- Final gate: exact build-lock/source provenance, license/notice manifest and byte/artifact inspection for Desktop renderer/sidecar/native/WASM and Mobile APK/iOS bundles, plus migration/recovery, protocol conformance, security and platform tests. No automatic restricted fallback in a distribution described as cleared.

## Staged migration

1. **Leaf primitives:** hash/encoding adapters using existing permissive libraries and independent oracles; no keys or data migration. Existing noble hash slice is already verified. Milestone M1 below adds strict hex encoding.
2. **Read-side:** new paged repository contracts and display projections, initially tested against synthetic exports in disposable stores. No storage format change or custody authority. Reject stale account generations.
3. **Formats and transport:** independently implement permitted wire/proof contracts and authenticated peers; prove old/new BRC-100 and Desktop/Mobile interoperability. Select and review a permissive full verifier before replacing existing validation.
4. **Custody and actions:** crypto review, independent derivation/signature/negative vectors, deterministic synthetic-wallet recovery, crash injection at every durable transition, reservation/holding tests. Enable one owner per account only after review; never ship incomplete signing.
5. **Data migration:** quiesce one account after monitoring its signed/broadcast obligations; make a verified recoverable export including BRC-39, journals and non-derivable remittance. Import into a new namespace, validate holdings/proofs/recovery equivalence, then atomically switch ownership. Never overwrite the legacy store. Rollback must account for every post-cutover signed action; a stale snapshot is not a safe rollback.
6. **Payments/items/liquidity:** migrate incrementally under the same authoritative account owner with pending-transaction/refund recovery and adversarial cross-chain tests. No big-bang runtime switch.
7. **Removal and clearance:** remove legacy paths only after all supported platform and recovery gates pass; inspect artifacts and dependency closure before changing notices, licensing metadata or public claims.

## M1: strict hex adapter provenance

Files: `src/meridian/encoding.ts` and its tests. New adapter requirement: encode byte sequences as lowercase, two hexadecimal digits per byte; decode even-length ASCII hexadecimal only, preserving zero bytes, returning fresh buffers. Host-specific whitespace normalization and errors remain outside this adapter. No BRC specification/code/vector was copied. Elementary base-16 mapping is tested against fixed hand-constructed values, all 256 byte values and independent Node Buffer conversion. Implementation delegates conversion to installed MIT `@noble/hashes` 2.4.0 `utils.js`; existing MIT notice remains required. Prior exposure is disclosed above; this slice is not a clean-room claim.

Integration replaces only the two SDK hex conversion calls in the existing Litecoin utility entry points, retaining their trimming/lowercase/error behavior. The legacy module is not newly authored Meridian code. Its SDK Base58, key and signing usage remains restricted/uncleared. Remaining restricted scope: SDK 2.8.11, Verifast 0.3.6 and embedded BDK/node material, vendored Webrtpay 0.2.1, Toolbox-client-2.13.2-derived engine and transitive consumers; Mobile exact shipped lock reconciliation remains open. See `restricted-component-replacement.md`.

M1 verification: TypeScript app typecheck, five targeted test files (71 tests, including 14 new encoding tests), and `git diff --check` pass. No live-wallet, signing or storage migration was exercised. Full-suite, all-platform and artifact clearance are still pending; the earlier full-suite runner timeout is not a pass.

## Preserved provenance findings / proposed public clarification (UNSENT)

Rechecked 6 November 2026: HandCash initial commit `2b1e159a` (29 July) already contains application wallet modules and imports Toolbox client ^2.4.4; this is not evidence of an entirely independent custody core. Local funding-script fix `4e574365` (12 August) predates engine recovery. PR #489's initial contribution `a07b6eac` (20 August) also predates recovery; its final head includes later maintainer commits. `75b0bc8a` (15 October) adds local bundle fixes before `3aa5421a` later that day introduces the recovered engine and records that origin in its README. Issue #1136 and PRs #1138–1141 follow on 17 October. These facts support distinguishing earlier HandCash work/fixes from the later recovered baseline; they do not prove all earlier application code original or establish a separate independently authored SDK. User reports of earlier independent work remain to be matched to dated sources.

Proposed **append-only clarification**, for user review, not posted:

> Provenance clarification — 6 November 2026: HandCash application work and local fixes predate the local wallet-engine package; for example, the funding-script fix was committed on 12 August and the initial #489 contribution on 20 August 2026. On 15 October, commit 3aa5421a introduced a local engine whose README records recovery of a Toolbox client 2.13.2 source-map baseline. References here to that derived engine describe that baseline, not the origin of every HandCash feature or fix. “Reference implementation” describes why it was linked, not proof of independent authorship or licensing permission. A file-level provenance review remains open; existing notices are retained.

The broad derivation sentence in #1136 is corroborated for the later baseline; it has not been demonstrated false. Do not retract it or assert blanket independent authorship. This clarification narrows scope without deleting history or making a legal conclusion. No GitHub description, comment or history is changed.
