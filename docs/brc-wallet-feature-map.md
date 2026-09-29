---
title: "Feature map: Connect to BRC wallet"
description: "The BRC wallet path to integrate today — auth, payments, items, and plain BSV-21 — and the Connect feature each call replaces"
---

**Beta — BRC wallet only.** Integrate the four rows under **Ship this**. The tables below them are the full Connect map, including calls this release forwards but has not proven. Request and response shapes follow [BRC-100](https://brc.dev/100).

## Read these as markdown

Each task page is published as markdown. Hand an agent the `.md` URL, or open it yourself.

| Task | Markdown |
| --- | --- |
| This map | [feature-map.md](https://docs.handcash.io/brc-wallet/feature-map.md) |
| Getting started | [getting-started.md](https://docs.handcash.io/brc-wallet/getting-started.md) |
| Permissions and errors | [permissions.md](https://docs.handcash.io/brc-wallet/permissions.md) |
| Payments | [payments.md](https://docs.handcash.io/brc-wallet/payments.md) |
| Collectables | [items.md](https://docs.handcash.io/brc-wallet/items.md) |
| Tokens | [tokens.md](https://docs.handcash.io/brc-wallet/tokens.md) |
| Signing | [signing.md](https://docs.handcash.io/brc-wallet/signing.md) |
| Local bridge | [local-bridge.md](https://docs.handcash.io/brc-wallet/local-bridge.md) |
| Every method | [interactions.md](https://docs.handcash.io/brc-wallet/interactions.md) |
| Examples | [examples.md](https://docs.handcash.io/brc-wallet/examples.md) |

## How to read this page

Connect (`@handcash/sdk`) is a cloud API: your server holds `appId` and `appSecret`, the user hands you an `authToken`, and HandCash executes on their behalf. The BRC wallet is the user's own keys on Desktop or Mobile: your app is identified by its origin, the user approves each capability once, and every payment, item, and token is a transaction your app describes and the wallet signs.

That is why the right-hand column is short. Payments, items, and tokens are not separate APIs on the BRC wallet — they are `createAction`, `internalizeAction`, and `listOutputs` with different scripts, baskets, and tags.

```bash
npm install @bsv/sdk
```

```typescript
import { WalletClient } from '@bsv/sdk'

const wallet = new WalletClient('auto') // finds HandCash Desktop on loopback
```

`WalletClient` already implements the BRC-100 method names below. There is no HandCash SDK for the BRC wallet, and the same code runs against any conforming wallet.

## Ship this

Hand these four to a developer integrating today. Each one has HandCash behavior in front of the wallet call: an origin gate, a prompt, a scope check, or a funds preflight. Desktop answers on `http://127.0.0.1:3321`.

| | Call | Stop here |
| --- | --- | --- |
| Auth | `isAuthenticated`, then `waitForAuthentication` | The origin is the session. There is no `authToken` and no app secret. |
| Payments | `createAction`, `signAction`, `abortAction`, `internalizeAction`, `listActions`, `listOutputs` on basket `default` | Amounts are satoshis. Auto-pay and the BRC-73 cap cover plain payments only. Retry `CHANGE_CHAINING_REQUIRED`. |
| Items | `listOutputs` on `p 1sat …`, `createAction` into basket `1sat`, `internalizeAction` with `basket insertion` | Always prompts. The app builds the ordinal script. Reads return only what the user granted. The contract is BRC-147, 150, 164, and 165; see [The 1Sat stack](#the-1sat-stack). |
| Plain BSV-21 | `listOutputs` on `p bsv21 …`, `createAction` into basket `bsv21`, `internalizeAction` into `bsv21` | The app builds the BRC-162 script. Change back into `bsv21` is mandatory. Cosigned tips are not this path: the wallet will not cosign, and a plain unlock is refused. |

Ordinary signing rides along with auth when a back end needs proof the wallet holds the key: `getPublicKey`, `createSignature`, `verifySignature`, `encrypt`, `decrypt`, `createHmac`, `verifyHmac`. A `createSignature` whose `protocolID` is `[2, 'wallet identity proof']` is checked against the calling origin. Any other protocol is signed as a normal BRC-42 signature.

Two HandCash conveniences are safe behind a `404` check: `getBalance` (otherwise sum basket `default`) and `getClaimedCloudHandle` (otherwise the identity key).

Leave the rest of this page for later. Certificates, identity discovery, and key-linkage reveals are forwarded to the wallet and have no HandCash proof that a third-party call succeeds. BRC-230 returns `404`. Market, migration, and handle writes return `403` to every other origin.

## Authentication and identity

| Connect (`@handcash/sdk`) | BRC wallet (BRC-100) | Notes |
| --- | --- | --- |
| `sdk.getRedirectionUrl()` → user signs in → `authToken` | `wallet.isAuthenticated()` then `wallet.waitForAuthentication()` | No redirect, no token. The wallet shows one Authorize prompt for your origin and remembers it per account. |
| `sdk.getAccountClient(authToken)` | Nothing | The connection is the origin. Every call carries `originator`; there is no per-user client to construct. |
| `Connect.getCurrentUserProfile()` → handle, paymail, display name, avatar | `wallet.getPublicKey({ identityKey: true })` | The stable user identity is the identity public key. The handle is a HandCash extension: `getClaimedCloudHandle` on the bridge, feature-detect it. Email and avatar are not exposed. |
| `Connect.getPermissions()` | Nothing to poll | Grants are per origin and per method group. A call the user has not approved prompts; a refused call returns `403 ACTION_DENIED` or `PERMISSION_DENIED`. |
| App secret on your server | Nothing | There is no server secret. Your app never holds anything the user did not sign. |

Task page: [Permissions and scopes](/brc-wallet/permissions) · [permissions.md](https://docs.handcash.io/brc-wallet/permissions.md)

## Payments

| Connect | BRC wallet | Notes |
| --- | --- | --- |
| `Connect.pay({ receivers: [{ destination: '$handle', sendAmount }] })` | `wallet.createAction({ outputs: [{ lockingScript, satoshis, outputDescription }] })` | You supply the locking script. For a P2PKH recipient: `new P2PKH().lock(address).toHex()`. Paying another HandCash or BRC identity uses BRC-29 derivation, see the task page. |
| `denominationCurrencyCode: 'USD'` | Not available | Amounts are satoshis. Convert on your side before you build the output. |
| Multiple `receivers` in one `pay` | Multiple `outputs` in one `createAction` | One transaction, one prompt. |
| `description` shown in the HandCash app | `description` and each `outputDescription` | These are what the user reads in the approval prompt. Keep them specific. |
| `Connect.getSpendableBalances()` | `wallet.listOutputs({ basket: 'default', limit: 1000 })` and sum `satoshis` | Portable. `POST /getBalance` on the HandCash bridge returns the same number as a convenience; feature-detect it. |
| `Connect.getBalances()` (multi-currency) | Not available | The BRC wallet holds BSV. Fiat display is the app's concern. |
| `Connect.getExchangeRate()` | Not available | Use your own rate source. |
| `Connect.getPaymentDetails({ transactionId })` | `wallet.listActions({ labels: [...], includeOutputs: true })` | Label every action you create; labels are how you find your own transactions later. |
| Receiving a payment: nothing to do, HandCash credits the handle | `wallet.internalizeAction({ tx: atomicBeef, outputs: [{ protocol: 'wallet payment', paymentRemittance }] })` | The payer or your service hands the wallet the Atomic BEEF. Do not mark a delivery complete until `accepted` is true. |
| Silent payments after one permission grant | Auto-pay, plus a `spendingAuthorization` cap in your web `manifest.json` (BRC-73) | User-controlled and per origin. Expect `CHANGE_CHAINING_REQUIRED` on rapid successive payments and retry with a short backoff. |
| Staging a transaction your app finishes | `createAction` with `unlockingScriptLength` and `options.signAndProcess: false`, then `signAction({ reference, spends })` or `abortAction` | No Connect equivalent. This is how an app spends its own contract outputs. |

Task page: [Payments and actions](/brc-wallet/payments) · [payments.md](https://docs.handcash.io/brc-wallet/payments.md)

## Items (collectables)

| Connect Items | BRC wallet | Notes |
| --- | --- | --- |
| `Connect.getItemsInventory({ body })` | `wallet.listOutputs({ basket: 'p 1sat all', includeTags: true })` | Reads go through a scoped view grant. `totalOutputs` is what the user let your app see, not the whole wallet. A view returns tags and `originVerified`; the wallet forces `includeCustomInstructions` off so provenance BEEF never rides an inventory. |
| `collectionId` filter | `basket: 'p 1sat collection', tags: ['collection:<id>'], tagQueryMode: 'all'` | Same idea for `p 1sat app`, `p 1sat creator`. |
| Item `id` / `origin` | `origin:` tag and `customInstructions.origin`; the held row is the `id:` tag | Origin is the genesis outpoint, stable across owners. The tip is the current outpoint a transfer spends. |
| `rarity`, `color`, `attributes`, `imageUrl` | `customInstructions` JSON your app writes at mint | The wallet reads `name`, `app`, `collectionId`, `content`, `creator`, `provenance`. Anything else is yours to define and render. |
| `HandCashMinter.createItemsOrder()` (cloud mint) | `wallet.createAction({ outputs: [{ satoshis: 1, basket: '1sat', tags: ['ordinal', 'name:…', 'app:…', 'collection:…'], customInstructions }] })` | Your app builds the ordinal inscription script; the wallet funds and signs. Always prompts, auto-pay never covers items. |
| `HandCashMinter.createCollectionOrder()` | A `collection:` tag on each item | There is no collection object. The collection is the tag plus your `collectionId` in `customInstructions`. |
| v2 `transfer` / send item to a handle | `createAction` spending the held tip with label `` `p 1sat input id ${rowId}` `` and one 1-sat output to the recipient script | Supply `inputBEEF`. A recipient script for a BRC identity uses BRC-29 derivation like a payment. |
| Receiving an item: automatic | `wallet.internalizeAction({ outputs: [{ protocol: 'basket insertion', insertionRemittance: { basket: '1sat', tags, customInstructions } }] })` | Keep `customInstructions` to identity fields; the wallet rebuilds BRC-150 provenance itself. |
| `HandCashMinter.burnAndCreateItemsOrder()` | A transfer whose output is a protocol-valid terminal spend your app constructs | No burn method. Never turn a failed item path into a plain payment. |
| Lock / unlock item | Not available | There is no custodian to hold a lock. A locked state is app-side or a covenant script you design. |
| Item verified badge | BRC-150 v2 `provenance` in `customInstructions` | Wallet-verified. Missing or oversized proofs show as unproven, never truncated. |

### The 1Sat stack

"Items" on the BRC wallet is four BRCs riding on `listOutputs`, `createAction`, and `internalizeAction`. The bridge advertises which ones it implements in `oneSat.brcs`, so an app can check before it builds an inscription.

| BRC | What it fixes | Where it shows up on the wire |
| --- | --- | --- |
| [BRC-147](https://github.com/HandCash/HANDCASH-DESKTOP/blob/master/docs/bsva/brcs/tokens/0147.md) | The storage basket `1sat`, the tag vocabulary, and the `customInstructions` schema (`origin`, `content`, `name`, `app`, `provenance`) | Every output you mint or receive into `1sat` |
| [BRC-150](https://github.com/HandCash/HANDCASH-DESKTOP/blob/master/docs/bsva/brcs/tokens/0150.md) | Offline tip → origin proof, version 2 | `customInstructions.provenance`; the wallet writes it on send and verifies it on receive |
| BRC-164 | A stable held-row key, `id:<key>`, that names one row without exposing inventory | Stamped on the tags when a tip enters custody; used by `p 1sat id` reads and spend labels |
| [BRC-165](https://github.com/bsv-blockchain/BRCs/pull/229) | The permission grammar: `p 1sat <scope>` for reads, `p 1sat input id <key>` for spends | `basket` on `listOutputs`; `labels` on `createAction` |

Storage and permission are separate. Held collectables live in `1sat`; your app never names that basket on a read. `listOutputs({ basket: '1sat' })` returns `400 USE_P1SAT_SCOPE`.

**View rules.** The scope is one of `all`, `collection`, `app`, `creator`, `id`. The value is always a tag, never part of the basket name. A non-`all` scope with no matching tag, a bare `p 1sat`, an unknown scope, or a value embedded in the basket name fails closed. Extra tags narrow a request but cannot widen it: the wallet post-filters to the granted axis even when you send `tagQueryMode: 'any'`. `app:` and `creator:` are different axes. `p 1sat id` with one `id:` tag resolves without a prompt, which makes it the right call for a detail screen.

A view returns tags plus the wallet's `originVerified` verdict. Provenance BEEF is not a view payload; the wallet never hands a 700-row inventory its proofs. Fetch one row with `include: 'entire transactions'` when you need the transaction itself.

**Spend rules.** Every label `p 1sat input id <key>` must resolve to exactly one held row, and that row's outpoint must appear in `inputs`, or the call fails with `400 INVALID_P1SAT_SPEND` before any prompt. Each item spend is approved per action. Pay and auto-pay grants never cover item view or item spend.

**What the bridge advertises.** `GET /health` and `GET /manifest.json` both carry this block. Branch on it, not on the wallet's name.

```json
{
  "oneSat": {
    "brcs": ["147", "150", "164", "165"],
    "baskets": ["1sat"],
    "permissions": {
      "protocol": "p 1sat",
      "viewScopes": ["all", "collection", "app", "creator", "id"],
      "spendLabel": "p 1sat input id <key>"
    },
    "provenanceVerify": ["v2"],
    "walletIdentityProof": {
      "version": 1,
      "methods": ["waitForAuthentication", "getPublicKey", "createSignature"],
      "protocolID": [2, "wallet identity proof"],
      "keyID": "identity-proof:<normalized-origin>",
      "counterparty": "anyone",
      "challenge": {
        "domain": "handcash-wallet-identity-proof",
        "encoding": "canonical-json-utf8",
        "maxTtlMs": 300000,
        "minNonceBits": 128
      }
    }
  }
}
```

`provenanceVerify: ['v2']` means the wallet shows an item as verified only on a complete BRC-150 v2 proof. BRC-156 soft-latch was withdrawn and is not advertised.

Task page: [Collectables](/brc-wallet/items) · [items.md](https://docs.handcash.io/brc-wallet/items.md)

## Tokens (BSV-21)

| Connect | BRC wallet | Notes |
| --- | --- | --- |
| No fungible token API in Connect | `wallet.listOutputs({ basket: 'p bsv21 all' })` or `basket: 'p bsv21 id', tags: ['bsv21:<tokenId>']` | Balances are the sum of `amt:` across held tips per token id. There is no per-token balance method; `basket: 'bsv21'` directly returns `400 USE_PBSV21_SCOPE`. |
| — | `createAction` with a BRC-162 / BSV-21 output, basket `bsv21`, tags `bsv21`, `op:`, `sym:`, `amt:`, `dec:` | Mint and transfer are the same call with different scripts. Amount lives in the lock, the output is 1 satoshi, change back to `bsv21` is mandatory. |
| — | `internalizeAction` with `basket insertion` into `bsv21` | The named output must be 1 sat, pay the wallet, and decode to the same token id and amount. Every output paying you in a self-send is custody. |
| — | Cosigned tips | Not the integrator path. The wallet's own send refuses them with `cosigner_required`, and the bridge will not produce the cosigner signature. An app spends one only by supplying that unlock itself. |
| — | Provenance | BRC-176 walk from tip to a fixed-supply deploy; `issuerAttested` is a Sigma signature check, not a supply audit. |

Task page: [Tokens](/brc-wallet/tokens) · [tokens.md](https://docs.handcash.io/brc-wallet/tokens.md)

## Signing and encryption

| Connect | BRC wallet | Notes |
| --- | --- | --- |
| Not offered by Connect | `wallet.getPublicKey({ protocolID, keyID, counterparty })` | App-scoped derived keys, BRC-42 / BRC-43. |
| — | `wallet.createSignature`, `wallet.verifySignature` | Prompts once per origin for the protocol. |
| — | `wallet.encrypt`, `wallet.decrypt`, `wallet.createHmac`, `wallet.verifyHmac` | Data the user can read on any BRC-100 wallet holding the same keys. |
| — | `acquireCertificate`, `listCertificates`, `proveCertificate`, `relinquishCertificate` | On the wire, not proven. Forwarded to the wallet. Do not ship a certificate flow on this release. |
| — | `discoverByIdentityKey`, `discoverByAttributes`, `revealCounterpartyKeyLinkage`, `revealSpecificKeyLinkage` | On the wire, not proven. No HandCash test shows a third-party discover or linkage call succeeding. |

Task page: [Signing and encryption](/brc-wallet/signing) · [signing.md](https://docs.handcash.io/brc-wallet/signing.md)

## Social, business, and embedded wallets

| Connect / Wallet API | BRC wallet | Notes |
| --- | --- | --- |
| `Connect.getPublicUserProfiles({ handles })`, friends list | Not available | Friends are a HandCash cloud graph. The BRC wallet identifies people by identity key. Resolve handles with your own directory or the cloud API. |
| Business Wallet payouts | Your own BRC-100 wallet instance running `createAction` | A server that pays users is itself a BRC-100 wallet, not a HandCash product. |
| Wallet API (WaaS): create wallets by email, `/v1/waas/*` | Not applicable | WaaS embeds wallets you control. The BRC wallet is the user's. If you need to create accounts for users, stay on Wallet API. |
| Sign in with Google via HandCash | Not applicable | The user unlocks their own wallet. |

## Errors

| Connect `error.code` | BRC wallet | Notes |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | `400 INSUFFICIENT_FUNDS`, `INSUFFICIENT_OR_STALE_FUNDS` | Confirmed and confirming balance still short. |
| — | `CHANGE_CHAINING_REQUIRED` | Pending change covers the ask. Retry shortly. |
| `PERMISSION_DENIED` | `403 PERMISSION_DENIED`, `403 ACTION_DENIED` | The user has not granted the capability, or declined this prompt. |
| `Permission denied` on items | `403 ITEM_VIEW_DENIED`, `403 TOKEN_VIEW_DENIED` | View grants are separate for collectables and tokens. |
| `INVALID_DESTINATION` | Script validation on your side | The wallet signs the locking script you give it. |
| Invalid token → re-authenticate | `NOT_AUTHENTICATED` → `waitForAuthentication` | |
| — | `WALLET_LOCKED`, `OFFLINE_PAYMENTS_DISABLED`, `DOUBLE_SPENT` | Device state. A timeout is not a failure — check `listActions` by label before retrying a payment. |
| — | `400 USE_P1SAT_SCOPE`, `400 INVALID_P1SAT_SPEND`, `403 MARKET_ORIGIN_DENIED` | Item scope grammar and HandCash-host-only methods. |

Full list with HTTP statuses: [Permissions and scopes](/brc-wallet/permissions) · [permissions.md](https://docs.handcash.io/brc-wallet/permissions.md).

## How BRC-100 grows

Connect grew by adding endpoints: `pay`, then `getItemsInventory`, then `createItemsOrder`, each a new SDK function with its own shape. BRC-100 does not grow that way. The method list is fixed and small; new functionality arrives in three layers, and each layer has a different portability guarantee.

```
Layer 3  Wallet-specific methods       getBalance, getClaimedCloudHandle, market*      HandCash only, feature-detect
Layer 2  Protocols carried by Layer 1  BRC-29, 1Sat (147/150/164/165), BSV-21/162/176 Portable to any wallet that speaks the protocol
Layer 1  BRC-100 core                  28 methods, getVersion reports the interface    Portable to every BRC-100 wallet
```

### Layer 1: the core interface

The wallet dispatches the BRC-100 method set as published, and `getVersion` names the interface it speaks. `@bsv/sdk` `WalletClient` covers this layer. Ship the groups marked ready. The others are forwarded and unproven in this release.

| Group | Methods | For integrators |
| --- | --- | --- |
| Session | `isAuthenticated`, `waitForAuthentication` | Ready |
| Transactions | `createAction`, `signAction`, `abortAction`, `listActions`, `internalizeAction` | Ready |
| Outputs | `listOutputs`, `relinquishOutput` | Ready. Reads of items and tokens use the `p` baskets, not the storage basket. |
| Keys | `getPublicKey` | Ready. `revealCounterpartyKeyLinkage` and `revealSpecificKeyLinkage` are forwarded and unproven. |
| Crypto | `encrypt`, `decrypt`, `createHmac`, `verifyHmac`, `createSignature`, `verifySignature` | Ready |
| Chain | `getVersion`, `getNetwork`, `getHeight`, `getHeaderForHeight` | `getVersion` at connect time. The other three are forwarded. |
| Certificates | `acquireCertificate`, `listCertificates`, `proveCertificate`, `relinquishCertificate` | Not this release |
| Identity discovery | `discoverByIdentityKey`, `discoverByAttributes` | Not this release |

### Layer 2: protocols that ride on the core

This is where features live. A payment, a collectable, and a fungible token are the same three calls with different scripts, baskets, tags, labels, and `customInstructions`. A wallet that adds support for a new protocol adds no methods; it learns to build, index, and verify a new kind of output.

| Feature | Protocol | Where it lands in the call |
| --- | --- | --- |
| Pay another identity | BRC-29 | `lockingScript` derived from the recipient's identity key; `paymentRemittance` on receive |
| Derived keys, per-app | BRC-42 / BRC-43 | `protocolID`, `keyID`, `counterparty` on every key method |
| Transaction proofs | BRC-62 Atomic BEEF | `inputBEEF` on `createAction`, `tx` on `internalizeAction` |
| Silent spending cap | BRC-73 | `spendingAuthorization` in your web `manifest.json` |
| Collectables | 1Sat ordinals: BRC-147 basket profile, BRC-150 provenance, BRC-164 held-row key, BRC-165 permission grammar | Basket `1sat`, tags `ordinal`, `origin:`, `name:`, `app:`, `collection:`, `creator:`, `id:`; read scope `p 1sat <scope>`; spend label `p 1sat input id <key>`. See [The 1Sat stack](#the-1sat-stack). |
| Fungible tokens | BSV-21 with BRC-162 value locks, BRC-176 provenance | Basket `bsv21`, tags `bsv21:`, `amt:`, `op:`, `sym:`, `dec:` |
| Certificates | BRC-52 | Forwarded, not proven. Leave off the integrator path until a third-party call is shown succeeding. |
| Catalog and overlay packs | BRC-230 | Not in this release. Shipping on `feature/brc-230-index-expansion`; the methods return `404 INDEX_EXPANSION_UNAVAILABLE` today |

The permission grammar is part of this layer too. `p 1sat collection` and `p bsv21 id` are baskets in the BRC-100 sense — the wallet interprets them as scoped views. Another wallet may use a different grammar, so treat the scope string as a HandCash convention and the underlying `listOutputs` call as portable.

### Layer 3: methods HandCash adds

These travel over the same loopback bridge, use the same JSON envelope, and are not in BRC-100. Feature-detect them and keep a portable fallback.

| Method | Purpose | Portable alternative |
| --- | --- | --- |
| `getBalance` | Spendable satoshis in one call | Sum `listOutputs` on basket `default` |
| `getClaimedCloudHandle` | The `$handle` this device has claimed | Identity key, plus your own handle directory |
| Wallet identity proof (a convention, not a method) | Prove to your back end that this wallet holds an identity key | Already portable: `getPublicKey` + `createSignature` under `protocolID [2, 'wallet identity proof']`, `keyID 'identity-proof:<origin>'`, `counterparty 'anyone'`. The manifest's `oneSat.walletIdentityProof` publishes the challenge rules. |

Methods reserved for HandCash hosts refuse any other origin: market (`createMarketListingAdvert`, `createMarketPurchaseIntent`, `purchaseMarketListing`, `createCancelMarketListingAdvert`, `getTokenIcon` → `403 MARKET_ORIGIN_DENIED`), migration (`getLegacyAddress`, `refreshLegacyAddress`, `listMigrationTxids`) and handle administration (`claimCloudHandle`, `clearClaimedCloudHandle`) → `403 MIGRATION_ORIGIN_DENIED`, and `createAdminIdentityProof` (HandCash operations only).

The origin is taken from the browser's `Origin` header first, then an `originator` header for non-browser clients. That is the identity every grant is keyed to.

### Discovering what a wallet supports

Do this at connect time, once, and branch on the result rather than on the wallet's brand.

| Probe | What it tells you |
| --- | --- |
| `GET http://127.0.0.1:3321/health` | The bridge is up. Returns `{ ok, service: 'handcash-brc100', oneSat }` |
| `GET http://127.0.0.1:3321/manifest.json` | `babbage.trust` (wallet name and identity public key) and `babbage.oneSat` |
| `oneSat.brcs` | Protocols the item path implements: `['147', '150', '164', '165']`. Full block under [The 1Sat stack](#the-1sat-stack). |
| `oneSat.permissions` | View-scope grammar (`p 1sat` with `all`, `collection`, `app`, `creator`, `id`) and the spend-label template |
| `oneSat.provenanceVerify` | Proof versions the wallet will mark verified: `['v2']` |
| `oneSat.walletIdentityProof` | Version, methods, `protocolID`, `keyID` template, challenge rules for identity proofs |
| `POST /getVersion` | The BRC-100 interface version |
| `POST /<unknownMethod>` | `404 Unsupported BRC-100 method: <name>` — the signal to fall back |

Probe extensions only after `waitForAuthentication` has resolved, so a probe can never be the thing that prompts the user.

```typescript
const BRIDGE = 'http://127.0.0.1:3321'

async function walletProfile(wallet: WalletClient) {
  const health = await fetch(`${BRIDGE}/health`).then((r) => r.json())
  const { version } = await wallet.getVersion()
  await wallet.waitForAuthentication()

  const balance = await fetch(`${BRIDGE}/getBalance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  const hasGetBalance = balance.status !== 404

  return { version, oneSat: health.oneSat, hasGetBalance }
}

async function spendableSats(wallet: WalletClient, hasGetBalance: boolean) {
  if (hasGetBalance) {
    const res = await fetch(`${BRIDGE}/getBalance`, { method: 'POST', body: '{}' })
    return (await res.json()).satoshis as number
  }
  const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
  return outputs.reduce((sum, o) => sum + o.satoshis, 0)
}
```

### The rule for app authors

Ship auth, payments, items, and plain BSV-21, plus ordinary signing when a back end must check the key. Pick those protocols from Layer 2. Use `getBalance` and `getClaimedCloudHandle` only behind a `404` check. Leave certificates, identity discovery, key-linkage reveals, and BRC-230 off the integration until this repo shows a third-party call succeeding. That is the point of not shipping a HandCash SDK for the BRC wallet: the calls above are BRC-100, and the rest is not ready to wrap.

## Transport

| | Connect | BRC wallet |
| --- | --- | --- |
| Where the call goes | `https://cloud.handcash.io` | Desktop: `http://127.0.0.1:3321` (HTTPS `:2121` also listens) |
| Who runs it | Your server | The user's browser or native app |
| Mobile | Same cloud API | Same wallet core; a public deep-link transport is not yet a contract |

Task page: [Local bridge](/brc-wallet/local-bridge) · [local-bridge.md](https://docs.handcash.io/brc-wallet/local-bridge.md). Live examples: [Transaction Bounce](https://brc-cloud.bcryderman.workers.dev/tx-bounce) and the [wallet demo](https://brc-cloud.bcryderman.workers.dev/wallet-demo).
