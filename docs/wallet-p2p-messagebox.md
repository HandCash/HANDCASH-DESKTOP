# Wallet P2P + messagebox — architecture update

Status: **accepted direction** (2026-08-11). Implements vocabulary + phased work from the wallet I/O / remittance / messagebox review.

Related in-app charts: Settings → About → View statecharts → Wallet I/O, Coordinator, Sign / broadcast, Chain ingest, Messagebox.  
Canvas (session): `wallet-io-master.canvas.tsx` tabs Transit / Messages / What P2P means.

---

## 1. Vocabulary (SSoT)

### Peer-to-peer (HandCash meaning)

Counterparty can obtain **value or facts addressed to them** without a third party deciding **who owns what** or **what an item is**.

| Grade | Meaning | Examples |
|-------|---------|----------|
| **A — Chain custody** | Facts on a tx found via payee address/key | P2PKH BSV and 1Sat item tips |
| **B — Identity relay** | Store-and-forward to identityKey; operator must not decide meaning | BRC-33 messagebox (any host) |
| **C — Convenience oracle** | Display / resolve helpers; not custody authority | GorillaPool `/content`; handle resolve host |

Device peer `:3340` and BRC-39 are **same-identity** sync — not counterparty P2P.

### Remittance

| Term | Spec | Travels to counterparty? |
|------|------|---------------------------|
| **BRC-150 remittance** | `customInstructions.provenance` + `beefB64` | **No** — BRC-100 local basket metadata; cannot ride a P2PKH lock |

Item identity and authenticity use the BRC-150 offline tip→origin proof. There
is no on-chain latch companion. GorillaPool after origin is known is **media
CDN (grade C)**, not the custody or authenticity authority.

### Messagebox

Standard idea: **BRC-33 PeerServ** (send / list / ack), addressed via **BRC-169** resolve → identity key + **messagebox URL**.

**BRC-CLOUD `/v1/messagebox` is a HandCash convenience host**, not the definition of messaging. Custody (A) must never require it.

Installs of one vault move accounts **device to device** (draft BRC-249). Each unlocked install keeps a **vault link** to the others: a BRC-246 session (`webrtpay/1`) on the vault identity (account 0), signalled in box **`vault-link`** (never `webrtpay_messages`, so chat sessions never answer it). The signed `release-request` / `release-accept` ride the link. Box **`account-holding`** on the account's own key carries them only when no link opens or a frame is not acked, and always carries `handover` parts sealed to self, so they wait for an offline holder. None of this is counterparty P2P, and it never gates a payment. A request that cannot reach the holder by either path fails the move, and nobody is asked to confirm one. Only the install holding an account acknowledges that account's messages.

### Dev keys (not a messagebox client)

Connected apps → Developer keys (the `</>` button) lists them. Each is created with the capabilities
ticked: **Sign**, **Wallet**, or both.

- **Sign**: the key is the presented identity's current BAP key
  (`identity-<seq>` under `[1,'sigma']`). BAP has one current signing key per
  identity, so one dev key at a time can sign; rotating on Identity retires it.
  The root (`identity-0`) never leaves the wallet.
- **Wallet**: a stock BRC-100 Toolbox wallet the server runs from that key. A
  key without Sign is derived from the account root
  (`[2, 'handcash server wallet']`, keyID = key number, counterparty `self`).

"Copy" gives the server the BSVA template env:

```
SERVER_PRIVATE_KEY=<hex>
WALLET_STORAGE_URL=https://storage.babbage.systems   # Wallet only
BSV_NETWORK=main
BAP_ID=<bapId>                                      # Sign only
```

HandCash opens the same key against the same storage, on this session's
services. Both see one set of outputs, so there is no report protocol and
nothing rides the messagebox. Settings shows money (basket `default`), items
(`1sat`) and tokens (distinct `bntft` asset ids).

