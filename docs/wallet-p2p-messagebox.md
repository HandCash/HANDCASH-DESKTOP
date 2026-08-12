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
| **A — Chain custody** | Facts on a tx found via payee address/key | P2PKH sats; soft-latch tip + 2-sat latch + OP_RETURN latch state |
| **B — Identity relay** | Store-and-forward to identityKey; operator must not decide meaning | BRC-33 messagebox (any host) |
| **C — Convenience oracle** | Display / resolve helpers; not custody authority | GorillaPool `/content`; handle resolve host |

Device peer `:3340` and BRC-39 are **same-identity** sync — not counterparty P2P.

### Remittance vs latch state (do not conflate)

| Term | Spec | Travels to counterparty? |
|------|------|---------------------------|
| **BRC-150 remittance** | `customInstructions.provenance` + `beefB64` | **No** — BRC-100 local basket metadata; cannot ride a P2PKH lock |
| **Soft-latch state** (legacy `BRC156` marker) | `OP_FALSE OP_RETURN BRC156 <json>` on settle | **Yes** — P2P item identity (origin, name, app, mime, tip ref); BRC-156 withdrawn |

Soft-latch exists so **item naming/discovery does not need an indexer**. Sender still builds remittance locally; receiver rebuilds authenticity from chain BEEF later. GorillaPool after origin is known is **media CDN (grade C)**, not tip discovery.

### Messagebox

Standard idea: **BRC-33 PeerServ** (send / list / ack), addressed via **BRC-169** resolve → identity key + **messagebox URL**.

**BRC-CLOUD `/v1/messagebox` is a HandCash convenience host**, not the definition of messaging. Custody (A) must never require it.

---

## 2. Current vs target

| Concern | Today | Target |
|---------|-------|--------|
| BSV / soft-latch custody + latch identity | Grade A | Keep |
| Solo / unlatched 1-sat identity | Often grade C | Prefer latch on all HandCash sends; solo remains legacy |
| BRC-150 remittance to peer | Local only | Optional later: Outpoint BEEF / messagebox envelope (B) — not required for soft-latch identity |
| Chat delivery | Hardcoded BRC-CLOUD box; plaintext + `handcash-message:` cards; no BRC-31 auth; custom `/files` | Resolve recipient **messagebox URL**; BRC-33-shaped client; BRC-CLOUD remains default fallback host |
| Chat encryption | Plain body | Move toward BRC-169 encrypted envelope content |
| Pay-into-messagebox (BRC-29 remittance) | **Used for HandCash peers** — tip / pay-sent / Send-to-friend | Remittance (prefix/suffix + txid) in chat card → `internalizeAction` wallet payment; BEEF via SPV by txid (box 16KB limit) |
| Plain identity-address P2PKH | Pasted address / external wallet only | Address-index scan + `fundWalletFromP2PKHOutpoints` fallback |
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
4. [x] Keep wire formats (`handcash-message:`) for now so existing threads work.  
5. [x] Document BRC-33 deltas we still violate (auth, ack shape, encrypted content) in `messageTransport.ts`.

**Done when:** a friend whose resolve returns another box URL can receive chat without code pointing only at `brc-cloud…/v1/messagebox`.
### Phase 2 — BRC-CLOUD box: converge on PeerServ

1. [x] Align request/response shapes with BRC-33 (`status`, `sender`, `messageIds[]`).  
2. [x] Interim identity auth (ECDSA headers) — full **BRC-103/104** still deferred.  
3. [x] Keep `/files` as a HandCash extension; advertise auth mode on box manifest.  
4. [x] Resolve response already exposes `messagebox` — keep that as the federation hook.

**Still deferred:** BRC-169 §7 encrypted envelopes, tolls/reachability policy, BRC-103/104 mutual Authrite.

### Phase 3 — Robustness (from I/O map; pick in order)

1. Syncing UI tied to coordinator region end (not soft deadline alone).  
2. Bridge / device-peer heartbeats during permission prompts.  
3. Single-flight address scan shared by Refresh + monitor.  
4. Auto ordinal pass after spend yields `fundingOnly`.  
5. History Argon2 off UI thread (already deferred post-spend; finish the job).

### Phase 4 — Optional richer P2P proofs (only if product needs)

- Ship authenticity package via messagebox or BRC-158 Outpoint BEEF so cold receive can verify without re-walking SPV.  
- Not a substitute for latch state identity.

---

## 4. Non-goals

- Requiring messagebox for BSV or collectable **custody**.  
- Treating BRC-CLOUD as the only legal messagebox.  
- Calling BRC-150 remittance “what peers receive” in UI or docs.  
- Direct stranger device↔device sockets (NAT); BRC-33 exists because of that.

---

## 5. Module map

| Concern | Module |
|---------|--------|
| Layers glossary | `HANDCASH-DESKTOP/src/wallet/layers.ts` |
| Latch state (P2P identity) | `oneSatLatch.ts` |
| Remittance (local proof) | `oneSatProvenance.ts` |
| Soft-latch receive | `oneSatImport.ts` / `ingestLegacyAddress.ts` |
| Chat transport | `messageTransport.ts` / `messageStore.ts` |
| Handle + box URL | `handleResolve.ts` → BRC-CLOUD resolve |
| Box host | `BRC-CLOUD/src/worker.js` `handleMessagebox` |
| Charts | `appStatecharts.ts` |

---

## 6. Acceptance checks

- Soft-latch receive test: latch state names tip **without** GorillaPool.  
- Docs/agents: remittance ≠ latch state.  
- [x] After Phase 1: unit test that `deliverOutbound` posts to a non-default messagebox base from peer record.
