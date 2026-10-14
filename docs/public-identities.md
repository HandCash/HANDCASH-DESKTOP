# Public issuer identities

Under **ID → Public identities** you give each identity key a name, an optional bio and an optional photo. That profile is what contacts, apps and the holders of the items and tokens you issue see.

- An identity key is either the wallet itself or an imported hex or WIF **master key**.
- You select which identity key signs new issuance and which one your identity card presents.
- The wallet's payment identity, and the ownership locks on assets, stay independent of the issuer.

Two drafts cover the normative rules:

- [BRC-247](../../BRCs/peer-to-peer/0247.md) is the asset stamp: a Sigma signature by the issuer's identity key over a MAP tape that names that key.
- [BRC-248](../../BRCs/peer-to-peer/0248.md) covers the identity key's own profile (§2), the package format and delivery, and the optional BAP profile: its key chain, signer verdicts and link to the identity key.

This page covers how the wallet implements them.

## The identity key's own profile

The name and photo belong to the **identity key**. Its profile is a BRC-52 certificate whose certifier and subject are both that key (`identityProfile.ts`). Every field is revealed to anyone:

| Field | Value |
|---|---|
| `name` | 1–80 characters; never an email address or phone number |
| `description` | up to 280 characters |
| `profilePhoto` | optional UHRP URL; the bytes travel beside the certificate and must hash to it |
| `issuedAt` | when it was signed; of two profiles by one key, the later wins |

**Save** signs it with the key's master and keeps it on this device. Nothing goes on chain and there is no fee. The photo is encoded as for BAP below (square, at most 512 px, metadata stripped, at most 64 KB). Each save is strictly later than the one before, so an older copy can never be replayed over it.

The store (`identityProfiles.ts`) keeps one profile per identity key, only after its certificate verified. Profiles of keys this wallet controls are pinned and ride the identity backup. A contact's or a held asset's profile is held; at most 8 profiles nothing on the device names are kept.

**Who it labels.** Everywhere the wallet names an identity key (account menu, identity card, chat, Collect shelves, asset details, app approvals, BRC-100 `displayName`) it uses `identityKeyProfile`: the key's own profile first, else a live BAP profile that links that key. `IssuerProfile.id` is what a person compares: the identity key for its own profile, the BAP ID for a BAP profile. A key with neither shows as its key.

A profile proves only that the key's holder chose that name. It is not a real-world identity or a handle.

## The optional BAP profile

