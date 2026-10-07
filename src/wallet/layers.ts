import { getActiveWallet } from './session'

/**
 * Wallet layers — HandCash Desktop SSoT for how funds exist on a device.
 *
 * Do not treat these as one “sync”. Refresh, Backup, and Restore are different layers.
 *
 * ```
 * custody        vault keys (BRC-75 / BRC-140) — durable, origin-independent
 * localState     toolbox IndexedDB — managed change, baskets, remittance / customInstructions
 * chainIngest    network → localState (spendable review + legacy P2PKH + 1sat import)
 * historyReplica BRC-39 blob — replica of localState for recovery / multi-device
 *              + write-once on-device archive under userData/brc39-archive (never overwritten)
 * balanceView    what UI shows: owned cash = spendable managed change
 *                + unconfirmed change of live local sends (never payment outs,
 *                never 1sat / bsv21). See `balanceView.ts`.
 *                Activity is the same kind of view: stored annotations over
 *                the localState transaction table (`activityLedger.ts`).
 * health         chain ingest health ⊕ history replica health ⊕ bridge
 * coordinator    walletCoordinatorMachine — legal overlaps between layers (UTXO safety)
 * runtime        one account instance + namespace + generation + abort signal;
 *                every feature cache/queue/lease is owned by this boundary
 * ```
 *
 * Glossary:
 * - **Wallet runtime** → the sole account feature root (`walletRuntime.ts`).
 *   Switch/lock aborts and disposes it before another account is published.
 * - **Account unit** → one vault account's Toolbox IndexedDB + services +
 *   monitor (`walletPool.ts`). Units share no mutable state, so they run side
 *   by side: a switch selects a warm unit instead of rebuilding one, and an
 *   unselected unit's monitor keeps proving its own transactions. Only the
 *   selected unit binds the ambient account scope; anything that outlives a
 *   switch resolves keys from its captured owner (`accountLocalKeyFor`).
 * - **Backup scope** → policy is vault-wide (`vaultLocalKeys.ts`): the key
 *   backup, the BRC-39 host and the "history backed up" confirmation do not
 *   change between sub-accounts. State is per account, because each account
 *   has its own blob at `/v1/wallets/<identityKey>/wallet.brc39`: last upload,
 *   last error, the spend-down high-water and the crash watchdog.
 * - **Dev keys** → keys handed to a developer's server (`devKeys.ts`), each
 *   generated with Sign, Wallet or both. Sign = the presented identity's
 *   current BAP key (one key at a time; rotation retires it). Wallet = a stock
 *   BRC-100 Toolbox wallet the server runs from that key; this wallet opens
 *   the same key against the same remote storage, so both read one set of
 *   outputs. Outside localState: never in the balance, never swept by
 *   Refresh. Fund = approved BRC-29 internalized into its storage; Recover =
 *   it pays this wallet by BRC-29, money only (`serverWalletRecoverMachine`).
 *   Items and tokens are counted, not moved.
 * - **Refresh** → `chainIngest` only (`refreshFromChain`). Finder of coins
 *   not yet in localState. Does not pull BRC-39. Does not reclassify a live
 *   unconfirmed cheque as dead because an indexer has not listed it.
 * - **Header digest** → local block headers (`blockHeaders.ts`, Arcade
 *   go-chaintracks, `chainTrackerFallback`) + `chainProofKind`. Mined txs
 *   verify merkle-to-header (`spvFinality`). Unconfirmed txs are a different
 *   kind: chain them only with ancestor bodies in the BEEF.
 * - **Indexer role** → Finder, never Judge. May add a coin this device cannot
 *   yet prove. Must not reclassify, detach, or prune a cheque the local BEEF
 *   / headers still prove. Explorer 404 is silence, not cancel.
 * - **Key discipline** → identity / receive may be a stable key (handle,
 *   BRC-29). Managed change is derived per `createAction` and is not that
 *   identity address reused as the only change key.
 * - **Settlement kinds** → signed Atomic BEEF is already a cheque
 *   (`unconfirmed`). `headerProven` is inclusion. Pay `pendingChange` is
 *   unconfirmed SPV we own, not a processor queue. Arcade accept is cashing
 *   started, not landed — the landing watch closes it.
 * - **Activity** → a view, not a record. Its base is the Toolbox transaction
 *   table read live (`activityLedger.ts`), which the BRC-39 replica already
 *   carries; stored rows (`appActivity.ts`) add only what the table cannot
 *   say — app, item identity, pending/failed sends, events. One transaction
 *   may be several activities (a send to yourself, a batch). Storage pressure
 *   sheds rows the table still shows first; wallet logic reads stored rows
 *   only (`listRecentActivity`), display reads the view (`listActivityFeed`).
 * - **Holdings** → the token and item lists are projections of baskets
 *   `bsv21` / `1sat`, read only while every coordinator region is idle and
 *   only when the read is the whole basket. Each disagreement with the chain
 *   — a listed output that left the basket, a basket row the address scan
 *   omits — is filed durably in `holdingsReconcile.ts` and settled by one
 *   chain answer per backoff step: spent closes or retires, unspent restores
 *   or re-claims, unknown waits. Nothing leaves silently.
 * - **History backup / Sync devices** → `historyReplica` (`deviceSync` / `historyBackup`).
 * - **Device backup** → known recovery peer + optional one-way sealed recovery
 *   (`deviceWallets` / `deviceKeyBackup`). Different keys remain different identities;
 *   reciprocal recovery is refused so compromise of one device does not expose both wallets.
 * - **Recompose** → historyReplica then chainIngest (`recomposeWallet`) — restore a device.
 *   Spends wait out the history decision; the funding pass after an unchanged
 *   localState is ordinary chainIngest, and only a replaced one stays fenced.
 * - **Legacy address** → receive P2PKH UTXOs not yet swept into managed change.
 * - **Managed change / P2P outs** → live only in `localState` until exported via BRC-39.
 *   Each change lock is derived from a random BRC-29 prefix/suffix that the
 *   seed cannot regenerate. Change scripts are rebuilt from those keys
 *   (`changeScriptFate.derivedLockingScript`), never guessed from an address.
 * - **Custody journal** (`custodyJournal.ts`) → how to spend every output this
 *   wallet ever controlled, outside `localState`. Each entry is exactly an
 *   `internalizeAction` output spec (`wallet payment` prefix/suffix/sender, or
 *   `basket insertion` basket/replayable customInstructions/tags), immutable
 *   and content-addressed; a `spent` entry is written only on chain evidence,
 *   `released` only by a user relinquish (and never retires a wallet payment).
 *   Copies merge by set union and are named by a root hash, so no replica is
 *   ever thinner than another. Capture wraps the wallet's own `createAction` /
 *   `signAction` / `internalizeAction` (`custodyJournalCapture.ts`) — every
 *   output is journaled before the call returns, ahead of propagation — plus a
 *   full sweep before any wipe or History replace. It survives factory wipe,
 *   replicates sealed (HKDF root key, AES-GCM) beside BRC-39 as
 *   `custody.journal` with conditional writes (`custodyJournalBackup.ts`), and
 *   after every recompose `custodyJournalRecovery.ts` re-internalizes each
 *   journaled output the chain says is unspent and `localState` has no row for.
 *   `derivedChangeEcho.ts` is the legacy capped copy; it feeds the journal.
 * - **Items (1sat / recursive)** → basket `1sat` in `localState`.
 *   - **BRC-150 remittance** (`oneSatProvenance.ts`) — tip→origin proof in
 *     `customInstructions`; **wallet-local**, does not ride a P2PKH lock to peers.
 *     This is the *only* item authenticity/identity model — there is no on-chain
 *     latch companion (BRC-156 was withdrawn and fully removed).
 *   - **Item art** (`localItemArt.ts`) — the picture comes from bytes the device
 *     already holds: the mint's own `createAction`, an unmoved tip's ord
 *     envelope, the peer's BRC-150 remittance BEEF, or the origin tx in managed
 *     storage. GorillaPool `/content/` is the last resort for an origin whose
 *     bytes never reached us (a legacy-address sweep), never how a fresh mint
 *     first paints — a just-signed transaction is in no indexer yet.
 *   - **Issuer identity** (`issuerIdentity.ts`, draft BRC-248 beside BRC-247) —
 *     a BAP identity: 0-sat AIP-signed ID records form a rotating key chain, the
 *     ALIAS is the profile, the image is a B:// file. Nothing is an ordinal.
 *     The wallet's own tree sits in basket `bap` as 1Sat wallets keep it;
 *     imported masters in `bap issuer`. Assets name the BAP ID inside their
 *     Sigma-signed tape, signed by the then-active key. The package (a minimal
 *     BEEF of the chain, ALIAS and image) is stored once per BAP ID
 *     (`issuerIdentities.ts`) and rides an item delivery as `meta.identities`
 *     only when it fits after the custody BEEF and item provenance. It never
 *     gates ingest or ACK.
 *   - **Self-send** keeps the settle Atomic BEEF locally (`beefCache`) so the next
 *     spend does not wait on an indexer.
 *     Failed sends must not ghost-relinquish the tip (that burned 1-sats).
 *   - **Item/token P2P settle** (`signedSendLifecycle.ts` +
 *     `itemSettlePath.ts`): assets are data over the same signed Bitcoin
 *     transaction lifecycle as BSV. Signing seals inputs and starts the durable
 *     miner/Arcade + BUMP path. `peerDeliver`, `selfReceive`, and
 *     `externalBroadcast` classify only metadata delivery/internalization; a
 *     messagebox miss never changes transaction propagation or creates a second
 *     spend. Remittance ± inline BEEF rides `sendMessage`. A live pair
 *     may skip the box for that session after a signed IPv6 offer (draft
 *     BRC-246, `directSession/`). The box stays the rendezvous and the offline inbox.
 *   - **1Sat market** (`marketListing.ts` + `marketSettlement.ts`): listing
 *     spends the tip into a re-tipped item + BRC-48 offer. Settlement is one
 *     atomic tx (item0 + offer1). Abort is forbidden after `signAction`; a later
 *     Refresh or send must not abort that nosend or overwrite the signed BEEF.
 *     Seller internalizes proceeds and retires baskets before ACK. Merkle skip
 *     is only the internal visible-P2PKH sweep scope — never a BRC-100 label.
 *   - Oversized remittance packages are omitted (fail unproven), never truncated.
 * - **Messagebox** → BRC-33 store-and-forward by identity key (chat/notify). Optional;
 *   not custody. Bodies are BRC-169 §7 / BRC-78 envelopes. A live draft-BRC-246
 *   IPv6 session carries the same sealed chat and skips the box for that message
 *   (Desktop Electron and Android Capacitor). BRC-CLOUD hosts a convenience box;
 *   resolve may return any box URL.
 * - **BRC-100 app exchange** — the signed Atomic BEEF (+ remittance) *is* the
 *   payment. SPV is primary; broadcast is how we cash it (required, secondary).
 *   The device must keep the header store and the full body of every
 *   unconfirmed local tx. `chainProofKind.ts`: a locally SPV-valid signed
 *   transaction is a cheque (`unconfirmed` while no header covers it;
 *   `headerProven` after BUMP vs local headers). Account the cheque at sign.
 *   Explorer / Arcade `/txs` / Bitails `/spent` / indexer `isUtxo` are rumours
 *   — latency, not a cancel. Undo only on a proven competing spend. Arcade
 *   `postBeef` is a miner cashing the cheque plus a reject oracle; its 202 is
 *   a queue receipt, so `arcadeLanding.ts` follows each accepted cheque until
 *   a node holds it and fails it only on proof (a node's reject — Arcade 466
 *   names the spender — an input another tx spends, a dead parent). Arcade's
 *   own give-up after its retry budget is silence, not a reject. Every
 *   signature — app reply, send, item, market, token, sweep, consolidation —
 *   passes `inputCertainty.ts`, installed on the toolbox instance at boot:
 *   each coin is proven unspent (a Teranode node's `/utxos` or WhatsOnChain
 *   cleared it — a spender either names wins — or it is change of a tx this
 *   wallet certified or a node already holds — `spendCertainty.ts`);
 *   unanswered coins refuse, and `signAction` is judged before it signs. The
 *   one spender the ledger cannot see is this key on another install:
 *   `peerDeviceSpends.ts` reads that install's BRC-39 upload as evidence
 *   (decrypt in the worker, never import — historyReplica stays separate
 *   from signing) and retires the coins it spent. Before any
 *   post, `spvPackage.ts` runs full SPV (scripts, amounts, proofs vs headers):
 *   incomplete packages wait in the outbox, invalid ones are never sent.
 *   Incoming packages are credited before any miner sees them, so
 *   `incomingFinality.ts` refuses one whose unmined txs are not final
 *   (BRC-67 step 4 — the SDK and toolbox check neither lock time nor sequence). A
 *   signed tx that was posted or queued keeps its seal — releasing its inputs
 *   is only for a body that never left this device. Heal
 *   fetching a raw tx restores a lost locking-script projection; it does not
 *   ask the network whether the cheque happened. Dependent economic activity
 *   chains unconfirmed UTXOs (parent bodies in the BEEF) so the next hop
 *   does not wait on ack. Proven miner reject / double-spend must rewrite
 *   Activity and seals as soon as that fact exists (zero economic loss).
 *   Unconfirmed spends must carry parent *bodies* (`mergeLocalUnconfirmedAncestry`);
 *   mined spends ride merkle paths against headers (`blockHeaders` /
 *   `chainTrackerFallback`). Keep posting until merkle proofs close. The merge
 *   is an outbound boundary:
 *   miner posts, BRC-33 item/payment/market wires, BRC-100 createAction
 *   responses, token transfers, and legacy/phrase sweeps all use it.
 * - **Peer BSV pay (BRC-29)** → `brc29SettlePath` + `brc29SendMachine`. Sender
 *   `createAction` broadcasts immediately (Babbage / toolbox). Remittance
 *   (± inline Atomic BEEF) then goes on `sendMessage`. Inbox miss → local
 *   outbox retry, never a second payment. Inbox is not ACKed until ingest
 *   succeeds. Same-identity still notifies our box so other devices ingest.
 *   `/files` is not the payment path (Android WebView). Plain address P2PKH
 *   remains for external/pasted addresses (`sendPayment.ts` + `bsvSendMachine`).
 * - **Dual-layer confirmation** → `txLifecycle` / `utxoLockManager` /
 *   `dualLayerSend` / `txReconcile`. Optimistic soft-locks + ARC status sit
 *   beside settle-path machines; hard finality is MINED only after SPV-verified
 *   BUMP. Overlay uses BRC-38 `spendable` / `spentBy` so coins are hidden
 *   without deleting toolbox rows (`lockOwnerId` is a local send reservation).
 *   UTXO writes follow Cloud's lesson: revert or restore a local tx, adopt a
 *   named spender, or quarantine until that spender can be inserted — never
 *   invent a competing spend by editing the UTXO set directly. Reservations
 *   expire; quarantine is not thawed on a timer.
 *   Refresh never asks the indexer `isUtxo` to resurrect coins — only change of
 *   a live local tx is restored, and inputs of those txs are re-hidden.
 *   Never treat HTTP 200 / postBeef accept as mined. Activity never drops a signed send
 *   until every one of its inputs is spent on chain — clearing history is not a
 *   cancel, and it keeps that tx's change.
 * - **Chained unconfirmed change** — spending change from a prior local send
 *   before it confirms on-chain. SPV for the child is the parent bodies this
 *   wallet already signed (`mergeLocalUnconfirmedAncestry`); merkle proofs of
 *   those parents cannot exist yet. `balanceView` credits pending change for
 *   display; `spendGuard.promoteSpendableChange` (reclaim sealed →
 *   `promotePendingLocalChangeOutputs` → script sweep →
 *   `staleOutputRelease.restoreLiveSpendableOutputs`)
 *   mark live change spendable for the next pay. `runExclusiveSpend` serializes
 *   sends so chains do not double-spend. Activity clear uses the lightweight
 *   `releaseUnsignedSpendReservations` path — not the full change-script sweep.
 * - **Change consolidation** → `changeConsolidationPath` (tagged-union decision) +
 *   `consolidateChange`. Many small BRC-29 receives fragment the managed-change
 *   pool and slow `createAction` coin selection. A rate-limited background pass
 *   collapses spendable change into one UTXO via a self-payment using the toolbox
 *   `maxPossibleSatoshis` output (same primitive as `Wallet.sweepTo`, aimed at
 *   self). It runs in the exclusive spend region so it never races a send, yields
 *   when a spend is waiting, and only ever selects change — assets (`1sat`,
 *   `bsv21`) live in their own baskets and are never touched.
 * - **Tokens (fungible)** → BRC-162 binary in basket `bsv21` (BRC-163 remittance).
 *   Balance = Σ `amt` per tip. Transfers spend 162 inputs and create payee (+ change)
 *   162 outputs with conserved amount; subject BEEF via BRC-176. See `token/`.
 *   The envelope carries the token-parent bodies back to the deploy as
 *   `meta.tokenLineage` (the BSV-21 twin of BRC-150 remittance), so the payee
 *   proves offline. It keeps the deploy (`token/genesisStore.ts`), which holds
 *   the issuer's Sigma, and files which tips reached it (`token/lineage.ts`).
 *   A tip is issuer-attested only when it is the deploy or a recorded walk
 *   bound it there; naming a token id is not enough.
 *   Legacy JSON BSV-21 rows may remain visible read-only; native JSON send is retired.
 * - **Asset burn** → `burnPlan` + `burnMachine` + `burn`.
 *   This is an explicit, irreversible spend — never local abandon and never a
 *   send/sweep fallback. A 1Sat burn ends tips (and BRC-150 origin when
 *   applicable). Only the resulting self BRC-29 wallet-payment internalize may
 *   move recovered physical sats into managed change / `balanceView`.
 */

