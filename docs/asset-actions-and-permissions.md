# Asset actions and permissions

Every permission an app can hold, and every item, token, market and BSV action the wallet performs, with the module that owns it. The last sections cover offers (market listings and direct offers), what is still missing, and countersigned (issuer-accepted) tokens and items.

Related: [`brc-wallet-feature-map.md`](./brc-wallet-feature-map.md) (feature → BRC), [`token-architecture.md`](./token-architecture.md), [`wallet-p2p-messagebox.md`](./wallet-p2p-messagebox.md).

## 0. The four asset profiles

Every asset the wallet holds belongs to exactly one profile. A profile is a storage basket, an app permission scheme, a tag prefix and a set of actions. Granting one profile never grants another, and no asset changes profile, not even a released countersigned one.

| | `1sat` | `p2pft` | `csft` | `csnft` |
|---|---|---|---|---|
| Holds | Items (one-sat ordinals) | Tokens (BRC-162, P2P-FT) | Countersigned tokens | Countersigned items (a supply-1 deploy) |
| Spec | BRC-147, BRC-150, BRC-165 | BRC-162, BRC-251, BRC-252 | BRC-253 draft | BRC-253 draft |
| Authenticity | BRC-150 proof to the origin | BRC-176 lineage to the deploy | The issuer's countersignature in each transfer | Same as `csft` |
| Who signs a transfer | Owner | Owner | Owner, then the issuer (or m of n cosigners); after release, the owner with the published keys | Same as `csft` |
| App view (section 2) | `p 1sat all \| collection \| app \| creator \| id` | `p p2pft all \| token \| id` | `p csft all \| asset \| id` | `p csnft all \| asset \| collection \| id` |
| App spend label | `p 1sat input id <key>` | `p p2pft input id <key>` | None: wallet only | None: wallet only |
| Send | `sendCollectable` (section 3) | `sendFungible` (section 4) | `transferCountersignedAsset` (section 9) | `transferCountersignedAsset` |
| Market listing (section 5) | `ordinal-v2` | `token-v2` | `token-v2`; the issuer countersigns list, buy and cancel | Same as `csft`, one unit |
| Direct offer (section 8) | Not yet (section 7) | Give, or ask for | Give; asking for one is refused (`countersigned-want`) | Same as `csft` |
| App actions, each prompted | Mint; `createAction` spend by label; list, cancel, buy | Deploy; `createAction` spend by label; list, cancel, buy; direct offers | `issue`, `transfer`, `join`, `retire`, `releaseCountersignedAsset`; list, cancel, buy; direct offers that give | Same as `csft` |

The two left profiles are open: only the chain and the proof decide. The two right profiles carry the issuer's control in the lock, so a sats price or a market signature alone cannot move them. Either party can still ask the issuer: every list, buy and cancel of a countersigned asset is a sender-funded trade (BRC-253 §6). The party that builds the transaction funds it and sends it to the acceptor, which countersigns the asset inputs.

## 1. Bridge methods

The bridge listens on `https://127.0.0.1:2121`, with an HTTP fallback on `http://127.0.0.1:3321` (`electron/httpServer.ts`). Gate sets live in `src/contracts/brc100.ts`. A method must also be in the handler manifest `src/contracts/brc100Handlers.ts`, or the bridge answers 404.

