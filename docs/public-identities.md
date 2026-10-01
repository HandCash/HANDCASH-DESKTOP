# Public issuer identities

Under **ID → Public identities** you can publish the identity behind the items and tokens you issue. It is a **BAP identity** with an image, a name and an optional bio.

- An issuer is either the wallet itself or an imported hex or WIF **master key**.
- You select which issuer new issuance uses.
- Issuing requires a published identity that has not been revoked.
- The wallet's payment identity, and the ownership locks on assets, stay independent of the issuer.

Two drafts cover the normative rules:

- [BRC-247](../../BRCs/peer-to-peer/0247.md) is the asset stamp: a Sigma signature by the current BAP key over a MAP tape that names the BAP ID.
- [BRC-248](../../BRCs/peer-to-peer/0248.md) covers the key chain, signer verdicts, profile selection, the package format and delivery.

This page covers how the wallet implements them.

## What an identity is

An identity is a [BAP](https://github.com/BitcoinSchema/bap/blob/master/PROTOCOL.md) identity, not an ordinal. Nothing about it is a spendable output, so it cannot be moved or sold. Authority comes from the key chain alone.

**BAP ID.** The BAP ID is the hash of the root address, which is key 0. Every key in the chain derives from the issuer's master key, at protocol `[1,'sigma']` with key ID `identity-N` and counterparty `self`. 1Sat BRC-100 wallets use the same derivation, so the same master key gives the same BAP ID there. The BAP ID never changes.

**Records.** Every record is a 0-sat `OP_FALSE OP_RETURN` output, AIP-signed. Where the records are kept depends on the master:

- The wallet's own identity uses basket `bap`, with the same tags, and on ID records the same `{protocolID, keyID}` custom instructions, that the 1Sat SDK writes. A 1Sat app connected to this wallet over BRC-100 therefore sees the same identity and current key.
- An imported master uses basket `bap issuer`. 1Sat apps read the highest `seq:` in `bap` as the wallet's own key, so another master's chain there would make them sign with a key that was never declared.

| Record | What it is | Signed by | Tags |
|---|---|---|---|
| `ID <bapId> <address>` | Declares the next signing key. The first one is signed by the root and declares `identity-1`. | The outgoing key | `type:id`, `bapId:`, `seq:N` |
| `ALIAS <bapId> <profile>` | A schema.org `Person` with `name`, an optional `description`, and `image: "b://<txid>"`. | The current key | `type:alias`, `bapId:`, `publishedAt:` |
| B:// file | The image bytes and their media type. | Nothing; the signed ALIAS names it by txid | `type:image`, `bapId:` |

**Image.** The picked file is drawn through a canvas, centre-cropped square, at most 512 px, then encoded as WebP (JPEG where the device cannot encode WebP). Quality and size step down until the result fits in 64 KB. Re-encoding removes EXIF and every other metadata block, including GPS location. There is no URL field.

**Text.** Name: 1–80 characters. Bio: up to 280 characters. Publishing asks for confirmation that the image, name and bio become public and permanent.

## Publish, update, rotate

All three run inside the exclusive spend region. They are `createAction` calls (label `bap-identity`) handed to `signedSendLifecycle` (flow `identity_publish`) for sealing, durable miner retry and finality.

- **Publish** writes the image file, then one transaction holding the root-signed `ID` for `identity-1` and an `ALIAS` signed by `identity-1`.
- **Publish update** writes only a new `ALIAS`, signed by the current key. An unchanged image is referenced again, never re-uploaded. A new image is a new B:// file.
- **Rotate signing key** writes one transaction: an `ID` signed by key N that declares N+1, and the same profile re-signed by N+1.
  - New assets are signed by N+1.
  - Assets that N signed stay attributed when they were mined before the rotation was mined, or while the rotation is still unmined.

Publish and rotate always merge the stored package with the records the wallet holds in its basket. So the wallet never redeclares `identity-1` over an existing chain, and never rotates from a key that another app has already retired.

**Held-record sync** (`syncHeldIssuerIdentities`) runs when the panel opens, and for the selected issuer before every BRC-100 issuance is approved. It does two things:

- It **adopts** held records that have no package yet, including those written by the earlier ID → BAP compose, whose bytes are identical.
- It **follows** a rotation or revocation that another BRC-100 app (for example, the 1Sat SDK's `rotateIdentity`) wrote into `bap`. That keeps issuance signing with the current key, even when that app has relinquished the ID outputs it replaced.

A profile change made by another app is not adopted, so the wallet's own choice of ALIAS stands.

After the sync, the panel **upgrades** unmined records in its own packages to mined copies, once their proofs exist and match block headers.

A revoked identity cannot be updated, rotated or used to issue. The wallet does not yet write revocations. It honours revocations written elsewhere: a root-signed `ID <bapId> 0`, as BAP defines.

## How assets name it

New item and BSV-21 genesis scripts carry a BRC-247 stamp: `MAP SET issuer <current signing key> bapId <BAP ID>` before their Sigma signature, and that signing key is the one that signs. Remittance carries the same two values as compact claims. The reference sits inside the signed origin script, so every later holder recovers it from the item's BRC-150 package, with no indexer involved.

Collect shows the issuer's image and name only when all of these hold:

- the asset's Sigma signature verifies, bound to its funding input, and its signer equals `issuer`;
- a verified package for `bapId` is in the store;
- that signer is an **active** key of the chain at the asset's mined height. The height comes from the retained merkle path of the asset's origin; without one, it is unknown.

Such assets share the shelf `issuer:bap:<bapId>` across rotations. A copied claim stays on a separate "issuer claim" shelf.

Builds before 1.3.393 wrote a self-signed `issuerProfile` JSON with an icon URL into mints. Those bytes are ignored. Those assets still group by their verified key, and the issuer's own wallet still recognises its earlier keys.

## Store once, attach when needed

A package is `{ v: 1, bapId, beefB64 }`. The BEEF holds only the ID chain, the chosen `ALIAS`, its image and any revocation, with merkle paths once mined, up to 160 KB.

The store (`issuerIdentities.ts`) keeps one durable key per BAP ID plus a small index. Assets hold only the BAP ID.

- The identities this wallet controls are pinned. Only its own publish, rotate, adopt and proof-upgrade flows rewrite them, and they are included in the identity backup.
- A peer's package is accepted only after every merkle root in it matches a block header. Heights decide rotation and revocation, so a forged proof must never reach the store.
- A peer's package merges into the stored one, and the merge keeps the first rotation on chain. A leaked retired key therefore cannot fork the chain by sending a package of its own.
- Peers' packages are capped at 8, and the oldest are evicted first. On Electron, writes commit to disk before success is reported.

When an item or token is delivered over the messagebox, `notifyPeerItemIncoming` looks up the BAP ID that the asset's origin names. If that package is in the store, it attaches it as `meta.identities`, at most 2 per envelope. It goes in **last**: the Atomic BEEF and the item's BRC-150 provenance keep the box cap first, and a package that does not fit is omitted. The receiver header-checks, verifies and stores packages off the receive path. Packages never gate ingest or ACK, and they are kept out of the chat transcript.

## Custody and recovery

Imported master keys are sealed to the active account with SDK BRC-78 authenticated encryption. Records are scoped by account and network, and hold custody only: the key, the signer kind, and the sealed key for imported signers. The BAP signing keys are derived on demand and are never stored.

The identity backup contains the sealed keys and the packages they publish under. A device restored from it can keep issuing, and keep rotating, without fetching anything. Keep **both the identity backup and the wallet recovery phrase**, or the original imported key. The phrase alone cannot derive an imported master key, and BRC-39 history backup does not replace the identity backup.

Removing an imported signer deletes its key from this wallet. Published identities and existing assets are unaffected. The issuer selection is captured at approval and checked again before signing; switching wallet or issuer stops signing. Key material never enters chart state, public metadata or app responses.

## Standards notes and limits

- Wallet requests stay standard BRC-100 `createAction`. Records are standard BAP / AIP / B, and asset authorship is standard Sigma / BRC-77.
- The asset stamp is proposed as BRC-247. The package format, the verdict rules and the `meta.identities` envelope field are proposed as BRC-248. Wallets that implement neither can ignore them.
- A receiver with no prior package sees only the records it is sent. A fork that the sender leaves out is invisible to it until another package brings it in.
- A rotation written by an app on this wallet is followed (held-record sync). A rotation written by a different wallet, for example 1Sat holding the same master, is only seen once its records reach this wallet. Without an indexer, a chain that moved on elsewhere is not discovered. Publishing over it then fails to package after broadcast, because the new ALIAS is signed by a retired key.
- Proof upgrade runs when the panel opens, not in the background. Until it does, a fresh publish verifies as unmined. An unmined update stays the preferred profile while it is unmined.
- Market listings do not yet carry identity packages.
- A valid chain proves control of keys, not a real-world name or handle.
