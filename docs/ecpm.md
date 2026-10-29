# ECPM (BRC-229)

The shared HandCash wallet core supports `@bsv/ecpm-permission-module` 0.1.3.
Desktop's HTTP bridge and Mobile's existing JSON/app-tab bridge keep using
BRC-100 `getPublicKey`; no new method or key-export capability is introduced.

```ts
const masked = await wallet.getPublicKey({
  protocolID: [2, `p ecpm apply ${pointHex} mental poker deal`],
  keyID: 'deck', counterparty: 'self'
})
const original = await wallet.getPublicKey({
  protocolID: [2, `p ecpm remove ${masked.publicKey} mental poker deal`],
  keyID: 'deck', counterparty: 'self'
})
```

The published module validates canonical lowercase compressed secp256k1 points,
isolates scalar derivation under `p ecpm <logical protocol>`, rejects identity
and `forSelf` requests, and implements only `getPublicKey`. Unsupported schemes
and other operations retain the existing reserved-key refusal. The bridge skips
its token-basket parser only for the exact implemented `getPublicKey` namespace;
ECPM never falls back to ordinary public-key derivation.

## Consent

Connect and identity-proof grants, Pay and Auto-pay do not authorize ECPM.
Levels 1/2 and all privileged calls use the existing Aeon action-approval queue
and permission-decision chart, on both platforms. All consent information fits
in its two detail rows. The five-minute grant covers **all key IDs**, points and
both operations for the same originator, logical protocol, security level and
key universe. Level 2 binds counterparties; level 1 covers all counterparties.
Privileged grants also bind the displayed reason. Level 0 ordinary derivation
is public under BRC-43 and requires no prompt. `seekPermission: false` never
opens a prompt and fails without an applicable grant.

The current selected runtime is checked before and after every operation and
privileged key retrieval. Lock, account/network/runtime replacement, permission
revocation and clearing the permission session dispose the modules and cancel
pending consent. Revoking one app conservatively clears all cached ECPM grants.
Dismissal/cancellation, no prompt subscriber, the 64-prompt limit and a two-minute
prompt deadline fail closed. No grant is persisted. Warm/background wallets
cannot answer ECPM requests.

Privileged support uses the engine's existing password/retrieval and retention
policy, after ECPM consent. The checked internal `getPrivilegedKey` adapter is
confined to trusted wallet code; hosts without it refuse privileged ECPM. Neither
it nor a private scalar is exported to apps. Re-run its real-engine regression
when upgrading the engine or module.

## Validation and Mobile pin

`npm run test:ecpm` checks an independent multiplication oracle, inverse removal,
ordinary-key compatibility, binary BRC-100, the production JSON handler,
malformed points/arguments, forbidden operations/schemes, origin/consent,
privileged retrieval, expiry, revocation and late account-switch/unlock refusal.
It uses synthetic keys and the hermetic suite's offline network stub.

Mobile consumes this implementation from its exact `ui-core-source.json` Desktop
SHA. Its matching PR updates that pin and tests the existing tab-channel payload
and error relay. Merge/retain the Desktop commit first; if it is rebased or
squashed, repin Mobile to the reviewed resulting SHA and repeat validation.
Builds and tests do not claim signed installer, physical-device or store release
acceptance. Versioning/publication remains the normal maintainer release step.

## Feature permission UX follow-up

The module now checks the trusted feature permission manager on every operation, including no-prompt probes. Non-financial declared app features may use one explicit BRC-116 group covering canonical ECPM and transcript scopes. Once, 30-minute memory session and remembered on-chain access are distinct choices. Payment and BRC-29 money-key approvals retain their existing separate guards. Protected keys receive per-request consent and the existing key-unlock policy.

Connected apps → Wallet feature access lists and revokes both active sessions and remembered DPACP records. Action Label grants explain applying a label versus reading all matching history; legacy broad grants retain both rights. Remembering or revoking a token discloses possible transaction/service fees. No database/archive format or BRC-100 wire migration is introduced.

The Desktop and Mobile renderer uses Aeon with lifetime choice owned by permissionDecisionMachine, and inventory operations owned by asyncActionMachine. Local build and tests cover scalar oracles, binary/JSON dispatch, 167 ECPM operations under one group, immediate revocation, label apply/read separation and financial-scope exclusion. The operator explicitly leaves the credential-dependent Jev UI review to HandCash maintainers; no review credential is present locally. No release tag or production installation is performed by this PR.
