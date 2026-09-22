/**
 * What the user may do about a spend that never confirmed — items and payments.
 *
 * A chain 404 alone never authorizes another spend. Retry is offered only when
 * the wallet can prove the original funds are still spendable, and the exact
 * recipient data was persisted with the attempt.
 *
 * Clearing is not a cancel. A signed transaction stays in Activity until every
 * one of its inputs is already spent on chain. Dropping the row earlier, then
 * repairing local spend state, is how a later resync can lose the coins that
 * transaction still holds. Unsigned attempts (no txid) never bound those coins.
 */
import { inputOutpointsFromRawTx } from "./txOutpoints";
import {
  countFailedActivity,
  isFailedActivity,
  isFailedMarketListingActivity,
  listFailedActivity,
  listRecentActivity,
  removeActivityById,
  removeFailedActivity,
  type ActivityEntry,
  type ActivityRetry,
} from "./appActivity";
import {
  isCollectableOutpointSpendable,
  sendCollectable,
} from "./collectables";
import { getCachedFungibles, getFungible, sendFungible } from "./token";
import {
  counterpartyMaySettle,
  forgetItemsSent,
  getSentItemRecord,
} from "./sentItemGuard";
import { getBeefForTxidCached } from "./beefCache";
import {
  parseOutpoint,
  spentStatusOfOutpoint,
  txExistsOnChain,
} from "./legacyScan";
import { broadcastAtomicBeef } from "./sendBrc29Payment";
import { getActiveWallet } from "./session";
import {
  arcadePinStillBinds,
  txIsArcadeRejected,
} from "./arcadeSubmitGuard";
import { itemSendMachine, maySenderBroadcast } from "./itemSendMachine";
import type { SignedInputsFate as KernelSignedInputsFate } from "./kernel/signedInputsFate";
import {
  chooseLocalTxReclaimPath,
  localTxReclaimRefusal,
} from "./localTxReclaimPath";
import { getTxByTxid } from "./txStore";
import type { Chain } from "./vault";
import { createActor } from "xstate";

export type SpendAttemptFate =
  | { kind: "notAttempt" }
  | { kind: "checking" }
  | { kind: "confirmed" }
  | {
      kind: "refuse";
      reason:
        | "statusUnknown"
        | "missingRetryDetails"
        | "sourceNotSpendable"
        /**
         * Every input of this signed send is already spent on chain. The row
         * is history only — clearing it does not undo the spend.
         */
        | "inputsSpent"
        /**
         * The transfer left this wallet and the payee may still broadcast it, and
         * this row has no signed transaction to publish. Clear stays refused —
         * it would delete the sender's only record of an item that can still land
         * in the recipient's wallet. (A row that *does* hold the signed transfer
         * is retryable instead: publishing it is the same txid, not a race.)
         */
        | "counterpartyMaySettle";
      message: string;
      mayClear: boolean;
      /**
       * Reserved coins may be released even when the row must stay. Repair only
       * fails *unsigned* transactions, so it frees a stuck balance without
       * touching a signed transfer the payee still holds.
       */
      mayReleaseFunds?: boolean;
      /**
       * The row is stuck on a signed transaction, so the holder may take its
       * sealed coins back. Offered without a chain call — {@link reclaimSpendAttempt}
       * re-checks and fails closed, so this only decides whether to show it.
       */
      mayReclaimInputs?: boolean;
      /** {@link SPEND_ATTEMPT_PEER_PUBLISHES} — a normal state, not a problem. */
      peerPublishes?: boolean;
    }
  | {
      kind: "retry";
      /**
       * `rebroadcast` re-submits the transaction this attempt already signed.
       * `recreateItem` re-runs a collectable / token send that died before signing.
       * `reopenPayment` hands a coin send back to the Send screen — the wallet
       * must never silently re-spend coins on the user's behalf.
       */
      action: "rebroadcast" | "recreateItem" | "reopenPayment";
      retry: ActivityRetry;
      message: string;
      mayClear: boolean;
      /** See the refuse variant — a retryable row may also be cancelled outright. */
      mayReclaimInputs?: boolean;
      /** {@link SPEND_ATTEMPT_PEER_PUBLISHES} — a normal state, not a problem. */
      peerPublishes?: boolean;
    };

/**
 * Projection key for "the recipient holds this signed transfer and publishes
 * it". Both a retryable and a refused row can be in that state, so the heading
 * and chrome read it from the fate instead of inferring it from `kind`.
 */
export const SPEND_ATTEMPT_PEER_PUBLISHES = "counterpartyMaySettle";

/** `data-aeon-state` for one attempt fate. */
export function spendAttemptState(fate: SpendAttemptFate): string {
  if (
    (fate.kind === "refuse" || fate.kind === "retry") &&
    fate.peerPublishes === true
  ) {
    return SPEND_ATTEMPT_PEER_PUBLISHES;
  }
  return fate.kind === "refuse" ? fate.reason : fate.kind;
}

