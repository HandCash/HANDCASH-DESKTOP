# Restricted component replacement — implementation record

Status: incomplete, not release-ready and not legal clearance. The earlier broad replacement plan below is historical scope, not authorization to remove the BSV stack. The approved current slice retains SDK functionality for BSV and replaces its other-coin cryptographic operations only. Current edits are isolated in chat cmw5ugu9s1b on 986797d8. No licenses, notices, manifests, lockfiles, releases or wallet data were changed; no commit, push or publication was performed.

## Exact identified scope at this baseline

| Covered component | Locked / recovered baseline | Required replacement scope |
| --- | --- | --- |
| `@bsv/sdk` | Desktop 2.8.11; inspected Mobile checkout 2.8.1 (not the shipped APK lock) | Runtime keys, signing, hashes, encoding, derivation, transactions/BEEF, scripts, proofs, wallet protocol helpers; also type/interface provenance review. |
| `@bsv/verifast` | 0.3.6 | JS/WASM verification including BDK 1.2.2 snapshot 6d1e8092e8a9917d2544cddc9e20c6dc38242d93 and bitcoin-sv snapshot 879fc8b42168dd0e608dafd51b39c6dabad37d4d; not just its wrapper. |
| `@bsv/webrtpay` | vendored 0.2.1 tarball | Peer authentication, payment transport and protocol behavior, including Mobile interoperability. |
| `packages/wallet-engine` | source-map recovery of Toolbox client 2.13.2, recorded in its README; historical notices snapshot d215223af67b2b08ef628e8e07f5cff8b60ec9b3 | Copied/derived baseline, generated output and modifications requiring provenance review; storage, actions, identity, history and recovery contracts. |
| Transitive consumers | Includes MIT `@1sat/templates` 0.0.2 consuming SDK | Reimplement or adapt restricted API usage; permissive wrapper licenses do not remove the dependency. Inventory every resolved copy. |

Installed license evidence and release limitations are in `licensing-audit.md`; exact lock integrities and notice hashes are emitted by `scripts/audit-license-evidence.mjs`. This is the exact **identified restricted set**, not a claim that every distributed byte has been cleared. Mobile release-lock reconciliation, native dependency graphs and source-map/WASM/artifact inspection remain required. Root license metadata is not itself a component to rewrite and stays unchanged.

## Defensible process

1. Maintain a per-adapter record of author exposure, inputs, dependencies, tests and review. Contributors here have examined upstream code: this work is **not clean-room**. Do not translate, paraphrase, mechanically port, or use restricted implementation code as generation context. Preserve notices on existing code.
2. Derive observable compatibility requirements from existing public interfaces, user-owned fixtures and independently licensed specifications/vectors. Public availability alone is not a license. Record the exact specification revision and its license before implementing from it; legal review is needed for BRC documentation grants, interface reproduction, historical derivation and patents. Do not copy specification prose/code without permission.
3. Prefer already-audited permissive primitives over writing cryptography. Preserve their licenses. For complex engine/consensus replacements, recruit independent contributors with documented exposure boundaries and obtain legal review of the process; do not invent a clean-room claim retrospectively.
4. Keep BRC-100 and existing transports/contracts, not a competing wallet protocol. Replace small modules behind stable interfaces. Golden compatibility tests are regression evidence, not independent provenance evidence. Validate new implementations against independent vectors/oracles too.
5. Never dual-run signing, broadcast, key generation or storage mutations against real custody. Use synthetic keys, offline fixtures and disposable stores. Preserve derivation bytes, signatures, serialization, recovery/export/import and database migrations. Keep the existing implementation until its replacement passes compatibility and security review; never fall back silently to restricted code in a supposedly cleared distribution.
6. Remove a notice only after its covered code is demonstrably absent from source, generated files, transitive graph and all distributed binaries. Do not apply a blanket MIT license or announce unrestricted multicurrency support before those checks and ownership review.

## First slice: hash compositions