import { fetchBalanceSats} from "./session";

/** Named layers — use in comments, health aggregates, and new APIs. */
export type WalletLayer =
  | "custody"
  | "localState"
  | "chainIngest"
  | "historyReplica"
  | "balanceView"
  | "health";

/** Canonical module map for agents and reviews. */
export const WALLET_LAYER_MODULES = {
  custody: ["vault.ts", "sessionBackupAuth.ts", "devKeys.ts"],
  localState: [
    "session.ts",
    "walletPool.ts",
    "collectables.ts",
    "token/index.ts",
    "token/types.ts",
    "token/decode162.ts",
    "token/list.ts",
    "token/listTips.ts",
    "token/send.ts",
    "token/sendEntry.ts",
    "token/sendPlan.ts",
    "token/burn.ts",
    "token/prove176.ts",
    "token/settle.ts",
    "token/issuer.ts",
    "retiredFungible.ts",
    "token/sendMachine.ts",
    "token/icons/cache.ts",
    "token/icons/resolve.ts",
    "token/marketView.ts",
    "burnPlan.ts",
    "burnMachine.ts",
    "burn.ts",
    "burnEconomics.ts",
    "brc100Handler.ts",
    "oneSatProvenance.ts",
    "authenticityMachine.ts",
    "collectableSendMachine.ts",
    "itemSendMachine.ts",
    "spendAttempt.ts",
    "itemSettlePath.ts",
    "ingestItemSettle.ts",
    "bsvSendMachine.ts",
    "brc29SettlePath.ts",
    "brc29SendMachine.ts",
    "collectableTipKind.ts",
    "collectableOwnershipFate.ts",
    "sentItemGuard.ts",
    "pendingSend.ts",
    "sendPayment.ts",
    "sendBrc29Payment.ts",
    "marketListing.ts",
    "marketListingPath.ts",
    "marketSettlement.ts",
    "marketSettlementPath.ts",
    "marketOverlayProtocol.ts",
    "marketOffer/index.ts",
    "spendVerdict/index.ts",
    "chainProbe/index.ts",
    "ingestPaymentByTxid.ts",
    "inscriptionCache.ts",
    "provenCache.ts",
    "txLifecycle.ts",
    "txLifecycleMachine.ts",
    "txStore.ts",
    "settlementCopy.ts",
    "utxoLifecycle.ts",
    "utxoLockManager.ts",
    "protocolValidate.ts",
    "arcStatusMap.ts",
    "spvFinality.ts",
    "dualLayerSend.ts",
  ],
  chainIngest: [
    "chainIngest.ts",
    "chainProofKind.ts",
    "blockHeaders.ts",
    "chainTrackerFallback.ts",
    "spvFinality.ts",
    "walletProgress.ts",
    "ingestLegacyAddress.ts",
    "legacyScan.ts",
    "legacySweepPath.ts",
    "legacyAssetScript.ts",
    "legacyStuckSweep.ts",
    "legacyReceiptActivity.ts",
    "ordinalMigratePath.ts",
    "changeConsolidationPath.ts",
    "consolidateChange.ts",
    "oneSatImport.ts",
    "asyncPool.ts",
    "legacyImportGuard.ts",
    "derivedChangeEcho.ts",
    "reimportDerivedChange.ts",
    "custodyJournal.ts",
    "custodyJournalCapture.ts",
    "custodyJournalRecovery.ts",
    "custodyJournalBackup.ts",
    "reclaimSealBatch.ts",
    "oneSatImportGuard.ts",
    "oneSatCollectableGuard.ts",
    "healMisfiledBsv21.ts",
    "healMisfiledCollectables.ts",
    "staleOutputRelease.ts",
    "holdingsReconcile.ts",
    "spendVerdict/index.ts",
    "chainProbe/index.ts",
    "txReconcile.ts",
  ],
  historyReplica: [
    "historyBackup.ts",
    "provenTxReqPurge.ts",
    "walletSetupApply.ts",
    "deviceSync.ts",
    "deviceWallets.ts",
    "deviceKeyBackup.ts",
    "phraseSweep.ts",
    "cloudBackupHealth.ts",
    "historyEmptyGuard.ts",
    "recompose.ts",
    "historyBackupPrefs.ts",
    "vaultLocalKeys.ts",
  ],
  balanceView: [
    "balanceView.ts",
    "session.ts#fetchBalanceSats",
    "layers.ts#inspectLocalToolboxState",
    "activityLedger.ts",
  ],
  health: [
    "walletHealth.ts",
    "walletProgress.ts",
    "cloudBackupHealth.ts",
    "backupStatus.ts",
    "walletRuntimeStatus.ts",
  ],
  coordinator: [
    "walletCoordinatorMachine.ts",
    "walletCoordinator.ts",
    "spendGuard.ts",
  ],
} as const satisfies Record<WalletLayer | "coordinator", readonly string[]>;

