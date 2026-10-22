# BNT tokens

Spec: BRC-255 draft, Bitcoin Native Tokens: Compact Format, in `BRCs-255/tokens/0255.md` until it is reviewed. The marker, box, tag and protocol IDs are `bnt`; the countersigned mode (IPT) gets its own `ipt` marker when it is built, so no marker spans both classes.

## Decision

All tokens and issuer items use one HandCash format. BRC-162 (BSV-21) is not supported:

- **Open mode (BNT, BRC-255).** The holder's signature alone moves an output, and validity is computed from transactions alone, so these are Bitcoin Native Tokens. Open tokens file in `bntft`, open items in `bntnft`.
- **Countersigned mode (IPT, not BNT, BRC-253 §15).** The issuer accepts every transfer, and custodians can release the asset when the issuer is gone. Countersigned tokens file in `iptft`, items in `iptnft`.
- **Items.** An item is a supply-1 deploy in either mode. One transaction can deploy up to 256 of them.

An asset's mode and kind are fixed at deploy, so it never changes filing. Rows are tagged with the filing name and `<filing>:<40-hex asset id>`.

New HandCash items are BNT items too. 1Sat ordinals (`1sat`, BRC-147/150/165) stay fully supported as an outside format: receive, hold, send, market (`ordinal-v2`) and BRC-150 provenance, so items keep moving to and from 1Sat wallets and markets. HandCash minting stops creating them.

An item is never both formats at once. Keeping a 1Sat view in step would tie every BNT item transfer to ordinal satoshi positions, which brings back market pads and lost-satoshi risk.

BRC-162 tokens are not read, listed, claimed or swept. A BRC-162 or `application/bsv-20` output paying a wallet address stays there: the address scan recognises it only to keep it out of the coin and 1Sat paths.

