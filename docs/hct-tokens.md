# HCT tokens

Spec: BRC-255 draft, in `BRCs-255/tokens/0255.md` until it is reviewed. "HCT" is a working name.

## Decision

All new tokens and issuer items use one HandCash format. It is not built on BRC-162:

- **Open mode (BNT, BRC-255).** The holder's signature alone moves an output, and validity is computed from transactions alone, so these are Bitcoin Native Tokens. Open tokens file in `p2pft`, open items in `p2pnft`.
- **Countersigned mode (not BNT, BRC-253 §15).** The issuer accepts every transfer, and custodians can release the asset when the issuer is gone. Countersigned tokens file in `csft`, items in `csnft`.
- **Items.** An item is a supply-1 deploy in either mode. One transaction can deploy up to 256 of them.

An asset's mode and kind are fixed at deploy, so it never changes filing. HCT shares each filing with the older format of the same mode (BRC-162 in `p2pft`, BRC-253 in `csft` / `csnft`), so one view shows a holder's tokens or items whatever their format. Readers tell them apart by the `hct` tag and the 40-hex asset id, never by the filing.

New HandCash items are HCT items too. 1Sat ordinals (`1sat`, BRC-147/150/165) stay fully supported as an outside format: receive, hold, send, market (`ordinal-v2`) and BRC-150 provenance, so items keep moving to and from 1Sat wallets and markets. HandCash minting stops creating them.

An item is never both formats at once. Keeping a 1Sat view in step would tie every HCT item transfer to ordinal satoshi positions, which brings back market pads and lost-satoshi risk.

BRC-162 tokens already held are converted by their issuer (BRC-255 §13). Until then they show read-only.