| Gate | Methods | Behaviour |
|---|---|---|
| Public | `getVersion`, `getNetwork`, `getHeight`, `getHeaderForHeight` | No origin check |
| Silent | `isAuthenticated` | Never prompts |
| Connect | `waitForAuthentication` | Shows the Connect prompt |
| Connected | `getPublicKey`, `abortAction`, `listActions`, `listOutputs`, `getBalance`, `createHmac`, `verifyHmac`, `verifySignature`, `listCertificates`, `discoverByIdentityKey`, `discoverByAttributes`, `getClaimedCloudHandle`, `getTokenIcon`, `listDirectOffers`, `listCountersignedAssets`, market reads | Connect only. `listOutputs` on an item, token, `csft` or `csnft` scope adds a view gate. |
| Action | `createAction`, `signAction`, `internalizeAction`, `relinquishOutput`, `relinquishCertificate`, `createSignature`, `encrypt`, `decrypt`, `revealCounterpartyKeyLinkage`, `revealSpecificKeyLinkage`, `proveCertificate`, `acquireCertificate`, `createAdminIdentityProof`, market writes, `createDirectOffer`, `buyDirectOffer`, `collectDirectOfferProceeds`, `cancelDirectOffer`, `issueCountersignedAsset`, `transferCountersignedAsset`, `joinCountersignedAsset`, `retireCountersignedAsset`, `releaseCountersignedAsset` | Connect, then an approval for each call. No two actions share consent. |
| Migration | `getLegacyAddress`, `refreshLegacyAddress`, `listMigrationTxids`, `openKeyRecovery` | HandCash hosts only (`migration.ts`) |

Origin-limited HandCash methods:

- **Market** (`isMarketListingOrigin`, `marketListing.ts`): HandCash hosts plus `market-v2.handcash.io`, `handcash-market-v2.pages.dev` and `brc-cloud.bcryderman.workers.dev`. Covers create, cancel and purchase of listings, purchase intents, provenance checks, receipts, status, publish marks and `getTokenIcon`. Duplicate in-flight list, cancel or purchase calls for one item return `409 ACTION_IN_PROGRESS`.
- **Handle claim:** `claimCloudHandle` and `clearClaimedCloudHandle` are limited to HandCash hosts.
- **Admin:** `createAdminIdentityProof` is limited to HandCash and BRC-CLOUD hosts, with a `handcash-ops-login` challenge that expires in 5 minutes.

Bridge-wide rules:

- The browser `Origin` header beats the `originator` header.
- Protocol `account` and self-linkage are reserved (BRC-208).
- `createAction` checks every held-row spend label against exactly one held row that is also an input.
- Index-expansion methods and the retired fungible protocol are refused by name.

## 2. Permissions

All grants are stored per account (`accountLocalKey`). Every HandCash catalog host folds to `handcash.io`, so one grant covers them all.

| Grant | What it allows | Granted by | Ends |
|---|---|---|---|
| **Connect** | Connected methods; opens a 20 s fresh-connect window | Connect prompt (`allowOrigin`) | Disconnect |
| **Item view** | `listOutputs` on `p 1sat all \| collection \| app \| creator \| id`; filtered to the granted collections, apps, creators or ids | View prompt (`requestItemViewApproval`); `id` lookups are silent and cover only that id; catalog hosts get `all` | Disconnect |
| **Token view** | `listOutputs` on `p p2pft all \| token \| id` (`p bsv21` still read); a filtered grant stays an allowlist | View prompt (`requestTokenViewApproval`) | Disconnect |
| **Countersigned token view** | `listOutputs` on `p csft all \| asset \| id` | View prompt (`requestCountersignedViewApproval`), one grant per profile; `id` lookups are silent | Disconnect |
| **Countersigned item view** | `listOutputs` on `p csnft all \| asset \| collection \| id` | Same, its own grant | Disconnect |
| **Item and token receive** | Later item or token `internalizeAction` calls without a prompt | First approved receive | Disconnect |
| **BSV receive** | Plain BSV `internalizeAction` without a prompt | On by default; "Require receive approval" opts out | Opt-out or disconnect |
| **Auto-pay** | `createAction` paying up to `maxUsd` (default $10) per `windowHours` (default 24); never `signAction` | App details | Cleared or disconnect |
| **Spending authorization** (BRC-73) | Replaces the auto-pay window with a monthly cap from the app manifest; auto-pay must be on | Connect, from `metanet.groupPermissions.spendingAuthorization` | Disconnect |
| **Identity proof** | `proveCertificate` without a prompt | Auto inside the fresh-connect window, then for the session in memory | Session end |
| **Held-row spend label** | `createAction` label `p 1sat input id <key>` / `p p2pft input id <key>` names the one held output this action may spend | Per action, inside the action prompt | Single use |