const ITEM_METHOD = "send-collectable";
const TOKEN_METHOD = "send-token";
const BSV_METHOD = "send";
const INPUTS_STILL_LIVE =
  "This transaction cannot be cleared while its inputs are still unspent.";

/**
 * How long a broadcast row is left alone before a chain 404 counts as trouble.
 * Item / token sends can be settled by the payee (`peerDeliver`), so their
 * transaction is legitimately absent for far longer than a coin payment's.
 */
const ITEM_UNCONFIRMED_GRACE_MS = 10 * 60_000;
const BSV_UNCONFIRMED_GRACE_MS = 2 * 60_000;

function isItemOrTokenMethod(method: string): boolean {
  return method === ITEM_METHOD || method === TOKEN_METHOD;
}

export function isSpendAttempt(
  entry: ActivityEntry | null,
  now = Date.now()
): boolean {
  if (!entry || entry.kind !== "spent" || entry.status === "pending")
    return false;
  const isItemLike = isItemOrTokenMethod(entry.method);
  if (isItemLike ? !entry.item : entry.method !== BSV_METHOD) return false;
  if (isFailedActivity(entry)) return true;
  const grace = isItemLike
    ? ITEM_UNCONFIRMED_GRACE_MS
    : BSV_UNCONFIRMED_GRACE_MS;
  return now - entry.at >= grace;
}

/**
 * True when the payee still owns the outcome of this item / token transfer.
 *
 * A failed row is not automatically a dead row: on a `peerDeliver` settle the
 * signed transfer is already in the recipient's inbox, so it can land hours
 * later. Clearing in that window deletes the only local record of an item that
 * is really gone, and building a *replacement* transfer would race a live one —
 * so both stay refused. Publishing the transfer this row already signed does
 * neither: it is the same transaction the recipient holds.
 */
export function isCounterpartySettlePending(
  entry: ActivityEntry,
  now = Date.now()
): boolean {
  if (!isItemOrTokenMethod(entry.method)) return false;
  const outpoint =
    entry.retry?.kind === "send-collectable"
      ? entry.retry.outpoint
      : entry.item?.outpoint;
  if (!outpoint) return false;
  return counterpartyMaySettle(outpoint, now);
}

function hasTxid(entry: ActivityEntry): boolean {
  return Boolean(entry.txid && /^[0-9a-f]{64}$/i.test(entry.txid));
}

/**
 * May this wallet publish the transfer it already signed?
 *
 * Asked of {@link itemSendMachine} rather than answered here:
 * `RETRY_BROADCAST` enters `confirmBroadcast` for the identical signed tx.
 * Asset metadata never authorizes a competing spend or changes who propagates
 * the underlying transaction.
 */
/**
 * The signed item / token transfer on this row, when this wallet is allowed to
 * publish it. Coin payments are absent on purpose: their retry builds a *new*
 * payment, which is not safe to offer without knowing the first one's fate.
 */
function publishableSignedTransfer(
  entry: ActivityEntry
): Extract<ActivityRetry, { kind: "send-collectable" | "send-token" }> | null {
  const retry = entry.retry;
  if (!hasTxid(entry)) return null;
  if (
    retry?.kind === "send-collectable" ||
    retry?.kind === "send-token"
  ) {
    return senderMayPublishSignedTransfer(entry) ? retry : null;
  }
  // Older item rows predate durable retry details, but rebroadcast needs only
  // the original outpoint as the chart key and the already-signed tx body. Do
  // not strand a perfectly recoverable peer-delivery cheque for absent UX data.
  const outpoint = entry.item?.outpoint?.trim();
  if (entry.method !== ITEM_METHOD || !outpoint) return null;
  const synthesized: Extract<
    ActivityRetry,
    { kind: "send-collectable" }
  > = {
    kind: "send-collectable",
    outpoint,
    toAddress: "",
  };
  return senderMayPublishSignedTransfer({
    ...entry,
    retry: synthesized,
  })
    ? synthesized
    : null;
}

function senderMayPublishSignedTransfer(entry: ActivityEntry): boolean {
  const chartKey =
    entry.retry?.kind === "send-collectable"
      ? entry.retry.outpoint
      : entry.item?.outpoint;
  if (!chartKey) return false;
  const chart = createActor(itemSendMachine).start();
  try {
    chart.send({
      type: "RETRY_BROADCAST",
      outpoint: chartKey,
      txid: entry.txid!.trim().toLowerCase(),
    });
    return maySenderBroadcast(chart.getSnapshot());
  } finally {
    chart.stop();
  }
}