/**
 * Feature modules sit on top of layers. A layer answers *where money lives*;
 * a module answers *one capability* with a hard public surface:
 *
 * - `index.ts` — only exports other code may import
 * - tagged unions / path choosers (no boolean fallthrough)
 * - XState machine if the module mutates UTXOs
 * - tests that pin the public surface
 *
 * Template: `token/`. Callers import the module, never internals.
 */
export const WALLET_FEATURE_MODULES = {
  tokens: "token/index.ts",
  spendVerdict: "spendVerdict/index.ts",
  chainProbe: "chainProbe/index.ts",
  marketOffer: "marketOffer/index.ts",
  /** Import section: stored legacy wallets, scan, explicit compatible-only sweep. */
  legacyImport: "import/index.ts",
  uiFeed: "components/uiFeed/index.ts",
} as const;

/**
 * Composed recovery entry — prefer over calling history + chain separately.
 * Isolated from Refresh: do not call from Dashboard / spend paths.
 */
export const RECOMPOSE_MODULE = "recompose.ts" as const;

/** Empty-local × remote clobber predicate — unit-tested in isolation. */
export const HISTORY_EMPTY_GUARD_MODULE = "historyEmptyGuard.ts" as const;

/**
 * Snapshot of toolbox IndexedDB richness — not the same as spendable balance.
 * A fully spent wallet can still have actions + remittance metadata that BRC-39 must keep.
 */
