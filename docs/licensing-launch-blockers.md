# Licensing launch blockers — 6 November 2026

Status: OPEN. Technical evidence and release checklist, not legal clearance.
No license choice, exception, dependency removal, publishing or relicensing is authorized by this report.

## Candidate and coordination

Earlier shared-checkout evidence: c57b4473 (1.3.663), 26 ahead / 6 behind cached origin/master, with existing UI/vendor edits and untracked files preserved. The earlier live remote check returned master and v1.3.661 at 01034869 and no v1.3.663 tag; it is not a current release-state assertion. This remediation worktree is based on 986797d8 (the previously saved launch-blocker report). It has uncommitted other-coin crypto changes, not a launch artifact. No fetch, merge, commit, tag, push or publication was performed here.

Mobile changed concurrently from a755cf4 to 40c9ecf during this audit; its cached branch state is now 1 ahead / 2 behind. The manifest checked earlier says 0.1.774. Neither checkout identifies a verified launch artifact.

Coordination: earlier snapshots from cmw5ujlnr2g (intended Desktop chat 271) supplied no verified candidate/artifact pins or overlap details. A follow-up failed with “Destination chat is unavailable”; the latest chat list no longer contains that destination. No coordinated merge or launch sign-off is claimed. Work stays isolated to src/wallet/{primitives,coins,ltc,btc,bch,doge,arcUsdc,swap}, these audit documents and one scope insight. No release, signing, manifest, lockfile, shell or shared UI edits are included. Launch owner must reconcile this patch with chat 271 before integration; its absence is not proof no concurrent work exists.

## Exact open gates

| ID | Kind and confirmed evidence | Launch impact | Closure evidence / responsible role |
| --- | --- | --- | --- |
| L1 | Confirmed restrictive text and runtime exposure; applicability unresolved. Retained engine Open BSV v6 condition 1 requires attribution/license retention; condition 2 limits covered software and derivatives to exclusive BSV use. The uncommitted patch removes direct SDK crypto operations from other-coin modules, retaining the BSV stack. Shared custody, identity, engine, transport and transitive bundle exposure are not removed or cleared. No reviewed grant is recorded; replacement specification/vector grants and historical derivation provenance are also unverified. | Do not describe or approve the multichain candidate as license-cleared. Notices alone cannot resolve field-of-use questions. This is not a ruling that all HandCash code inherits v6 or that historical grants are identical. | Rights holder/counsel maps exact snapshots and actual use to applicable grants; either a sufficient authorized exception is reviewed, or a reviewed replacement eliminates the relevant covered use and passes compatibility/security tests. Developer must not choose a legal interpretation. |
| L2 | Confirmed source notice-tree defect. packages/wallet-engine/THIRD_PARTY_NOTICES.md references missing LICENSE.txt and LICENSES/Open-BSV-License-4-wallet-pre-2026.txt plus Open-BSV-License-4-wallet-client-pre-2026.txt. LICENSE.upstream.txt exists but does not satisfy those relative references. | Required historical texts cannot be followed from this checkout. Do not fabricate texts, substitute v6 for v4, or delete upstream notices. | Packaging/provenance owner restores byte-identical files from the exact retained upstream snapshot with hashes, then verifies complete referenced trees in each distributed artifact. |
| L3 | Evidence gap: exact launch artifacts and build provenance are unidentified. /tmp/handcash-license-audit is now absent. Earlier archive hashes and notice-path observations are historical findings, not a current inspection. | Neither tonight's Desktop build nor Mobile APK has a demonstrated shipped-code and notice inventory. No current claim that binaries contain no notices is supported. | Release owner supplies immutable artifact hashes, source commits including dirty patches, lockfiles and build inputs. Audit reconciles JS/sidecar/WASM/native/runtime/plugin/assets and applicable texts against those exact bytes, including historical grants and permissive alternatives. |
| L4 | Evidence gap: candidate lock inventory is not a shipped SBOM. Current scan has 847 Desktop / 371 Mobile lock entries. Desktop has 75 missing package directories and 125 entries with no discovered notices; Mobile has 50 / 59. Optional/platform packages and first-party entries can explain these; counts are not violations. Version mismatches are listed below. | Current checkout cannot by itself establish release dependency closure or absence of required attribution. | Build/audit owner classifies each candidate by actual target inclusion, follows file links, verifies installed content and native graphs, and records provenance/notices for included code. |
| L5 | Ownership/legal evidence gap. Company ownership of candidate original code, historical contributor authority, NAR applicability and remediation of older distributions remain unsettled. Root LICENSE/NOTICE absence and the manifest label do not establish rights or, alone, prove a violation. | No blanket MIT/Apache relabeling, unrestricted multichain claim or NAR exemption claim is justified by this audit. | User obtains appropriate rights/ownership/legal review for the intended distribution and claims; retain all upstream grants. This technical report makes no legal decision. |

