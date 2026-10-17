# Asset actions and permissions

Every permission an app can hold, and every item, token, market and BSV action the wallet performs, with the module that owns it. The last sections cover offers (market listings and direct offers), what is still missing, and the basket scheme proposed for countersigned assets.

Related: [`brc-wallet-feature-map.md`](./brc-wallet-feature-map.md) (feature → BRC), [`token-architecture.md`](./token-architecture.md), [`wallet-p2p-messagebox.md`](./wallet-p2p-messagebox.md).

## 1. Bridge methods

The bridge listens on `https://127.0.0.1:2121`, with an HTTP fallback on `http://127.0.0.1:3321` (`electron/httpServer.ts`). Gate sets live in `src/contracts/brc100.ts`. A method must also be in the handler manifest `src/contracts/brc100Handlers.ts`, or the bridge answers 404.

| Gate | Methods | Behaviour |
|---|---|---|
| Public | `getVersion`, `getNetwork`, `getHeight`, `getHeaderForHeight` | No origin check |
| Silent | `isAuthenticated` | Never prompts |
| Connect | `waitForAuthentication` | Shows the Connect prompt |
| Connected | `getPublicKey`, `abortAction`, `listActions`, `listOutputs`, `getBalance`, `createHmac`, `verifyHmac`, `verifySignature`, `listCertificates`, `discoverByIdentityKey`, `discoverByAttributes`, `getClaimedCloudHandle`, `getTokenIcon`, `listDirectOffers`, market reads | Connect only. `listOutputs` on an item or token scope adds a view gate. |
| Action | `createAction`, `signAction`, `internalizeAction`, `relinquishOutput`, `relinquishCertificate`, `createSignature`, `encrypt`, `decrypt`, `revealCounterpartyKeyLinkage`, `revealSpecificKeyLinkage`, `proveCertificate`, `acquireCertificate`, `createAdminIdentityProof`, market writes, `createDirectOffer`, `buyDirectOffer`, `collectDirectOfferProceeds`, `cancelDirectOffer` | Connect, then an approval for each call. No two actions share consent. |
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
| **Item and token receive** | Later item or token `internalizeAction` calls without a prompt | First approved receive | Disconnect |
| **BSV receive** | Plain BSV `internalizeAction` without a prompt | On by default; "Require receive approval" opts out | Opt-out or disconnect |
| **Auto-pay** | `createAction` paying up to `maxUsd` (default $10) per `windowHours` (default 24); never `signAction` | App details | Cleared or disconnect |
| **Spending authorization** (BRC-73) | Replaces the auto-pay window with a monthly cap from the app manifest; auto-pay must be on | Connect, from `metanet.groupPermissions.spendingAuthorization` | Disconnect |
| **Identity proof** | `proveCertificate` without a prompt | Auto inside the fresh-connect window, then for the session in memory | Session end |
| **Held-row spend label** | `createAction` label `p 1sat input id <key>` / `p p2pft input id <key>` names the one held output this action may spend | Per action, inside the action prompt | Single use |

Always prompted, never covered by a grant: item and token sends, mints, identity-signed issuance, every market write and direct offer, `createSignature`, encryption and key linkage. Prompt wording comes from `summarizeAction` (`permissions.ts`). Market prompts show the item and "Total includes the 5% market fee".

Not implemented: BRC-73 protocol, basket, certificate and counterparty grants. Calls that would use them prompt each time. Persisted grants never expire.

Revocation: `revokeOrigin` removes the app and clears its auto-pay, spending authorization and session grants (`AppDetailsPanel.tsx`, Disconnect).