type SignedInputsFate = KernelSignedInputsFate;

async function loadLocalRawTx(txid: string): Promise<number[] | null> {
  const storage = getActiveWallet()?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return null;
  try {
    const found = await storage.runAsStorageProvider(
      async (sp: {
        getProvenOrRawTx?: (
          id: string
        ) => Promise<{ rawTx?: number[] } | undefined>;
      }) => {
        if (typeof sp.getProvenOrRawTx !== "function") return undefined;
        return sp.getProvenOrRawTx(txid);
      }
    );
    const raw = found?.rawTx;
    if (Array.isArray(raw) && raw.length > 0) return raw;
  } catch (err) {
    console.warn("[spend-attempt] local raw tx lookup skipped", err);
  }
  return null;
}

async function loadSignedInputOutpoints(txid: string): Promise<string[]> {
  const raw = await loadLocalRawTx(txid);
  if (raw?.length) {
    const fromRaw = inputOutpointsFromRawTx(raw);
    if (fromRaw.length > 0) return fromRaw;
  }
  const stored = getTxByTxid(txid)?.inputOutpoints ?? [];
  const dotted: string[] = [];
  for (const key of stored) {
    const parsed = parseOutpoint(key);
    if (parsed) dotted.push(`${parsed.txid}.${parsed.vout}`);
  }
  return dotted;
}

/**
 * Spend status of every input on a signed attempt.
 *
 * Clear is allowed only for `unsigned` (nothing was signed) or `spent` (the
 * coins already moved). `unspent` and `unknown` keep the row — the latter is
 * how a missing body or indexer silence fails closed.
 */
async function signedTxInputsFate(
  entry: ActivityEntry,
  chain: Chain
): Promise<SignedInputsFate> {
  if (!hasTxid(entry)) return "unsigned";
  const outpoints = await loadSignedInputOutpoints(entry.txid!);
  if (outpoints.length === 0) return "unknown";
  const statuses = await Promise.all(
    outpoints.map((outpoint) => spentStatusOfOutpoint(outpoint, chain))
  );
  if (statuses.some((s) => s === "unknown")) return "unknown";
  if (statuses.some((s) => s === "unspent")) return "unspent";
  return "spent";
}

function mayClearSignedInputs(
  fate: SignedInputsFate,
  txConfirmedOnChain: boolean | null = null,
  arcadePinBinds = false
): boolean {
  if (fate === "unsigned" || fate === "spent") return true;
  // Signed but never broadcast — inputs still local; safe to drop the history row
  // unless Arcade holds the tx (accepted, or still working it). A rejection
  // voids that hold: nothing on chain will ever settle a tx Arcade refused.
  if (fate === "unspent" && txConfirmedOnChain === false) {
    return !arcadePinBinds;
  }
  return false;
}

/** Does the Arcade pin still hold this row? Asked only when a txid exists. */
async function pinBindsRow(
  entry: ActivityEntry,
  chain: Chain
): Promise<boolean> {
  if (!hasTxid(entry)) return false;
  return arcadePinStillBinds(entry.txid!, chain);
}

/** True when the wallet still holds enough of this token to recreate the send. */
function isTokenSendRetryable(
  retry: Extract<ActivityRetry, { kind: "send-token" }>
): boolean | null {
  try {
    const token =
      getFungible(retry.tokenId) ??
      getCachedFungibles().find(
        (t) =>
          t.tokenId === retry.tokenId || t.tokenIds?.includes(retry.tokenId)
      );
    if (!token) return false;
    if (token.spendKind === "cosigned" || token.spendKind === "mixed")
      return false;
    const held = BigInt(token.amt.replace(/\D/g, "") || "0");
    const need = BigInt(retry.amount.replace(/\D/g, "") || "0");
    if (need <= 0n) return false;
    return held >= need;
  } catch {
    return null;
  }
}