Always prompted, never covered by a grant: item and token sends, mints, identity-signed issuance, every market write and direct offer, `createSignature`, encryption and key linkage. Prompt wording comes from `summarizeAction` (`permissions.ts`). Market prompts show the item and "Total includes the 5% market fee".

Not implemented: BRC-73 protocol, basket, certificate and counterparty grants. Calls that would use them prompt each time. Persisted grants never expire.

Revocation: `revokeOrigin` removes the app and clears its auto-pay, spending authorization and session grants (`AppDetailsPanel.tsx`, Disconnect).

Scopes refused by name: a bare `1sat` (`USE_P1SAT_SCOPE`), a bare `p2pft` or `bsv21` (`USE_PBSV21_SCOPE`), a bare `csft` or `csnft` (`USE_COUNTERSIGNED_SCOPE`), any app write into either or a `p csft|csnft input id` label (`COUNTERSIGNED_WALLET_ONLY`), and any unknown `p` scheme (`UNSUPPORTED_P_BASKET`).

## 3. Item actions (1Sat)

| Action | Owner | Started from |
|---|---|---|
| Send one | `sendCollectable` → `collectableSendMachine` → `itemSendMachine`; BRC-150 remittance from `oneSatProvenance.ts`; `signedSendLifecycle` | `SendCollectablePanel` |
| Send many to one recipient | `sendCollectables`, `collectableBatch.ts`, bulk run `collectableSendRun*` | `SendCollectablePanel` |
| Receive from a peer | `internalizePeerItemSettle` (`ingestItemSettle.ts`), Atomic BEEF from the messagebox | Inbox, bridge `internalizeAction` |
| Receive by address scan | `oneSatImport.ts`, `ingestLegacyAddress.ts` | Refresh |
| Mint | App `createAction`; "Mint item" prompt; optional BRC-247 issuer stamp (`identityIssuance.ts`) | Apps only |
| Import from legacy keys | `import/items.ts`, `itemMigrateBundle.ts`, `phraseSweep.ts` | Settings → Import |
| Burn | `burnOneSat`, `burnMachine` | `BurnAssetPanel` |
| Abandon (no chain spend) | `abandonCollectable` | Item details |
| Release from an app | `relinquishOutput` on an item basket | Prompt |
| Verify | `verifyItemAuthenticity`, `oneSatAuthenticity.ts` | Item details |
| List, cancel, buy | Section 5 | Market site; cancel also in wallet |

## 4. Token actions (BRC-162 / P2P-FT)

Filing name `p2pft`, tag `p2pft:<tokenId>`; legacy `bsv21` rows move over once (`token/filing.ts`).

| Action | Owner | Started from |
|---|---|---|
| Deploy or mint | App `createAction`; wire format from `token/mintWire.ts`; issuer stamp `token/issuer.ts` | Apps only |
| Send | `sendFungible` → `sendBsv21Tokens`, `bsv21SendMachine`, `sendPlan.ts` | `SendFungiblePanel` (with the peer capability warning) |
| Receive | `internalizePeerFungibleSettle` (`token/settle.ts`), lineage in the envelope | Inbox, bridge |
| Prove lineage | `token/prove176.ts`, `lineage.ts`, `genesisStore.ts` | Token details |
| Combine | `combineBsv21Tips` | `FungibleDetailsPanel` |
| Burn | `burnBsv21Tokens` | `BurnAssetPanel` |
| Icon | `token/icons/*`; bridge `getTokenIcon` | Token face |
| Required processing | `token/requiredProcessing.ts`: any `req` → unsupported | Automatic |
| Cosigned (MNEE) | Detected and refused for send; sweep from imported keys through the MNEE API | Import |
| Release from an app | `relinquishOutput` on a token basket | Prompt |

Keys follow BRC-251 Custody. Every value output a transfer writes gets a fresh BRC-207 `p color` child:

