# Desktop / shared Mobile licensing audit

Status: evidence-backed recommendation, NOT legal clearance. No license terms, notices, dependencies, release files or wallet data changed. Audit baseline: Desktop e9245220 (package 1.3.661); sibling Mobile checkout 0.1.774 pins Desktop 27578493 / 1.3.655. Those checkouts are not interchangeable with shipped artifacts.

## Findings and provenance

- Root `package.json` has declared Open BSV License since initial commit **2b1e159a** (`git log -S 'Open BSV License' -- package.json`). This establishes metadata history, not the legal scope of every file. No root license text was found among tracked license files.
- `packages/wallet-engine/README.md` explicitly records recovery from the source map of **@bsv/wallet-toolbox-client@2.13.2**. Engine introduced in **3aa5421a**. Its retained `LICENSE.upstream.txt` is Open BSV v6; `THIRD_PARTY_NOTICES.md` also identifies historical Toolbox/client v4 material at upstream snapshot d215223af67b2b08ef628e8e07f5cff8b60ec9b3. The referenced engine `LICENSES/` directory is absent. Calling this package owned or original does not remove the copied baseline. The user's account of independent implementation deserves file-level review against this recorded provenance; it is not dismissed or treated as proof of copying every file.
- Installed **@bsv/sdk**, **@bsv/verifast**, **@bsv/webrtpay 0.2.1** carry Open BSV v6 text. Its numbered condition 1 requires copyright and license retention; condition 2 restricts the covered software and derivatives to exclusive BSV use. Historical grants and incorporated permissive portions must remain separately scoped; current metadata alone cannot retroactively narrow older grants. Exact installed/locked versions must be matched to each release.
- SDK notices identify historical pre-2026 grants and other incorporated material. Verifast notices identify bundled JS/WASM from BDK (legacy Open BSV AND MIT), bitcoin-sv (Open BSV v5 AND MIT), Boost and Emscripten. MIT portions do not erase the conjunctive restrictions. Retain the complete applicable license/notice trees, not just a new top-level notice.
- `vendor/aeon-ui-engine/LICENSE` is MIT, copyright SpiderCorp / Aeon contributors. It remains separately licensed, subject to provenance of its contents. `@1sat/templates` is MIT in the lock but transitively uses SDK; a permissive wrapper does not clear a restricted dependency.
- HandCash UI, shells and new wallet contributions are **candidate original code**, not an established company-owned inventory. Git authorship and product branding do not prove copyright assignment. Separate copied/adapted code, employee/contractor grants, assets and contributor permissions before licensing this set. Preserve existing permissive grants.

## Other-chain exposure is concrete

`src/wallet/ltc/litecoin.ts` imports SDK ECDSA, Hash, BigNumber, PrivateKey and Utils; `btc/bitcoin.ts` imports SDK Utils; `arcUsdc/address.ts` and `arcUsdWallet.ts` import SDK private-key/key-derivation primitives. These are runtime imports, unlike the type-only import in `ltcWallet.ts`. Therefore this is not merely unrelated packages sharing a manifest. Neither splitting a process/package nor replacing the manifest license establishes compliance. Counsel must assess derivation, actual usage, historical grants, and applicable law; this report does not conclude all HandCash code automatically inherits v6.

## Inventory and artifact evidence

Run `node scripts/audit-license-evidence.mjs . /absolute/path/to/HANDCASH-MOBILE` to capture every checkout lock entry, exact version/integrity, license declaration and installed top-level notice hashes. Include dev entries: build tools can contribute runtime binaries. Entries are **candidates, not a shipped SBOM**. The inherited inventory script/report were not present in this checkout and the former chat was unavailable; they were not overwritten. Takeover output was saved at `/tmp/handcash-license-audit/takeover-inventory.json` (machine-local, not archival).

The candidate inventory includes MIT, ISC, BSD-2/3-Clause, Apache-2.0, BlueOak-1.0.0, Unlicense/0BSD, dual-license choices, Open BSV and undeclared entries. For example node-forge offers BSD-3-Clause OR GPL-2.0; DOMPurify offers MPL-2.0 OR Apache-2.0. Select and document a permitted permissive branch rather than treating OR as AND. Missing declarations and symlink entries require following the actual package, not assuming unrestricted code.

Saved artifacts inspected read-only in `/tmp/handcash-license-audit`:

| Artifact | SHA-256 |
| --- | --- |
| HandCash-1.3.661-arm64-linux.zip | 7c142f74e9356e69a2fae80f884503e02256b6291a04216515f0e2143fd8a2a7 |
| handcash-mobile-0.1.776.apk | c6778ab48886e8b6d25af500c81181f3c769dc0413fd9d54d2625195942f8a45 |