export async function resolveSpendAttemptFate(
  entry: ActivityEntry,
  chain: Chain
): Promise<SpendAttemptFate> {
  if (!isSpendAttempt(entry)) return { kind: "notAttempt" };

  let txOnChain: boolean | null = null;
  if (hasTxid(entry)) {
    const onChain = await Promise.resolve(
      txExistsOnChain(entry.txid!, chain)
    ).catch(() => null);
    if (onChain === true) return { kind: "confirmed" };
    if (onChain === null) {
      // Not knowing must not strand the row. Publishing the transaction this
      // attempt already signed is safe under uncertainty — if it turns out to be
      // on chain already, the same txid is simply re-announced. Only clearing
      // and reclaiming its coins need proof, and both stay closed here.
      const publishable = publishableSignedTransfer(entry);
      if (publishable) {
        return {
          kind: "retry",
          action: "rebroadcast",
          retry: publishable,
          message:
            "The chain could not be checked just now, so this row cannot be cleared. You can still publish the transfer it already signed — that is the same transaction, so it settles rather than duplicates.",
          mayClear: false,
        };
      }
      return {
        kind: "refuse",
        reason: "statusUnknown",
        message:
          "Confirmation status is unavailable, and this row has no signed transaction to publish. It stays as it is until the chain can be checked.",
        mayClear: false,
      };
    }
    txOnChain = onChain;
  }

  const inputsFate = await signedTxInputsFate(entry, chain);
  if (inputsFate === "spent") {
    return {
      kind: "refuse",
      reason: "inputsSpent",
      message:
        "The coins this send used are already spent on chain. You can drop the history row — that does not undo the spend.",
      mayClear: true,
    };
  }

  const pinBinds = await pinBindsRow(entry, chain);
  const retry = entry.retry;

  // Checked *after* the chain: a transfer the recipient already published reads
  // as confirmed, and only a transfer that is genuinely absent is described as
  // theirs to publish.
  if (isCounterpartySettlePending(entry)) {
    const publishable = publishableSignedTransfer(entry);
    if (publishable) {
      return {
        kind: "retry",
        action: "rebroadcast",
        retry: publishable,
        // Publishing this is not a race: it is the same signed transaction the
        // recipient holds, so both copies are one txid. It is the sender's own
        // silent postBeef, offered by hand because it has not landed.
        message:
          "The item has left your wallet and the recipient has the signed transfer — their wallet publishes it once they are online. It is not on chain yet, so you can publish that same transfer yourself; it is the same transaction, not a second one.",
        mayClear: false,
        mayReclaimInputs: inputsFate === "unspent",
        peerPublishes: true,
      };
    }
    return {
      kind: "refuse",
      reason: "counterpartyMaySettle",
      // Nothing has gone wrong here, so the copy does not describe hazards. It
      // says who holds the transfer, who publishes it, and that the row is the
      // sender's record until then — the reason there is no clear.
      message:
        "The item has left your wallet and the recipient has the signed transfer. Their wallet publishes it, so it confirms once they are online. This stays in your Activity as the record until then.",
      mayClear: false,
      // Unsigned debris may hold a reservation. A signed peer transfer does
      // not: showing "Unlock coins" there ran unsigned repair for 30 seconds,
      // changed nothing, and implied the transfer's real sealed inputs were
      // released when they were not.
      mayReleaseFunds: !hasTxid(entry),
      mayReclaimInputs: hasTxid(entry) && inputsFate === "unspent",
      peerPublishes: true,
    };
  }

  if (!retry) {
    return {
      kind: "refuse",
      reason: "missingRetryDetails",
      message: isFailedActivity(entry)
        ? "This send failed and cannot be retried — its original recipient details were not saved."
        : "This send did not confirm and cannot be retried — its original recipient details were not saved.",
      mayClear: mayClearSignedInputs(inputsFate, txOnChain, pinBinds),
    };
  }

  if (retry.kind === "send-bsv") {
    return {
      kind: "retry",
      action: "reopenPayment",
      retry,
      message: hasTxid(entry)
        ? "This payment never landed on chain. You can send it again from the Send screen."
        : "This payment failed before it reached the network. You can send it again from the Send screen, or clear it.",
      mayClear: mayClearSignedInputs(inputsFate, txOnChain, pinBinds),
    };
  }

  if (retry.kind === "send-token") {
    const spendable = isTokenSendRetryable(retry);
    if (spendable === null) {
      return {
        kind: "refuse",
        reason: "statusUnknown",
        message:
          "Token balance could not be checked. Retry stays disabled until the wallet refreshes.",
        mayClear: false,
      };
    }
    if (!spendable) {
      return {
        kind: "refuse",
        reason: "sourceNotSpendable",
        message:
          "This send cannot be retried — there is no longer enough of this token spendable in this wallet.",
        mayClear: mayClearSignedInputs(inputsFate, txOnChain, pinBinds),
      };
    }
    return {
      kind: "retry",
      action: hasTxid(entry) ? "rebroadcast" : "recreateItem",
      retry,
      message: hasTxid(entry)
        ? "This send did not confirm. The token tips are still unspent, so the signed transfer can be broadcast again."
        : "This send failed before it produced a transaction. The token is still spendable and can be retried.",
      mayClear: mayClearSignedInputs(inputsFate, txOnChain, pinBinds),
    };
  }

  const spendable = await Promise.resolve(
    isCollectableOutpointSpendable(retry.outpoint)
  ).catch(() => null);
  if (spendable === null) {
    return {
      kind: "refuse",
      reason: "statusUnknown",
      message:
        "Item spendability could not be checked. Retry stays disabled until the wallet refreshes.",
      mayClear: false,
    };
  }
  if (!spendable) {
    return {
      kind: "refuse",
      reason: "sourceNotSpendable",
      message:
        "This send cannot be retried — the original item output is no longer spendable in this wallet.",
      mayClear: mayClearSignedInputs(inputsFate, txOnChain, pinBinds),
    };
  }

  return {
    kind: "retry",
    action: hasTxid(entry) ? "rebroadcast" : "recreateItem",
    retry,
    message: hasTxid(entry)
      ? "This send did not confirm. The item is still unspent, so the signed transfer can be broadcast again."
      : "This send failed before it produced a transaction. The item is still spendable and can be retried.",
    mayClear: mayClearSignedInputs(inputsFate, txOnChain, pinBinds),
  };
}