- the payee's own child, when the transfer is delivered to it by identity key;
- this wallet's own child, for change, a self-send, burn change and the market split change.

The remittance strings are stored in each output's `customInstructions`, so BRC-39 backs them up with the rest of local state. The delivery carries the payee's strings in `meta.asset.remittance`, and receive derives the key from them. A payee known only by a bare address keeps that address. Market and direct-offer lots stay on the identity address, because BRC-251 does not define swaps. Every token input signs with `tipSigningKey` (`token/tipKeys.ts`), and every ownership check uses `ownsTokenLock`.

## 5. Market actions

A listing is a `1SAT-MARKET` PushDrop offer: the asset at vout 0, the offer at vout 1. At list time the seller signs both inputs of the buyer's settlement `SIGHASH_SINGLE|ANYONECANPAY|FORKID` (settlement v2, `marketSettlementLayout.ts`). Each signature commits to the output at its own input index: the asset to the seller payment, the offer to the market fee. The asset cannot move without paying the seller, and withdrawing someone else's advert costs the fee.

| Layout | Inputs | Outputs |
|---|---|---|
| `token-v2` (BRC-162) | item, offer, buyer funding | seller, fee, buyer token, change |
| `ordinal-v2` (1Sat) | pad, pad, item, offer, buyer funding | pad return, buyer item, seller, fee, change (a fresh pad among them) |

An ordinal follows its satoshi. Output 0 returns exactly the two pads' satoshis, so the item's satoshi lands in output 1 while its signature binds output 2. Pads are root-key P2PKH outputs in basket `market-pads` (`marketPads.ts`). The toolbox never funds with them, and the first ordinal buy mints two.

Version 1 signed the asset `NONE|ANYONECANPAY`, and the index served that signature to anyone, so anyone could move a listed asset to themselves. Cancel spent only the offer, which left the signature live. Now:

- the wallet completes only v2 unlocks (`unlocksBindSellerPayment`);
- the index refuses v1 at admission (`settlement-unlocks-unbound`) and never serves it;
- cancel spends the asset back to the seller along with the offer.

Before paying for a token, the buyer walks its BRC-176 lineage with script checks (`proveListedToken`). Token listings read both token baskets (`p2pft` and legacy `bsv21`).

Countersigned listings (`csft`, `csnft`) use `token-v2`. Listing is a sender-funded trade the acceptor countersigns: the listed units go to vout 0 under a fresh holder key (tag `market-held`), the offer to vout 1, and change, if any, to vout 2. The seller then signs vout 0 `0xC3` against its payment, so the listing needs no live seller. The proof is `{ v: 253, assetId, kind, amt }`. The buyer and the index check it against the listing transaction and the deploy (`checkCountersignedListing`). To buy, the buyer:

1. builds the settlement with its own countersigned output (`planCountersignedReceive`), with a linkage entry for it;
2. asks the acceptor to countersign vout 0 (`countersignSettlement`);
3. broadcasts.

Cancel is another trade back to the seller. It spends the listed output and the offer. The live-seller sign path is refused for a countersigned listing. An earlier countersigned sale never blocks a later request, so a buyer that goes silent cannot freeze a listing.

| Action | Method | Chart |
|---|---|---|
| List an item or tokens (tokens split to the exact lot first) | `createMarketListingAdvert` | `marketListingMachine` |
| Cancel | `createCancelMarketListingAdvert` | `marketListingMachine` |
| Purchase intent | `createMarketPurchaseIntent` | — |
| Buy | `purchaseMarketListing` → `executeMarketPurchase` | `marketPurchaseMachine` |
| Settle as seller, receipt | `handleInboundMarketSettlementWire`, `getMarketSettlementReceipt` | `marketSellerSettlementMachine` |
| Verify a listing | `verifyMarketListingProvenance` | — |
| Publish marks | `markMarketListingPublished` / `…PublishFailed` | — |