export type LocalToolboxState = {
  spendableSats: number;
  defaultOutputCount: number;
  actionCount: number;
  /** True only when there is nothing worth restoring/pushing as history. */
  looksEmpty: boolean;
};

type ToolboxWallet = NonNullable<ReturnType<typeof getActiveWallet>>["wallet"];

async function countOutputs(wallet: ToolboxWallet, basket: string): Promise<number> {
  try {
    const result = await wallet.listOutputs({ basket, limit: 1 });
    if (Number.isFinite(result.totalOutputs))
      return Math.max(0, Math.trunc(result.totalOutputs));
    return result.outputs?.length ?? 0;
  } catch {
    return 0;
  }
}

async function countActions(wallet: ToolboxWallet): Promise<number> {
  try {
    const result = await wallet.listActions({ labels: [], limit: 1 });
    const total = (result as { totalActions?: number }).totalActions;
    if (Number.isFinite(total)) return Math.max(0, Math.trunc(total!));
    return (result as { actions?: unknown[] }).actions?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Inspect toolbox localState (IndexedDB). Prefer this over balance for BRC-39 empty checks. */
export async function inspectLocalToolboxState(): Promise<LocalToolboxState> {
  const active = getActiveWallet();
  if (!active) {
    return {
      spendableSats: 0,
      defaultOutputCount: 0,
      actionCount: 0,
      looksEmpty: true,
    };
  }

  // Item/token outputs from address scan alone are not historyReplica. After restore,
  // chain ingest can land item tips before BRC-39 pull — those outs must
  // not block empty-local recovery of spendable balance + TX history, so
  // baskets `1sat` / `bsv21` are never read here (thousands of fat rows).
  const [spendableSats, defaultOutputCount, actionCount] = await Promise.all([
    fetchBalanceSats(active.wallet).catch(() => 0),
    countOutputs(active.wallet, "default"),
    countActions(active.wallet),
  ]);

  const looksEmpty =
    spendableSats <= 0 && defaultOutputCount <= 0 && actionCount <= 0;

  return {
    spendableSats,
    defaultOutputCount,
    actionCount,
    looksEmpty,
  };
}

/** Same verdict as `inspectLocalToolboxState().looksEmpty`, stopping at the first sign of history. */
export async function localToolboxStateLooksEmpty(): Promise<boolean> {
  const active = getActiveWallet();
  if (!active) return true;
  if ((await countOutputs(active.wallet, "default")) > 0) return false;
  if ((await countActions(active.wallet)) > 0) return false;
  return (await fetchBalanceSats(active.wallet).catch(() => 0)) <= 0;
}
