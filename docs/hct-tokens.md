# HCT tokens: design (draft)

Spec: BRC-255 draft, in `BRCs-255/tokens/0255.md` until it is reviewed. "HCT" is a working name.

## Decision

All new tokens and issuer items use one HandCash format. It is not built on BRC-162:

- **Open mode.** The holder's signature alone moves an output. It replaces `p2pft`.
- **Countersigned mode.** The issuer accepts every transfer, and custodians can release the asset when the issuer is gone. It replaces `csft` and `csnft`.
- **Items.** An item is a supply-1 deploy in either mode. One transaction can deploy up to 256 of them.

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
- **Acceptor fee coins.** These are P2PK, at 114 bytes per input against 148. Each fee input also checkpoints the transfer.
- **Beacon.** There is one per issuer key set, not one per asset.

The larger gain is proof size. Checkpoints (BRC-255 §7) end every validity walk at the last transaction the issuer signed `ALL`:

- **Countersigned transfer:** the package is one Extended Format transaction, about 0.8 KB.
- **Open transfer:** the package reaches back only to the last checkpoint. A holder asks for a free checkpoint with a self-transfer whenever its history grows. Today's BRC-176 proofs grow with every hop back to the deploy.

## Module plan

| Concern | Module | Reuses |
|---|---|---|
| Script encode/parse: deploy, held, authority, both clauses, beacon | `src/wallet/hct/script.ts` | `countersign/script.ts` sighash helpers |
| Deploy payload (DAG-CBOR, `crit`) | `src/wallet/hct/payload.ts` | `token/decode162.ts` CBOR reader, moved to a neutral module |
| Issuer key derivation (`[2, "hct issuer"]`, counterparty `anyone`) | `src/wallet/hct/issuerKey.ts` | — |
| Validity walk, checkpoints, validated-txid cache | `src/wallet/hct/validity.ts` | `countersign/resolve.ts` checks, generalized |
| Proof package: build, delta per peer, `need` | `src/wallet/hct/proof.ts` | `token/inboundLineage.ts` frontier idea |
| Send / receive / checkpoint request (chart) | `src/wallet/hct/wallet.ts`, `hctSendMachine` | `countersign/wallet.ts` acceptor and requester paths |
| Acceptor (accept-once, P2PK fee coins, checkpoints) | `src/wallet/hct/acceptor.ts` | `countersign/store.ts`, policy (`checkAcceptorPolicy`) |
| Beacon, lapse and hash-lock release | `src/wallet/hct/beacon.ts` | `countersign/beacon.ts`, `beaconSource.ts` |
| Holder keys (`[2, "hct holder"]`) | `src/wallet/hct/holderKeys.ts` | `countersign/holderKeys.ts` |
| Filing `hct` / `hcti`, `p hct …` / `p hcti …` scopes | `src/wallet/hct/access.ts`, `itemAccess.ts` | `countersign/access` model |
| Market `token-v2` on HCT outputs | `marketListing.ts`, `marketSettlement.ts` | settlement v2 layouts |
| Convert from BRC-162 | `src/wallet/hct/convert.ts` | `token/send.ts` (outbound legacy leg only) |

Every send goes through `signedSendLifecycle`, as today. Each wallet-layer path is a tagged union plus an XState chart registered in `machineManifest.ts`, with Settings statecharts kept accurate.

## Phases

1. **Spec review.** Review BRC-255 and settle the name, marker, filing names and protocol IDs.
2. **Core.** `hct/script`, `payload`, `issuerKey`, `validity` and `proof`, with unit tests and the BRC test script vectors.
3. **Open mode end to end.** Deploy, send, receive, checkpoint request, `p hct` access and inventory.
4. **Countersigned mode.** Acceptor, requester, beacon, release, policy, and items with collections.
5. **Market.** BRC-254 on HCT outputs; BRC-CLOUD index and storefront read `hct` and `hcti`.
6. **Items.** `hcti` inventory and detail. Mint-studio and issuers mint HCT items. The market sells `hcti` on the token layout, with no pads. `1sat` stays as the outside-format path.
7. **Convert.** Issuers convert BRC-162 holdings. `p2pft`, `csft` and `csnft` become read-only, then are removed along with the BRC-162 code, after a release in which no device reports a holding.

## Open decisions

- The final protocol name, which is mechanical to change before phase 2.
- Whether mint-studio issues HCT only from phase 3 on.
- How long read-only BRC-162 support lasts after conversion opens.
