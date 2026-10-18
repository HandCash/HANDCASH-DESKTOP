# HCT tokens

Spec: BRC-255 draft, in `BRCs-255/tokens/0255.md` until it is reviewed. "HCT" is a working name.

## Decision

All new tokens and issuer items use one HandCash format. It is not built on BRC-162:

- **Open mode.** The holder's signature alone moves an output. Open tokens file in `p2pft`, open items in `p2pnft`.
- **Countersigned mode.** The issuer accepts every transfer, and custodians can release the asset when the issuer is gone. Countersigned tokens file in `csft`, items in `csnft`.
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
| BRC-100 methods `issueHctAsset`, `mintHctAsset`, `transferHctAsset`, `listHctAssets` (wallet-internal `burnHctUnits` for wLTC) | `src/wallet/brc100Handler.ts` |
| App views (`p p2pft token`, `p p2pnft …` under the item grant) | `src/wallet/itemAccess.ts` |

Rules the code holds to:

- A row counts only when its (txid, asset) pair was validated by the walk **and** the remittance derives the key in its lock. A conjured or mis-filed row is never listed or spent.
- Receive checks that the box sender is the remittance sender and that every claimed output is a held output or authority of the named asset, never a deploy. History the package lacks is asked for with `need`; the message is not ACKed until filing succeeds. An invalid transfer is ACKed and refused.
- Apps view HCT rows and never write, spend or relinquish them. Every spend is built and signed by the wallet, re-checked against §4 before and after `signAction`, and aborted on any mismatch.
- Code written for BRC-162, 1Sat or change never heals, consolidates, sweeps or counts an HCT row (`isAssetFilingBasket`).
- Every send goes through `signedSendLifecycle`.

## Wrapped LTC (wLTC), proof of concept

wLTC is litecoin carried as an open, backed HCT token (`sym: wLTC`, 8 decimals, open supply, `bk: ["ltc", <reserve script>]`). One unit is one litoshi held at a Litecoin reserve address. BSV script cannot release LTC, so someone must hold the LTC key; in this proof of concept that is the wallet itself, a 1-of-1 federation. Nobody else can mint wLTC for that reserve, and only that wallet can pay its LTC out.

| Step | What the wallet does |
|---|---|
| Address | `getLtcDepositAddress` returns the P2WPKH address of the `[2, "wltc reserve"]` key (counterparty `self`). Apps can never derive or sign with that protocol (`reservedKeyRefusal` → `asset-protocol`). |
| Credit | `listLtcDeposits` lists the reserve's outputs. A deposit whose raw transaction hashes to its txid and pays the reserve script is minted as wLTC at once, like an unproven BSV payment: the balance is UTXO state from first sight. The first deposit issues the token; later ones mint. Each deploy and mint carries a backing output (`OP_FALSE OP_RETURN "hctb" <deposit outpoint> <asset id>`) naming its deposit. |
| Move | Units a backed deploy or mint writes move only with the deposit's burial proof (BRC-255 backed tokens): the raw deposit, its merkle path, and the height and header of its block. Every receiver checks that block is on its own Litecoin header chain (`wltc/headers.ts`: shipped checkpoint, exact retarget, scrypt proof of work, most work wins a reorg, synced only when a check needs it) under at least 6 confirmations. The proof rides the transfer package (`bk`), so a double-spent or replaced deposit never yields wLTC anyone accepts, and no conflict watch or burn is needed. `listHctAssets` reports units still waiting as `locked`, and the wallet never spends them. |
| Watch | `watchLtcDeposits` runs once a minute while the wallet is visible. For 2 hours after `getLtcDepositAddress` hands out the address it also reads the reserve and credits new deposits, so one sent after the deposit page closed still appears. With no deposit expected and none waiting it does nothing and touches no network. |
| Prove | While a deposit waits, a watcher (60 s, only with the page visible) asks an explorer which block holds it (`locateLtcDeposit`) and keeps the checked inclusion proof. From then on only the wallet's own header chain counts its confirmations (`checkLtcBurial`); no explorer is asked how deep it is. At 6 the wallet records the proof (`proveHctBacking`). A reorg off its block drops the proof and locates it again. A deposit no explorer has known for 30 minutes is shown `void`; that is presentation only, and its wLTC moves if the deposit later reaches a block. |
| Show | Each deposit has a phase (`wltc/depositPhase.ts`): `unconfirmed`, `confirming` n of 6, `movable`, `unchecked` (Litecoin unreadable; keeps the last count and its time), `missing`, `abandoned`. Every phase says who established it and when; time estimates are labelled as Litecoin's 2.5-minute pace. Collections show the Litecoin mark the wallet draws from `bk`, and confirmation marks per waiting deposit; the send form lists each one. Activity's `Litecoin deposit` row carries the marks, and its details show the deposit outpoint, block and BSV mint. |
| Order | While the first deposit is unproven, its deploy is the mint authority, so later deposits wait (`waiting`). Once it is proven the wallet splits the deploy into units and a bare authority, so every later mint spends the authority alone and never re-locks proven units. |
| Once only | Each mint carries the label `wltc deposit <txid>.<vout>`, which rides the BRC-39 history. A mint interrupted mid-flight is resolved by that label, never by minting again. |
| Withdraw | `withdrawLtc({ address, litoshi })` (prompted) pays from proven deposits only, using the amounts it recorded, never the explorer's. It signs the LTC payout and keeps it unsent, burns the amount plus the Litecoin fee to a key nobody can sign for, then broadcasts. A failed burn sends nothing. A failed broadcast after the burn is retried on every refresh, and the payout is never burned twice. |

The explorers (`litecoinspace.org`, then BRC-CLOUD `/v1/ltc`, Esplora API) are untrusted. A lying explorer can make the wallet mint against a deposit that never confirms, but those units never move: nobody can produce their burial proof. Wallets from before 1.3.601 hold an unbacked wLTC whose deposits were credited only after burial; it stays withdrawable.

Cost per deposit: one BSV mint of about 0.5 KB (about 50 satoshis at 100 sat/kB) with a 0-satoshi backing output, and one split after the first deposit. Burial proofs travel off chain in the transfer package: about 1 KB at 2 headers, up to about 92 KB at 576. Explorer calls: one reserve listing per refresh, one raw transaction per new deposit, one status per unproven deposit per refresh, then the merkle path and its headers once. A deposit that never confirms costs the issuer only its mint fee. Code: `src/wallet/wltc/` and chart `wltcMachine`. Try it at `https://brc-cloud.bcryderman.workers.dev/ltc-deposit`.

Not built: a multi-party federation (k-of-n LTC multisig with HCT countersigned mode), and Runes-style open minting. Open minting needs a mint output that anyone can spend, but only if they re-create it with a lower counter. Plain HCT locks cannot hold that rule without a covenant or a change to the spec.

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
