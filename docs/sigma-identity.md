# Sigma identities

Spec: [`docs/bsva/brcs/identity/0247.md`](bsva/brcs/identity/0247.md) (draft BRC-247).

A Sigma identity is an on-chain persona derived from a BRC-100 wallet. It is
not the wallet root, and it is not a BRC-169 handle.

| Thing | What it is |
|---|---|
| Root identity | BRC-100 identity key. Apps prove it with a BRC-138 signature. |
| BRC-169 handle | A `$handle` claimed on the root key. |
| Sigma identity | A BKDS child used to attest 1Sat and BSV-21 issuances. |

Spending a Sigma control output revokes that persona. It does not rotate the
root key and it does not release the BRC-169 handle.

## Stack

| Layer | Protocol | Role |
|---|---|---|
| State computing | BRC-100 | Application actions, baskets, BKDS derivation |
| Assets | 1Sat / BSV-21 | Ordinal envelopes and token supply |
| Attestation | Sigma identity | VIN-bound proof that an issuer key created the output |

An indexer does not need a vendor table. The wallet identity key, the persona
id, and the inscription are enough.

## Derivation

BRC-42 public path (security level 0, counterparty `anyone`):

- `protocolID`: `[0, "sigma identity"]`
- `keyID`: persona id, or `<id>:<generation>` after a rotation
- Invoice: `0-sigma identity-<keyID>`

Anyone with the wallet identity key can reconstruct the persona public key.
Only the root holder can derive the private key. The root is never inscribed.

## Baskets

Active persona UTXOs live in basket `sigma-<id>`. That basket is not `default`,
`1sat`, or `bsv21`, so coin selection cannot spend a control output as cash or
as a collectable. Pay balance excludes `sigma-*`.

## On-chain layout

A persona document is a 1-sat output:

```
<persona P2PKH>
OP_FALSE OP_IF
  "ord"
  OP_1 "application/sigma-identity+json"
  OP_0 {"v":1,"id":"studio","name":"Studio"}
OP_ENDIF
OP_RETURN
  {"p":"sigma-identity","op":"publish","id":"studio"}
  |
  SIGMA
  BSM
  <signing address>
  <signature>
  0
```

VIN is a concrete input index. `-1` is refused. The signature covers the
inscription and the metadata in front of the `|` separator, and it commits to
the outpoint at that input, so it cannot be replayed onto another spend.

The same tail is appended to a 1Sat inscription or a BSV-21 deploy+auth output
when that output asks for `sigma-identity:<id>`. The asset envelope stays the
asset. The Sigma tail is the issuer attestation. Name and traits that must be
authoritative live in the signed inscription or the signed metadata, not in an
unsigned URL.

A second output in the same basket is the control UTXO. It is spendable only
with the persona key. Unspent control means the generation is active. Spending
it without a successor revokes the persona. The inscription remains as history.

## Off-chain challenges

API gateways get a BSM signature over:

```
sigma-identity
<personaId>
<generation>
<publicKey>
<expiresAt>
<nonce>
```

That signature does not reveal the root and does not revoke anything. A gateway
must also see an unspent control output for that generation. Revocation is the
spend, not a message.

## Wallet

Identity shows three things apart:

1. Root identity key
2. BRC-169 handle
3. Sigma identities, with create / use-for-signing / revoke

Creating a persona funds a 1-sat output in `sigma-<id>`, then spends it as
VIN 0 to inscribe the document and leave a control output.