Minimum price 20 sats. Fee 5% (`MARKET_FEE_BASIS_POINTS`).

## 6. BSV actions

| Action | Owner |
|---|---|
| Send to an address | `sendSatsToAddress`, `bsvSendMachine` |
| Pay an identity (BRC-29) | `sendBrc29ToIdentityKey`, `brc29SendMachine`, outbox retry |
| Receive BRC-29 | `internalizeBrc29Payment`; `brc29:` and `peerpay:` URIs |
| Legacy sweep | `legacySweepPath.ts`, `importLegacyUtxos`, `phraseSweep.ts` |
| Buy or sell BSV for another coin | `marketSwap.ts` opens the external swap page; nothing is signed in the wallet |
| Chat payments | BRC-218 `/pay`, `/request`, `/tip` |

## 7. Missing

| Feature | State | Builds on |
|---|---|---|
| Item direct offers | Missing; token for sats and token for token ship (section 8) | Ordinal pads from `ordinal-v2` |
| Asking for a countersigned asset in a direct offer | Refused by name (`countersigned-want`) | The seller signs before the buyer's receive output exists, so the offer cannot carry the linkage the acceptor checks; needs a per-entry prover in BRC-253 |
| Countersigned swaps across issuers | Missing | A conditional accept per acceptor; BRC-253 open question |
| Token-priced market listings | Missing; the market prices in sats only | Overlay offer fields carry a token price; fee rule for a token price |
| Direct offer delivery | Offers are shared by hand (JSON); the seller collects with the buy txid | Messagebox `direct-offer` box |
| Bids (offers to buy) | Missing; listings are seller-side only | Purchase intent signing |
| Partial fills | Missing; a buy takes the whole lot | `splitBsv21CoverToExactAmt` |
| Many recipients (airdrop) for BSV, tokens or items | Missing; every send takes one recipient | `buildBsv21SendOutputs`, bulk run machinery |
| Token split as a user action | Missing; only combine is exposed | The combine self-send |
| Issuer freeze, transfer limits | Acceptance and release ship (section 9); the acceptor has no freeze or limit policy yet | Acceptor `frozen` / `limit` refusals in `countersign/resolve.ts` |
| Required-processing profiles | Every `req` is unsupported | `requiredProcessing.ts` is the hook |
| On-chain escrow | Chat card only, local stub | BRC-218 parser |
| Subscriptions | Missing | Spending authorization, auto-pay |
| BRC-73 protocol, basket, certificate and counterparty grants | Missing; those calls prompt each time | `ConnectedApp` grant rows |
| Grant expiry | Grants never expire | Auto-pay window timestamps |
| Wallet-side mint, list and buy screens | Apps and the market site only | `identityIssuance.ts`, market methods |

## 8. Offers: market listings and direct offers

There is one offer mechanism. The seller holds an output with exactly what it offers, out of the spendable balance, and signs that input with `SIGHASH_SINGLE|ANYONECANPAY|FORKID`, binding the output at the same index to what it wants back. Whoever holds the signature can complete the trade without the seller; the buyer adds its own inputs and the remaining outputs and signs `ALL`. The seller cancels by spending the held output to itself. Holding the lot back is not a separate rule: spending it elsewhere would leave a published signature pointing at a coin that no longer exists.

Two venues use it:

| | Market listing | Direct offer |
|---|---|---|
| Wanted back | Sats | Sats, or another token |
| Who sees it | Published to the market overlay and index | JSON handed to a buyer |
| Fee | 5% market fee, bound by the BRC-48 offer deposit's signature | None |
| Code | `marketListing.ts`, `marketSettlement.ts` (settlement v2) | `directOffer.ts`, `directOfferPath.ts` |
| Basket of the held lot | Token, `1sat`, `csft` or `csnft` basket, tag `market-held` | `direct-offers`; a countersigned lot stays in `csft` or `csnft`, tag `market-held` |

