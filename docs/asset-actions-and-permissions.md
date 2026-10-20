# Asset actions and permissions

Every permission an app can hold, and every item, token, market and BSV action the wallet performs, with the module that owns it. The last sections cover what is still missing and the state of countersigned (issuer-accepted) assets.

Related: [`brc-wallet-feature-map.md`](./brc-wallet-feature-map.md) (feature → BRC), [`bnt-tokens.md`](./bnt-tokens.md), [`wallet-p2p-messagebox.md`](./wallet-p2p-messagebox.md).

Specs: market listings are [BRC-254](../../BRCs-254/tokens/0254.md) (draft); tokens and issuer items are BNT, [BRC-255](../../BRCs-255/tokens/0255.md) (draft), planned in [`bnt-tokens.md`](./bnt-tokens.md). BRC-162 (BSV-21) and BRC-253 are not supported. This page and the drafts are published at `https://brc-cloud.bcryderman.workers.dev/docs`; paste that address into Apps → Open a web app to read them inside the wallet.

## 0. Asset profiles

Profiles are specified in BRC-214 ([`docs/bsva/brcs/coins/0214.md`](bsva/brcs/coins/0214.md), held back, not submitted); apps read them with `listAssetProfiles`. Five are coin profiles that share the per-app payment budget: `bsv` (`createAction`), `coin:ltc`, `coin:bch`, `coin:btc` and `coin:doge` (BRC-213, [`docs/bsva/brcs/coins/0213.md`](bsva/brcs/coins/0213.md): native coins, spendable once buried on the wallet's own header chain — 6 confirmations on Litecoin and Bitcoin Cash, 3 on Bitcoin, 20 on Dogecoin — apps use `getCoinAddress` / `listCoins` / `sendCoins` with `chain: "ltc"`, `"bch"`, `"btc"` or `"doge"`; `sendCoins` takes an `identityKey` in place of `address` when the recipient's signed record names the chain, BRC-213 §7). The four asset profiles below are always per-action.

Every asset the wallet holds belongs to exactly one profile. A profile is a storage basket, an app permission scheme, a tag prefix and a set of actions. Granting one profile never grants another, and no asset changes profile.

| | `1sat` | `bntft` | `bntnft` | `iptft` / `iptnft` |
|---|---|---|---|---|
| Holds | Items (one-sat ordinals) | BNT tokens, open mode | BNT items, open mode | Reserved for IPT, the countersigned mode (section 8) |
| Spec | BRC-147, BRC-150, BRC-165 | BRC-251, BRC-255 | BRC-255 | BRC-255 countersigned mode, not built |
| Bitcoin Native Token (BRC-251) | Not a token | Yes (`bnt: true`) | Yes (`bnt: true`) | No: IPT, Issuer-Permissioned Token (`bnt: false`) |
| Authenticity | BRC-150 proof to the origin | Walk to the deploy (`bnt/validity.ts`) | Same as `bntft` | — |
| Who signs a transfer | Owner | Owner | Owner | — |
| App view (section 2) | `p 1sat all \| collection \| app \| creator \| id` | `p bntft all \| token \| id` | `p bntnft …` under the item grant | `p iptft …` / `p iptnft …`, view only |
| App spend label | `p 1sat input id <key>` | None: wallet only | None: wallet only | None: wallet only |
| Send | `sendCollectable` (section 3) | `transferBntAsset` (section 4) | `transferBntAsset` | — |
| Market listing (section 5) | `ordinal-v2` | Not yet | Not yet | — |
| App actions, each prompted | Mint; `createAction` spend by label; list, cancel, buy | `issueBntAsset`, `mintBntAsset`, `transferBntAsset` | Same as `bntft` | None |

## 1. Bridge methods

The bridge listens on `https://127.0.0.1:2121`, with an HTTP fallback on `http://127.0.0.1:3321` (`electron/httpServer.ts`). Gate sets live in `src/contracts/brc100.ts`. A method must also be in the handler manifest `src/contracts/brc100Handlers.ts`, or the bridge answers 404.

| Gate | Methods | Behaviour |
|---|---|---|
| Public | `getVersion`, `getNetwork`, `getHeight`, `getHeaderForHeight` | No origin check |
| Silent | `isAuthenticated` | Never prompts |
| Connect | `waitForAuthentication` | Shows the Connect prompt |
| Connected | `getPublicKey`, `abortAction`, `listActions`, `listOutputs`, `getBalance`, `createHmac`, `verifyHmac`, `verifySignature`, `listCertificates`, `discoverByIdentityKey`, `discoverByAttributes`, `getClaimedCloudHandle`, `listAssetProfiles`, `listBntAssets`, `getCoinAddress`, `listCoins`, market reads | Connect only. `listOutputs` on an item, token, `iptft` or `iptnft` scope adds a view gate. |
| Action | `sendCoins`, `withdrawLtc` (rewritten to `sendCoins` on chain `ltc` before any gate), `createAction`, `signAction`, `internalizeAction`, `relinquishOutput`, `relinquishCertificate`, `createSignature`, `encrypt`, `decrypt`, `revealCounterpartyKeyLinkage`, `revealSpecificKeyLinkage`, `proveCertificate`, `acquireCertificate`, `createAdminIdentityProof`, market writes, `issueBntAsset`, `mintBntAsset`, `transferBntAsset` | Connect, then an approval for each call. No two actions share consent. |
| Migration | `getLegacyAddress`, `refreshLegacyAddress`, `listMigrationTxids`, `openKeyRecovery` | HandCash hosts only (`migration.ts`) |