BRC-251 and BRC-252 ([#320](https://github.com/bsv-blockchain/BRCs/pull/320), [#321](https://github.com/bsv-blockchain/BRCs/pull/321)) stay as drafts. BRC-253 is rewritten as BRC-255's acceptance protocol, and BRC-254's `token-v2` layout moves to BNT outputs.

## Why it is cheaper

Measured with `@bsv/sdk` (BRC-255 §14 and `media/0255/bnt.mjs`):

| | Lock bytes | 1-in, 2-out transfer | Output life (created + spent) |
|---|---|---|---|
| BRC-253 (retired) | 246 | 891 | 478 |
| IPT (countersigned) | 125 | 580 | 322 |
| BRC-162 (retired) | 67 | 492 | 224 |
| BNT open | 64 | 452 | 187 |

Where the bytes go:

- **Prefix.** A 3-byte marker plus a 20-byte hashed asset id (23 bytes) replaces the 36-byte BRC-162 id.
- **Holder.** The holder's public key sits in the lock, so the unlock carries only the signature.
- **Release.** A 20-byte hash lock replaces the release key set. Revealing the secret is the release, so release-branch spends cannot be private.
- **Acceptor fee coins.** These are P2PK, at 114 bytes per input against 148.
- **Beacon.** There is one per issuer key set, not one per asset.

Proof trust is fixed per mode, with nothing in between:

- **Open transfer:** the recipient checks every hop back to the deploy and trusts no one, not even the issuer. The sender ships only the hops this recipient has not already checked, so repeat receipts are small. A first receipt of an old, busy asset is the largest case, at about 0.5 KB per hop.
- **Countersigned transfer:** the issuer checked the history before signing, so the package is one Extended Format transaction, about 0.8 KB. A transfer after a release is not issuer-checked, so it walks back to the last transaction the issuer accepted.

## Supply

Every token deploy fixes its supply policy (BRC-255 §4), and `listBntAssets` reports it as `supply`:

| Policy | `issueBntAsset` arguments | Minting |
|---|---|---|
| Fixed | no `auth`, `max` or `size` | `mintBntAsset` refuses `fixed-supply` |
| Open | `auth: true` | any amount |
| Capped | `max` (units, supply included) and/or `size` (collection members); either implies `auth` | up to the cap; past it is `over-cap` |

| Open mint (Runes-style) | `openMint: { count, amount }` on a token, with no `max`, `size` or `item`; `amount` defaults to the supply | anyone, `amount` units at a time, `count` times; then `minted-out` |

A capped authority states the units and members issued so far. Every reader checks each mint against the cap during its walk, so a mint past the cap is never credited, whoever signed it. Dropping the authority ends minting for good.

### Open minting (HandCash extension to BRC-255, `om`)

The deploy payload carries `om: [count, lim]`, listed in `crit`, so a reader that does not know it refuses the asset instead of misreading it. `count` is at most 10,000, which keeps a first receipt's walk inside its 20,000-hop budget. The most that can ever exist is `supply + count × lim`.

- **Opening.** Right after the deploy, the issuer spends the authority into one mint output with `remaining = count` and keeps the supply. That transaction issues nothing, and no authority exists after it, so the issuer has no more minting power than anyone else.
- **Mint output.** `<"bnt"‖asset id> OP_0 <remaining, 4-byte LE> OP_2DROP OP_DROP <covenant>`, 1 sat, with no holder. The covenant checks the spending transaction through OP_PUSH_TX (a signature with key 1 and nonce 1, so anyone can make it). Output 0 must be the same mint with `remaining − 1`, left out once that reaches 0, and the next output must be a held output of exactly `lim` units, 1 sat, to a key the minter names. Other outputs are free.
- **Unlock.** `<other outputs serialized> <holder key> <preimage>`. The covenant needs a 32-byte low-S signature, so about 1 in 512 transactions must change `nLockTime` and sign again; the wallet does this.
- **Validity.** The walk applies the same rules as the covenant, so a reader never relies on the script alone. A transaction that spends the mint but breaks §4 elsewhere still passes its vout-0 mint on, so nobody can end the mint chain by spending it badly; nothing else in that transaction is credited.
- **Finding the tip.** `mintBntAsset({ assetId, deploy?, tip? })` starts from the last mint it knows (or the one it is given) and follows spends with the chain's spend lookup, up to 64 steps. Two minters racing for the same tip get one mint; the loser's broadcast fails and is aborted.

## Modules (open mode, shipped)

| Concern | Module |
|---|---|
| Script encode/parse: deploy, held, authority, mint, both clauses, beacon | `src/wallet/bnt/script.ts` |
| Open-mint covenant (OP_PUSH_TX) and its unlock | `src/wallet/bnt/mintCovenant.ts` |
| Deploy payload (DAG-CBOR, `crit`) | `src/wallet/bnt/payload.ts` |
| Issuer and holder keys (`[2, "bnt issuer"]` counterparty `anyone`; `[2, "bnt holder"]`) | `src/wallet/bnt/keys.ts` |
| Deploy read, per-transaction conservation check, walk to the deploy | `src/wallet/bnt/validity.ts` |
| Proof package (§6) and validated-transaction store | `src/wallet/bnt/proof.ts`, `store.ts` |
| Issue, mint, transfer, receive (box `bnt`), durable outbox, per-peer frontier | `src/wallet/bnt/wallet.ts`, `state.ts`, chart `bntMachine` |
| Collectables shelf and send form | `src/components/BntShelf.tsx`, chart `bntHoldingsMachine` |
| BRC-100 methods `issueBntAsset`, `mintBntAsset`, `transferBntAsset`, `listBntAssets` (wallet-internal `burnBntUnits`) | `src/wallet/brc100Handler.ts` |
| App views (`p bntft token`, `p bntnft …` under the item grant) | `src/wallet/itemAccess.ts` |

Rules the code holds to:

- A row counts only when its (txid, asset) pair was validated by the walk **and** the remittance derives the key in its lock. A conjured or mis-filed row is never listed or spent.
- Receive checks that the box sender is the remittance sender and that every claimed output is a held output or authority of the named asset, never a deploy. History the package lacks is asked for with `need`; the message is not ACKed until filing succeeds. An invalid transfer is ACKed and refused.
- Apps view BNT rows and never write, spend or relinquish them. Every spend is built and signed by the wallet, re-checked against §4 before and after `signAction`, and aborted on any mismatch.
- Code written for 1Sat or change never heals, consolidates, sweeps or counts a BNT row (`isAssetFilingBasket`).
- Every send goes through `signedSendLifecycle`.

## Coins of other chains are native, not wrapped

Spec: BRC-213 ([`docs/bsva/brcs/coins/0213.md`](bsva/brcs/coins/0213.md), held back, not submitted), abstract for UTXO chains with Litecoin, Bitcoin Cash (`D` = 6), Bitcoin (`D` = 3) and Dogecoin (`D` = 20) bindings. Apps call `getCoinAddress` / `listCoins` / `sendCoins` with `chain: "ltc"`, `"bch"`, `"btc"` or `"doge"`; the Litecoin names below are aliases kept for apps written against earlier builds. Bitcoin Cash works the same way with its own key (`[2, "bch coin"]`, reserved from apps), CashAddr P2PKH, `SIGHASH_ALL|FORKID`, a header chain checked by SHA-256d and ASERT (`bch/headers.ts`), and Fulcrum servers over WSS that fail over (`bch/chain.ts`). Bitcoin (`[2, "btc coin"]`) and Dogecoin (`[2, "doge coin"]`) follow the same pattern over the shared Electrum source (`coins/electrumChain.ts`): Bitcoin pays from P2WPKH with BIP143 and checks SHA-256d with the 2016-block retarget; Dogecoin pays from P2PKH with the legacy signature hash and checks each header's AuxPoW against its scrypt parent, with DigiShield every block. This is depositing: the wallet holds the coins themselves. Wrapping a deposited coin so it moves at BSV fees is a separate, optional step that the wallet does not do; BRC-213 §13 lays out what it would cost and whom each kind of wrap trusts.

The wallet holds litecoin on Litecoin, with its own key; nothing is wrapped, minted or burned. A backed BNT token held by anyone but its issuer is a claim only the issuer's reserve key can pay, which is custody, so the wallet never creates one: a backed token only ever moves back to one of its issuers (`transferBntAsset` refuses anyone else with `custodial`, BRC-100 code `BNT_CUSTODIAL`). Earlier builds' wLTC tokens are retired records: hidden from Collections and Activity, never counted or priced.

| | |
|---|---|
| Key | The P2WPKH key `[2, "wltc reserve"]`, key ID `1`, counterparty `self` (the derivation earlier builds used, so their coins carry over). Apps can never derive or sign with that protocol (`reservedKeyRefusal` → `asset-protocol`). |
| Receive | `getLtcDepositAddress` returns the address and tells the watcher to read it for 2 hours; outside that window it reads every 5 minutes. A coin is recorded once its raw transaction hashes to its txid and pays this wallet's script. |
| Spendable | A received coin is spendable once this wallet's own Litecoin header chain (`ltc/headers.ts`: shipped checkpoint, exact retarget, scrypt proof of work, most work wins a reorg) counts 6 confirmations over its block. Explorers say which block, never how deep. Change from the wallet's own broadcast payment is spendable at once. |
| Pay | `withdrawLtc({ address, litoshi, description? })` (Send → LTC in the app) is an app payment in the same scope as a BSV `createAction`: contract group `wallet`, refused offline and on an install that does not hold the account (re-checked after a gap), the same "Approve payment" prompt with the amount in LTC and dollars, and the same per-app Auto-pay / spending grant, counted at its BSV-equivalent dollar value (no price, no Auto-pay; an approved payment with Auto-pay on waits for one). The Activity row names the app. It signs a P2WPKH payment from spendable coins, refuses the wallet's own address (`own-address`), records it, then broadcasts. A broadcast Litecoin did not take is retried each pass; a sent payment is checked until it is in a block and re-broadcast whenever no explorer knows it. |
| Show | Each received coin has a phase (`ltc/depositPhase.ts`): `unconfirmed`, `confirming` n of 6, `movable`, `unchecked`, `missing`, `abandoned`, each saying who established it and when. Activity rows `ltc-receive` / `ltc-send` read "Received / Sent X LTC", "On Litecoin", in dollars, and open on a Litecoin explorer. |
| Report | `listLtcDeposits` reads Litecoin and returns `{ address, balance, locked, deposits, withdrawals }`: `balance` is received and unspent, `locked` the part still confirming. |

The explorers (`litecoinspace.org`, then BRC-CLOUD `/v1/ltc`, Esplora API) are untrusted: amounts come from raw transactions the wallet checked, and depth only from its own header chain. The first run carries an earlier build's wLTC record over (`handcash.wltc.v1` → `handcash.ltc.v1`) and rewrites its rows to name the Litecoin transactions. Code: `src/wallet/coins/` (engine shared by every chain), `src/wallet/ltc/` and `src/wallet/bch/` (bindings), chart `coinMachine`. The watcher of a chain reads the network only for an account that has shown its address or held a coin on that chain.

## Phases

1. **Spec review.** BRC-255 draft open; name, marker and protocol IDs still movable.
2. **Core.** Done: script, payload, keys, validity, proof, with adversarial tests.
3. **Open mode end to end.** Done: issue, send, receive, `bntft` / `bntnft` filing, app access, Collectables shelf.
4. **Countersigned mode.** Acceptor, requester, beacon, release, policy, and items with collections. Until it lands, a countersigned transfer stays unacknowledged in box `bnt` so nothing is lost.
5. **Market.** BRC-254 on BNT outputs; BRC-CLOUD index and storefront read BNT rows in `bntft` / `bntnft`.
6. **Items.** Mint-studio and issuers mint BNT items. The market sells them on the token layout, with no pads. `1sat` stays as the outside-format path.
7. **BRC-162 removed.** Done: no read-only support and no conversion path.

## Open decisions

- The final protocol name.
- Whether mint-studio issues BNT only from phase 3 on.
- Whether open minting (`om`, the mint form) goes into the BRC-255 draft or stays a HandCash extension, and whether it gets a UI and an indexed mint tip instead of following spends.