- **Fund**: the payment approval prompt, then a BRC-29 payment to the key's
  identity and `internalizeAction` into its storage. Recorded first; a miss
  retries on the next read.
- **Recover**: the dev key's wallet pays this wallet by BRC-29, money only,
  and this wallet internalizes it. Items and tokens stay with the server.
- **Remove**: refused while the key still signs or its wallet holds anything.

---

## 2. Current vs target

| Concern | Today | Target |
|---------|-------|--------|
| BSV / item-tip custody | Grade A P2PKH | Keep |
| Item identity / authenticity | BRC-150 v2 offline tip→origin proof | Keep; fail closed when proof cannot be verified |
| BRC-150 remittance to peer | Inbox envelope `meta.provenance` + Atomic BEEF of this hop | Keep; receive verifies from the package. Indexer hydrate is C fallback for a slimmed origin body. Never gate chain custody on delivery |
| Chat delivery | Resolved peer **messagebox URL**; BRC-CLOUD fallback; live draft-BRC-246 WebRTC data channel when both wallets are online | Keep box as rendezvous (signalling box `webrtpay_messages`; direct payments in `webrtpay_signals`) + offline inbox; the channel is the hot path |
| Chat encryption | BRC-169 §7 envelope + BRC-78 content (legacy plaintext inbound still accepted) | Tolls / reachability policy; full Authrite Peer sessions |
| Pay-into-messagebox (BRC-29 remittance) | **Used for HandCash peers** — tip / pay-sent / Send-to-friend | `brc29SendMachine`: `createAction` broadcasts immediately (toolbox/Babbage). Remittance ± inline `beefB64` on `sendMessage` (not `/files`). Inbox miss → outbox retry, not a second tx. Inbox not ACKed until ingest. The payment output records `notice: pending` until a delivery marks it `delivered` (`paymentNotice.ts`); that rides BRC-39 and the handover delta, so a restored device or new holder re-sends exactly the notices still owed. The outbox never drops an owed notice: misses back off from 30 s to hourly, a row leaves only when the record says delivered or the payment failed, the flush re-reads the records every 10 min, and after 20 misses the payment's details show it stalled with **Notify now**. Because the BRC-39 push waits 45 s after a send, the notice is also journaled once the payment is sealed, before it propagates (`noticeJournal.ts`: payee, derivation, Atomic BEEF up to 64 KB), and replicated sealed beside BRC-39 as `notices.journal` within seconds; a delivery writes a tombstone, and a queued notice a tombstone settled — on any device — is dropped unsent and its stale record marked delivered. A device lost in that window leaves the notice for the next one, which can hand the payee a payment that never reached a miner. A restore that replaces localState reconciles before the next payment (`paymentReconcile.ts`): pull the journal, re-queue every owed notice, list in Activity any journaled payment the restored history lost; a foreground send waits for it at most 20 s, then sends anyway. A lost payment is resumed, never re-made: its journaled BEEF goes through `registerSignedSend` (inputs sealed before the hold lifts, same txid propagated), its notice waits for the miner verdict, and a proven reject settles the notice unsent; without a BEEF its Activity row stays pending until the chain shows it. A displaced install tombstones and pushes the notices of the payments it voids at handover before voiding them, so a holder never hands their BEEF to a payee. Activity marks a payment whose notice is still owed ("Notifying recipient…", "needs attention" once stalled). The payee keeps one card per payment output. |
| Item/token send | Plain P2PKH transaction + asset metadata | `signedSendLifecycle` owns the same durable miner/Arcade/BUMP relationship as BSV; `ItemSettlePath` only routes optional remittance/internalization |
| Plain identity-address P2PKH | Pasted address / external wallet only; nothing this wallet writes locks there (BRC-42/43: a BRC-100 wallet never signs with its identity key) | Address-index scan + `fundWalletFromP2PKHOutpoints` fallback (grade C) for outputs others or earlier releases sent |
| Inscription media | GP `/content/<origin>` | Keep as C; optional “fetch origin tx + parse” path when offline to GP |