export type SpendAttemptRetryResult =
  | { kind: "rebroadcasted"; txid: string }
  | { kind: "recreated"; txid: string }
  | { kind: "reopenPayment"; toAddress: string; satoshis: number };

/**
 * Retry the transaction this attempt already signed when one exists. A new
 * spend is created only for an item / token attempt that never produced a
 * txid; coin payments are handed back to the Send screen instead.
 */
export async function retrySpendAttempt(
  entry: ActivityEntry,
  chain: Chain
): Promise<SpendAttemptRetryResult> {
  const fate = await resolveSpendAttemptFate(entry, chain);
  if (fate.kind !== "retry") {
    // The display copy for a peer-published transfer describes a normal state,
    // so a refusal states its own reason rather than reusing that sentence.
    if (fate.kind === "refuse" && fate.reason === "counterpartyMaySettle") {
      throw new Error(
        "There is no signed transaction on this row to publish, and the recipient may still broadcast their copy. Building a second transfer would race it."
      );
    }
    throw new Error(
      fate.kind === "refuse" ? fate.message : "This send cannot be retried."
    );
  }

  if (fate.action === "reopenPayment" && fate.retry.kind === "send-bsv") {
    return {
      kind: "reopenPayment",
      toAddress: fate.retry.toAddress,
      satoshis: fate.retry.satoshis,
    };
  }

  if (fate.retry.kind === "send-token") {
    if (fate.action === "recreateItem") {
      const sent = await sendFungible({
        tokenId: fate.retry.tokenId,
        amount: fate.retry.amount,
        toAddress: fate.retry.toAddress,
        recipientIdentityKey: fate.retry.recipientIdentityKey,
        friendLabel: fate.retry.friendLabel,
      });
      return { kind: "recreated", txid: sent.txid };
    }
    const spentTip = entry.item?.outpoint?.trim();
    if (!spentTip) {
      throw new Error(
        "The token input for this signed transfer is no longer available."
      );
    }
    return rebroadcastSignedTransfer(entry, spentTip);
  }

  if (fate.retry.kind !== "send-collectable") {
    throw new Error("This send cannot be retried.");
  }

  if (fate.action === "recreateItem") {
    const sent = await sendCollectable({
      outpoint: fate.retry.outpoint,
      toAddress: fate.retry.toAddress,
      recipientIdentityKey: fate.retry.recipientIdentityKey,
      friendLabel: fate.retry.friendLabel,
      name: entry.item?.name,
      origin: entry.item?.origin,
      app: entry.item?.app,
    });
    return { kind: "recreated", txid: sent.txid };
  }

  return rebroadcastSignedTransfer(entry, fate.retry.outpoint);
}

async function rebroadcastSignedTransfer(
  entry: ActivityEntry,
  chartKey: string
): Promise<SpendAttemptRetryResult> {
  const txid = entry.txid?.trim().toLowerCase() ?? "";
  const active = getActiveWallet();
  if (!active || !/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error(
      "The signed transfer is no longer available to rebroadcast."
    );
  }
  const chart = createActor(itemSendMachine).start();
  chart.send({ type: "RETRY_BROADCAST", outpoint: chartKey, txid });
  if (!maySenderBroadcast(chart.getSnapshot())) {
    chart.stop();
    throw new Error("The item send statechart refused this broadcast retry.");
  }
  let atomic: number[];
  try {
    const beef = await getBeefForTxidCached(active, txid, {
      allowUnprovenRawTx: true,
    });
    atomic = Array.from(beef.toBinaryAtomic(txid));
  } catch {
    chart.send({ type: "FAIL", error: "Signed transaction body unavailable" });
    chart.stop();
    throw new Error(
      "The signed transaction body is no longer available. This attempt cannot be retried."
    );
  }
  if (!(await broadcastAtomicBeef(txid, atomic))) {
    chart.send({ type: "FAIL", error: "Network refused broadcast retry" });
    chart.stop();
    throw new Error(
      "The network did not accept the transfer. The original output remains safe."
    );
  }
  chart.send({ type: "BROADCASTED" });
  chart.stop();
  const { reviveFailedOutboundByTxid } = await import("./appActivity");
  reviveFailedOutboundByTxid(txid);
  return { kind: "rebroadcasted", txid };
}