Scopes refused by name: a bare `1sat` (`USE_P1SAT_SCOPE`), a bare `p2pft` or `bsv21` (`USE_PBSV21_SCOPE`), and any unknown `p` scheme (`UNSUPPORTED_P_BASKET`).

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
| Token-priced market listings | Missing; the market prices in sats only | Overlay offer fields carry a token price; fee rule for a token price |
| Direct offer delivery | Offers are shared by hand (JSON); the seller collects with the buy txid | Messagebox `direct-offer` box |
| Bids (offers to buy) | Missing; listings are seller-side only | Purchase intent signing |
| Partial fills | Missing; a buy takes the whole lot | `splitBsv21CoverToExactAmt` |
| Many recipients (airdrop) for BSV, tokens or items | Missing; every send takes one recipient | `buildBsv21SendOutputs`, bulk run machinery |
| Token split as a user action | Missing; only combine is exposed | The combine self-send |
| Issuer-controlled tokens (freeze, acceptance) | Missing; cosigned tips are refused | Unpublished issuer-control draft |
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
| Basket of the held lot | Token or `1sat` basket, tag `market-held` | `direct-offers` |

Both venues share the vocabulary in `offerTerms.ts` (`OfferVenue`, `OfferWant`), the seller signer and buyer check in `offerSeal.ts` (`signSellerInputs`, `sellerUnlockValid`), and one chart, `offerMachine`, for list, cancel, direct buy and collect. A market purchase keeps its own chart, `marketPurchaseMachine`, for overlay hydrate and the seller receipt.

Activity treats them alike: **Listing**, **Cancel listing**, **Sold** and **Purchase** marks, with the asset as the row's subject. Direct-offer notes end in "(direct offer)"; rows that 1.3.573 recorded as token swaps read the same way.

| Method (action, prompts) | What it does |
|---|---|
| `createDirectOffer({ give: { tokenId, amount }, want })` | Holds the exact lot (basket `direct-offers`, so send and burn never select it), signs input 0, returns the offer JSON |
| `buyDirectOffer({ offer })` | Proves the lot back to its deploy (BRC-176), script-checks the seller unlock inside the real transaction, then signs the buyer's coins |
| `collectDirectOfferProceeds({ offerId, txid })` | Seller files output 0 (P2PKH sweep, or token ingest) and retires the held lot |
| `cancelDirectOffer({ offerId })` | Spends the lot back to the token balance; refused once the chain shows it spent |
| `listDirectOffers()` (connect) | This account's direct offers and purchases |

`want` is `{ kind: 'sats', sats }` or `{ kind: 'token', tokenId, amount, layout? }`. Refusals are named: `same-token`, `cosigned-token`, `want-layout-mismatch`, `unbound-signature`, `offer-already-sold`, and the rest in `DirectOfferRefusal`. When one wallet is seller and buyer, it files output 0 itself.

Run every bridge asset action in one pass, direct offers included, at `https://brc-cloud.bcryderman.workers.dev/token-demo`; it ends by checking that every listed unit came back. The wallet boundary run at `/wallet-demo` ends with a direct offer bought by the same wallet.

| Pair | How output 0 pays the seller | Notes |
|---|---|---|
| Token → BSV | P2PKH sats | Same as a market token listing, minus fee and overlay |
| Token → token | A BRC-162 output of the wanted token | The buyer adds its token inputs and change; each token sums exactly |
| Item → token or BSV | Same as above | Ordinal satoshi placement: the item sits behind buyer pads, as in `ordinal-v2` |
| Countersigned assets | One transaction, both holders sign `0xC1`, the acceptor countersigns | Same issuer only (open question in that draft) |

Every offer transaction goes through `signedSendLifecycle`. Delivery of the seller's proceeds rides the messagebox and never gates broadcast.

## 9. Countersigned assets: basket `cosigned`

Proposed in an unpublished issuer-control draft. Tokens and items share one scheme, because an item is a countersigned deploy with a supply of 1.

- Filing name `cosigned`, wallet-internal. An app naming it is refused.
- Tags: `cosigned:<assetId>` (deploy outpoint), `cosigned:token` or `cosigned:item`, `col:<collectionId>` when membership checks out, `id:<key>` (BRC-164).
- App scopes: `p cosigned all | tokens | items | asset | collection | id`. `asset`, `collection` and `id` need matching tags.
- Spend label: `p cosigned input id <key>`. The wallet then requests acceptance itself; the app never addresses the acceptor.
- `p 1sat …`, `p p2pft …` and `bsv21` never return a `cosigned` output, and payment or auto-pay grants never cover one.