A key can also mirror its profile as a [BAP](https://github.com/BitcoinSchema/bap/blob/master/PROTOCOL.md) identity, for 1Sat apps that read BAP. It is never the label of a key that has its own profile, and never the issuer signal. **Publish to BAP**, **Update BAP profile**, **Link BAP profile to identity key** and **Rotate BAP signing key** are in the row menu; each is a quoted, approved transaction. A BAP identity is not an ordinal. Nothing about it is a spendable output, so it cannot be moved or sold. Authority comes from the key chain alone.

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

**Text.** Name: 1–80 characters. Bio: up to 280 characters.

**Approval.** Publishing, updating and rotating go through the wallet's own transaction approval (`planIdentityPublish` → review → `publishIdentityPlan`). The review lists every record transaction (image, ID, ALIAS), each output's size, the estimated network fee and a per-transaction fee ceiling, the key that will sign assets from then on (and the key a rotation retires), and whether the image is new or already on-chain. Nothing is signed before approval. On approval the plan is rebuilt under the spend lock; a plan whose digest moved (another rotation, a different image or text, a wallet switch) is refused as `plan-changed`. Each transaction is staged unsigned, checked to carry exactly the approved records, and aborted unsigned (change released) when its fee is over the ceiling (`fee-over-plan`). Only then is it signed and sent through the signed-send lifecycle.

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

New item and BSV-21 genesis scripts carry a BRC-247 stamp: `MAP SET issuer <identity key>` before a Sigma signature by that key over an anchor input, or no stamp when the user opts out. Remittance carries the same value as a compact claim. The reference sits inside the signed origin script, so every later holder recovers it from the item's BRC-150 package, with no indexer involved.

Collect has one shelf per issuer identity key (`issuer:pubkey:<identityKey>`). `issuerAttribution` (`issuerIdentities.ts`) decides whether a signed asset is `verified` for its key, and `issuerViewFor` (`collectableGroups.ts`) turns that into the shelf, the token chip label and the issuer rows in item and token details. The shelf's name and image come from the key's own profile, else its linked BAP profile; a key with neither still gets its shelf, labelled with the key shortened. A newer profile from any delivery or identity card relabels it.

Earlier drafts stamped `bapId <BAP ID>` and signed with the current BAP key. Those assets still resolve through the BAP chain:

| Attribution | When | Shelf |
|---|---|---|
| `verified` | the signer is an active key of the chain at the asset's mined height, and the BAP profile links an identity key | that identity key's shelf |
| `unconfirmed` | no package yet, a signer the package does not list, or a retired key at an unknown height | `issuer:bap-unconfirmed:<bapId>`, "Unconfirmed profile …"; never a name or image |
| `refused` | the package retires the signer before the asset's height, or the identity is revoked | the signing key |

The height comes from the retained merkle path of the asset's origin; without one, it is unknown. Anyone can copy a stamp, so an unsigned copy stays on a separate "issuer claim" shelf.

### Telling identities apart

A name and image are whatever the key's owner chose, so anyone can call themselves "HandCash" with HandCash's logo. Every profile is therefore shown with its **fingerprint**: the profile ID (the identity key, or the BAP ID for a BAP profile) shortened to its first 6 and last 4 characters beside a 5×5 identicon drawn from its SHA-256 (`profileFingerprint` in `issuerTrust.ts`, `ProfileIdenticon.tsx`). The full ID stays in the title and in item and token details.

A verified profile can also carry one of these marks (`verifiedProfileMark` → `issuerTrustFrom`):

| Mark | When |
|---|---|
| checkmark, **Verified by HandCash** | the profile ID, or the BAP ID of the BAP profile the key links, is on HandCash's verified-issuer list |
| caution, **imitation** | not listed, and its name reads like a listed issuer's name (case, accents, spacing and look-alike characters such as `rn`/`m`, `0`/`o`, `1`/`l` folded away) |
| caution, **shared name** | not listed, and another stored profile reads the same. A BAP profile linked to a key that has its own profile is not counted, so nobody collides with themselves |

Unconfirmed stamps get neither mark; they never show a name to imitate.

The verified-issuer list is served by BRC-CLOUD at `GET /v1/identities/verified` as `{ v, updatedAt, entries: [{ bapId, name }], certifier, signature }`. The signature is BRC-3 by the HandCash handle certifier, the key the wallet already pins for handle certificates, under protocol `[2, 'handcash verified issuers']`, key ID `1`, counterparty `anyone`, over `JSON.stringify({ v, updatedAt, entries })`. The wallet (`verifiedIssuers.ts`) refuses any list that is unsigned, signed by another key, or older than one it has already seen, so a removed entry cannot be replayed. It refreshes every 6 hours, keeps the last valid list on the device and re-verifies it on load. Without a valid list nobody gets a checkmark.

To list an issuer, add `{ bapId, name }` to `BRC-CLOUD/src/verifiedIssuers.json`, move `updatedAt` forward, run its tests and deploy. The worker signs the list at request time; the certifier key never leaves the worker secret.

A short fingerprint can be ground to collide; the identicon, the cautions and the list together are the defence, not the 10 characters alone.

Builds before 1.3.393 wrote a self-signed `issuerProfile` JSON with an icon URL into mints. Those bytes are ignored. Those assets still group by their verified key, and the issuer's own wallet still recognises its earlier keys.

## Store once, attach when needed

An identity-key package is `{ v: 2, identityKey, certificates?, images?, bap? }`, up to 160 KB: the key's profile certificate, the photo bytes, and the BAP package when it links that key. A package over its budget drops the BAP part first, never the key's own profile.

A BAP package is `{ v: 1, bapId, beefB64 }`. The BEEF holds only the ID chain, the chosen `ALIAS`, its image, the link and any revocation, with merkle paths once mined.

The BAP store (`issuerIdentities.ts`) keeps one durable key per BAP ID plus a small index. Assets hold only the identity key (or, from earlier drafts, the BAP ID).

- The identities this wallet controls are pinned. Only its own publish, rotate, adopt and proof-upgrade flows rewrite them, and they are included in the identity backup.
- A peer's package is accepted only after every merkle root in it matches a block header. Heights decide rotation and revocation, so a forged proof must never reach the store.
- A peer's package merges into the stored one, and the merge keeps the first rotation on chain. A leaked retired key therefore cannot fork the chain by sending a package of its own.
- Peers' packages are capped at 8, and the oldest are evicted first. On Electron, writes commit to disk before success is reported.

### Tokens are attested like items

An item is attested when its retained origin carries the issuer's Sigma and a BRC-150 proof binds the tip to that origin. A BSV-21 token follows the same rule. The deploy is the origin, and a BRC-176 walk is the binding.

- **The sender** attaches the token-parent bodies from the transfer back to the deploy as `meta.tokenLineage`, up to 96 KB. The deploy keeps its merkle path. A lineage over budget is omitted, never truncated.
- **The receiver** proves every tip from that lineage without the network. Only an older peer, or an omitted lineage, makes it walk parents from its cache or an indexer. It then keeps the deploy (`token/genesisStore.ts`), with its merkle path only once the root matched a block header, and files the tips that reached it (`token/lineage.ts`).
- **Listing** attests a tip only when it is the deploy itself (its script matches), or when a recorded walk bound it to the deploy. In both cases the deploy's Sigma must verify for the issuer. A tip that merely names a real token ID stays an issuer claim.
- Tips held before this landed are healed in the background, four per list pass (`proveHeldTokenTip`). That includes cards that name no issuer yet, because a received token's issuer is unknown until its deploy is held. The walk reads this device's bytes first. A received token's parents live on the sender's device, so missing bodies are then fetched by txid. A body is keyed by the hash of its bytes, so a provider can withhold the lineage but never forge it. Each heal logs a named outcome (`bound (verdict|local|fetched)` or `refused no-tip-body|walk-failed|no-genesis`).
- Re-attestation takes the issuer and the BAP ID from the retained deploy, not from the remittance claim, so an attested card filed before its deploy was held gains the BAP ID that shelves it.
- Every pass logs `[bsv21] attestation census` when the counts change: tokens on a verified BAP shelf (`bap`), attested without a stored package (`bap-unconfirmed`), attested with no BAP ID (`key`), or the step they lack (`no-genesis`, `unbound`, `unsigned`, `unsigned-mint`). `npm run triage` reads it as `tokenAttestation`.

### Where the issuer shows

Item details, token details, Send, Burn and every app approval that previews a held asset show its issuer with one mark (`AssetIssuers` → `IssuerIdentityMark`). That mark is the issuer key's profile with its image, HandCash checkmark and fingerprint when the asset's signature verifies for that key. Otherwise it is the signing key, or an unsigned issuer claim. It is never a handle. A batch shows each distinct issuer, up to three.

A received token therefore lands on its issuer's shelf beside that issuer's items, and it can be forwarded with the same identity package.

When an item or token is delivered over the messagebox, `notifyPeerItemIncoming` builds the package for the identity key that the asset's origin names (or the BAP package an earlier-draft stamp names) and attaches it as `meta.identities`, at most 2 per envelope. It goes in **last**: the Atomic BEEF, the item's BRC-150 provenance and the token's lineage keep the box cap first, and a package that does not fit is omitted. The receiver verifies the certificate and photo hash, header-checks the BAP part (kept only when it links that key) and stores both off the receive path (`rememberIdentityKeyPackage`). Packages never gate ingest or ACK, and they are kept out of the chat transcript.

## Identity cards

Contacts learn the profile from a signed **identity card** (`identityCard.ts`, `identityCardShare.ts`), sent once per contact after a delivery and again when the profile or the presented key changes. A v2 card is the statement `{ v: 2, identityKey, presents, issuedAt }`, BRC-3 signed by the wallet key under protocol `[2, 'identity card']`, key ID `1`, counterparty `anyone`. When the presented key is not the wallet key, it countersigns. The card carries the presented key's v2 package; `presents: null` withdraws it. An older card, or one at the same time naming a different key, is refused. v1 cards from older builds (a BAP identity, protocol `[2, 'bap identity card']`) are still read. Presenting a key needs only its own profile, not a BAP identity.

## Custody and recovery

Imported master keys are sealed to the active account with SDK BRC-78 authenticated encryption. Records are scoped by account and network, and hold custody only: the key, the signer kind, and the sealed key for imported signers. The BAP signing keys are derived on demand and are never stored.

The identity backup contains the sealed keys, each key's own profile and the BAP packages they publish under. Restore keeps a profile only when its certificate verifies for a key the backup controls. A device restored from it can keep issuing, and keep rotating, without fetching anything. Keep **both the identity backup and the wallet recovery phrase**, or the original imported key. The phrase alone cannot derive an imported master key, and BRC-39 history backup does not replace the identity backup.

Removing an imported signer deletes its key from this wallet. Published identities and existing assets are unaffected. The issuer selection is captured at approval and checked again before signing; switching wallet or issuer stops signing. Key material never enters chart state, public metadata or app responses.

## Standards notes and limits

- Wallet requests stay standard BRC-100 `createAction`. Records are standard BAP / AIP / B, and asset authorship is standard Sigma / BRC-77.
- The asset stamp is proposed as BRC-247. The identity key's profile, the package format, the verdict rules and the `meta.identities` envelope field are proposed as BRC-248. Wallets that implement neither can ignore them.
- The wallet labels a key by its own profile ahead of a linked BAP profile. BRC-248 §4 as drafted still ranks a BAP profile first and has no `issuedAt` rule for self-published profiles.
- HandCash's verified-issuer list is keyed by BAP ID. A key with its own profile gets the checkmark through the BAP profile it links.
- Builds before v2 identity cards refuse them and keep showing the previous card.
- A receiver with no prior package sees only the records it is sent. A fork that the sender leaves out is invisible to it until another package brings it in.
- A rotation written by an app on this wallet is followed (held-record sync). A rotation written by a different wallet, for example 1Sat holding the same master, is only seen once its records reach this wallet. Without an indexer, a chain that moved on elsewhere is not discovered. Publishing over it then fails to package after broadcast, because the new ALIAS is signed by a retired key.
- Proof upgrade runs when the panel opens, not in the background. Until it does, a fresh publish verifies as unmined. An unmined update stays the preferred profile while it is unmined.
- Market listings do not yet carry identity packages.
- A valid chain proves control of keys, not a real-world name or handle.
