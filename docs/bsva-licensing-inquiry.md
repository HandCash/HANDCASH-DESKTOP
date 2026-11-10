# Licensing inquiry to BSV Association: multichain wallet using BSV SDK

DRAFT for counsel review before sending. Not legal advice. Bracketed items need filling in.

To: BSV Association, licensing / legal [contact]
From: [company, contact name, role, email]
Date: [date]
Re: Use of Open BSV licensed software in a wallet that also supports other coins

## 1. Who we are and what we ask

We build HandCash Desktop and HandCash Mobile, wallet applications that share one UI package. We are adding support for coins other than BSV (BTC, LTC, BCH, DOGE and a USD stablecoin) and want to stay inside the Open BSV License. We ask for written answers to the questions in section 5, and for confirmation of the licence version that applies to each component in section 3.

## 2. What we intend to do

- Keep the BSV SDK and wallet engine for BSV only: BSV keys, transactions, BEEF and BSV payments.
- Implement every other coin with separate MIT-licensed libraries (noble curves and hashes). The non-BSV modules do not import the BSV SDK or wallet engine. A repository test enforces this; the one exception is the BSV leg of a cross-chain swap.
- Keep the upstream copyright notices and licence texts with everything we ship.

## 3. Facts we can state (and what we have not verified)

| Item | State |
| --- | --- |
| BSV SDK (`@bsv/sdk`) | Desktop lock: 2.8.11. Mobile lock: 2.8.1. |
| Wallet engine | Vendored in `packages/wallet-engine`; notes cite Open BSV v6 and older v4 wallet grants. |
| Application manifest | `package.json` declares "Open BSV License"; there is no root LICENSE or NOTICE file yet. |
| Missing notices | `packages/wallet-engine/THIRD_PARTY_NOTICES.md` references historical licence texts that are not in our tree. We will restore them byte-identical from the upstream snapshot and ask you to confirm the source. |
| Shipped builds | We have not yet inspected the exact bytes of our Desktop and Mobile release artifacts. |
| Past releases | Earlier public builds exist; we have not mapped which licence version each used. |

## 4. Shared code we want you to consider

A single app contains both BSV and non-BSV coins. Code shared across coins includes: key custody and storage, identity and handles, transport and messaging, the UI, and the swap engine. We believe the non-BSV coin modules contain no covered code, but we want your view on whether bundling and shared custody alone is a "use" of covered software on non-BSV chains.

## 5. Questions

1. Does an application that bundles the SDK and uses it only for BSV operations, while handling other coins through independent code, satisfy the BSV-only condition?
2. Does the answer change if the covered code is in the same binary, the same process, or shares a key store with the non-BSV code?
3. Is code that only calls the SDK's public API (for example, to build a BSV transaction) treated as a derivative work? Which of our files would you treat as derivatives?
4. Which licence version governs each of: the SDK versions above, the vendored wallet engine, and the historical v4 wallet grants? Can you supply the canonical texts and hashes?
5. For a cross-chain atomic swap where one leg is on BSV and the other on another chain, is the BSV-side use permitted, and is the other-chain side outside the licence?
6. Do the Network Access Rules apply to a wallet in this configuration? If so, which parts?
7. Would you issue a written confirmation or exception covering the design in section 2? If conditions apply, what are they?
8. For builds already released, is any remediation expected, and by when?
9. What attribution and notice format do you require in the app UI, installer and source repository?
10. Is there a contact or process for future changes, so we can ask before shipping rather than after?

## 6. What we will do while waiting

We will keep the BSV boundary enforced in tests, restore the missing notice files, add a root LICENSE/NOTICE that retains all upstream grants, and avoid describing the product as licence-cleared until we receive your answer.

## 7. Attachments to include

- Import-boundary test: `src/wallet/primitives/bsvBoundary.test.ts`
- `docs/restricted-component-replacement.md`
- `packages/wallet-engine/THIRD_PARTY_NOTICES.md`
- Dependency list for the SDK versions above