Neither archive contains paths named license/notice/copying (case-insensitive). Linux includes sidecar source maps; APK has no `.map` files. This establishes a packaging warning, not absence of all embedded legal text. Saved APK pin names clean Desktop **010348694d344dbd3cffc0e8cc4f7eea61a09a02 / 1.3.661**, Mobile **0.1.776**. It does not establish that build is currently installed. The shipping chat was asked for state and had no verified installation outcome in its available snapshot. No release operations were duplicated.

**Still required for an exhaustive shipped inventory:** reconcile renderer/sidecar maps and WASM with release lockfiles; recover the APK build lock/provenance; inspect embedded notices; enumerate Rust Cargo.lock and platform feature graph, Node runtime, GTK/WebKit/system-library distribution, Swift/native frameworks, Gradle/Android/Capacitor plugins, iOS pods/frameworks, fonts/icons/brand assets. Cargo.toml alone is insufficient. Windows/macOS/iOS artifacts were not cleared. Do not call the checkout inventory a complete shipped audit.

## Least-restrictive recommendation (requires approval)

Choose **MIT for verified original HandCash code**, with explicit third-party exclusions. It meets the stated priority of fewest redistribution conditions: retain copyright and permission text. Apache-2.0 is also permissive and offers an explicit contributor patent grant plus patent-litigation termination, but requires change notices and applicable NOTICE retention. Prefer Apache if explicit patent assurance outweighs minimal obligations; neither license grants third-party rights or clears BSV restrictions. No blanket relicensing now.

Authoritative comparison: [MIT text](https://opensource.org/license/mit), [Apache-2.0 §§3–4](https://www.apache.org/licenses/LICENSE-2.0). Upstream overview: [TS Stack](https://github.com/bsv-blockchain/ts-stack); exact local package texts, historical snapshots and release bytes take precedence over a changing web page.

## Proposed minimal compliance patch — not applied

1. Restore missing upstream license trees from the exact Toolbox baseline; verify hashes and referenced paths. Do not fabricate notices or replace historical grants with v6.
2. Generate one deduplicated third-party notice index plus exact license texts for actually distributed code. Preserve copyright, disclaimer, Apache NOTICE/change notices and BSD non-endorsement requirements; choose documented permissive branches where available. Do not add advertising acknowledgments not required by a license.
3. Package that directory in every Desktop archive/installer and Mobile asset bundle, including sidecar, WASM and runtime notices; add an accessible legal link using the existing UI architecture only if needed. CI should fail when required texts are absent. Notice compliance does not cure field-of-use violations.
4. Only after ownership approval, add the chosen license scoped to original code and make metadata accurate without implying upstream relicensing. No dependency uninstall until replacement compatibility and security are verified.

## Permission / replacement plan

| Component | Concrete path | Acceptance gate |
| --- | --- | --- |
| SDK | Seek written unrestricted grant covering exact snapshots, derivatives, redistribution, other chains and relevant patents from all necessary rights holders. In parallel isolate non-BSV key/hash/signing uses behind small adapters; existing noble packages are candidates, not drop-in BRC-100/BEEF replacements. | License/provenance review; key/address/signature vectors on each chain, deterministic derivation and migration compatibility; independent crypto review. |
| Verifast | Seek permission covering embedded BDK/node material too, or replace with an independently sourced permissive interpreter/verifier. Do not silently delete validation. | Consensus/script negative vectors, WASM/native parity, proof-verification and adversarial tests. |
| Webrtpay | Independently implement transport from public BRC specifications and standard WebRTC, or obtain unrestricted rights; do not copy restricted implementation. | BRC authentication, replay resistance, ACK/retry, disconnect/fallback, Mobile interoperability tests. |
| Toolbox-derived engine | Obtain grant covering copied baseline plus modifications, or independently implement storage/action/history contracts from public specifications with documented provenance. Renaming or transpiling is not replacement. | BRC-100/38/39, recovery, holding/handover, spend guards, backups and migration fixtures; no wallet data loss. |

Ask rights holders for a precise license amendment, not a vague endorsement. For replacement, inventory exact APIs, choose audited permissive primitives, build differential compatibility tests, preserve old-data recovery, and stage changes separately. An isolation boundary may help engineering but is not itself a legal exemption.

## Questions requiring legal/ownership review

Who can grant rights to historical contributions and embedded node/BDK code? Which original files and assets are assigned to HandCash? Does any proven independently implemented subset avoid derivation? How do field-of-use terms apply to the combined app and its existing other-chain paths? What patent/trademark rights remain outside any copyright license? What remediation is appropriate for already distributed archives if required notices were missing? Obtain advice before claiming unrestricted multichain compliance or issuing a blanket open-source license.
