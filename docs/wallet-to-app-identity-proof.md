# Wallet-to-app identity proof

HandCash exposes an application-scoped identity proof using only existing
BRC-100 methods:

1. `waitForAuthentication`
2. `getPublicKey`
3. `createSignature`

There is no HandCash-specific bridge method. The signature is the BRC-3
signature produced through BRC-100 with BRC-42/43 key derivation. This feature
is not Sigma: Sigma remains the BRC-77 token issuer attestation.

Apps can discover the recipe in `GET /manifest.json` at
`babbage.oneSat.walletIdentityProof` (also returned by `GET /health`).

## Fixed recipe

- `protocolID`: `[2, "wallet identity proof"]`
- `keyID`: `"identity-proof:" + normalizedOrigin`
- `counterparty`: `"anyone"`
- signed input: `data` (never `hashToDirectlySign`)
- encoding: canonical JSON encoded as UTF-8 bytes

`getPublicKey` uses the same `protocolID`, `keyID`, and `counterparty`, plus
`forSelf: true`. The returned key is a stable, app-scoped derived public key. It
is not the wallet's root identity key and must not be presented as a global
cross-app identifier.

`normalizedOrigin` is the host (including a non-default port) seen by the
wallet's BRC-100 bridge. The HTTP `Origin` header is authoritative when present;
otherwise the BRC-100 `originator` header is used. HandCash lowercases this host
and removes a leading `www.`. The challenge `origin` and the `keyID` suffix must
exactly equal this normalized value. Apps must not use a display name, path,
scheme, wildcard, parent domain, or user-supplied return URL in either field.

## Canonical challenge

The challenge has exactly these fields and this order:

```json
{"domain":"handcash-wallet-identity-proof","version":1,"origin":"app.example.com","nonce":"base64url-with-at-least-128-random-bits","issuedAt":1780000000000,"expiresAt":1780000120000,"purpose":"Sign in to Example"}
```

Serialization is `JSON.stringify` over a newly constructed object whose keys
are inserted in the order shown below. No whitespace, alternate key order,
unknown fields, Unicode normalization, or pre-hashing is allowed.

```ts
type WalletIdentityChallenge = {
  domain: 'handcash-wallet-identity-proof'
  version: 1
  origin: string
  nonce: string
  issuedAt: number
  expiresAt: number
  purpose: string
}

export function serializeChallenge(c: WalletIdentityChallenge): string {
  return JSON.stringify({
    domain: c.domain,
    version: c.version,
    origin: c.origin,
    nonce: c.nonce,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    purpose: c.purpose,
  })
}
```

Timestamps are integer Unix milliseconds. `expiresAt` must be after `issuedAt`
and no more than five minutes later. HandCash allows at most 60 seconds of clock
skew and rejects already-expired requests. `purpose` is 1-120 trimmed printable
characters and is shown in the wallet approval prompt.

The verifier, normally an app backend, generates the nonce using a
cryptographically secure RNG. It must encode at least 128 random bits as
unpadded base64url and store this tuple before sending the challenge:

`(normalizedOrigin, nonce, issuedAt, expiresAt, expectedPurpose/session)`

After a valid signature, the verifier must atomically mark the nonce consumed
in the same transaction that creates the authenticated session. Reject unknown,
expired, origin-mismatched, or already-consumed nonces. Never accept a nonce
chosen only by the browser client, and never make a failed verification consume
the nonce. Retrying a wallet call before successful verification is allowed;
successful verification is single-use.

## TypeScript request example

This example uses the JSON BRC-100 HTTP substrate. A production app should use
its normal BRC-100 client when available.

```ts
const bridge = 'https://127.0.0.1:2121'
const normalizedOrigin = window.location.host.toLowerCase().replace(/^www\./, '')
const protocolID = [2, 'wallet identity proof'] as const
const keyID = `identity-proof:${normalizedOrigin}`

async function walletCall<T>(method: string, args: unknown): Promise<T> {
  const response = await fetch(`${bridge}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      originator: normalizedOrigin,
    },
    body: JSON.stringify(args),
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<T>
}

await walletCall<{ authenticated: boolean }>('waitForAuthentication', {})

// Obtain this challenge from the verifier that issued and stored the nonce.
const challenge: WalletIdentityChallenge = await fetch(
  '/api/wallet-challenge',
).then((r) => r.json())
if (challenge.origin !== normalizedOrigin) throw new Error('Origin mismatch')

const data = Array.from(
  new TextEncoder().encode(serializeChallenge(challenge)),
)
const { publicKey } = await walletCall<{ publicKey: string }>('getPublicKey', {
  protocolID,
  keyID,
  counterparty: 'anyone',
  forSelf: true,
})
const { signature } = await walletCall<{ signature: number[] }>(
  'createSignature',
  {
    data,
    protocolID,
    keyID,
    counterparty: 'anyone',
  },
)

await fetch('/api/wallet-proof', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ challenge, publicKey, signature }),
})
```

## TypeScript verification example

The verifier must reconstruct the canonical bytes from its stored challenge,
not trust serialized bytes supplied by the browser. It must also repeat all
origin, expiry, nonce, purpose/session, and exact-field checks before verifying
the DER-encoded ECDSA signature.

```ts
import { PublicKey, Signature } from '@bsv/sdk'

type SubmittedProof = {
  challenge: WalletIdentityChallenge
  publicKey: string
  signature: number[]
}

export async function verifyWalletProof(
  proof: SubmittedProof,
  expectedOrigin: string,
  now = Date.now(),
): Promise<boolean> {
  const stored = await challenges.findUnconsumed(
    expectedOrigin,
    proof.challenge.nonce,
  )
  if (!stored) return false
  if (proof.challenge.origin !== expectedOrigin) return false
  if (proof.challenge.domain !== 'handcash-wallet-identity-proof') return false
  if (proof.challenge.version !== 1) return false
  if (proof.challenge.issuedAt !== stored.issuedAt) return false
  if (proof.challenge.expiresAt !== stored.expiresAt) return false
  if (proof.challenge.purpose !== stored.purpose) return false
  if (now > stored.expiresAt || stored.expiresAt - stored.issuedAt > 300_000) {
    return false
  }

  const data = Array.from(
    new TextEncoder().encode(serializeChallenge(proof.challenge)),
  )
  let valid = false
  try {
    valid = PublicKey.fromString(proof.publicKey).verify(
      data,
      Signature.fromDER(proof.signature),
    )
  } catch {
    return false
  }
  if (!valid) return false

  // Must be an atomic compare-and-set: exactly one request can consume it.
  return challenges.consumeIfUnconsumed(
    expectedOrigin,
    proof.challenge.nonce,
  )
}
```

The derived public key is part of the proof result. On first use, bind it to the
app account created by the consumed challenge. On later sign-ins, require the
same key for that account unless the product has an explicit account-recovery
or key-rotation flow.