Both venues share the vocabulary in `offerTerms.ts` (`OfferVenue`, `OfferWant`), the seller signer and buyer check in `offerSeal.ts` (`signSellerInputs`, `sellerUnlockValid`), and one chart, `offerMachine`, for list, cancel, direct buy and collect. A market purchase keeps its own chart, `marketPurchaseMachine`, for overlay hydrate and the seller receipt.

Activity treats them alike: **Listing**, **Cancel listing**, **Sold** and **Purchase** marks, with the asset as the row's subject. Direct-offer notes end in "(direct offer)"; rows that 1.3.573 recorded as token swaps read the same way.

| Method (action, prompts) | What it does |
|---|---|
| `createDirectOffer({ give: { tokenId, amount }, want })` | Holds the exact lot (basket `direct-offers`, so send and burn never select it), signs input 0, returns the offer JSON |
| `buyDirectOffer({ offer })` | Proves the lot back to its deploy (BRC-176), script-checks the seller unlock inside the real transaction, then signs the buyer's coins |
| `collectDirectOfferProceeds({ offerId, txid })` | Seller files output 0 (P2PKH sweep, or token ingest) and retires the held lot |
| `cancelDirectOffer({ offerId })` | Spends the lot back to the token balance; refused once the chain shows it spent |
| `listDirectOffers()` (connect) | This account's direct offers and purchases |

`want` is `{ kind: 'sats', sats }` or `{ kind: 'token', tokenId, amount, layout? }`. Refusals are named: `same-token`, `cosigned-token`, `countersigned-want`, `want-layout-mismatch`, `unbound-signature`, `offer-already-sold`, and the rest in `DirectOfferRefusal`. When one wallet is seller and buyer, it files output 0 itself.

Run every bridge asset action in one pass, direct offers included, at `https://brc-cloud.bcryderman.workers.dev/token-demo`; it ends by checking that every listed unit came back. The wallet boundary run at `/wallet-demo` ends with a direct offer bought by the same wallet.

| Pair | How output 0 pays the seller | Notes |
|---|---|---|
| Token → BSV | P2PKH sats | Same as a market token listing, minus fee and overlay |
| Token → token | A BRC-162 output of the wanted token | The buyer adds its token inputs and change; each token sums exactly |
| Item → token or BSV | Not built (section 7) | Would need ordinal satoshi placement: the item behind buyer pads, as in `ordinal-v2` |
| Countersigned asset (`csft`, `csnft`) → BSV or token | P2PKH sats, or the wanted token | Listing and cancel are funded trades the acceptor countersigns. The buyer checks the lot against its deploy, gets its own output countersigned, and broadcasts. Asking for a countersigned asset is refused, `countersigned-want` (section 7) |

Every offer transaction goes through `signedSendLifecycle`. Delivery of the seller's proceeds rides the messagebox and never gates broadcast.

## 9. Countersigned assets: profiles `csft` and `csnft`

From an unpublished issuer-control draft. A countersigned output is a BRC-162 transfer whose lock also needs a second signature: the holder signs `0xC1`, and the issuer key set countersigns. Countersigning is for assets whose value comes from the issuer (handles, stablecoins, tickets); art and open tokens stay BRC-150 / BRC-162. Tokens and items share one scheme, because an item is a deploy with a supply of 1. Code: `src/wallet/countersign/` (`script.ts`, `payload.ts`, `resolve.ts`, `path.ts`, `beacon.ts`, `beaconSource.ts`, `wallet.ts`), chart `countersignMachine`.

