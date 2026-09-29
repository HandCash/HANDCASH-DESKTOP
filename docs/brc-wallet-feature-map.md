---
title: "Feature map: Connect to BRC wallet"
description: "Every Connect and Items feature, the BRC-100 call that does the same job against the HandCash BRC wallet, and where the two differ"
---

Beta — BRC wallet only. This page maps features, not payloads. Request and response shapes follow [BRC-100](https://brc.dev/100); the HandCash-specific guidance for each row is on the linked task page.

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

## Authentication and identity

| Connect (`@handcash/sdk`) | BRC wallet (BRC-100) | Notes |
| --- | --- | --- |
| `sdk.getRedirectionUrl()` → user signs in → `authToken` | `wallet.isAuthenticated()` then `wallet.waitForAuthentication()` | No redirect, no token. The wallet shows one Authorize prompt for your origin and remembers it per account. |
| `sdk.getAccountClient(authToken)` | Nothing | The connection is the origin. Every call carries `originator`; there is no per-user client to construct. |
| `Connect.getCurrentUserProfile()` → handle, paymail, display name, avatar | `wallet.getPublicKey({ identityKey: true })` | The stable user identity is the identity public key. The handle is a HandCash extension: `getClaimedCloudHandle` on the bridge, feature-detect it. Email and avatar are not exposed. |
| `Connect.getPermissions()` | Nothing to poll | Grants are per origin and per method group. A call the user has not approved prompts; a refused call returns `403 ACTION_DENIED` or `PERMISSION_DENIED`. |
| App secret on your server | Nothing | There is no server secret. Your app never holds anything the user did not sign. |

Task page: [Permissions and scopes](https://docs.handcash.io/brc-wallet/permissions).

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

Task page: [Payments and actions](https://docs.handcash.io/brc-wallet/payments).

## Items (collectables)

| Connect Items | BRC wallet | Notes |
| --- | --- | --- |
| `Connect.getItemsInventory({ body })` | `wallet.listOutputs({ basket: 'p 1sat all', includeCustomInstructions: true })` | Reads go through a scoped view grant. `totalOutputs` is what the user let your app see, not the whole wallet. |
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

Task page: [Collectables](https://docs.handcash.io/brc-wallet/items).

## Tokens (BSV-21)

| Connect | BRC wallet | Notes |
| --- | --- | --- |
| No fungible token API in Connect | `wallet.listOutputs({ basket: 'p bsv21 all' })` or `basket: 'p bsv21 id', tags: ['bsv21:<tokenId>']` | Balances are the sum of `amt:` across held tips per token id. There is no per-token balance method; `basket: 'bsv21'` directly returns `400 USE_PBSV21_SCOPE`. |
| — | `createAction` with a BRC-162 / BSV-21 output, basket `bsv21`, tags `bsv21`, `op:`, `sym:`, `amt:`, `dec:` | Mint and transfer are the same call with different scripts. Amount lives in the lock, the output is 1 satoshi, change back to `bsv21` is mandatory. |
| — | `internalizeAction` with `basket insertion` into `bsv21` | The named output must be 1 sat, pay the wallet, and decode to the same token id and amount. Every output paying you in a self-send is custody. |
| — | Provenance | BRC-176 walk from tip to a fixed-supply deploy; `issuerAttested` is a Sigma signature check, not a supply audit. |

Task page: [Tokens](https://docs.handcash.io/brc-wallet/tokens).

## Signing and encryption

| Connect | BRC wallet | Notes |
| --- | --- | --- |
| Not offered by Connect | `wallet.getPublicKey({ protocolID, keyID, counterparty })` | App-scoped derived keys, BRC-42 / BRC-43. |
| — | `wallet.createSignature`, `wallet.verifySignature` | Prompts once per origin for the protocol. |
| — | `wallet.encrypt`, `wallet.decrypt`, `wallet.createHmac`, `wallet.verifyHmac` | Data the user can read on any BRC-100 wallet holding the same keys. |
| — | `acquireCertificate`, `listCertificates`, `proveCertificate`, `relinquishCertificate` | BRC-52 certificates. |
| — | `discoverByIdentityKey`, `discoverByAttributes`, `revealCounterpartyKeyLinkage`, `revealSpecificKeyLinkage` | Identity discovery and selective disclosure. |

Task page: [Signing and encryption](https://docs.handcash.io/brc-wallet/signing).

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

Full list with HTTP statuses: [Permissions and scopes](https://docs.handcash.io/brc-wallet/permissions).

## How BRC-100 grows

Connect grew by adding endpoints: `pay`, then `getItemsInventory`, then `createItemsOrder`, each a new SDK function with its own shape. BRC-100 does not grow that way. The method list is fixed and small; new functionality arrives in three layers, and each layer has a different portability guarantee.

```
Layer 3  Wallet-specific methods       getBalance, getClaimedCloudHandle, market*      HandCash only, feature-detect
Layer 2  Protocols carried by Layer 1  BRC-29, 1Sat (147/150/164/165), BSV-21/162/176 Portable to any wallet that speaks the protocol
Layer 1  BRC-100 core                  28 methods, getVersion reports the interface    Portable to every BRC-100 wallet
```

### Layer 1: the core interface

The wallet implements the BRC-100 method set as published, and `getVersion` names the interface it speaks. Nothing HandCash-specific is needed to authenticate, pay, receive, list, sign, encrypt, or hold certificates. `@bsv/sdk` `WalletClient` covers exactly this layer.

| Group | Methods |
| --- | --- |
| Discovery | `getVersion`, `getNetwork`, `getHeight`, `getHeaderForHeight` |
| Session | `isAuthenticated`, `waitForAuthentication` |
| Transactions | `createAction`, `signAction`, `abortAction`, `listActions`, `internalizeAction` |
| Outputs | `listOutputs`, `relinquishOutput` |
| Keys | `getPublicKey`, `revealCounterpartyKeyLinkage`, `revealSpecificKeyLinkage` |
| Crypto | `encrypt`, `decrypt`, `createHmac`, `verifyHmac`, `createSignature`, `verifySignature` |
| Certificates | `acquireCertificate`, `listCertificates`, `proveCertificate`, `relinquishCertificate` |
| Identity | `discoverByIdentityKey`, `discoverByAttributes` |

### Layer 2: protocols that ride on the core

This is where features live. A payment, a collectable, and a fungible token are the same three calls with different scripts, baskets, tags, labels, and `customInstructions`. A wallet that adds support for a new protocol adds no methods; it learns to build, index, and verify a new kind of output.

| Feature | Protocol | Where it lands in the call |
| --- | --- | --- |
| Pay another identity | BRC-29 | `lockingScript` derived from the recipient's identity key; `paymentRemittance` on receive |
| Derived keys, per-app | BRC-42 / BRC-43 | `protocolID`, `keyID`, `counterparty` on every key method |
| Transaction proofs | BRC-62 Atomic BEEF | `inputBEEF` on `createAction`, `tx` on `internalizeAction` |
| Silent spending cap | BRC-73 | `spendingAuthorization` in your web `manifest.json` |
| Collectables | 1Sat ordinals, BRC-147 / 164 / 165, BRC-150 provenance | Basket `1sat`, tags `ordinal`, `origin:`, `name:`, `app:`, `collection:`; label `p 1sat input id <key>` |
| Fungible tokens | BSV-21 with BRC-162 value locks, BRC-176 provenance | Basket `bsv21`, tags `bsv21:`, `amt:`, `op:`, `sym:`, `dec:` |
| Certificates | BRC-52 | `acquireCertificate` and friends, unchanged |
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
| `oneSat.brcs` | Protocols the item path implements: `['147', '150', '164', '165']` |
| `oneSat.permissions` | View-scope grammar (`p 1sat` with `all`, `collection`, `app`, `creator`, `id`) and the spend-label template |
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

Write against Layer 1. Choose protocols from Layer 2 by what your product needs, knowing each one is a published BRC any wallet can adopt. Use Layer 3 only when it saves the user a prompt or a round trip, and only behind a check. An app built this way runs on HandCash today and on the next conforming wallet without a rewrite — which is the point of not shipping a HandCash SDK for the BRC wallet.

## Transport

| | Connect | BRC wallet |
| --- | --- | --- |
| Where the call goes | `https://cloud.handcash.io` | Desktop: `http://127.0.0.1:3321` (HTTPS `:2121` also listens) |
| Who runs it | Your server | The user's browser or native app |
| Mobile | Same cloud API | Same wallet core; a public deep-link transport is not yet a contract |

Task page: [Local bridge](https://docs.handcash.io/brc-wallet/local-bridge). Live examples: [Transaction Bounce](https://brc-cloud.bcryderman.workers.dev/tx-bounce) and the [wallet demo](https://brc-cloud.bcryderman.workers.dev/wallet-demo).