function fateAllowsClear(fate: SpendAttemptFate): boolean {
  return (
    (fate.kind === "retry" || fate.kind === "refuse") && fate.mayClear === true
  );
}

/**
 * Drop a dead attempt from Activity.
 *
 * Unsigned rows (no txid) may also release local reservations they left on our
 * outputs. A signed row is only removed once every input is spent on chain.
 * Clearing that row keeps its change spendable and hides the spent inputs —
 * it does not undo the spend and does not run unsigned-tx repair.
 *
 * Failed market listings are local history only — always dismissable.
 */
export async function clearSpendAttempt(
  entry: ActivityEntry
): Promise<{ removed: boolean }> {
  if (isFailedMarketListingActivity(entry)) {
    const { dismissFailedMarketListingActivity } = await import(
      "./marketListing"
    );
    return { removed: dismissFailedMarketListingActivity(entry) };
  }
  if (isCounterpartySettlePending(entry)) {
    throw new Error(
      "The recipient can still broadcast this transfer, so it cannot be cleared yet."
    );
  }
  const chain = getActiveWallet()?.chain;
  if (!chain) {
    throw new Error("Wallet is not unlocked.");
  }
  const fate = await resolveSpendAttemptFate(entry, chain);
  if (!fateAllowsClear(fate)) {
    throw new Error(fate.kind === "refuse" ? fate.message : INPUTS_STILL_LIVE);
  }
  if (!hasTxid(entry)) await releaseLocalSpendReservations();
  else {
    const inputsFate = await signedTxInputsFate(entry, chain);
    if (inputsFate === "spent") {
      const { keepChangeOfSignedTx, hideSpentOutpoints } = await import(
        "./staleOutputRelease"
      );
      const inputs = await loadSignedInputOutpoints(entry.txid!);
      if (inputs.length > 0) await hideSpentOutpoints(inputs);
      await keepChangeOfSignedTx(entry.txid!);
    } else if (txIsArcadeRejected(entry.txid!)) {
      await retireArcadeRejectedTx(entry.txid!);
    }
  }
  return { removed: removeActivityById(entry.id) };
}

/**
 * Write off a cheque Arcade refused, so the coins it sealed come back.
 *
 * Dropping the Activity row alone would leave the inputs sealed by a
 * transaction that no longer has a row to explain them — visibly short by
 * exactly the size of the dead send.
 */
async function retireArcadeRejectedTx(txid: string): Promise<void> {
  try {
    const { failUnsentLocalTx } = await import("./staleOutputRelease");
    await failUnsentLocalTx(txid, { force: true });
  } catch (err) {
    console.warn(
      "[spend-attempt] Arcade-rejected retire skipped",
      txid.slice(0, 12),
      err
    );
  }
}

/**
 * Free the coins a dead attempt reserved, without touching history.
 *
 * Repair only fails *unsigned* transactions, so this unblocks a balance that a
 * half-built send is sitting on while leaving any signed transfer — and every
 * Activity row — alone. It is the safe half of "clear" for an attempt whose
 * record has to stay.
 */
export async function releaseSpendAttemptFunds(): Promise<void> {
  await releaseLocalSpendReservations();
}

export type SpendAttemptReclaim = {
  /** Sealed inputs handed back to the spendable set. */
  inputs: number;
  /** The item returned to inventory, when this was an item transfer. */
  outpoint: string | null;
};

/**
 * Take back the coins sealed for a signed transaction that never reached the
 * chain, so the next send may spend over it.
 *
 * This is the holder's decision, not a repair the wallet may make on its own: if
 * the counterparty ever publishes their copy, it becomes a double-spend of
 * whatever is spent from here first. {@link chooseLocalTxReclaimPath} is
 * re-evaluated against live chain state and refuses on anything uncertain, so a
 * transaction that did land — or that no explorer can speak for — is never
 * reclaimed.
 */
