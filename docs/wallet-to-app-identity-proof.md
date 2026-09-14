# Wallet-to-app identity proof

Identification to an application is a [BRC-138](https://bsv.brc.dev/peer-to-peer/0138.md)
single-use signed proof. HandCash produces it only through existing BRC-100
methods:

1. `waitForAuthentication`
2. `getPublicKey`
3. `createSignature`

There is no HandCash identity method. The signature is the BRC-3 signature
produced through BRC-100 with BRC-42/43 derivation required by BRC-138. The
derived signing child is not the identity. The authenticated subject is
`data.identityKey`, and it must be this wallet's identity key.

A BRC-138 proof does not authorize a payment. Payments, encryption, and
transaction signing stay on the operational root via `createAction`, `encrypt`,
and `signAction`.

This is not a Sigma identity. A BRC-138 proof authenticates the wallet root
key. A BRC-169 handle is a claim on that same root. Sigma identities are
separate BKDS personas used to attest 1Sat and BSV-21 issuances. See
`docs/sigma-identity.md`.

Apps discover the parameters in `GET /manifest.json` at
`babbage.oneSat.walletIdentityProof` (also returned by `GET /health`).

## Parameters

- `protocolID`: `[2, "bsv auth proof"]`
- `keyID`: the proof `nonce`
- `counterparty` when signing: the verifier identity key (compressed pubkey hex)
- `counterparty` when the verifier checks: the claimed client `identityKey`
- signed input: `data` (never `hashToDirectlySign`)
- encoding: `action + "\n" + identityKey + "\n" + decimal(expiresAt) + "\n" + nonce`
- `validityWindow`: 120000 ms
- `clockSkew`: 30000 ms

`action` is letters, numbers, and spaces. `nonce` is the base64 encoding of 32
random bytes. `identityKey` is the wallet identity key, obtained with
`getPublicKey({ identityKey: true })`. It is not a protocol-derived child.

The verifier publishes its own identity public key out of band. A proof signed
toward a different key will not verify.

## Wallet checks

Before prompting, HandCash refuses a `createSignature` on this protocol when:

- the statement is not the canonical four-line encoding
- `keyID` is not the nonce
- `counterparty` is not a compressed verifier pubkey (including `"anyone"` and `"self"`)
- `identityKey` is not this wallet's identity key
- the proof is expired, or `expiresAt` is further ahead than `validityWindow + clockSkew`
- the request uses `hashToDirectlySign` or `privileged`
- the request uses the withdrawn HandCash recipe (`[2, "wallet identity proof"]`)

The approval prompt shows `action` and states that signing cannot spend.

## App verification

Verification is the app backend's job. Use BRC-100 `verifySignature`, or
`@bsv/auth` `verifyAuthProof` against a BRC-100 wallet. After the signature
checks, record `nonce` with an atomic insert-if-not-exists until `expiresAt`.
A per-process map is only valid for one long-lived instance.

There is no identity registry. Store the public `identityKey` only. Do not
treat the proof as spend authority.

An ongoing mutual session, when required, is BRC-103. Do not stretch BRC-138
into a session.

## TypeScript request example

```ts
const bridge = 'https://127.0.0.1:2121'
const protocolID = [2, 'bsv auth proof'] as const
const verifierKey = '<verifier identity key from the app backend>'

async function walletCall<T>(method: string, args: unknown): Promise<T> {
  const response = await fetch(`${bridge}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      originator: window.location.host,
    },
    body: JSON.stringify(args),
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<T>
}

await walletCall('waitForAuthentication', {})
const { publicKey: identityKey } = await walletCall<{ publicKey: string }>(
  'getPublicKey',
  { identityKey: true },
)

const expiresAt = Date.now() + 120_000
const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const statement = `login\n${identityKey}\n${expiresAt}\n${nonce}`
const { signature } = await walletCall<{ signature: number[] }>('createSignature', {
  protocolID,
  keyID: nonce,
  counterparty: verifierKey,
  data: Array.from(new TextEncoder().encode(statement)),
})

await fetch('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    data: { action: 'login', identityKey, expiresAt, nonce },
    signature,
  }),
})
```

The backend verifies that signature over the same statement with
`keyID = nonce` and `counterparty = identityKey`, then consumes the nonce.

## Multi-identity

Not implemented. A later wallet may select which identity key is the BRC-100
subject for an origin. That selection stays inside the wallet. Apps still call
the same three methods. There is no `actAs` parameter, no custom derivation
path, and no sync of private keys. Name-to-payment binding waits on the
published BRC-174 text.