| T1 | Technical readiness gap, not a license restriction. The narrower crypto patch has offline regression evidence but no independent crypto/security review, Mobile-runtime run, complete application-suite result or inspected build artifact. Chat 271 integration is unconfirmed. | Do not ship this custody-path change solely on focused tests or treat it as clearance. | Wallet/security reviewer reviews derivation, deterministic signing and framing; launch owner reconciles the patch and verifies both platform candidates, including restore/payment/swap fixtures and exact packaged dependencies/notices. |

These gates block a positive licensing readiness finding, not a claim that every unknown is a proven infringement. Narrowing a feature's UI does not establish removal of covered runtime code.

## Earlier inventory evidence (not re-run against launch artifacts)

Desktop lock SHA-256: 4dec323c6b23dfdb7956a3314ea1a6bab056a7e6019599cdb251486dd7f3c3c8.
Mobile lock SHA-256: f65d57d5e4298e4197d8000b9485ca32ff73e3dc6f63d848406508251d715321.

Installed restricted package versions match locks:
- Desktop: SDK 2.8.11, Verifast 0.3.6, Webrtpay 0.2.1.
- Mobile: SDK 2.8.1, Verifast 0.3.6.

Recursive notice collection now finds 20 SDK and 10 Verifast notice/license files per checkout, rather than only top-level files. That improves evidence; it neither restores the engine's missing texts nor proves packaging.

Lock/manifest version differences:
- Desktop root: lock 1.3.641, manifest 1.3.663.
- Desktop vendor/aeon-ui-engine: lock 1.10.0, manifest 1.11.0.
- Mobile linked ../HANDCASH-DESKTOP/packages/wallet-ui: lock 1.3.638, manifest 1.3.663.

These are provenance discrepancies, not proof of restricted-license violations. Do not regenerate locks over concurrent work merely to make the report green.

## Safe remediation performed

Inventory script now hashes nested license/notice directories and reports installed-version mismatches, missing directories, unverified versions and absent discovered notices separately from license declarations. Hidden files and nested symlinks are skipped. Linked package roots are intentionally followed; this is a trusted-checkout tool, not an untrusted filesystem sandbox.

Added a temporary-fixture regression test for nested historical grants, hidden-file exclusion, mismatches and missing packages. Node test: 1 passed, 0 failed; diff whitespace check passed. No full app/build result is asserted.

The approved narrower wallet remediation now replaces other-coin derivation, public keys, signing, hashing and address helpers with installed MIT noble libraries plus small framing adapters. BSV SDK functionality is retained, including BEEF/transaction/P2PKH helpers. See docs/restricted-component-replacement.md for exact scope, dependency LICENSE hashes, input provenance and remaining permissions/security gates. Existing upstream and permissive notices are untouched; manifests, lockfiles, UI/vendor work and release configuration are unchanged. No commit, push or publication performed. These are source edits in the isolated worktree, not evidence that any distributed binary uses them. Final verification: 35 affected test files, 367 tests passed (including 39 new crypto/encoding cases); TypeScript no-emit and diff whitespace check passed. The inventory Node regression also passed (1/1). No full application-suite, packaging or Mobile-runtime pass is asserted.

## Next handoff

1. Desktop launch owner reconnects chat 271, reconciles this isolated patch and identifies exact candidate commits/artifacts for both platforms; independent wallet/security review and platform tests close T1.
2. Provenance owner recovers L2 texts from the exact upstream snapshot; audit verifies hashes and package inclusion.
3. Release/audit owners resolve L3–L4 on exact built artifacts, not just checkout manifests.
4. User/rights holder/counsel resolves L1 and L5. Technical notice repair does not close those gates.