export async function reclaimSpendAttempt(
  entry: ActivityEntry,
  chain: Chain
): Promise<SpendAttemptReclaim> {
  if (!hasTxid(entry)) {
    throw new Error(localTxReclaimRefusal("nothingSigned"));
  }
  const txid = entry.txid!.trim().toLowerCase();
  const onChain = await Promise.resolve(txExistsOnChain(txid, chain)).catch(
    () => null
  );
  const path = chooseLocalTxReclaimPath({
    onChain,
    inputsFate: await signedTxInputsFate(entry, chain),
    // A rejected cheque is not one a broadcaster can still present.
    arcadeContacted: await arcadePinStillBinds(txid, chain),
  });
  if (path.path === "refuse") {
    console.info(
      `[spend-attempt] reclaim refused reason=${path.reason} txid=${txid}`
    );
    throw new Error(localTxReclaimRefusal(path.reason));
  }

  const { releaseSealedInputsOfUnsentTx } = await import(
    "./staleOutputRelease"
  );
  const inputs = await releaseSealedInputsOfUnsentTx(txid, undefined);

  // The tip was hidden as sent. Nothing published it, so it is ours again —
  // otherwise the coins come back while the item stays invisible for a day.
  const outpoint =
    entry.retry?.kind === "send-collectable"
      ? entry.retry.outpoint
      : entry.item?.outpoint ?? null;
  if (outpoint) forgetItemsSent([outpoint]);

  console.info(
    `[spend-attempt] reclaimed ${inputs} input(s) of ${txid.slice(
      0,
      12
    )} — nothing was published`
  );
  return { inputs, outpoint: outpoint ?? null };
}

/**
 * Clear failed sends from history in one pass (archives rows — they stay in storage).
 *
 * Unsigned rows may repair local reservations first. Signed rows are archived
 * only when every input is already spent on chain, and never through that
 * repair. Item transfers the payee can still broadcast are kept. Returns how
 * many rows were archived and how many were kept back.
 */
export async function clearAllFailedSpends(): Promise<{
  removed: number;
  kept: number;
}> {
  const now = Date.now();
  const chain = getActiveWallet()?.chain;
  const failed = countFailedActivity();
  const keepIds = new Set<string>();
  let unsignedToClear = false;

  const toKeepChange: string[] = [];
  /** Arcade-rejected cheques — dropping the row must also free their coins. */
  const toRetire: string[] = [];

  for (const row of listFailedActivity()) {
    if (isFailedMarketListingActivity(row)) {
      const { releaseFailedMarketListingAuth } = await import(
        "./marketListing"
      );
      releaseFailedMarketListingAuth(row);
      continue;
    }
    if (isCounterpartySettlePending(row, now)) {
      keepIds.add(row.id);
      continue;
    }
    if (!hasTxid(row)) {
      unsignedToClear = true;
      continue;
    }
    if (!chain) {
      keepIds.add(row.id);
      continue;
    }
    let txOnChain: boolean | null = null;
    if (hasTxid(row)) {
      txOnChain = await txExistsOnChain(row.txid!, chain).catch(() => null);
      if (txOnChain === null) {
        keepIds.add(row.id);
        continue;
      }
    }
    const inputsFate = await signedTxInputsFate(row, chain);
    const pinBinds = await pinBindsRow(row, chain);
    if (!mayClearSignedInputs(inputsFate, txOnChain, pinBinds)) {
      keepIds.add(row.id);
      continue;
    }
    if (inputsFate === "spent") toKeepChange.push(row.txid!);
    else if (txIsArcadeRejected(row.txid!)) toRetire.push(row.txid!);
  }

  if (unsignedToClear) await releaseLocalSpendReservations();
  for (const txid of toRetire) await retireArcadeRejectedTx(txid);
  if (toKeepChange.length > 0) {
    const { keepChangeOfSignedTx, hideSpentOutpoints } = await import(
      "./staleOutputRelease"
    );
    const cleanupFailedTxids = new Set<string>();
    for (const txid of toKeepChange) {
      try {
        const inputs = await loadSignedInputOutpoints(txid);
        if (inputs.length > 0) await hideSpentOutpoints(inputs);
        await keepChangeOfSignedTx(txid);
      } catch (err) {
        console.warn(
          "[spend-attempt] clear failed row cleanup skipped",
          txid,
          err
        );
        cleanupFailedTxids.add(txid.toLowerCase());
      }
    }
    if (cleanupFailedTxids.size > 0) {
      for (const row of listFailedActivity()) {
        const txid = row.txid?.toLowerCase();
        if (txid && cleanupFailedTxids.has(txid)) keepIds.add(row.id);
      }
    }
  }
  const removed = removeFailedActivity((entry) => keepIds.has(entry.id));
  if (
    removed > 0 ||
    toKeepChange.length > 0 ||
    toRetire.length > 0 ||
    unsignedToClear
  ) {
    const { scheduleHealAfterSendCleanup } = await import(
      "./chainedChangeHeal"
    );
    scheduleHealAfterSendCleanup();
  }
  return { removed, kept: Math.max(0, failed - removed) };
}

/** Failed sends whose signed transfer can be re-submitted without a new spend. */
export async function countRebroadcastableFailedSpends(
  chain: Chain
): Promise<number> {
  let count = 0;
  for (const row of listFailedActivity()) {
    if (isCounterpartySettlePending(row)) continue;
    const fate = await resolveSpendAttemptFate(row, chain);
    if (fate.kind === "retry" && fate.action === "rebroadcast") count += 1;
  }
  return count;
}