---

## 3. Phased work

### Phase 0 — Documentation / agent SSoT (this update)

- [x] This doc  
- [x] Cursor rule `wallet-p2p-and-messagebox.mdc`  
- [x] `layers.ts` glossary clarification  
- [x] Statechart page **Messagebox** + Master link  
- [x] Canvas tabs (Transit / Messages / What P2P means)

### Phase 1 — Messagebox client: standard addressing (no product break)

1. [x] On handle resolve, **persist `messagebox` URL** from the resolve response (already returned by BRC-CLOUD).  
2. [x] `deliverOutbound` / `pollInbound` / `uploadChatFile` take **resolved box base URL**, defaulting to today’s BRC-CLOUD path when missing.  
3. [x] Friends / chat peers store `messagebox?: string` alongside identityKey.  
4. [x] Keep wire formats (`handcash-message:`) inside sealed envelopes so existing thread kinds still decode.
5. [x] Document remaining BRC-33 deltas (tolls, full Authrite Peer) in `messageTransport.ts`.

**Done when:** a friend whose resolve returns another box URL can receive chat without code pointing only at `brc-cloud…/v1/messagebox`.
### Phase 2 — BRC-CLOUD box: converge on PeerServ

1. [x] Align request/response shapes with BRC-33 (`status`, `sender`, `messageIds[]`).  
2. [x] Identity auth: `X-BRC33-*` everywhere; `X-BRC103-*` on BRC-CLOUD. Full **Authrite Peer** sessions still deferred.
3. [x] Keep `/files` as a HandCash extension; advertise auth mode on box manifest.  
4. [x] Resolve response already exposes `messagebox` — keep that as the federation hook.
5. [x] BRC-169 §7 / BRC-78 sealed content. Chat also rides a WebRTC data channel (draft BRC-246) when the pair is online: IPv4 behind NAT, same LAN or IPv6, from the WebView on Desktop and Mobile with no native socket. The box is still the offline inbox.

**Still deferred:** tolls/reachability policy, full Authrite Peer sessions + certificates, overlay catalog mirrors (BRC-230, parked).

**Public beta vs dropping BETA.** Encrypted friend chat is a product requirement and is implemented. Draft BRC-246 data channels, overlay catalog mirrors, and Authrite-complete sessions are protocol polish: they must not block a public-beta **wallet**. They should block dropping the BETA badge if the promise includes Authrite-complete federated messaging or in-wallet catalogs.

### Phase 3 — Robustness (from I/O map; pick in order)

1. Syncing UI tied to coordinator region end (not soft deadline alone).  
2. Bridge / device-peer heartbeats during permission prompts.  
3. Single-flight address scan shared by Refresh + monitor.  
4. Auto ordinal pass after spend yields `fundingOnly`.  
5. History Argon2 off UI thread (already deferred post-spend; finish the job).

### Phase 4 — Item send is fully verifiable P2P

- The sender attaches BRC-150 remittance on the same `sendMessage` as the hop’s Atomic BEEF (`notifyPeerItemIncoming`). Receive files that remittance against the held tip and verifies locally first.
- An item sent to an identity key locks to a fresh BRC-29 child of the payee (`planItemRecipientKey`, `itemRecipientKey.ts`); the notice carries the strings that derive it in `meta.asset.remittance` beside the BRC-150 provenance. A missed item notice waits in `pendingItemOutbox.ts`, keyed by txid and output, with the same remittance. The payee cannot find a child without it, so a lost notice costs the payee its key as well as provenance — the sender's outbox keeps it until delivered. The queue never drops a row: backoff grows to hourly, stalls are logged at 20 attempts, a flush merges its outcomes into the current list so a notice queued mid-flush is kept, and one flight runs per owner.
- Batch cards carry their exact output index. Receive merges every card sharing a
  txid before internalize, so each held output keeps its own name, origin, and
  BRC-150 remittance; the outbox likewise keys retries by txid + output index.