New `src/wallet/primitives/hashes.ts` delegates SHA256d and HASH160 to existing **MIT @noble/hashes 2.4.0**, retaining the existing Litecoin module exports. No new hash algorithm implementation, signing, key derivation, storage, protocol or dependency version change. Its implementation inputs are the mathematical compositions SHA256(SHA256(bytes)) and RIPEMD160(SHA256(bytes)), not SDK internals. The author has prior SDK exposure; no legal independence claim follows from these few lines.

Algorithm references: [NIST SHA-256 / FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final), [RIPEMD authors' algorithm/vector page](https://homes.esat.kuleuven.be/~bosselae/ripemd160.html). No implementation or prose was copied from these references. Implementations are supplied by noble under its installed MIT license (Paul Miller). Tests use the independent Node `crypto` oracle, fixed empty-input values, block-padding boundaries, offset views, large inputs, unchanged inputs and fresh output buffers. Existing chain tests exercise transaction/address behavior; they are not provenance evidence.

Verification: `npx tsc -p tsconfig.json --noEmit`, four targeted test files (57 tests, including 17 new adapter tests), and `git diff --check` passed. An earlier pre-adapter full `test:ci` run was killed by the runner at 120 seconds (exit 130); its partial passing output is not a full-suite pass. Full-suite, browser/build-artifact and Mobile verification remain outstanding.

At that earlier slice, Litecoin still imported SDK signing/key/encoding classes. The following approved slice supersedes that technical observation, not the unresolved legal findings. The SDK, engine and verifiers remain installed.

## Approved slice: other-coin crypto, with BSV retained

Implementation: `primitives/coinCrypto.ts` delegates curve arithmetic, compressed ECDH, RFC6979 ECDSA and verification to existing noble secp256k1; HMAC/SHA256 delegate to noble hashes. Application glue preserves BRC-42 scalar addition and BRC-43 invoice bytes, self/anyone/peer behavior and a narrow serialized-key boundary. `base58check.ts` implements positional base conversion, leading zeroes and checksum framing around the existing hash adapter, with a 128-character address input bound. It is address-only, not a replacement for arbitrary SDK encoding APIs. ASN.1 DER framing is small application glue; no curve/hash/signature algorithm was reimplemented.

Affected consumers: LTC/BTC/BCH/DOGE own keys, identity-payment child keys and signatures; Electrum script hashes; Arc USDC derived keys and public-key-to-address conversion; shared swap offers/cancel/fill signatures, settlement keys/secrets, HTLC signing/verification and fee/address helpers. Arc transaction signing already used noble and stays in place. Derivation domains, serialized root keys, storage, transaction sighashes and network/broadcast policy are unchanged. BSV transaction/BEEF/P2PKH functionality remains on SDK in `swap/legChains.ts` and the rest of the BSV stack is retained. Shared HTLC helpers also serve BSV; regression tests exercise that behavior.

There are no SDK runtime imports in `coins`, `ltc`, `btc`, `bch`, `doge`, `arcUsdc`, `primitives` or `swap` except the explicit BSV helpers in `swap/legChains.ts`. A regression checks this direct-import boundary. This is NOT a claim of transitive bundle separation: shared custody, identity, message transport and engine code still use restricted components. No SDK runtime fallback or real custody dual-run is introduced.

### Dependency evidence

Existing installed manifests and full LICENSE files were checked against the unchanged root lock:

| Dependency | Installed / locked | License text | SHA-256 of installed LICENSE |
| --- | --- | --- | --- |
| @noble/secp256k1 | 2.3.0 | MIT, Paul Miller, copyright 2019 | 394c2e6e5552e5dba202bee6390b9d6aa2754d657f5b9869e83b3d265a315501 |
| @noble/hashes | 2.4.0 | MIT, Paul Miller, copyright 2022 | 4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec |

These texts require retention of their copyright and permission notices. Packaging inclusion is still L3/L4, not established by an installed file. No new dependency installation or version/lockfile change was needed.

### Inputs, provenance and limits

Author exposure: prior upstream exposure is recorded; this is not clean-room. Inputs for this slice were existing application call sites/interfaces, mathematical protocol requirements and observable outputs for public synthetic keys. SDK implementation source was not read or translated for this slice. SDK calls remain in tests as compatibility oracles only. No upstream implementation or specification prose/code was copied into these adapters.

The mathematical compatibility references are BRC-42 “Key Derivation” and BRC-43 “Specification”. Their latest per-file revisions and document hashes were retrieved after implementation; this is a reproducibility record, NOT proof the earlier mutable-page fetch used identical bytes:
- [BRC-42 d403af3417815919218468556503b627cd272abc](https://raw.githubusercontent.com/bitcoin-sv/BRCs/d403af3417815919218468556503b627cd272abc/key-derivation/0042.md), SHA-256 5918476483e815914aac5ad780dca9d3fee15cd19dd9bc1e54aa5ab745dff6af.
- [BRC-43 99ee33ea5980313a5c2b01a02a1e42569d981fd6](https://raw.githubusercontent.com/bitcoin-sv/BRCs/99ee33ea5980313a5c2b01a02a1e42569d981fd6/key-derivation/0043.md), SHA-256 b84211fa1ab546643a388e99b6c7433f38eb070849adfb3c75e27812a959261d.

Specification/vector grants have NOT been verified: the root LICENSE retrieval failed. That leaves the plan's permission-before-use gate unsatisfied; user/rights/legal review is required before treating this slice as provenance-cleared. Golden compatibility and mathematical vectors do not establish rights to the existing app or its historical derivation.

Tests include recorded legacy own-key outputs for all five coins, self/anyone/peer derivation, sender/recipient reciprocity and serialized-root recovery, a published BRC-42 vector, independent Node/OpenSSL public-key/signature checks, exact deterministic DER bytes including scalar/digest boundaries, high-S verification, malformed keys/DER/paths and Base58 address versions/checksums. Only public synthetic keys and offline fixtures are used. Verification: 35 affected Vitest files / 367 tests passed; the 39 new crypto/encoding regression cases passed, TypeScript no-emit passed, the inventory Node test passed (1/1), and git diff --check passed. Independent crypto/security review, full-suite/build and exact Desktop/Mobile artifact verification remain open.

## Historical broader slices and acceptance gates (not current authorization)

1. **Encoding and keys:** inventory every used API; independently sourced permissive encoding/secp adapters, external address/signature/derivation vectors, malformed-input/low-S behavior and synthetic backup-restore equivalence. Crypto review before custody changes.
2. **Transaction/proof formats:** preserve BRC-100, BEEF and BRC-150 semantics; revision/license ledger first, then independent serialization/proof vectors and adversarial tests. No downgrade from complete proofs to indexer trust.
3. **Peer transport:** preserve authentication, replay defenses, ACK/retry, fallback, revocation and Desktop/Mobile interop; fake actors plus real peer integration tests.
4. **Engine:** read-compatible storage first, then actions/history; synthetic migrations, BRC-38/39 recovery, holding/handover, stale-session and spend priority tests. No network under storage locks; never abort signed queued transactions.
5. **Verifier:** independently maintained permissive consensus/script candidate must pass positive/negative consensus vectors and platform parity; no disabling validation. Independent security review is a release gate.
6. **Final clearance:** regenerate full dependency/native SBOMs, inspect renderer/sidecar maps, WASM, archives and APK/iOS assets; package exact required notices; legal/ownership review and all platform tests before removing restrictions from claims or metadata.

Blocking the *complete rewrite*, not this first slice: no cleared full BRC engine/consensus replacement has been selected; independent contributors/security review are needed for high-risk components, BRC specification rights need confirmation, and distributed dependency/provenance coverage is unfinished. A hash adapter does not make this wallet unrestricted.