/** Failed sends that are actually safe to drop from Activity. */
export async function countClearableFailedSpends(
  chain: Chain
): Promise<number> {
  let count = 0;
  for (const row of listFailedActivity()) {
    if (isFailedMarketListingActivity(row)) {
      count += 1;
      continue;
    }
    if (isCounterpartySettlePending(row)) continue;
    if (!hasTxid(row)) {
      count += 1;
      continue;
    }
    const fate = await resolveSpendAttemptFate(row, chain);
    if (fateAllowsClear(fate)) count += 1;
  }
  return count;
}

/**
 * Rebroadcast every failed send that already has a signed transfer.
 *
 * Unsigned failures and coin payments are skipped — those need a fresh send from
 * the Send screen, not a silent rebroadcast.
 */
export async function rebroadcastAllFailedSpends(): Promise<{
  rebroadcasted: number;
  skipped: number;
  failed: number;
  errors: string[];
}> {
  const chain = getActiveWallet()?.chain;
  if (!chain) throw new Error("Wallet is not unlocked.");

  let rebroadcasted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of listFailedActivity()) {
    if (isCounterpartySettlePending(row)) {
      skipped += 1;
      continue;
    }
    const fate = await resolveSpendAttemptFate(row, chain);
    if (fate.kind !== "retry" || fate.action !== "rebroadcast") {
      skipped += 1;
      continue;
    }
    try {
      await retrySpendAttempt(row, chain);
      rebroadcasted += 1;
    } catch (err) {
      failed += 1;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { rebroadcasted, skipped, failed, errors };
}

function unresolvedPeerTransferRows(): ActivityEntry[] {
  const seen = new Set<string>();
  const rows: ActivityEntry[] = [];
  for (const row of listRecentActivity(1000)) {
    const txid = row.txid?.trim().toLowerCase() ?? "";
    const outpoint =
      row.retry?.kind === "send-collectable"
        ? row.retry.outpoint
        : row.item?.outpoint;
    if (
      !/^[0-9a-f]{64}$/.test(txid) ||
      !outpoint ||
      seen.has(txid) ||
      getSentItemRecord(outpoint)?.settle !== "peerDeliver" ||
      !publishableSignedTransfer(row)
    ) {
      continue;
    }
    seen.add(txid);
    rows.push(row);
  }
  return rows;
}

/** Signed peer-delivery transactions that this wallet can safely publish. */
export function countUnresolvedPeerTransfers(): number {
  return unresolvedPeerTransferRows().length;
}

/**
 * Publish every unresolved peer-delivery cheque as its original transaction.
 *
 * This creates no replacement spend: sender and recipient hold the same txid.
 * Rows are deduplicated by txid because one five-item leg writes five Activity
 * members. Successful submission lets normal chain reconciliation settle them.
 */
export async function publishUnresolvedPeerTransfers(): Promise<{
  published: number;
  confirmed: number;
  failed: number;
  errors: string[];
}> {
  const active = getActiveWallet();
  if (!active) throw new Error("Wallet is not unlocked.");
  let published = 0;
  let confirmed = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const row of unresolvedPeerTransferRows()) {
    const txid = row.txid!.trim().toLowerCase();
    const onChain = await txExistsOnChain(txid, active.chain).catch(() => null);
    if (onChain === true) {
      confirmed += 1;
      continue;
    }
    const chartKey =
      row.retry?.kind === "send-collectable"
        ? row.retry.outpoint
        : row.item!.outpoint!;
    try {
      await rebroadcastSignedTransfer(row, chartKey);
      published += 1;
    } catch (err) {
      failed += 1;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { published, confirmed, failed, errors };
}

/** Best-effort release of the local reservations a dead spend left behind. */
const RELEASE_RESERVATIONS_BUDGET_MS = 30_000;

async function withClearBudget<T>(
  label: string,
  ms: number,
  work: () => Promise<T>
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } catch (err) {
    console.warn(`[spend-attempt] ${label} skipped`, err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function releaseLocalSpendReservations(): Promise<void> {
  const repair = await withClearBudget(
    "release unsigned spend reservations",
    RELEASE_RESERVATIONS_BUDGET_MS,
    async () => {
      const { releaseUnsignedSpendReservations } = await import(
        "./actionReview"
      );
      return releaseUnsignedSpendReservations(undefined, { skipReview: true });
    }
  );
  if (
    repair &&
    (repair.failedTxs > 0 ||
      repair.batchesAborted > 0 ||
      repair.reviewLog.trim())
  ) {
    console.info("[spend-attempt] cleared local spend state", repair);
  }
}