| Method (action, prompts) | What it does |
|---|---|
| `issueCountersignedAsset({ kind, sym?, name?, supply?, dec?, icon?, content?, release?, cosigners?, silenceSeconds? })` | Deploys at output 0 (this wallet is the first holder), the beacon at output 1, an item's content at output 2. The issuer set is this wallet's identity key alone, or `cosigners: { threshold, keys }`: m of n identity keys (n ≤ 5), this wallet's among them, with m more than half of n so any two quorums share a cosigner. A bad set refuses before the prompt with `COUNTERSIGN_COSIGNERS_INVALID`, `COUNTERSIGN_COSIGNERS_WITHOUT_ISSUER` or `COUNTERSIGN_COSIGNERS_SPLIT` (`chooseCosignerQuorum`). Each other cosigner gets a `join` invite in box `countersign`. `release` is required: the custodians' `{ threshold, keys }`, which keys this wallet does not hold must meet on their own (`releaseCustody: 'independent'`), or `'self'` for this wallet's own release key (`[2, 'countersign release']`, key `1`), 1-of-1 (`'issuer-only'`: the asset freezes for good if this wallet stops without releasing it, and the prompt says so). Anything else refuses before the prompt with `COUNTERSIGN_RELEASE_REQUIRED` or `COUNTERSIGN_RELEASE_ISSUER_ONLY` (`chooseReleaseCustody`, `countersign/path.ts`). Silence is at least 7 days (default 30). |
| `transferCountersignedAsset({ assetId, amount?, recipient })` | Holder signs; the acceptor countersigns or refuses. `CountersignTransferPath`: `local-acceptor` when this wallet holds the issuer key, `remote-acceptor` over box `countersign`, `quorum` for a shared issuer set, or `refuse`. `released` once the beacon chain shows the release keys published. A refusal or 45 s of silence sends nothing; on silence or `not_acceptor` the wallet reads the beacon chain and, if released, completes the transfer itself. |
| `joinCountersignedAsset({ assetId })` | A named cosigner joins: from then on it answers transfer requests and beacon proposals for the asset. The deploy must list this wallet in a shared issuer set. Its own prompt. |
| `retireCountersignedAsset({ assetId })` | Issuer only. Stops accepting for good. When this wallet holds the release keys it publishes them in the same step; otherwise it writes the final beacon and a retire marker for the custodians. A cosigner of a shared set only withdraws (`txid: null`, nothing on chain); the asset ends once too few cosigners remain to refresh its beacon. |
| `releaseCountersignedAsset({ assetId })` | Custodian. Publishes this wallet's release key by spending the last beacon on the release branch, only once the asset has retired or lapsed (for its own issuer, releasing is retiring; a cosigner of a live shared asset is refused with `asset-live`). |
| `listCountersignedAssets()` (connect) | Deploys this wallet knows, what it holds of each, whether it is the issuer, its `cosigners` set, its phase (`live`, `ended`, `released`, `unknown`), pending cosigner `invites`, and `releaseKey`: this wallet's custodian key for an issuer to name |