BRC-251 and BRC-252 ([#320](https://github.com/bsv-blockchain/BRCs/pull/320), [#321](https://github.com/bsv-blockchain/BRCs/pull/321)) stay as drafts. BRC-253 is rewritten as BRC-255's acceptance protocol, and BRC-254's `token-v2` layout moves to HCT outputs.

## Why it is cheaper

Measured with `@bsv/sdk` (BRC-255 §14 and `media/0255/hct.mjs`):

| | Lock bytes | 1-in, 2-out transfer | Output life (created + spent) |
|---|---|---|---|
| `csft` today | 246 | 891 | 478 |
| HCT countersigned | 125 | 580 | 322 |
| `p2pft` today | 67 | 492 | 224 |
| HCT open | 64 | 452 | 187 |

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

Every token deploy fixes its supply policy (BRC-255 §4), and `listHctAssets` reports it as `supply`:

| Policy | `issueHctAsset` arguments | Minting |
|---|---|---|
| Fixed | no `auth`, `max` or `size` | `mintHctAsset` refuses `fixed-supply` |
| Open | `auth: true` | any amount |
| Capped | `max` (units, supply included) and/or `size` (collection members); either implies `auth` | up to the cap; past it is `over-cap` |

A capped authority states the units and members issued so far. Every reader checks each mint against the cap during its walk, so a mint past the cap is never credited, whoever signed it. Dropping the authority ends minting for good.

## Modules (open mode, shipped)

| Concern | Module |
|---|---|
| Script encode/parse: deploy, held, authority, both clauses, beacon | `src/wallet/hct/script.ts` |
| Deploy payload (DAG-CBOR, `crit`) | `src/wallet/hct/payload.ts` |
| Issuer and holder keys (`[2, "hct issuer"]` counterparty `anyone`; `[2, "hct holder"]`) | `src/wallet/hct/keys.ts` |
| Deploy read, per-transaction conservation check, walk to the deploy | `src/wallet/hct/validity.ts` |
| Proof package (§6) and validated-transaction store | `src/wallet/hct/proof.ts`, `store.ts` |
| Issue, mint, transfer, receive (box `hct`), durable outbox, per-peer frontier | `src/wallet/hct/wallet.ts`, `state.ts`, chart `hctMachine` |
| Collectables shelf and send form | `src/components/HctShelf.tsx`, chart `hctHoldingsMachine` |
| BRC-100 methods `issueHctAsset`, `mintHctAsset`, `transferHctAsset`, `listHctAssets` (wallet-internal `burnHctUnits`) | `src/wallet/brc100Handler.ts` |
| App views (`p p2pft token`, `p p2pnft …` under the item grant) | `src/wallet/itemAccess.ts` |

Rules the code holds to:

- A row counts only when its (txid, asset) pair was validated by the walk **and** the remittance derives the key in its lock. A conjured or mis-filed row is never listed or spent.
- Receive checks that the box sender is the remittance sender and that every claimed output is a held output or authority of the named asset, never a deploy. History the package lacks is asked for with `need`; the message is not ACKed until filing succeeds. An invalid transfer is ACKed and refused.
- Apps view HCT rows and never write, spend or relinquish them. Every spend is built and signed by the wallet, re-checked against §4 before and after `signAction`, and aborted on any mismatch.
- Code written for BRC-162, 1Sat or change never heals, consolidates, sweeps or counts an HCT row (`isAssetFilingBasket`).
- Every send goes through `signedSendLifecycle`.

## Coins of other chains are native, not wrapped

Spec: BRC-213 ([`docs/bsva/brcs/coins/0213.md`](bsva/brcs/coins/0213.md), held back, not submitted), abstract for UTXO chains with Litecoin, Bitcoin Cash (`D` = 6), Bitcoin (`D` = 3) and Dogecoin (`D` = 20) bindings. Apps call `getCoinAddress` / `listCoins` / `sendCoins` with `chain: "ltc"`, `"bch"`, `"btc"` or `"doge"`; the Litecoin names below are aliases kept for apps written against earlier builds. Bitcoin Cash works the same way with its own key (`[2, "bch coin"]`, reserved from apps), CashAddr P2PKH, `SIGHASH_ALL|FORKID`, a header chain checked by SHA-256d and ASERT (`bch/headers.ts`), and Fulcrum servers over WSS that fail over (`bch/chain.ts`). Bitcoin (`[2, "btc coin"]`) and Dogecoin (`[2, "doge coin"]`) follow the same pattern over the shared Electrum source (`coins/electrumChain.ts`): Bitcoin pays from P2WPKH with BIP143 and checks SHA-256d with the 2016-block retarget; Dogecoin pays from P2PKH with the legacy signature hash and checks each header's AuxPoW against its scrypt parent, with DigiShield every block. This is depositing: the wallet holds the coins themselves. Wrapping a deposited coin so it moves at BSV fees is a separate, optional step that the wallet does not do; BRC-213 §13 lays out what it would cost and whom each kind of wrap trusts.

The wallet holds litecoin on Litecoin, with its own key; nothing is wrapped, minted or burned. A backed HCT token held by anyone but its issuer is a claim only the issuer's reserve key can pay, which is custody, so the wallet never creates one: a backed token only ever moves back to one of its issuers (`transferHctAsset` refuses anyone else with `custodial`, BRC-100 code `HCT_CUSTODIAL`). Earlier builds' wLTC tokens are retired records: hidden from Collections and Activity, never counted or priced.

| | |
|---|---|
| Key | The P2WPKH key `[2, "wltc reserve"]`, key ID `1`, counterparty `self` (the derivation earlier builds used, so their coins carry over). Apps can never derive or sign with that protocol (`reservedKeyRefusal` → `asset-protocol`). |
| Receive | `getLtcDepositAddress` returns the address and tells the watcher to read it for 2 hours; outside that window it reads every 5 minutes. A coin is recorded once its raw transaction hashes to its txid and pays this wallet's script. |
| Spendable | A received coin is spendable once this wallet's own Litecoin header chain (`ltc/headers.ts`: shipped checkpoint, exact retarget, scrypt proof of work, most work wins a reorg) counts 6 confirmations over its block. Explorers say which block, never how deep. Change from the wallet's own broadcast payment is spendable at once. |
| Pay | `withdrawLtc({ address, litoshi, description? })` (Send → LTC in the app) is an app payment in the same scope as a BSV `createAction`: contract group `wallet`, refused offline and on an install that does not hold the account (re-checked after a gap), the same "Approve payment" prompt with the amount in LTC and dollars, and the same per-app Auto-pay / spending grant, counted at its BSV-equivalent dollar value (no price, no Auto-pay; an approved payment with Auto-pay on waits for one). The Activity row names the app. It signs a P2WPKH payment from spendable coins, refuses the wallet's own address (`own-address`), records it, then broadcasts. A broadcast Litecoin did not take is retried each pass; a sent payment is checked until it is in a block and re-broadcast whenever no explorer knows it. |
| Show | Each received coin has a phase (`ltc/depositPhase.ts`): `unconfirmed`, `confirming` n of 6, `movable`, `unchecked`, `missing`, `abandoned`, each saying who established it and when. Activity rows `ltc-receive` / `ltc-send` read "Received / Sent X LTC", "On Litecoin", in dollars, and open on a Litecoin explorer. |
| Report | `listLtcDeposits` reads Litecoin and returns `{ address, balance, locked, deposits, withdrawals }`: `balance` is received and unspent, `locked` the part still confirming. |

The explorers (`litecoinspace.org`, then BRC-CLOUD `/v1/ltc`, Esplora API) are untrusted: amounts come from raw transactions the wallet checked, and depth only from its own header chain. The first run carries an earlier build's wLTC record over (`handcash.wltc.v1` → `handcash.ltc.v1`) and rewrites its rows to name the Litecoin transactions. Code: `src/wallet/coins/` (engine shared by every chain), `src/wallet/ltc/` and `src/wallet/bch/` (bindings), chart `coinMachine`. The watcher of a chain reads the network only for an account that has shown its address or held a coin on that chain.

Not built: Runes-style open minting. Open minting needs a mint output that anyone can spend, but only if they re-create it with a lower counter. Plain HCT locks cannot hold that rule without a covenant or a change to the spec.

## Phases

1. **Spec review.** BRC-255 draft open; name, marker and protocol IDs still movable.
2. **Core.** Done: script, payload, keys, validity, proof, with adversarial tests.
3. **Open mode end to end.** Done: issue, send, receive, `p2pft` / `p2pnft` filing, app access, Collectables shelf.
4. **Countersigned mode.** Acceptor, requester, beacon, release, policy, and items with collections. Until it lands, a countersigned HCT transfer stays unacknowledged in box `hct` so nothing is lost.
5. **Market.** BRC-254 on HCT outputs; BRC-CLOUD index and storefront read HCT rows in `p2pft` / `p2pnft`.
6. **Items.** Mint-studio and issuers mint HCT items. The market sells them on the token layout, with no pads. `1sat` stays as the outside-format path.
7. **Convert.** Issuers convert BRC-162 holdings; BRC-162 code is removed after a release in which no device reports a holding.

## Open decisions

- The final protocol name.
- Whether mint-studio issues HCT only from phase 3 on.
- How long read-only BRC-162 support lasts after conversion opens.
