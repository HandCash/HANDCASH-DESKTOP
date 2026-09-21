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

---

## 2. Current vs target

| Concern | Today | Target |
|---------|-------|--------|
| BSV / item-tip custody | Grade A P2PKH | Keep |
| Item identity / authenticity | BRC-150 v2 offline tip→origin proof | Keep; fail closed when proof cannot be verified |
| BRC-150 remittance to peer | Inbox envelope `meta.provenance` + Atomic BEEF of this hop | Keep; receive verifies from the package. Indexer hydrate is C fallback for a slimmed origin body. Never gate chain custody on delivery |
| Chat delivery | Resolved peer **messagebox URL**; BRC-CLOUD fallback; live draft-BRC-246 IPv6 session when both wallets are reachable | Keep box as rendezvous + offline inbox; socket is the hot path |
| Chat encryption | BRC-169 §7 envelope + BRC-78 content (legacy plaintext inbound still accepted) | Tolls / reachability policy; full Authrite Peer sessions |
| Pay-into-messagebox (BRC-29 remittance) | **Used for HandCash peers** — tip / pay-sent / Send-to-friend | `brc29SendMachine`: `createAction` broadcasts immediately (toolbox/Babbage). Remittance ± inline `beefB64` on `sendMessage` (not `/files`). Inbox miss → outbox retry, not a second tx. Inbox not ACKed until ingest. |
| Item/token send | Plain P2PKH transaction + asset metadata | `signedSendLifecycle` owns the same durable miner/Arcade/BUMP relationship as BSV; `ItemSettlePath` only routes optional remittance/internalization |
| Plain identity-address P2PKH | Pasted address / external wallet only | Address-index scan + `fundWalletFromP2PKHOutpoints` fallback (grade C) |
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
5. [x] BRC-169 §7 / BRC-78 sealed content. Chat also rides a live IPv6 session (draft BRC-246) when the pair is hot (Desktop Electron and Mobile Capacitor). The box is still the offline inbox.

**Still deferred:** tolls/reachability policy, full Authrite Peer sessions + certificates, overlay catalog mirrors (BRC-230, parked).

**Public beta vs dropping BETA.** Encrypted friend chat is a product requirement and is implemented. Draft BRC-246 sockets, overlay catalog mirrors, and Authrite-complete sessions are protocol polish: they must not block a public-beta **wallet**. They should block dropping the BETA badge if the promise includes Authrite-complete federated messaging or in-wallet catalogs.

### Phase 3 — Robustness (from I/O map; pick in order)

1. Syncing UI tied to coordinator region end (not soft deadline alone).  
2. Bridge / device-peer heartbeats during permission prompts.  
3. Single-flight address scan shared by Refresh + monitor.  
4. Auto ordinal pass after spend yields `fundingOnly`.  
5. History Argon2 off UI thread (already deferred post-spend; finish the job).

### Phase 4 — Item send is fully verifiable P2P

- The sender attaches BRC-150 remittance on the same `sendMessage` as the hop’s Atomic BEEF (`notifyPeerItemIncoming`). Receive files that remittance against the held tip and verifies locally first.
- Batch cards carry their exact output index. Receive merges every card sharing a
  txid before internalize, so each held output keeps its own name, origin, and
  BRC-150 remittance; the outbox likewise keys retries by txid + output index.
- Slimming a fat mint origin to txid-only is a **size** fallback so the package still travels. Fetching that origin from an indexer is grade C, not the reason send omitted the proof.
- Not a substitute for chain custody (A). Messagebox miss still retries the outbox; it does not create a second payment tx.

---

## 4. Non-goals

- Requiring messagebox for BSV or collectable **custody**.  
- Treating BRC-CLOUD as the only legal messagebox.  
- Calling BRC-150 remittance “what peers receive” in UI or docs.  
- Replacing BRC-33 with a raw socket. A signed IPv6 session (draft BRC-246) may upgrade a live pair after the box has exchanged a short-lived offer. The box stays the rendezvous and the offline inbox. Custody stays on the chain.

---

## 5. Module map

| Concern | Module |
|---------|--------|
| Layers glossary | `HANDCASH-DESKTOP/src/wallet/layers.ts` |
| Item identity / remittance | `oneSatProvenance.ts` |
| Soft-latch | withdrawn (do not revive `oneSatLatch*`) |
| Chat transport | `messageTransport.ts` / `messageStore.ts` |
| Handle + box URL | `handleResolve.ts` → BRC-CLOUD resolve |
| Box host | `BRC-CLOUD/src/worker.js` `handleMessagebox` |
| Charts | `appStatecharts.ts` |

---

## 6. Acceptance checks

- Soft-latch receive test: latch state names tip **without** GorillaPool.  
- Docs/agents: remittance ≠ latch state.  
- [x] After Phase 1: unit test that `deliverOutbound` posts to a non-default messagebox base from peer record.