- The acceptor accepts once: a durable record of accepted outputs and spends, written in one step before anything leaves the wallet. It funds the fee from root-key coins in basket `countersign-fee` (200 sats, minted four at a time) and adds no change. Refusals are named (`unknown_input`, `spent`, `invalid`, `frozen`, `recipient`, `limit`, `fee`, `policy`, `not_acceptor`) and signed.
- A shared issuer set (m of n) takes the `quorum` path. The holder funds the fee, so every cosigner signs the same transaction, and a random disabled `nLockTime` makes each attempt a new request. Each cosigner accepts an input by proof: the deploy, or a parent whose asset inputs carry valid countersignatures on the issuer branch (the request carries those ancestors when they fit). It then reserves the inputs and returns its countersignature per input (`cosigned`). The holder assembles the first m in issuer-set order. Once fewer than m can still sign, the request is refused. A cosigner's refusal is final, and the holder forwards more than n − m signed refusals so the cosigners that did sign free their reservations. A silent quorum keeps its answers on the open request, which completes when late answers arrive. Because the sender funded it and could void it by double spending a fee input, the recipient files a quorum transfer only once it is mined.
- With m of n cosigners, any one of them proposes the next beacon in its turn (key order, staggered over the second half of the silence period). It funds the refresh and the others sign it (`beacon-sign` / `beacon-signed`). Two refreshes of one beacon cannot both be mined, so signing more than one is harmless. Lapse is read from the beacon chain, not from a cosigner's own last refresh.
- Holder keys (BRC-253 §2): every countersigned output is held under a fresh BRC-207 `p color` child, never the identity key (`countersign/holderKeys.ts`). A deploy uses `ISSUE`. A transfer draws one prefix and a suffix per output: the recipient's child for the payment, the sender's own child for change. Each request lists every output with a BRC-69 specific linkage, encrypted to the acceptor or cosigner it is sent to. The acceptor checks that `identityKey + linkage·G` hashes to the holder key, and refuses `recipient` when the linkage does not open. The delivery carries `senderIdentityKey` and the recipient's `outputs`, and receive derives the key from them. A held output's remittance sits in its `customInstructions`, so BRC-39 backs it up. Outputs locked to an identity key by earlier versions still resolve and spend.
- Box `countersign` carries requests, cancels, decisions, cosigner invites, beacon proposals and deliveries to the recipient, each BRC-78 sealed. Deliveries carry the Atomic BEEF; the recipient resolves the transfer offline from the deploy before filing. The box never gates custody.
- The beacon (basket `countersign-beacon`) is `OP_IF <issuer> OP_ELSE <release> OP_ENDIF`. The issuer re-spends it on the issuer branch once half the silence period has passed. An issuer whose last refresh is older than the silence period has lapsed for good and stops countersigning (`not_acceptor`).
- Phases come from the beacon chain alone (`beacon.ts`, read over WhatsOnChain): `live`; `ended` when retired or when two mined beacons, or the last one and the tip, are more than the silence period apart (a mempool refresh does not count); `released` when the last beacon is spent on the release branch with an `OP_RETURN` publishing the release private keys.
- Who must be online: the sender and the issuer (or m of its n cosigners, with the receipt final once mined), for every transfer of a live asset (45 s answer window). The recipient may be offline: the delivery waits in box `countersign` and is checked offline against the deploy when the recipient next opens its wallet. After release only the sender must be online, and the recipient files the transfer once it is mined. True offline payment (both sides offline) is not supported; that is BRC-175's model.
- After release the asset is owner-only: the holder countersigns with the published keys and funds the fee from its own `countersign-fee` coins. Accept-once is gone, so a receipt that spends on the release branch, or any receipt of an asset known to be released, is filed only once mined.
- Two profiles, each its own filing basket and permission scheme: countersigned tokens in `csft` (countersigned fungible token), countersigned items in `csnft` (countersigned non-fungible token), beside `p2pft` and `1sat`. A released asset stays in its countersigned profile: its lock still carries the clause and spends with the published keys, so it is not a plain token or item.
- Tags: `<profile>:<assetId>` (`<profile>:deploy` on the issuer's deploy row, which is its own asset id), `amt:<units>`, `sym:` and `name:` when known (display only; views list tags, never the remittance), `id:<key>` (BRC-164).
- Trades (BRC-253 §6): market listings, purchases and cancels, and direct offers that give a countersigned asset, are sender-funded. The party that builds the transaction funds it, the acceptor countersigns without adding an input and replies `cosigned`, and the builder broadcasts. A holder may sign `0xC3` (`SWAP_HOLDER_SCOPE`) bound to a plain payment at its own index. The acceptor refuses one bound to a countersigned output. An earlier signed sale, or a request sharing a plain input, never blocks a new request (`blockingPriorSpends`), because at most one of them can be mined. Any other sender-funded request blocks until a mined spend of one of its plain inputs proves it dead. Recipients file a trade once it is mined.
- App scopes: `p csft all | asset | id` and `p csnft all | asset | collection | id`, with `<profile>:<assetId>`, `collection:<id>` or `id:<key>` tags for the narrow ones. Listed deploy rows get a `<profile>:<assetId>` tag.
- Apps cannot write into either profile or spend from it with a label; transfers go through `transferCountersignedAsset`. `p 1sat …`, `p p2pft …` and `bsv21` never return a countersigned output, and payment or auto-pay grants never cover one.
