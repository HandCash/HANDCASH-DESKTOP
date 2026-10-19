# Coins of other chains

Specs for holding, swapping and wrapping coins of other UTXO chains. BRC-213
(native coins, [#337](https://github.com/bsv-blockchain/BRCs/pull/337)) and
BRC-214 (asset profiles, [#338](https://github.com/bsv-blockchain/BRCs/pull/338))
and BRC-256 (swaps, [#339](https://github.com/bsv-blockchain/BRCs/pull/339))
are BSVA drafts; numbers are proposed, not assigned. BRC-212 (wrapping by an
issuer's reserve) stays held back: that is custody. The working drafts live in
the sibling checkouts `../BRCs-212`, `../BRCs-213`, `../BRCs-214`; this folder
is the source, so copy changes from here (absolute BRC links become `../`).

| Doc | What | Code |
|---|---|---|
| [BRC-213](./0213.md) | Native coins: the wallet holds its own key on the coin's chain. Burial at each binding's depth on its own header chain; `getCoinAddress` / `listCoins` / `sendCoins`, to an address or, when the recipient's signed record names the chain, to an identity (§7) | `src/wallet/coins/` (engine), `ltc/`, `bch/`, `btc/`, `doge/` (bindings), `coinMethods.ts`, `walletProtocols.ts`, `coins/coinPaymentBox.ts`, chart `coinMachine` |
| [BRC-256](./0256.md) | Cross-chain atomic swaps between wallets: offers, HTLC legs, BSV refund pre-sign, optional fee output | `src/wallet/swap/` (`offer.ts`, `htlc.ts`, `settle.ts`, `legChains.ts`, `settleRunner.ts`), chart `swapSettleMachine` |
| [BRC-214](./0214.md) | Asset profiles: every kind of value the wallet holds and how apps reach it (`listAssetProfiles`) | `src/wallet/assetProfiles.ts` |
| [BRC-212](./0212.md) | Wrapped coins: BSV tokens backed by a reserve on the coin's chain, burial proof per mint | `src/wallet/hct/backing.ts` |
| [HCT backed tokens](./hct-backed-tokens.md) | BRC-212 bound to HCT (`bk`, `hctb`); was BRC-255 §15 | `src/wallet/hct/payload.ts`, `validity.ts` |

Bindings shipped, each with its own key, address form, signature hash, header
rules and burial depth:

| Chain | Address | Signature | Header rules | Depth |
|---|---|---|---|---|
| Litecoin | P2WPKH `ltc1q` | BIP143 | scrypt, 2016-block retarget | 6 |
| Bitcoin Cash | CashAddr P2PKH | BIP143 + `FORKID` | SHA-256d, ASERT | 6 |
| Bitcoin | P2WPKH `bc1q` (pays `bc1q`, `bc1p`, `3…`; never `1…`, which reads as BSV) | BIP143, RBF opt-in | SHA-256d, 2016-block retarget | 3 |
| Dogecoin | P2PKH `D…` | legacy `SIGHASH_ALL` | AuxPoW (parent scrypt), DigiShield every block | 20 |

Checkpoints: `npm run ltc:checkpoint` and `npm run coin:checkpoint -- <bch|btc|doge>`
(`--height <n>` writes one agreed by two servers; `--check` reports a fresh
install's first sync).

## Swaps (wallet action between Send and Receive)

Wallet-to-wallet settlement is [BRC-256](./0256.md) (draft,
[#339](https://github.com/bsv-blockchain/BRCs/pull/339)); routing and the
Exolix route are product, not spec. Between coins the wallet holds, with no
addresses entered:

- `src/wallet/swap/routing.ts` ranks routes: direct offers paying at least
  what Exolix pays come first (best, then oldest), then Exolix, then worse
  direct offers. Direct offers are priced halfway between the market rate and
  Exolix's rate (`interceptPrice`).
- `src/wallet/swap/offer.ts` signs direct offers with the identity key's
  BRC-42 child under the wallet-only protocol `swap order` (reserved from apps
  in `vaultAccounts.ts`).
- `src/wallet/swap/exolixSwap.ts` / `runSwap.ts` run the Exolix route: payout
  and refund to the wallet's own addresses, refused unless the exchange
  matches the confirmed quote, recorded before the deposit is paid. Exolix
  holds the coins between deposit and payout; the UI says so.
- Chart `swapMachine`; only `CONFIRM` moves coins.
- Offer book: when no route takes a swap (under Exolix's minimum, say), the
  same amount can be published as a whole offer at the market rate
  (`offerBook.ts` `draftOfferAtMarket` → `publishSwapOffer`; chart states
  `offering` → `publishing` → `published`, only `PUBLISH` signs). BRC-CLOUD
  hosts the book (`/v1/market/swap-offers`, open CORS): it verifies on
  publish, caps 20 open offers and 30 publishes an hour per maker, and
  accepts a cancel only signed by the offer's key over
  `handcash swap offer cancel v1\n<nonce>`. The host is never trusted: every
  listed offer is verified again in the wallet. Swap › Offers
  (`swapOffersMachine`) browses the book and cancels the wallet's own offers.
  Publishing moves no coin.

- Wallet-to-wallet settlement (`settle.ts`, `htlc.ts`, `legChains.ts`,
  `settleRunner.ts`, chart `swapSettleMachine`): both legs are hash-locked
  to one taker secret. Coin chains use `IF sha256 claim ELSE CLTV refund`
  (P2WSH on LTC/BTC, P2SH on BCH/DOGE); BSV has no CLTV, so its lock adds a
  co-signer and the counterparty pre-signs the refund before the lock goes
  out. Taker locks first (36 h), maker after the taker's lock is buried
  (12 h); the taker's claim reveals the secret. Messages ride box
  `swap-settle` (BRC-78 sealed). Each lock is journaled (`swap lock`
  recipe) and replayed on unlock. A maker's wallet answers takes of its own
  published offers without asking; a taker confirms in Swap or Swap › Offers.
  `listSwapOffers` reads the book, so direct offers are executable routes.
- Fee: 0.5% (`fee.ts`), success only, on the BSV leg when there is one, else
  the maker's; a third output with the same hash, claimable by
  `HANDCASH_SWAP_FEE_PUB`, back to its payer after the lock time. No fee on
  Exolix routes.

The HandCash fee claimer runs on BRC-CLOUD (`src/swapFees.js`, cron every
5 minutes). Both wallets report the fee lock to `POST /v1/swap-fees`
(`settlePorts.ts` `reportFeeLock`); the report is only a pointer. The claimer
rebuilds both scripts from it (`src/wallet/swap/feeClaim.ts`, vendored as
`src/vendor/swapFeeCore.mjs`), checks the lock on chain, reads the secret from
the claim of the sibling swap output and signs the fee claim. A refunded swap
output means no swap, and the fee output returns to its payer after the lock
time. The claimer refuses to run unless `SWAP_FEE_KEY` is the key for
`HANDCASH_SWAP_FEE_PUB`.
