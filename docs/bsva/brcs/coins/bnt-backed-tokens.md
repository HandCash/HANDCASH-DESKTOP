# BNT backed tokens (binding of BRC-212)

**Status:** held back. This was §15 of draft BRC-255 ([#335](https://github.com/bsv-blockchain/BRCs/pull/335)) until external coins were pulled from submission. Section numbers below (§2, §6, §7) are BRC-255's. The wallet still implements it in `src/wallet/bnt/backing.ts`, `payload.ts` (`bk`) and `validity.ts`.

## Backed tokens

A backed token stands for value held on another chain. Each unit is one base unit (a litoshi for Litecoin; a USDC atom for Arc) held at the reserve named in `bk`, and someone who holds the reserve key, the issuer acting as a federation, pays it out. The issuer is trusted to hold the reserve and not to mint one deposit twice. Every reader checks that each unit was minted against a real deposit that pays the reserve at least that much.

- **`ltc`:** PoW burial proof (BRC-212); `bk.reserve` is the foreign output script; deposit outpoint is a UTXO.
- **`arc`:** Arc Transfer receipt to a 20-byte Eth address (`bk.reserve`); deposit outpoint is `(txHash, logIndex)` in the same `bntb` wire form. Instant finality — not PoW SPV. Labs wrap: `src/wallet/arcUsdc/wrap.ts`.

**Backing output.** The deploy transaction, and every transaction that spends the authority and writes more units than it spends (a mint), MUST carry exactly one backing output for the asset:

```
OP_FALSE OP_RETURN "bntb" <deposit: txid in internal byte order || vout, 4 bytes little-endian> <asset id | OP_0>
```

The output carries 0 satoshis. `OP_0` in place of the asset id names the deploy that this transaction writes, whose id is not yet known when it is signed. A transaction that issues no units MUST NOT carry a backing output for the asset. A deploy or mint without one, or with more than one, fails §2 or §4.

One deposit backs one issuance. A reader MUST refuse a deploy or mint whose deposit another issuance it has checked already names, under the same chain and reserve. This is [BRC-212](./0212.md) §1, of which this section is a binding.

**Holding rule.** A reader credits a backed output at once. Units that a backed deploy or mint writes MUST NOT move until the deposit it names is proven. In the walk of §7, when an input takes a held output of a backed mint, or the deploy output of a backed deploy, the recipient MUST hold a burial proof of that transaction's deposit that checks. Without one the walk is missing; with one that fails it is invalid. An input that takes only an authority output needs no proof, so minting never waits on an earlier deposit. No script enforces the rule. Every wallet's walk does, so units moved early are worthless to everyone downstream.

A deploy output carries both supply and the authority. An issuer SHOULD split it, after its deposit is proven, into a held output and an authority, issuing nothing, before minting again. A mint that spent the deploy would rewrite the deploy's units into outputs that also wait on the new deposit.

**Burial proof.** A JSON object with the chain's evidence. For `"ltc"`:

```json
{ "tx": "<raw deposit transaction, hex>", "path": ["<merkle sibling, display hex>", "…"], "pos": 0, "height": 3197244, "header": "<80-byte header of the deposit's block, hex>" }
```

The proof checks when:

1. `tx` hashes, without witness data, to the deposit txid; it is not a coinbase; and it is not 64 bytes long.
2. Output `vout` of `tx` pays exactly the `bk` reserve script, and its value is at least the units the backed transaction issued: the deploy's `supply`, or for a mint its written minus spent units.
3. `path` and `pos` lead from the txid to the merkle root of `header`.
4. The reader's own header chain of the backing chain holds `header` at `height`, and holds at least 5 blocks after it (6 confirmations).

**Reader's header chain.** Each reader keeps its own header chain of the backing chain (SPV) and trusts no explorer. For Litecoin it starts at a checkpoint the reader ships, and accepts a header after it only when the header names the hash of the one before it, carries exactly the bits Litecoin's retarget rule gives it (every 2016 blocks, measured from the last block of the previous window), meets those bits by scrypt proof of work, and is not more than two hours in the future. On a reorganization the reader keeps the branch with more work. A block before the checkpoint is accepted only when it links up to the checkpoint by hash. A reader that cannot read its chain, or whose chain is not 6 blocks past `height` yet, treats the proof as missing, not as failing. A proof whose block the chain holds 6 deep, with another block at `height`, fails.

A proof is a fact about the other chain alone; it never goes stale. Readers need no live connection once their chain has passed the block. Every reader checks the same block against its own chain, so a forged burial would need more work than the whole backing chain did after the reader's checkpoint, not just the work of a few headers.

**Double spends.** A deposit that is replaced or reorganized away before it is buried never gets a proof. The units minted against it stay where they were minted and never move validly. Nothing has to watch for the conflict, and nothing is burned.

**Withdrawal.** The issuer pays out of the reserve only against proven deposits, and burns the units it redeems by locking them to a key nobody can sign for (§4 forbids destroying units). Units minted against a deposit that never confirms are never paid out.
