# Public issuer identities

Under **ID → Public identities**, define the wallet's public name, icon and optional description, or import an existing issuer's hex/WIF private signing key. Select the key to use for new issuance. A name and icon are required before issuing assets. The wallet's payment identity and asset ownership locks remain independent of the issuer signer.

An imported key must be the actual Sigma signing private key. A legacy API credential is not interchangeable with it. Importing does not move funds or recreate a legacy cloud wallet.

## Standards and interoperability

- Wallet requests remain standard BRC-100 `createAction` / `signAction`. No new app connection or signing endpoint.
- Items remain ord inscriptions in `1sat`; fungibles retain the existing `bsv21` basket and token wire. The existing BRC-162 binary path is a BRC proposal; this feature does not imply that every 1Sat SDK version supports it.
- Authorship uses standard Sigma/BRC-77, implemented with the published `@1sat/templates/sigma` signing and verification primitives. Funding is bound to a real input. When a simple issuance request has no explicit input, the wallet follows the SDK's `noSend` anchor → `sendWith` flow. The additional 2-sat anchor and network fee are disclosed in approval. A mint that fails before broadcast aborts its signable transaction and then the anchor, so the anchor's change returns to the wallet; the toolbox refuses to abort anything that already reached the network. No unsigned mint is substituted.
- The published template version exposes hash-based signing. The adapter hashes the exact script prefix bytes and the funding outpoint, following the current SDK/go-sigma rules. This avoids the old parser's loss of metadata inside an `OP_RETURN`.
- Authenticated issuer shelves are separate from unsigned claim shelves. A copied publisher key or signed public profile cannot place an unauthenticated asset in the publisher’s shelf.
- `issuer:<compressedPubkey>` and compact CI `issuer` are remittance claims, not proof. The actual transaction's signature, vin and BRC-77 embedded signing key must verify before an attestation is reported. This is authorship verification, separate from SPV inclusion and token/ordinal ancestry.
- Standard Bitcom MAP carries `issuer` and `issuerProfile` on new genesis scripts, before Sigma. Those two metadata fields and the profile format below are **HandCash extensions**, not new 1Sat token fields or a claim of universal profile discovery. Other wallets may ignore them. Retained origin/deploy BEEF lets HandCash recover profiles after ownership moves; exported public profiles provide another explicit import path.
- Existing on-chain BAP ID/ALIAS publishing stays available. BAP can bind an identity through signing-key rotation; a key-bound profile does not provide that continuity. BAP profiles use the existing schema.org `name`, `description`, `image` path. Neither a name nor a self-signed profile proves real-world identity.

References: [1Sat SDK](https://github.com/b-open-io/1sat-sdk), [SDK Sigma anchor flow](https://github.com/b-open-io/1sat-sdk/blob/master/packages/actions/src/apply/inscribeSigma.ts), [SDK Sigma template](https://github.com/b-open-io/1sat-sdk/blob/master/packages/templates/src/bitcom/sigma.ts), [1Sat signing documentation](https://docs.1satordinals.com/adding-metadata/signing), [BAP protocol](https://github.com/BitcoinSchema/bap/blob/master/PROTOCOL.md).

## Signed profile format

The public JSON record has exactly these fields, in this canonical preimage order:

```text
kind, version, identityKey, chain, displayName, icon, description, updatedAt
```

`kind` is `handcash-public-identity`, `version` is `1`, and `identityKey` is the lowercase compressed public key. The SDK signs the UTF-8 bytes of `HandCash-public-identity-v1\n` followed by compact JSON of those fields. `signature` is the DER ECDSA signature encoded as hex. Import verifies the signature, exact fields, network, timestamp, name/icon limits and expected issuer key.

This is public attribution, not a token or a transferable right. It grants no spending authority. The model can describe people, apps, organizations and issuers of awards; it does not define a soulbound NFT standard. Handles are omitted until there is a verified binding. SPV alone cannot establish the handle's issuer authority or current revocation status.

An HTTPS icon signature binds its URL, not the mutable image bytes. Use an `ord://txid_vout` icon for an immutable inscription reference.

## Custody and recovery

Imported private keys are sealed to the active account with SDK BRC-78 authenticated encryption. Records are scoped by account and network. Public exports contain profile signatures only; identity backups also contain the sealed keys. Keep **both the identity backup and the wallet recovery phrase**, or the original imported key. The phrase alone cannot derive an imported issuer key. BRC-39 history backup does not replace this identity backup.

Restoring merges keys and keeps newer profiles; it cannot overwrite another account. Public-only imported profiles can be displayed and exported but cannot be selected to sign. Removing a selected identity returns issuance to the wallet key, which still needs a defined profile. Payment keys and already issued assets are unaffected.

Issuer selection is captured before approval and checked again after anchor creation. Switching wallet or issuer stops signing. Imported key material never enters chart state, public metadata or app responses.

A backend hot wallet/environment credential needs its own custody, limits and revocation design. The public-profile export and the issuer backup are not spending credentials for a service basket.