- Slimming a fat mint origin to txid-only is a **size** fallback so the package still travels. Fetching that origin from an indexer is grade C, not the reason send omitted the proof.
- Not a substitute for chain custody (A). Messagebox miss still retries the outbox; it does not create a second payment tx.

### Phase 5 — Handle trust (BRC-169)

A handle is a convenience name for an identity key (grade C). The wallet trusts the resolver's answer only as far as these checks go:

- [x] The resolve answer must echo the requested handle. A `$name@domain` the resolver does not serve is refused, not resolved on the default domain.
- [x] A saved friend pins the key (`friends.ts`, `HandleKeyChangedError`); a legacy friend whose handle is only its label pins it too. If the handle later resolves to another key, every recipient field (BSV, collectable, token, add friend) refuses as it resolves, and the send refuses again right before signing (`refuseBoundHandleConflict`, local, no resolve). Nothing redirects a pinned handle: a handle friend's key cannot be edited, device sync skips a friend that repoints it, and add friend refuses when the key changed after its preview. Accepting a new key means removing the friend after confirming the change with them another way.
- [x] Only a `404`/`410` from the resolver clears this device's claim. A network error keeps it.
- [x] BRC-CLOUD claims are first-writer-wins in one SQL statement (`handleClaimRow.js`). Re-claim by the same key and reclaim of a revoked handle still work.
- [x] Certifier-signed BRC-52 certificates (BRC-169 §4.1, Appendix A.3 field encoding), verified in the client against the certifier key pinned per domain in `handleCertificate.ts`. Resolve, reverse lookup and claim fail closed on a placeholder, wrong certifier, wrong subject, mismatched fields or bad signature. BRC-CLOUD signs with the `HANDLE_CERTIFIER_KEY` secret and re-signs older rows on first read.
- [x] `acquireCertificate` into the wallet (BRC-169 §4.6). The claim returns a subject-encrypted copy; the wallet holds exactly one current handle certificate and relinquishes the rest.
- [ ] On-chain revocation outpoints. Today the outpoint is null and the resolver's `404`/`410` is the revocation channel.
- [ ] Proof of key possession at claim, and single-use claim tickets.
- [ ] Handle release and forwarding, and a BAP `ALIAS` cross-link.

---

## 4. Non-goals

- Requiring messagebox for BSV or collectable **custody**.  
- Treating BRC-CLOUD as the only legal messagebox.  
- Calling BRC-150 remittance “what peers receive” in UI or docs.  
- Replacing BRC-33 with a raw socket. A WebRTC data channel (draft BRC-246) may upgrade a live pair after the box has carried a signed offer and answer. The box stays the rendezvous and the offline inbox. Custody stays on the chain.

---

## 5. Module map

| Concern | Module |
|---------|--------|
| Layers glossary | `HANDCASH-DESKTOP/src/wallet/layers.ts` |
| Item identity / remittance | `oneSatProvenance.ts` |
| Soft-latch | withdrawn (do not revive `oneSatLatch*`) |
| Chat transport | `messageTransport.ts` / `messageStore.ts` |
| Dev keys (sign and/or shared Toolbox storage, server-spent) | `devKeys.ts` / `serverWalletRecoverMachine.ts` |
| Handle + box URL | `handleResolve.ts` → BRC-CLOUD resolve |
| Account move (vault link, box `account-holding`) | `vaultLink.ts` / `accountRelease.ts` / `accountMove.ts` / `accountHandover.ts` |
| Box host | `BRC-CLOUD/src/worker.js` `handleMessagebox` |
| Charts | `appStatecharts.ts` |

---

## 6. Acceptance checks

- Soft-latch receive test: latch state names tip **without** GorillaPool.  
- Docs/agents: remittance ≠ latch state.  
- [x] After Phase 1: unit test that `deliverOutbound` posts to a non-default messagebox base from peer record.
