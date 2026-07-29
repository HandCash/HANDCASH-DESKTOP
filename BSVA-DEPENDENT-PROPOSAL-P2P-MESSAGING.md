# Dependent Proposal: Peer Messaging for BRC-100

**Status:** Draft for BSVA review  
**Depends on:** [BRC-100](https://brc.dev/100)  
**Date:** 2026-07-29

## Problem

BRC-100 defines how apps talk to wallets. It does not define how identity-key holders exchange messages with each other. Without a shared model, every app invents its own format, crypto, and delivery rules—breaking interoperability.

## Proposal

Define an **optional, dependent** messaging capability for BRC-100 wallets: peer communication addressed by identity keys, with end-to-end confidentiality and authenticity, discoverable via capability advertisement so non-supporting wallets remain unaffected.

## What Should Be Standardized

| Area | Intent |
|------|--------|
| Addressing | Recipients identified by identity key |
| Envelope | Common fields for version, parties, payload type, ciphertext, signature, time |
| Crypto baseline | Signed + encrypted end-to-end; plaintext never leaves the wallet boundary |
| Permissions | Messaging consent separate from payment/signing scopes |
| Capability | Optional advertise/discover so apps can degrade gracefully |
| Extensibility | Opaque payload types and metadata so apps can build chat, payment notes, contact exchange, etc. without forking the envelope |

Transport (relay, on-chain, hybrid), UI, contact books, and group/sync features are left to implementers unless BSVA later chooses to norm them.

## Non-goals (v1)

Mandating a specific transport, on-chain encoding, media formats, or multi-device sync.

## Ask of BSVA

1. Confirm interest in a dependent messaging BRC (or equivalent).
2. Advise desired breadth: envelope-only vs envelope + minimal wallet methods.
3. Advise naming (capability / permission / document ID) and process for a full draft.