Origin-limited HandCash methods:

- **Market** (`isMarketListingOrigin`, `marketListing.ts`): HandCash hosts plus `market-v2.handcash.io`, `handcash-market-v2.pages.dev` and `brc-cloud.bcryderman.workers.dev`. Covers create, cancel and purchase of listings, purchase intents, provenance checks, receipts, status and publish marks. Duplicate in-flight list, cancel or purchase calls for one item return `409 ACTION_IN_PROGRESS`.
- **Handle claim:** `claimCloudHandle` and `clearClaimedCloudHandle` are limited to HandCash hosts.
- **Admin:** `createAdminIdentityProof` is limited to HandCash and BRC-CLOUD hosts, with a `handcash-ops-login` challenge that expires in 5 minutes.

Bridge-wide rules:

- The browser `Origin` header beats the `originator` header.
- Protocol `account` and self-linkage are reserved (BRC-208).
- `createAction` checks every held-row spend label against exactly one held row that is also an input.
- Index-expansion methods and the retired fungible protocol are refused by name.

## 2. Permissions

All grants are stored per account (`accountLocalKey`). Grants, prompts and activity name the caller's own host; no host is ever shown or granted as another. View grants alone are shared across the market hosts under `handcash.io` (`viewGrantOriginAliases`), never with a domain HandCash does not own.

| Grant | What it allows | Granted by | Ends |
|---|---|---|---|
| **Connect** | Connected methods; opens a 20 s fresh-connect window | Connect prompt (`allowOrigin`) | Disconnect |
| **Item view** | `listOutputs` on `p 1sat all \| collection \| app \| creator \| id`; filtered to the granted collections, apps, creators or ids | View prompt (`requestItemViewApproval`); `id` lookups are silent and cover only that id; handcash.io market hosts get `all` | Disconnect |
| **Token view** | `listOutputs` on `p bntft all \| token \| id`; a filtered grant stays an allowlist | View prompt (`requestTokenViewApproval`) | Disconnect |
| **Countersigned token view** | `listOutputs` on `p iptft all \| asset \| id` | View prompt (`requestCountersignedViewApproval`), one grant per profile; `id` lookups are silent | Disconnect |
| **Countersigned item view** | `listOutputs` on `p iptnft all \| asset \| collection \| id` | Same, its own grant | Disconnect |
| **Item and token receive** | Later item or token `internalizeAction` calls without a prompt | First approved receive | Disconnect |
| **BSV receive** | Plain BSV `internalizeAction` without a prompt | On by default; "Require receive approval" opts out | Opt-out or disconnect |
| **Auto-pay** | `createAction` paying up to `maxUsd` (default $10) per `windowHours` (default 24); never `signAction` | App details | Cleared or disconnect |
| **Spending authorization** (BRC-73) | Replaces the auto-pay window with a monthly cap from the app manifest; auto-pay must be on | Connect, from `metanet.groupPermissions.spendingAuthorization` | Disconnect |
| **Identity proof** | `proveCertificate` without a prompt | Auto inside the fresh-connect window, then for the session in memory | Session end |
| **Held-row spend label** | `createAction` label `p 1sat input id <key>` names the one held output this action may spend | Per action, inside the action prompt | Single use |

Always prompted, never covered by a grant: item and token sends, mints, identity-signed issuance, every market write, `createSignature`, encryption and key linkage. Prompt wording comes from `summarizeAction` (`permissions.ts`). Market prompts show the item and "Total includes the 5% market fee".

Not implemented: BRC-73 protocol, basket, certificate and counterparty grants. Calls that would use them prompt each time. Persisted grants never expire.

Revocation: `revokeOrigin` removes the app and clears its auto-pay, spending authorization and session grants (`AppDetailsPanel.tsx`, Disconnect).

Scopes refused by name: a bare `1sat` (`USE_P1SAT_SCOPE`), a bare `bntft`, a bare `iptft` or `iptnft` (`USE_COUNTERSIGNED_SCOPE`), any app write into either or a `p iptft|iptnft input id` label (`COUNTERSIGNED_WALLET_ONLY`), and any unknown `p` scheme (`UNSUPPORTED_P_BASKET`).

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

## 4. Token actions (BNT, open mode)

Filing `bntft` (tokens) or `bntnft` (items), tags `<filing>` and `<filing>:<40-hex asset id>`. Details in [`bnt-tokens.md`](./bnt-tokens.md).

