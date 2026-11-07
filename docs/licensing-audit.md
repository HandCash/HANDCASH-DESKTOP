# Desktop / shared Mobile licensing audit

Status: evidence-backed recommendation, NOT legal clearance. No license terms, notices, dependencies, release files or wallet data changed. Audit baseline: Desktop e9245220 (package 1.3.661); sibling Mobile checkout 0.1.774 pins Desktop 27578493 / 1.3.655. Those checkouts are not interchangeable with shipped artifacts.

## Recovery checkpoint — 6 November 2026

Chat 261 is not exposed by the available open-chat list; its full conversation has not been recovered. Available evidence is the committed audit/replacement work (0a5bacbb) and Meridian architecture/encoding slice (b4536eb8), retained upstream text and machine-local artifacts. Both archive SHA-256 values below were rechecked and match. The saved inventory and test log remain available; `cargo-metadata.json` is zero bytes, not successful native inventory evidence. Existing UI/machine/vendor worktree edits were left untouched. Earlier findings below describe their stated baselines, not a fresh complete dependency or shipped-artifact audit. Checkpoint verification: app TypeScript typecheck and diff whitespace check passed; full test:ci ended with exit 130 and is not a pass. No runtime implementation was expanded.

## NAR / DAR — verified terms, not legal clearance

- **NAR = Network Access Rules.** The [official introduction](https://nar.bsvblockchain.org/) identifies version 1, uploaded 15 February 2024, with corrections on 27 February. [Part I](https://docs.bsvblockchain.org/network-access-rules/network-access-rules/part-i-master-rules) §I.1 describes an Association/Nodes multilateral agreement; §I.2 states assent triggers: Network Activity, Node Software use or benefit from its license. §I.5.2(d) permits alternative node software only subject to protocol/rules compatibility and message reception; §I.10 selects England and Wales law. Independent node code therefore is not, on the text's own terms, an automatic escape from network rules.
- **DAR = Digital Asset Recovery.** This is the upstream term for asset-recovery processes, not a permissive software license or a wallet seed-recovery feature. The Association's [protocol overview](https://bsvassociation.org/protocol/) describes miner compliance with valid court orders. Its [Alert System documentation](https://docs.bsvblockchain.org/network-topology/nodes/sv-node/alert-system) describes signed informational/directive messages and DAR alert support.
- [NAR Part III](https://docs.bsvblockchain.org/network-access-rules/network-access-rules/part-iii-enforcement-rules) §§III.1–2 specifies Directive Events and prompt node compliance. §III.3 includes specified rule breaches/misrepresentations; §§III.4–5 address qualifying decisions enforceable/recognised in England and Wales or Switzerland. §III.6 limits directives to a qualifying event and purpose, and permits UTXO freezes, peer-IP restrictions, frozen-coin reassignment and block invalidation. Thus “every directive requires a new court order” overstates the text. §III.7 contains node information duties, subject to applicable-law disclosure limits.
- **Software-license link:** retained `packages/wallet-engine/LICENSE.upstream.txt` (Open BSV v6) defines BSV Blockchain by reference to NAR-consistent chains. Condition 1 requires attribution/license retention; condition 2 confines software and derivatives to exclusive BSV use. It does not name DAR or expressly require every wallet to implement a DAR service. Historical v4/v5 grants must be assessed separately; do not substitute v6 retroactively.
- **Legal uncertainty:** these are verified published provisions, not a ruling on assent, enforceability, derivation or HandCash's particular role. A wallet submitting transactions is not automatically shown to be a mining Node. Counsel must map actual wallet/SPV/sidecar activities to the full definitions and operative version, assess incorporation of NAR through licenses and jurisdiction, and distinguish copyright, patents, contract and direct legal orders. Replacing licensed code cannot remove BSV miners' network-level enforcement or promise immunity for BSV funds.

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

## Gate for future releases without Open BSV-covered implementation

The hash and hex slices in 0a5bacbb / b4536eb8 do not meet this gate. Replace or obtain a written, appropriately scoped grant for SDK implementations, the Toolbox-derived engine, Verifast and embedded BDK/node code, Webrtpay, and every restricted transitive/generated copy. The user's replacement scope also includes BSVA implementation code even where a particular portion has a permissive grant. Keep independently sourced permissive libraries with their own notices.

Require file-level provenance and contributor rights; exact source/lock/native/WASM/runtime closure; permitted specification/vector inputs and patent review; recovery, conformance, security and all-platform tests; then inspect the actual Desktop and Mobile distributions. Renaming, a new request language, interface compatibility, architectural separation or rewriting alone is not clearance. Written exceptions must cover exact historical snapshots, derivatives, other-chain use and downstream distribution from authorized rights holders.

Retain historical notices and provenance in history and archived releases. Any future removal from an active distribution requires evidence that the covered material is absent or a reviewed replacement grant that expressly permits it; it never rewrites old obligations or cures earlier notice omissions. A scoped license for verified-original code is distinct from blanket relicensing. No root/package license metadata, public claims, notices or release artifacts are changed by this checkpoint.

## Fastest legal path to a multicurrency wallet — recommendation (requires approval)

Evidence: other-chain code (LTC, BTC, ARC USDC) imports `@bsv/sdk` at runtime; SDK, Verifast, Webrtpay and the Toolbox-derived engine carry Open BSV terms whose condition 2 confines covered software and derivatives to BSV use. No written permission from any rights holder is in this repository; the root `package.json` label is metadata, not a grant.

1. **Existing permission — not available.** Nothing found grants multichain use. Older historical grants (v4/v5, pre-2026 SDK notices) may be broader, but they apply only to the exact snapshots they cover and need counsel to confirm. Babbage's setup is a comparison, not permission for us.
2. **Fastest for the non-BSV paths: replace.** Move LTC/BTC/USDC key, hash and signing code to audited permissive primitives (noble/scure) behind small adapters, with per-chain vectors. This is days, needs no third party, and does not touch the BSV wallet.
3. **In parallel: ask for written permission** from the actual rights holders (BSV Association and the Toolbox/SDK authors, to be identified by counsel) for the exact snapshots, derivatives, other-chain use and downstream distribution. Timing is outside our control.
4. **Slowest: first-principles BRC-100 engine** replacing Toolbox-derived engine, Verifast and Webrtpay from public specs with documented provenance. Do this only if permission is refused or the product must be free of Open BSV code.

Until step 2 or 3 lands, do not ship a build that advertises multichain support as license-clean.

## NAR / DAR: is it an issue?

Not for the non-BSV adapters once they carry no covered code. For BSV paths it is a legal question, not a code one: NAR assent can be triggered by Network Activity or use of Node Software, and DAR/directives act at miner and node level. Replacing code cannot remove miner-level enforcement on BSV funds. Whether a wallet is a "Node" under NAR is for counsel.

## Questions requiring legal/ownership review

Who can grant rights to historical contributions and embedded node/BDK code? Which original files and assets are assigned to HandCash? Does any proven independently implemented subset avoid derivation? How do field-of-use terms apply to the combined app and its existing other-chain paths? What patent/trademark rights remain outside any copyright license? What remediation is appropriate for already distributed archives if required notices were missing? Obtain advice before claiming unrestricted multichain compliance or issuing a blanket open-source license.
