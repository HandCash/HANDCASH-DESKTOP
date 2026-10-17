# Asset actions and permissions

Every permission an app can hold, and every item, token, market and BSV action the wallet performs, with the module that owns it. The last sections list what is missing, including swaps, and the basket scheme proposed for countersigned assets.

Related: [`brc-wallet-feature-map.md`](./brc-wallet-feature-map.md) (feature → BRC), [`token-architecture.md`](./token-architecture.md), [`wallet-p2p-messagebox.md`](./wallet-p2p-messagebox.md).

## 1. Bridge methods

The bridge listens on `https://127.0.0.1:2121`, with an HTTP fallback on `http://127.0.0.1:3321` (`electron/httpServer.ts`). Gate sets live in `src/contracts/brc100.ts`. A method must also be in the handler manifest `src/contracts/brc100Handlers.ts`, or the bridge answers 404.

| Gate | Methods | Behaviour |
|---|---|---|
| Public | `getVersion`, `getNetwork`, `getHeight`, `getHeaderForHeight` | No origin check |
| Silent | `isAuthenticated` | Never prompts |
| Connect | `waitForAuthentication` | Shows the Connect prompt |
| Connected | `getPublicKey`, `abortAction`, `listActions`, `listOutputs`, `getBalance`, `createHmac`, `verifyHmac`, `verifySignature`, `listCertificates`, `discoverByIdentityKey`, `discoverByAttributes`, `getClaimedCloudHandle`, `getTokenIcon`, market reads | Connect only. `listOutputs` on an item or token scope adds a view gate. |
| Action | `createAction`, `signAction`, `internalizeAction`, `relinquishOutput`, `relinquishCertificate`, `createSignature`, `encrypt`, `decrypt`, `revealCounterpartyKeyLinkage`, `revealSpecificKeyLinkage`, `proveCertificate`, `acquireCertificate`, `createAdminIdentityProof`, market writes | Connect, then an approval for each call. No two actions share consent. |
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

Always prompted, never covered by a grant: item and token sends, mints, identity-signed issuance, every market write, `createSignature`, encryption and key linkage. Prompt wording comes from `summarizeAction` (`permissions.ts`). Market prompts show the item and "Total includes the 5% market fee".

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
| **Atomic P2P swaps**: token↔token, token↔BSV, item↔token | Missing. The only "swap" is a link to an external exchange. | Market settlement v2 (`SINGLE\|ANYONECANPAY` at a fixed index); plan in section 8 |
| Bids (offers to buy) | Missing; listings are seller-side only | Purchase intent signing |
| Partial fills | Missing; a buy takes the whole lot | `splitBsv21CoverToExactAmt` |
| Many recipients (airdrop) for BSV, tokens or items | Missing; every send takes one recipient | `buildBsv21SendOutputs`, bulk run machinery |
| Token split as a user action | Missing; only combine is exposed | The combine self-send |
| Issuer-controlled tokens (freeze, acceptance) | Missing; cosigned tips are refused | BRC-253 draft, section 9 |
| Required-processing profiles | Every `req` is unsupported | `requiredProcessing.ts` is the hook |
| On-chain escrow | Chat card only, local stub | BRC-218 parser |
| Subscriptions | Missing | Spending authorization, auto-pay |
| BRC-73 protocol, basket, certificate and counterparty grants | Missing; those calls prompt each time | `ConnectedApp` grant rows |
| Grant expiry | Grants never expire | Auto-pay window timestamps |
| Wallet-side mint, list and buy screens | Apps and the market site only | `identityIssuance.ts`, market methods |

## 8. Swaps

A swap offer is market settlement v2 without the market. The maker holds an output with exactly the amount it offers, then signs that one input with `SIGHASH_SINGLE|ANYONECANPAY|FORKID` at input 0. That signature binds output 0 to what the maker wants. The taker adds its own inputs and the remaining outputs, signs `ALL`, and broadcasts. The maker loses nothing if the taker never acts, and it can cancel by spending the offered output to itself.

| Pair | How output 0 pays the maker | Notes |
|---|---|---|
| Token → BSV | P2PKH sats | Same as a market token listing, minus fee and overlay |
| Token → token | A BRC-162 output of the wanted token | The taker adds its token inputs and change; each token sums exactly |
| Item → token or BSV | Same as above | Ordinal satoshi placement: the item sits behind taker pads, as in `ordinal-v2` |
| Countersigned assets | One transaction, both holders sign `0xC1`, the acceptor countersigns | Same issuer only (BRC-253 open question 2) |

Every swap transaction goes through `signedSendLifecycle`. Delivery of the maker's proceeds rides the messagebox and never gates broadcast.

## 9. Countersigned assets: basket `cosigned`

Proposed in the local BRC-253 draft (not published). Tokens and items share one scheme, because an item is a countersigned deploy with a supply of 1.

- Filing name `cosigned`, wallet-internal. An app naming it is refused.
- Tags: `cosigned:<assetId>` (deploy outpoint), `cosigned:token` or `cosigned:item`, `col:<collectionId>` when membership checks out, `id:<key>` (BRC-164).
- App scopes: `p cosigned all | tokens | items | asset | collection | id`. `asset`, `collection` and `id` need matching tags.
- Spend label: `p cosigned input id <key>`. The wallet then requests acceptance itself; the app never addresses the acceptor.
- `p 1sat …`, `p p2pft …` and `bsv21` never return a `cosigned` output, and payment or auto-pay grants never cover one.
