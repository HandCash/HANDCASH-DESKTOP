# BSV Script Conformance Check (Development-Only)

Development-only conformance replay of the pinned `bsv-script-lean` seed corpus against the installed `@bsv/sdk` (`Spend` / `Transaction`).

This check is **not** a runtime wallet dependency, is **not** vendored into the repository or shipped builds, and is **not** a release-blocking CI gate.

## Commands

```bash
# Download pinned seed corpus, verify SHA-256, and replay all 10,000 cases
npm run test:script-conformance

# Replay an already-downloaded local copy offline (still SHA-256 verified)
node scripts/bsv-script-conformance.mjs --corpus /path/to/seed.jsonl

# Run offline unit tests for the conformance runner itself
node --test scripts/bsv-script-conformance.test.mjs
```

## Pinned Upstream Provenance & Licensing

| Field | Value |
|-------|-------|
| Upstream repository | `https://github.com/Calhooon/bsv-script-lean` |
| Pinned commit | `1c051eaef1077cc95e5d1618686d5efacc4aa097` |
| Corpus path | `corpus/seed/seed.jsonl` |
| Corpus SHA-256 | `bc0651d0f7f8193aebbd233b258148d81ca553a8f43a01fc2594b51610f554b0` |
| Recorded oracle key | `spec@cb7e46e` (Lean 4 script semantics citing `bitcoin-sv` v1.2.3 `6504a3af`, `sv-mainnet-default`) |
| Consensus flag word | `4015663` (post-Chronicle block consensus at height `967896`; not mempool word `4016127`) |

Upstream licensing at commit `1c051eaef1077cc95e5d1618686d5efacc4aa097` is split by path per upstream `NOTICE`:

- **Open BSV License Version 5** (`LICENSE`, BSV Blockchains use condition): Lean semantics, generated spec, and corpora including `corpus/seed/seed.jsonl`.
- **Apache License 2.0** (`LICENSE-APACHE`): separable tooling (`tools/`, `harness/`, `Makefile`), except third-party copies noted in `NOTICE`.

HandCash Desktop does not commit, vendor, or distribute any `bsv-script-lean` source or corpus files. `scripts/bsv-script-conformance.mjs` fetches the pinned corpus on demand for local verification and rejects any payload whose SHA-256 differs from `SEED_SHA256`.

## Verified Baseline (`@bsv/sdk` 2.8.11)

Upstream's `corpus/witnesses/ts-sdk/manifest.json` recorded `@bsv/sdk` `3.0.0` (`ts-sdk@3.0.0`). This runner tests whatever version is installed in `node_modules/@bsv/sdk` (`2.8.11` at verification time).

- **Cases:** `10,000` (`5,502` valid, `4,498` invalid)
- **Explicit consensus flags (`4015663`):** `0` mismatches (`consensusMismatches: 0`)
- **Default SDK flags (no `verifyFlags`):** `160` differences (`defaultDifferences: 160`), matching upstream's recorded `default/spec` count (`9,840 / 10,000`) under `flags.policy-as-consensus`, where `@bsv/sdk` applies stricter mempool/policy restrictions by transaction version when `verifyFlags` is omitted.
- **Flag mapping note:** `@bsv/sdk` `Spend` derives post-Genesis rules from `UTXO_AFTER_GENESIS` / `UTXO_AFTER_CHRONICLE` and does not read a standalone `GENESIS` flag bit (matching upstream manifest's `unmapped_bits.GENESIS`).

## Scope & Limits

1. **Seed corpus only:** Replays only `corpus/seed/seed.jsonl` (10,000 synthetic post-Chronicle spends at spend/UTXO height `967896`, `tx_version` 1 or 2, `consensus: true`). It does not cover the other upstream corpora (`arith`, `bytes`, `crypto`, `eras`, `flow`, `gen`, `stack`, `tx`, `xsig-144`) or pre-Genesis / pre-Chronicle heights.
2. **Recorded oracle, not live Lean or reference node:** Compares against recorded `spec@cb7e46e` verdicts in `seed.jsonl`. It does not build or run Lean 4, `eval/bsvs`, `bitcoin-sv` (`sv-node`), or Teranode. Upstream explicitly states `bsv-script-lean` does not prove the reference node correct.
3. **Verdict parity only:** Checks `valid` vs `invalid` outcomes, not exact `SCRIPT_ERR_*` codes. Adapter/decoding errors, prevout mismatches, and non-`ScriptEvaluationError` exceptions (including `ScriptResourceLimitError`) fail the run rather than being counted as `'invalid'`.
4. **TypeScript SDK interpreter only:** Exercises `@bsv/sdk` (`Transaction` / `Spend`). It does not test the Rust wallet crates (`native-desktop/`), key derivation, coin selection, storage, fee policy, mempool relay rules, or live chain state. Passing does not guarantee a transaction will be mined or accepted by a node's mempool.
5. **Timeout & network bounds:** Default invocation requires HTTPS access to GitHub (`60 s` fetch timeout) and executes evaluation in an isolated child process killed with `SIGKILL` after `120 s`. Pass `--corpus` for offline runs.
6. **Updating the pin:** Never point at a moving branch. Review the target upstream commit, `LICENSE`/`NOTICE`, `SPEC` key, and flag word first, then update `PIN`, `SEED_SHA256`, `SPEC`, and `FLAGS` together in `scripts/bsv-script-conformance.mjs` and re-verify.