| Action | Owner | Started from |
|---|---|---|
| Issue, mint | `issueBntAsset`, `mintBntAsset` (`bnt/wallet.ts`, chart `bntMachine`) | Apps only |
| Send | `transferBntAsset`, delivered over box `bnt` | `BntShelf` send form, apps |
| Receive | `bnt/wallet.ts` receive: proof package, walk to the deploy, then filing | Inbox |
| List | `listBntAssets`; app views `p bntft …` / `p bntnft …` | Collectables shelf, apps |
| Burn | `burnBntUnits`, wallet only | `BntShelf` |

Keys follow BRC-251 Custody. Every value output a transfer writes gets a fresh BRC-29 child (protocol `[2,"3241645161d8"]`, key ID `"<prefix> <suffix>"`, counterparty the other party; `brc29Keys.ts`). A BRC-100 wallet never signs with its root key, so no new output locks to an identity address:

- the payee's own child, when the transfer is delivered to it by identity key: tokens and items (single and batch);
- this wallet's own child, for change, a self-send, burn change and the burn inscription's sat, imported item sweeps, the market listing lot, its payout, offer key and change, the buyer's received item, ordinal pads and the Sigma issuer anchor.

The remittance strings are stored in each output's `customInstructions`, so BRC-39 backs them up with the rest of local state. Item, pad and fee-coin rows also carry them as a `brc29:<hex prefix>.<hex suffix>.<sender>` tag, so the `1sat` listing finds each tip's key without reading every row's `customInstructions`. The delivery carries the payee's strings in `meta.asset.remittance` (`DeliveryRemittance`, one row per output), and receive derives the key from them. A payee known only by a bare address keeps that address; an identity key is never turned into its address. Outputs earlier releases wrote to the identity address still resolve and spend (`heldP2pkhSigningKey`). Every token and item input signs with `tipSigningKey` (`tipKeys.ts`), and every ownership check uses `lockHolder`: a `derived` lock is never on the address scan, so its absence there never rejects a send or ghost-drops the tip. `identityAddressRatchet.test.ts` holds the identity-address sites to recognition only.

## 5. Market actions

Specified in BRC-254 §1–§9. A listing is a `1SAT-MARKET` PushDrop offer: the asset at vout 0, the offer at vout 1. At list time the seller signs both inputs of the buyer's settlement `SIGHASH_SINGLE|ANYONECANPAY|FORKID` (settlement v2, `marketSettlementLayout.ts`). Each signature commits to the output at its own input index: the asset to the seller payment, the offer to the market fee. The asset cannot move without paying the seller, and withdrawing someone else's advert costs the fee.

| Layout | Inputs | Outputs |
|---|---|---|
| `ordinal-v2` (1Sat) | pad, pad, item, offer, buyer funding | pad return, buyer item, seller, fee, change (a fresh pad among them) |

An ordinal follows its satoshi. Output 0 returns exactly the two pads' satoshis, so the item's satoshi lands in output 1 while its signature binds output 2. Pads are root-key P2PKH outputs in basket `market-pads` (`marketPads.ts`). The toolbox never funds with them, and the first ordinal buy mints two.

Version 1 signed the asset `NONE|ANYONECANPAY`, and the index served that signature to anyone, so anyone could move a listed asset to themselves. Cancel spent only the offer, which left the signature live. Now:

- the wallet completes only v2 unlocks (`unlocksBindSellerPayment`);
- the index refuses v1 at admission (`settlement-unlocks-unbound`) and never serves it;
- cancel spends the asset back to the seller along with the offer.

| Action | Method | Chart |
|---|---|---|
| List an item | `createMarketListingAdvert` | `marketListingMachine` |
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
| Token-priced market listings | Missing; the market prices in sats only | Overlay offer fields carry a token price; fee rule for a token price |
| Bids (offers to buy) | Missing; listings are seller-side only | Purchase intent signing |
| Partial fills | Missing; a buy takes the whole lot | Exact-amount split in `marketListing.ts` |
| Many recipients (airdrop) for BSV, tokens or items | Missing; every send takes one recipient | Bulk run machinery |
| BNT market listings | Missing; the market lists 1Sat items only | BRC-254 on BNT outputs (`bnt-tokens.md` phase 5) |
| Countersigned assets, issuer freeze, transfer limits | Missing (section 8) | BRC-255 countersigned mode |
| On-chain escrow | Chat card only, local stub | BRC-218 parser |
| Subscriptions | Missing | Spending authorization, auto-pay |
| BRC-73 protocol, basket, certificate and counterparty grants | Missing; those calls prompt each time | `ConnectedApp` grant rows |
| Grant expiry | Grants never expire | Auto-pay window timestamps |
| Wallet-side mint, list and buy screens | Apps and the market site only | `identityIssuance.ts`, market methods |

## 8. Countersigned assets

Not built. The BRC-253 engine, direct offers and token listings were removed with BRC-162. Countersigned assets come back as BRC-255 countersigned mode (`bnt-tokens.md` phase 4), filed in `iptft` / `iptnft`. Until then the wallet issues and moves open assets only (`unsupported-mode`), apps may view those filings but never write or spend there (`COUNTERSIGNED_WALLET_ONLY`), and a countersigned delivery waits unacknowledged in box `bnt`.
