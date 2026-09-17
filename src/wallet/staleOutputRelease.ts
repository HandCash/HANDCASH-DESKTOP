/**
 * Writing off spendable outputs — the only path allowed to do it.
 *
 * `reviewSpendableOutputs(all, release)` decides an output is dead through
 * `services.isUtxo`, which returns `or.isUtxo === true`. An indexer that has not
 * seen our unconfirmed change and a UTXO service that errored both answer
 * `false`, and `release` then sets `spendable: false` permanently. So a bulk
 * release run on a schedule destroys live coins, which is why chain ingest only
 * ever audits (see `chainIngest.auditSpendableOutputs`).
 *
 * A node rejecting a spend because an input is already spent is different: that
 * is affirmative evidence our set is stale, and it is the only trigger for the
 * release here.
 */
import {
  parseOutpoint,
  spentStatusOfOutpoint,
  txExistsOnChain,
} from "./legacyScan";
import { logDiag } from "./diagnosticLog";
import { getActiveWallet, type ActiveWallet } from "./session";
import { isItemSent } from "./sentItemGuard";
import {
  creditUtxo,
  getUtxoLock,
  hideUtxo,
  isUtxoBlockedFromRestore,
  listUtxoLocks,
  releaseConsumedUtxo,
} from "./utxoLockManager";
import { isQuarantined } from "./utxoLifecycle";
import {
  inputOutpointsFromAtomicBeef,
  inputOutpointsFromRawTx,
  outpointFromOutput,
} from "./txOutpoints";
import { shouldYieldChainIngestToSpend } from "./walletCoordinator";
import { yieldToUi } from "./yieldToUi";
import {
  classifyChangeScript,
  hasLockingScript,
  resolveChangeRowOutpoint,
  sweepChangeScripts,
  type ChangeRow,
} from "./changeScriptFate";
import {
  isLiveLocalTxStatus,
  LIVE_LOCAL_TX_STATUSES,
  txLivenessFromStatus,
} from "./kernel/txLiveness";
import {
  signedTxMayBeRemoved,
  signedTxSpendConflictIsProven,
  txHadArcadeSubmitContact,
} from "./arcadeSubmitGuard";
import { chooseSpentCoinMutation, isNamedSpenderTxid } from "./utxoTxMutation";

export { isAlreadySpentInputError } from "./spendVerdict";
export { isLiveLocalTxStatus } from "./kernel/txLiveness";

/** Toolbox statuses that mean this wallet already committed the tx locally. */
const LIVE_LOCAL_TX: ReadonlySet<string> = new Set(LIVE_LOCAL_TX_STATUSES);

type TxStatusRow = {
  status?: string;
  rawTx?: number[];
  txid?: string;
  transactionId?: number;
};

/** Statuses toolbox `internalizeAction` will merge into an existing row. */
const INTERNALIZE_OK_TX = new Set([
  "completed",
  "unproven",
  "sending",
  "nosend",
]);

function positiveId(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cap restore work so a huge dead set cannot stall unlock/refresh. */
const RESTORE_MAX = 200;

/** The toolbox rejects `undefined` partial filters on some storage backends. */
export function isUndefinedPartialFilterError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("must be not undefined") ||
    message.includes("Passing undefined as a filter value is not supported")
  );
}

/**
 * Wallet storage marked an input unspendable (failed createAction / signAction
 * that did not roll back). Not proof the UTXO is gone on-chain — do **not**
 * {@link releaseStaleSpendableOutputs}; abort + unfail instead.
 */
export function isNoLongerSpendableError(err: unknown): boolean {
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase();
  return (
    message.includes("no longer spendable") ||
    (message.includes("werr_invalid_operation") &&
      message.includes("spendable"))
  );
}

export type UtxoEvidenceHealResult = {
  checked: number;
  hiddenSpent: number;
  restoredUnspent: number;
  quarantined: number;
  unknown: number;
  spentOutpoints: string[];
  restoredOutpoints: string[];
  quarantinedOutpoints: string[];
};

type EvidenceOutputRow = ChangeRow & {
  basket?: string;
  spentBy?: number;
};

export type UtxoEvidenceAction =
  | { action: "remove"; reason: "proven-spent" }
  | { action: "quarantine"; reason: "spent-spender-unknown" }
  | { action: "restore"; reason: "proven-unspent-dropped" }
  | {
      action: "keep";
      reason: "unknown" | "already-correct" | "local-spend" | "item-transfer";
    };

/** Pure decision used by manual Heal; no boolean fallthrough around UTXO writes. */
export function chooseUtxoEvidenceAction(args: {
  verdict: "spent" | "unspent" | "unknown";
  spendable: boolean;
  hasToolboxSpender: boolean;
  blockedByLocalSpend: boolean;
  itemTransferPending: boolean;
  namedSpenderTxid?: string | null;
}): UtxoEvidenceAction {
  if (args.verdict === "spent") {
    const mutation = chooseSpentCoinMutation({
      spendable: args.spendable,
      namedSpenderTxid: args.namedSpenderTxid ?? null,
      hasLocalSpenderRow: args.hasToolboxSpender,
      blockedByLocalSpend: args.blockedByLocalSpend,
      itemTransferPending: args.itemTransferPending,
    });
    if (mutation === "keep") {
      return {
        action: "keep",
        reason: args.blockedByLocalSpend
          ? "local-spend"
          : args.itemTransferPending
          ? "item-transfer"
          : "already-correct",
      };
    }
    if (mutation === "adopt-spend") {
      return { action: "remove", reason: "proven-spent" };
    }
    return { action: "quarantine", reason: "spent-spender-unknown" };
  }
  if (args.verdict === "unknown") return { action: "keep", reason: "unknown" };
  if (args.spendable) return { action: "keep", reason: "already-correct" };
  if (args.hasToolboxSpender || args.blockedByLocalSpend) {
    return { action: "keep", reason: "local-spend" };
  }
  if (args.itemTransferPending) {
    return { action: "keep", reason: "item-transfer" };
  }
  return { action: "restore", reason: "proven-unspent-dropped" };
}

/**
 * Reconcile the toolbox output set against affirmative outpoint evidence.
 *
 * This is the actual UTXO-heal contract:
 * - `spent` + named spender → adopt that spend (hide as spentBy)
 * - `spent` + unknown spender → quarantine until the body can be inserted
 * - `unspent` → restore a dropped row only when no local spend/overlay owns it
 * - `unknown` → do nothing
 *
 * `isUtxo === false`, tx absence, Arcade status, and explorer silence are not
 * spend evidence. A locally signed unconfirmed cheque therefore survives this
 * pass, while genuinely stale spendable rows are removed.
 */
export async function reconcileKnownUtxosByEvidence(opts?: {
  maxOutputs?: number;
  /** Explicit Settings heal owns the ingest turn and completes its audit. */
  forManualHeal?: boolean;
}): Promise<UtxoEvidenceHealResult> {
  const empty: UtxoEvidenceHealResult = {
    checked: 0,
    hiddenSpent: 0,
    restoredUnspent: 0,
    quarantined: 0,
    unknown: 0,
    spentOutpoints: [],
    restoredOutpoints: [],
    quarantinedOutpoints: [],
  };
  const active = getActiveWallet();
  const storage = active?.wallet?.storage;
  if (!active || !storage?.runAsStorageProvider) return empty;

  // Cap per side so a large historical spent set cannot prevent current
  // spendable coins (or vice versa) from ever reaching the audit.
  const maxOutputs = Math.max(1, Math.min(4_000, opts?.maxOutputs ?? 2_000));
  const rows: EvidenceOutputRow[] = [];
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      if (typeof sp.findOutputs !== "function") return;
      for (const spendable of [true, false]) {
        let sideCount = 0;
        for (let offset = 0; sideCount < maxOutputs; offset += RESTORE_MAX) {
          const batch = await sp.findOutputs({
            partial: { spendable },
            paged: {
              limit: Math.min(RESTORE_MAX, maxOutputs - sideCount),
              offset,
            },
          });
          if (!Array.isArray(batch) || batch.length === 0) break;
          rows.push(...(batch as EvidenceOutputRow[]));
          sideCount += batch.length;
          if (batch.length < RESTORE_MAX) break;
        }
      }
    });
  } catch (err) {
    console.warn("[stale-output] evidence snapshot failed", err);
    return empty;
  }

  const candidates = rows
    .map((row) => ({ row, outpoint: outpointFromOutput(row) }))
    .filter(
      (candidate): candidate is { row: EvidenceOutputRow; outpoint: string } =>
        Boolean(candidate.outpoint) &&
        positiveId(candidate.row.outputId) != null
    );

  const verdicts = new Map<string, "spent" | "unspent" | "unknown">();
  const isUtxo = active.services?.isUtxo;
  const concurrency = 8;
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    if (!opts?.forManualHeal && shouldYieldChainIngestToSpend()) break;
    const batch = candidates.slice(offset, offset + concurrency);
    await Promise.all(
      batch.map(async ({ outpoint }) => {
        const parsed = parseOutpoint(outpoint);
        if (!parsed) return;

        // A positive isUtxo answer is affirmative unspent evidence. A negative
        // is only "this provider did not affirm", so ask the tri-state probe.
        if (typeof isUtxo === "function") {
          try {
            const result = await isUtxo({
              txid: parsed.txid,
              vout: parsed.vout,
            } as never);
            const alive =
              result === true ||
              (!!result &&
                typeof result === "object" &&
                (result as { isUtxo?: unknown }).isUtxo === true);
            if (alive) {
              verdicts.set(outpoint, "unspent");
              return;
            }
          } catch {
            // Tri-state provider waterfall below.
          }
        }
        const status = await spentStatusOfOutpoint(
          outpoint,
          active.chain
        ).catch(() => "unknown" as const);
        if (status === "unspent") {
          // A 404 on /spent is only meaningful when the source transaction is
          // known. Otherwise the provider may simply have no record of either.
          const sourceExists = await txExistsOnChain(
            parsed.txid,
            active.chain
          ).catch(() => null);
          verdicts.set(outpoint, sourceExists === true ? "unspent" : "unknown");
          return;
        }
        verdicts.set(outpoint, status);
      })
    );
    await yieldToUi();
  }

  const spent: string[] = [];
  const quarantined: string[] = [];
  for (const { row, outpoint } of candidates) {
    const overlay = getUtxoLock(outpoint);
    const action = chooseUtxoEvidenceAction({
      verdict: verdicts.get(outpoint) ?? "unknown",
      spendable: row.spendable === true,
      hasToolboxSpender: positiveId(row.spentBy) != null,
      blockedByLocalSpend: isUtxoBlockedFromRestore(outpoint),
      itemTransferPending:
        String(row.basket ?? "").toLowerCase() === "1sat" &&
        isItemSent(outpoint),
      namedSpenderTxid: overlay?.spentBy ?? null,
    });
    if (action.action === "remove") spent.push(outpoint);
    if (action.action === "quarantine") quarantined.push(outpoint);
  }
  if (spent.length > 0) {
    empty.hiddenSpent = await hideSpentOutpoints(spent);
    empty.spentOutpoints = spent;
  }
  if (quarantined.length > 0) {
    empty.quarantined = await quarantineSpentOutpoints(quarantined);
    empty.quarantinedOutpoints = quarantined;
  }

  const restorable = candidates.filter(({ row, outpoint }) => {
    const action = chooseUtxoEvidenceAction({
      verdict: verdicts.get(outpoint) ?? "unknown",
      spendable: row.spendable === true,
      hasToolboxSpender: positiveId(row.spentBy) != null,
      blockedByLocalSpend: isUtxoBlockedFromRestore(outpoint),
      itemTransferPending:
        String(row.basket ?? "").toLowerCase() === "1sat" &&
        isItemSent(outpoint),
      namedSpenderTxid: getUtxoLock(outpoint)?.spentBy ?? null,
    });
    return action.action === "restore";
  });

  if (restorable.length > 0) {
    try {
      await storage.runAsStorageProvider(async (activeSp) => {
        const sp = activeSp as unknown as LocalStorage;
        const txCache = new Map<number, TxStatusRow | null>();
        for (const { row, outpoint } of restorable) {
          const outputId = positiveId(row.outputId);
          if (outputId == null) continue;
          const basket = String(row.basket ?? "").toLowerCase();
          let healed: number[] | null = null;
          if (basket !== "1sat" && basket !== "bsv21") {
            healed = await healLockingScript(sp, row, txCache, {
              fromChain: false,
            });
            if (healed == null && !hasLockingScript(row)) continue;
          }
          await sp.updateOutput(outputId, {
            spendable: true,
            spentBy: undefined,
            ...(healed != null ? { lockingScript: healed } : {}),
          });
          const sats = Math.max(0, Math.trunc(Number(row.satoshis) || 0));
          creditUtxo(outpoint, { satoshis: sats });
          empty.restoredUnspent += 1;
          empty.restoredOutpoints.push(outpoint);
        }
      });
    } catch (err) {
      console.warn("[stale-output] evidence restore failed", err);
    }
  }

  empty.checked = verdicts.size;
  empty.unknown = [...verdicts.values()].filter((v) => v === "unknown").length;
  console.info(
    `[stale-output] evidence heal checked=${empty.checked} spent=${empty.hiddenSpent} restored=${empty.restoredUnspent} quarantined=${empty.quarantined} unknown=${empty.unknown}`
  );
  return empty;
}

/**
 * Write off outputs the network refuses to spend. Prefer
 * {@link hideSpentOutpoints} with the rejected tx's inputs — a bulk review
 * treats unseen unconfirmed change as dead and hides live coins.
 *
 * @returns how many outputs were released.
 */
export async function releaseStaleSpendableOutputs(): Promise<number> {
  const result = await reconcileKnownUtxosByEvidence();
  return result.hiddenSpent + result.quarantined;
}

/**
 * After already-spent: hide those inputs, keep this tx's change, restore only
 * live local change — never a bulk indexer rewrite of the spendable set.
 */
export async function onAlreadySpentSend(args: {
  txid?: string;
  atomic?: number[];
}): Promise<void> {
  const txid = args.txid?.trim().toLowerCase();
  let inputs: string[] = [];
  if (txid && args.atomic?.length) {
    inputs = inputOutpointsFromAtomicBeef(args.atomic, txid);
  }
  if (txid && inputs.length === 0) {
    const raw = await loadLocalRawTx(txid);
    if (raw?.length) inputs = inputOutpointsFromRawTx(raw);
  }
  if (inputs.length > 0) {
    // Keep the sealing txid on the overlay. Calling hide without spentBy used to
    // wipe it to '', so reclaim could not match dead sealers and restore left
    // hundreds of inputs “locally-spent” forever (failed consolidate).
    const hidden = await hideSpentOutpoints(inputs, txid);
    console.info(
      `[stale-output] hid ${hidden} already-spent input(s) without deleting them`
    );
  }
  if (txid) await keepChangeOfSignedTx(txid);
  // Do not run restore here — it blocked for minutes on large wallets (explorer
  // down) while already-spent hide left spendable=0. Callers / heal reclaim.
}

/** @deprecated Use {@link onAlreadySpentSend} so live change is not bulk-released. */
export async function releaseThenRestoreStaleOutputs(): Promise<void> {
  await restoreLiveSpendableOutputs({ onlyLiveChange: true });
}

/**
 * Mark the inputs a just-signed spend consumed as unspendable, immediately.
 *
 * `createAction` returns a signed transaction whose inputs are gone, but the
 * toolbox rows can still read `spendable: true`. The pass that repaired that —
 * {@link rehideInputsOfLiveLocalTxs} — is chain-ingest maintenance and returns
 * early while a spend is queued, which is exactly the state a burst of sends
 * holds. So back-to-back sends could re-select a coin the previous send had
 * already spent: every broadcaster rejected the second transaction as a double
 * spend and the send failed "Already spent".
 *
 * This runs on the spend path and is deliberately *not* gated on
 * `shouldYieldChainIngestToSpend()` — it is the spend's own bookkeeping, not
 * maintenance that may defer. Rows are hidden, never deleted, so a transaction
 * that ultimately fails can still have its change and inputs recovered.
 */
export async function sealSpentInputsOfSignedTx(
  txid: string | undefined,
  atomic: number[] | undefined
): Promise<number> {
  const id = txid?.trim().toLowerCase();
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return 0;

  let inputs: string[] = [];
  if (atomic?.length) inputs = inputOutpointsFromAtomicBeef(atomic, id);
  if (inputs.length === 0) {
    const raw = await loadLocalRawTx(id);
    if (raw?.length) inputs = inputOutpointsFromRawTx(raw);
  }
  if (inputs.length === 0) return 0;

  const hidden = await hideSpentOutpoints(inputs, id);
  if (hidden > 0) {
    console.info(
      `[stale-output] sealed ${hidden} input(s) spent by ${id.slice(
        0,
        12
      )} — next send cannot reselect them`
    );
  }
  // Promote this tx's change immediately so the spend queue can chain the next
  // payment without waiting for chain ingest (restoreLiveSpendableOutputs yields
  // while a spend holds priority).
  await keepChangeOfSignedTx(id);
  return hidden;
}

/**
 * Undo {@link sealSpentInputsOfSignedTx} for a transaction that never broadcast.
 *
 * The seal is placed before the broadcast, so a send that dies in transport
 * leaves live coins retired. On an offline device every broadcaster errors and
 * some of them report that as a double spend, so each failed attempt used to
 * eat another handful of inputs: spendable balance fell with nothing on chain
 * to show for it, and every later send failed "Already spent".
 *
 * Only call this when no service claimed the inputs are gone — a `doubleSpend`
 * or `missingInputs` verdict means they really are spent and must stay sealed.
 * If the transaction does turn up, chain ingest re-hides these inputs from the
 * indexer's own view.
 */
export async function releaseSealedInputsOfUnsentTx(
  txid: string | undefined,
  atomic: number[] | undefined
): Promise<number> {
  const id = txid?.trim().toLowerCase();
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return 0;

  let inputs: string[] = [];
  if (atomic?.length) inputs = inputOutpointsFromAtomicBeef(atomic, id);
  if (inputs.length === 0) {
    const raw = await loadLocalRawTx(id);
    if (raw?.length) inputs = inputOutpointsFromRawTx(raw);
  }
  if (inputs.length === 0) return 0;

  const unique = [...new Set(inputs.map((o) => o.trim()).filter(Boolean))];
  for (let i = 0; i < unique.length; i++) {
    if (i > 0 && i % 8 === 0) await yieldToUi();
    releaseConsumedUtxo(unique[i]!, `unsent:${id.slice(0, 12)}`);
  }

  const storage = getActiveWallet()?.wallet?.storage;
  if (storage?.runAsStorageProvider) {
    try {
      await storage.runAsStorageProvider(async (activeSp) => {
        const sp = activeSp as unknown as LocalStorage;
        for (let i = 0; i < unique.length; i++) {
          if (i > 0 && i % 8 === 0) await yieldToUi();
          const op = unique[i]!;
          const parsed = parseOutpoint(op);
          if (!parsed) continue;
          const rows = await findOutputsForTxid(sp, parsed.txid);
          const match = rows.find(
            (row) => Number(row.vout ?? row.outputIndex) === parsed.vout
          );
          const outputId = positiveId(match?.outputId);
          if (outputId == null) continue;
          try {
            await sp.updateOutput(outputId, {
              spendable: true,
              spentBy: undefined,
            });
          } catch (err) {
            console.warn(
              "[stale-output] unseal spendable=true skipped",
              op,
              err
            );
          }
        }
      });
    } catch (err) {
      console.warn("[stale-output] unseal toolbox rows skipped", err);
    }
  }

  console.info(
    `[stale-output] released ${unique.length} input(s) of ${id.slice(
      0,
      12
    )} — never reached a node`
  );
  // Inputs are free again; the local signed row must not keep crediting pending
  // change or looking "live" to heal/promote (lab: cb36a9099dfc × pendingChange).
  await failUnsentLocalTx(id, { force: true });
  return unique.length;
}

/**
 * Mark a signed local tx as failed and retire its outputs.
 *
 * Default refuses live `unmined`/`sending` rows — explorer lag after a
 * successful submit is not a ghost. Pass `{ force: true }` only when this
 * caller already proved the spend never reached a node (unseal path).
 */
export async function failUnsentLocalTx(
  txid: string,
  opts?: { force?: boolean }
): Promise<boolean> {
  const id = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return false;
  const storage = getActiveWallet()?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return false;

  try {
    const failed = await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      if (typeof sp.findTransactions !== "function") return false;

      let rows: TxStatusRow[] | undefined;
      try {
        rows = await sp.findTransactions({
          partial: { txid: id },
          noRawTx: true,
          paged: { limit: 1, offset: 0 },
        });
      } catch (err) {
        if (!isUndefinedPartialFilterError(err)) {
          console.warn(
            "[stale-output] fail-unsent tx lookup skipped",
            id.slice(0, 12),
            err
          );
        }
        return false;
      }
      const row = rows?.[0] as
        | (TxStatusRow & { transactionId?: number; status?: string })
        | undefined;
      const transactionId = positiveId(row?.transactionId);
      if (transactionId == null) return false;

      const status = String(row?.status ?? "").toLowerCase();
      if (status === "failed" || status === "completed") return false;
      // Submit ACK is success. Explorers lag for minutes after Arcade accepts
      // the BEEF (hc-a580a: unmined + post.status success, then send-cleanup
      // heal marked the tx failed and un-deducted change).
      // Item `noSend` rows stay `unsent` until processAction — Arcade pin is
      // the commit signal (hc-ad7afb: 3aba0b7a fox send reclaimed 20s later).
      if (
        !opts?.force &&
        (isLiveLocalTxStatus(status) || txHadArcadeSubmitContact(id))
      ) {
        console.info(
          `[stale-output] skip fail-unsent — ${id.slice(0, 12)} still ${
            txHadArcadeSubmitContact(id) ? "Arcade-pinned" : status
          } after submit`
        );
        return false;
      }

      if (typeof sp.updateTransactionStatus === "function") {
        try {
          await sp.updateTransactionStatus("failed", transactionId);
        } catch (err) {
          console.warn(
            "[stale-output] fail-unsent status skipped",
            id.slice(0, 12),
            err
          );
        }
      }

      const outs = await findOutputsForTxid(sp, id);
      for (const out of outs) {
        const outputId = positiveId(out.outputId);
        if (outputId == null) continue;
        try {
          await sp.updateOutput(outputId, {
            spendable: false,
            spentBy: undefined,
          });
        } catch (err) {
          console.warn(
            "[stale-output] fail-unsent output skipped",
            outputId,
            err
          );
        }
      }
      return true;
    });
    if (failed) {
      console.info(
        `[stale-output] failed ghost local tx ${id.slice(
          0,
          12
        )} — pending change retired`
      );
    }
    return failed === true;
  } catch (err) {
    console.warn("[stale-output] fail-unsent skipped", id.slice(0, 12), err);
    return false;
  }
}

/**
 * Revive a local tx so `internalizeAction` can merge into it.
 *
 * Toolbox refuses merge unless status is completed/unproven/sending/nosend,
 * and `updateTransactionStatus` cannot un-fail a `failed` row. Ghost-fail from
 * explorer lag (hc-a580a ad40b4db) leaves an on-chain send stuck `failed`,
 * then BRC-29 ingest throws `invalid status failed`.
 *
 * Failed rows restore only when `txExistsOnChain === true`. Live monitor
 * statuses (unmined/callback/…) coerce to unproven without an explorer trip.
 */
export async function restoreOnChainLocalTx(txid: string): Promise<boolean> {
  const id = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return false;
  const active = getActiveWallet();
  const storage = active?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return false;

  try {
    const looked = await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      if (typeof sp.findTransactions !== "function") return null;
      let rows: TxStatusRow[] | undefined;
      try {
        rows = await sp.findTransactions({
          partial: { txid: id },
          noRawTx: true,
          paged: { limit: 1, offset: 0 },
        });
      } catch (err) {
        if (!isUndefinedPartialFilterError(err)) {
          console.warn(
            "[stale-output] restore tx lookup skipped",
            id.slice(0, 12),
            err
          );
        }
        return null;
      }
      const row = rows?.[0];
      const transactionId = positiveId(row?.transactionId);
      if (transactionId == null) return null;
      return {
        transactionId,
        status: String(row?.status ?? "").toLowerCase(),
      };
    });
    if (!looked) return false;
    if (INTERNALIZE_OK_TX.has(looked.status)) return false;

    if (looked.status === "failed") {
      const chain = active?.chain;
      if (!chain) return false;
      const onChain = await txExistsOnChain(id, chain).catch(() => null);
      if (onChain !== true) {
        console.info(
          `[stale-output] skip restore ${id.slice(
            0,
            12
          )} failed — on-chain=${onChain}`
        );
        return false;
      }
    }

    const restored = await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      if (looked.status === "failed") {
        // updateTransactionStatus refuses un-fail; write the row directly.
        if (typeof sp.updateTransaction !== "function") return false;
        await sp.updateTransaction(looked.transactionId, {
          status: "unproven",
        });
        return true;
      }
      if (typeof sp.updateTransactionStatus === "function") {
        try {
          await sp.updateTransactionStatus("unproven", looked.transactionId);
          return true;
        } catch (err) {
          console.warn(
            "[stale-output] restore status coerce skipped",
            id.slice(0, 12),
            err
          );
        }
      }
      if (typeof sp.updateTransaction !== "function") return false;
      await sp.updateTransaction(looked.transactionId, { status: "unproven" });
      return true;
    });
    if (!restored) return false;

    console.info(
      `[stale-output] restored on-chain local tx ${id.slice(0, 12)} ${
        looked.status
      } → unproven`
    );
    void import("./appActivity")
      .then(({ reviveFailedOutboundByTxid }) => reviveFailedOutboundByTxid(id))
      .catch(() => undefined);
    // Seal spent inputs first — keep-then-seal left inputs spendable while
    // change was already counted (same ~2× class as sibling abort).
    await sealSpentInputsOfSignedTx(id, undefined);
    await keepChangeOfSignedTx(id);
    return true;
  } catch (err) {
    console.warn("[stale-output] restore skipped", id.slice(0, 12), err);
    return false;
  }
}

/** Failed local txids that may need an on-chain restore (capped). */
export async function listFailedLocalTxids(): Promise<string[]> {
  const active = getActiveWallet();
  const storage = active?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return [];

  const txids = new Set<string>();
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as LocalStorage;
      if (typeof sp.findTransactions !== "function") return;
      for (let page = 0; page < 2; page += 1) {
        const rows = await sp.findTransactions({
          partial: {},
          status: ["failed"],
          noRawTx: true,
          paged: { limit: 25, offset: page * 25 },
        });
        if (!rows?.length) break;
        for (const row of rows) {
          const txid = String(row.txid ?? "")
            .trim()
            .toLowerCase();
          if (/^[0-9a-f]{64}$/.test(txid)) txids.add(txid);
        }
        if (rows.length < 25) break;
      }
    });
  } catch (err) {
    console.warn("[stale-output] failed tx scan skipped", err);
  }
  return [...txids];
}

/**
 * Cloud false-negative pass: a local `failed` row whose tx is actually known
 * on chain is restored as that transaction, not by editing its outputs.
 */
export async function restoreFailedLocalTxsKnownOnChain(): Promise<number> {
  const txids = await listFailedLocalTxids();
  let restored = 0;
  for (const txid of txids) {
    if (await restoreOnChainLocalTx(txid)) restored += 1;
  }
  return restored;
}

/**
 * Hide these outpoints as consumed by a named spending transaction.
 * Without a spender txid this is quarantine, not a fake `spentBy: ''` consume —
 * Cloud would not mark chain-spent until it could insert the spending tx.
 */
export async function hideSpentOutpoints(
  outpoints: string[],
  spentBy?: string
): Promise<number> {
  if (!isNamedSpenderTxid(spentBy)) {
    return quarantineSpentOutpoints(outpoints);
  }
  const unique = [...new Set(outpoints.map((o) => o.trim()).filter(Boolean))];
  if (unique.length === 0) return 0;
  const id = spentBy!.trim().toLowerCase();
  for (let i = 0; i < unique.length; i++) {
    if (i > 0 && i % 8 === 0) await yieldToUi();
    hideUtxo(unique[i]!, {
      spentBy: id,
      diagnostic: `spent-by:${id.slice(0, 12)}`,
    });
  }
  return hideToolboxOutputs(unique);
}

/** Freeze coins the chain shows spent until the spender body can be inserted. */
export async function quarantineSpentOutpoints(
  outpoints: string[]
): Promise<number> {
  const unique = [...new Set(outpoints.map((o) => o.trim()).filter(Boolean))];
  if (unique.length === 0) return 0;
  for (let i = 0; i < unique.length; i++) {
    if (i > 0 && i % 8 === 0) await yieldToUi();
    hideUtxo(unique[i]!, { diagnostic: "quarantine:spent-unknown" });
  }
  return hideToolboxOutputs(unique);
}

async function hideToolboxOutputs(unique: string[]): Promise<number> {
  const active = getActiveWallet();
  const storage = active?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return unique.length;
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      for (let i = 0; i < unique.length; i++) {
        if (i > 0 && i % 8 === 0) await yieldToUi();
        const op = unique[i]!;
        const parsed = parseOutpoint(op);
        if (!parsed) continue;
        const rows = await findOutputsForTxid(sp, parsed.txid);
        const match = rows.find(
          (row) => Number(row.vout ?? row.outputIndex) === parsed.vout
        );
        const outputId = positiveId(match?.outputId);
        if (outputId == null) continue;
        try {
          await sp.updateOutput(outputId, { spendable: false });
        } catch (err) {
          console.warn("[stale-output] hide spendable=false skipped", op, err);
        }
      }
    });
  } catch (err) {
    console.warn("[stale-output] hide toolbox rows skipped", err);
  }
  return unique.length;
}

/**
 * Re-enable one asset basket row only after a live UTXO service proves the
 * outpoint is unspent. Failed/aborted asset spends can leave `spentBy` on the
 * toolbox row, while the inscription remains on chain and in the display cache.
 */
export async function restoreUnspentAssetOutpoint(
  active: ActiveWallet,
  outpoint: string
): Promise<boolean> {
  if (isItemSent(outpoint)) return false;
  const parsed = parseOutpoint(outpoint);
  if (!parsed) return false;

  let unspent = false;
  const isUtxo = active.services?.isUtxo;
  if (typeof isUtxo === "function") {
    try {
      const result = await isUtxo({
        txid: parsed.txid,
        vout: parsed.vout,
      } as never);
      unspent =
        result === true ||
        (!!result &&
          typeof result === "object" &&
          (result as { isUtxo?: unknown }).isUtxo === true);
    } catch {
      unspent = false;
    }
  }
  if (!unspent) {
    unspent =
      (await spentStatusOfOutpoint(outpoint, active.chain).catch(
        () => "unknown" as const
      )) === "unspent";
  }
  if (!unspent) return false;
  // A spend may have completed while the provider check was in flight. Local
  // confirmed-consumption state always outranks a lagging "unspent" response.
  if (isItemSent(outpoint)) return false;

  const storage = active.wallet.storage;
  if (!storage?.runAsStorageProvider) return false;
  let restored = false;
  await storage.runAsStorageProvider(async (activeSp) => {
    const sp = activeSp as unknown as LocalStorage;
    const rows = await findOutputsForTxid(sp, parsed.txid);
    const row = rows.find(
      (candidate) =>
        Number(candidate.vout ?? candidate.outputIndex) === parsed.vout
    );
    const outputId = positiveId(row?.outputId);
    if (outputId == null) return;
    await sp.updateOutput(outputId, {
      spendable: true,
      spentBy: undefined,
    });
    restored = true;
  });
  if (!restored) return false;

  const released = releaseConsumedUtxo(
    outpoint,
    "restore:asset-proven-unspent"
  );
  if (!released) creditUtxo(outpoint, { satoshis: 1 });
  console.info(`[stale-output] restored proven-unspent asset ${outpoint}`);
  return true;
}

/** Sealed coins to re-check per pass, so a long-lived wallet cannot stall. */
const RECLAIM_MAX = 200;

/**
 * Give back coins sealed for a spend that never made it onto the chain.
 *
 * A send seals its inputs before broadcasting. When the broadcast dies in
 * transport the coins stay retired, and on a device that was offline for a
 * while those add up until spendable balance is visibly short and further
 * sends fail "Already spent". {@link releaseSealedInputsOfUnsentTx} handles the
 * attempt that is failing right now; this recovers the ones already stranded.
 *
 * When explorers prove the sealing tx never landed (`txExists === false`), revive
 * those inputs without waiting on indexer `isUtxo`. Named seals and blank seals
 * (spentBy wiped by older hide paths) are both considered in one pass.
 */
export async function reclaimSealedInputsNeverSpent(opts?: {
  /** Spend-path reclaim — do not defer while a send holds spend priority. */
  forSpendChain?: boolean;
}): Promise<number> {
  const forSpendChain = opts?.forSpendChain === true;
  if (!forSpendChain && shouldYieldChainIngestToSpend()) return 0;
  const active = getActiveWallet();
  const isUtxo = active?.services?.isUtxo;
  const storage = active?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return 0;

  const sealedNamed = listUtxoLocks()
    .filter((rec) => !!rec.spentBy && /^[0-9a-f]{64}$/.test(rec.spentBy))
    .slice(0, RECLAIM_MAX);
  const sealedBlank = listUtxoLocks()
    .filter(
      (rec) =>
        rec.spendable === false &&
        (!rec.spentBy || !/^[0-9a-f]{64}$/.test(rec.spentBy))
    )
    .slice(0, RECLAIM_MAX);
  if (sealedNamed.length === 0 && sealedBlank.length === 0) return 0;

  let revived = 0;

  // Named and blank seals both matter — skipping blank whenever any named seal
  // remained left ~144 overlay-hidden coins stuck after ghost consolidate.
  if (sealedBlank.length > 0 && typeof isUtxo === "function") {
    const reviveBlank: string[] = [];
    for (const rec of sealedBlank) {
      if (!forSpendChain && shouldYieldChainIngestToSpend()) break;
      const parsed = parseOutpoint(rec.outpoint);
      if (!parsed) continue;
      try {
        const result = await isUtxo({
          txid: parsed.txid,
          vout: parsed.vout,
        } as never);
        const alive =
          result === true ||
          (!!result &&
            typeof result === "object" &&
            (result as { isUtxo?: unknown }).isUtxo === true);
        if (alive) reviveBlank.push(rec.outpoint);
      } catch {
        /* leave sealed */
      }
    }
    if (reviveBlank.length > 0) {
      for (const outpoint of reviveBlank) {
        releaseConsumedUtxo(outpoint, "reclaim:blank-sealer");
      }
      try {
        await storage.runAsStorageProvider(async (activeSp) => {
          const sp = activeSp as unknown as LocalStorage;
          for (const outpoint of reviveBlank) {
            const parsed = parseOutpoint(outpoint);
            if (!parsed) continue;
            const rows = await findOutputsForTxid(sp, parsed.txid);
            const match = rows.find(
              (row) => Number(row.vout ?? row.outputIndex) === parsed.vout
            );
            const outputId = positiveId(match?.outputId);
            if (outputId == null) continue;
            try {
              await sp.updateOutput(outputId, {
                spendable: true,
                spentBy: undefined,
              });
            } catch (err) {
              console.warn(
                "[stale-output] reclaim spendable=true skipped",
                outpoint,
                err
              );
            }
          }
        });
      } catch (err) {
        console.warn("[stale-output] reclaim toolbox rows skipped", err);
      }
      console.info(
        `[stale-output] reclaimed ${reviveBlank.length} blank-sealer input(s) still unspent`
      );
      revived += reviveBlank.length;
    }
  }

  if (sealedNamed.length === 0) return revived;

  const sealerIds = [
    ...new Set(sealedNamed.map((rec) => rec.spentBy as string)),
  ];
  const liveSealers = new Set<string>();
  const deadSealers = new Set<string>();
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      if (typeof sp.findTransactions !== "function") return;
      for (const txid of sealerIds) {
        try {
          const rows = await sp.findTransactions({
            partial: { txid },
            paged: { limit: 1, offset: 0 },
          });
          const status = String(rows?.[0]?.status ?? "").toLowerCase();
          // Arcade contact is propagation, not a competing spend. A pin still
          // has to survive {@link signedTxMayBeRemoved} so a cheque whose
          // inputs actually moved elsewhere can be failed.
          // Missing local row is common for app createAction seals — never treat
          // absence as a ghost (that revived spent inputs and bounced the hero
          // 47¢→23¢→70¢ with no Activity). Leave unclassified for Arcade/chain.
          if (!rows?.length) {
            continue;
          }
          // `unsent` alone is not a ghost — app createAction / noSend often
          // stay unsent while Arcade already has the BEEF. Only hard-fail
          // statuses revive without explorers; unsent goes to Arcade/chain.
          if (
            status === "failed" ||
            status === "doublespend" ||
            status === "invalid"
          ) {
            deadSealers.add(txid);
            liveSealers.delete(txid);
          } else if (rows.some((row) => isLiveLocalTxStatus(row?.status))) {
            liveSealers.add(txid);
          }
          // status === 'unsent' (and other unknowns): leave unclassified.
        } catch (err) {
          if (!isUndefinedPartialFilterError(err)) {
            console.warn(
              "[stale-output] sealer status skipped",
              txid.slice(0, 12),
              err
            );
          }
          // Do not assume live on lookup failure — leave unclassified for chain check.
        }
      }
    });
  } catch (err) {
    console.warn("[stale-output] reclaim status sweep skipped", err);
    return revived;
  }

  const chain = active?.chain;
  if (chain) {
    for (const txid of sealerIds) {
      // "Live" is a local status, not immunity from a proven competing spend.
      // The poisoned 46-input consolidations stayed live forever and Heal
      // resealed them on every pass. Promote to dead only on real conflict.
      if (liveSealers.has(txid)) {
        const conflict = await signedTxSpendConflictIsProven({
          txid,
          chain,
        });
        if (!conflict) continue;
        liveSealers.delete(txid);
        deadSealers.add(txid);
        await failUnsentLocalTx(txid, { force: true });
        continue;
      }
      if (deadSealers.has(txid)) continue;
      if (!(await signedTxMayBeRemoved({ txid, chain }))) {
        liveSealers.add(txid);
        deadSealers.delete(txid);
        console.info(
          `[stale-output] skip reclaim — ${txid.slice(0, 12)} Arcade-pinned`
        );
        continue;
      }
      const onChain = await txExistsOnChain(txid, chain).catch(() => null);
      if (onChain === true) {
        liveSealers.add(txid);
        deadSealers.delete(txid);
        continue;
      }
      // Missing local row + explorer absence is not cancellation evidence.
      // Signed cheques survive; only explicit failed/invalid status above or a
      // proven competing spend can make a named sealer reclaimable.
    }
    if (deadSealers.size > 0) {
      console.info(
        `[stale-output] reclaiming seal(s) from ${deadSealers.size} unsent local tx(s)`
      );
    }
  }

  const revive: string[] = [];
  for (const rec of sealedNamed) {
    if (!forSpendChain && shouldYieldChainIngestToSpend()) break;
    const sealer = rec.spentBy as string;
    if (!deadSealers.has(sealer)) continue;

    // A conflicting multi-input transaction can have one input spent by the
    // winner and many siblings still unspent. Verify every sibling; reviving
    // the whole group reintroduced the actually-spent coin and poisoned the
    // next consolidation.
    const parsed = parseOutpoint(rec.outpoint);
    if (!parsed) continue;
    let unspent = false;
    if (typeof isUtxo === "function") {
      try {
        const result = await isUtxo({
          txid: parsed.txid,
          vout: parsed.vout,
        } as never);
        unspent =
          result === true ||
          (!!result &&
            typeof result === "object" &&
            (result as { isUtxo?: unknown }).isUtxo === true);
      } catch {
        unspent = false;
      }
    }
    if (!unspent && chain) {
      const status = await spentStatusOfOutpoint(rec.outpoint, chain).catch(
        () => "unknown" as const
      );
      if (status === "unspent") {
        unspent =
          (await txExistsOnChain(parsed.txid, chain).catch(() => null)) ===
          true;
      }
    }
    if (unspent) revive.push(rec.outpoint);
  }
  if (revive.length === 0) return revived;

  for (const outpoint of revive)
    releaseConsumedUtxo(outpoint, "reclaim:never-spent");
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      for (const outpoint of revive) {
        const parsed = parseOutpoint(outpoint);
        if (!parsed) continue;
        const rows = await findOutputsForTxid(sp, parsed.txid);
        const match = rows.find(
          (row) => Number(row.vout ?? row.outputIndex) === parsed.vout
        );
        const outputId = positiveId(match?.outputId);
        if (outputId == null) continue;
        try {
          await sp.updateOutput(outputId, {
            spendable: true,
            spentBy: undefined,
          });
        } catch (err) {
          console.warn(
            "[stale-output] reclaim spendable=true skipped",
            outpoint,
            err
          );
        }
      }
    });
  } catch (err) {
    console.warn("[stale-output] reclaim toolbox rows skipped", err);
  }

  console.info(
    `[stale-output] reclaimed ${revive.length} sealed input(s) never spent on chain`
  );
  return revived + revive.length;
}

/**
 * After an app `createAction`: hide spent inputs and promote this tx's unspent
 * outs so the next bet / payout spend can chain without waiting on confirmation.
 */
/**
 * App `noSend` / `unsent` change must not become the next app's fee input —
 * that chains an unbroadcast parent and Arcade rejects with missing-inputs.
 * Promote only once the wallet (or Arcade) has taken the tx past that hold.
 */
async function appCreateActionChangeReadyToPromote(
  txid: string
): Promise<boolean> {
  const id = txid.trim().toLowerCase();
  if (txHadArcadeSubmitContact(id)) return true;
  const storage = getActiveWallet()?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return false;
  try {
    const status = await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      if (typeof sp.findTransactions !== "function") return null;
      let rows: TxStatusRow[] | undefined;
      try {
        rows = await sp.findTransactions({
          partial: { txid: id },
          noRawTx: true,
          paged: { limit: 1, offset: 0 },
        });
      } catch (err) {
        if (!isUndefinedPartialFilterError(err)) {
          console.warn(
            "[stale-output] app-change status lookup skipped",
            id.slice(0, 12),
            err
          );
        }
        return null;
      }
      return String(rows?.[0]?.status ?? "").toLowerCase() || null;
    });
    if (!status) return false;
    // App still owns broadcast — leave change unspendable so other apps pick
    // confirmed / unrelated UTXOs instead of chaining this parent.
    if (status === "unsent" || status === "nosend") return false;
    if (status === "failed") return false;
    return isLiveLocalTxStatus(status);
  } catch (err) {
    console.warn(
      "[stale-output] app-change promote gate skipped",
      id.slice(0, 12),
      err
    );
    return false;
  }
}

export async function sealAfterAppCreateAction(
  txid: string,
  result: unknown
): Promise<void> {
  const id = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return;
  try {
    const { inputOutpointsFromAtomicBeef, inputOutpointsFromRawTx } =
      await import("./txOutpoints");
    const raw = (result as { tx?: unknown } | null)?.tx;
    let inputs: string[] = [];
    if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) {
      const binary = raw as number[];
      inputs = inputOutpointsFromAtomicBeef(binary, id);
      if (inputs.length === 0) inputs = inputOutpointsFromRawTx(binary);
    } else if (raw instanceof Uint8Array) {
      const binary = Array.from(raw);
      inputs = inputOutpointsFromAtomicBeef(binary, id);
      if (inputs.length === 0) inputs = inputOutpointsFromRawTx(binary);
    }
    if (inputs.length > 0) await hideSpentOutpoints(inputs, id);
  } catch (err) {
    console.warn("[stale-output] seal inputs after createAction skipped", err);
  }
  try {
    if (await appCreateActionChangeReadyToPromote(id)) {
      await keepChangeOfSignedTx(id);
    } else {
      console.info(
        `[stale-output] defer change promote for ${id.slice(
          0,
          12
        )} — unsent/noSend; next app uses fresh UTXOs`
      );
    }
  } catch (err) {
    console.warn("[stale-output] keep change after createAction skipped", err);
  }
  // Hero reads coalesced Wallet.balance() — toolbox spendable just changed.
  // Always invalidate after an app createAction seal pass; even a partial
  // hide/keep (or a missed input parse) must not leave yesterday's sats painted.
  try {
    const { bumpBalanceAfterHeal } = await import("./session");
    bumpBalanceAfterHeal();
  } catch (err) {
    console.warn(
      "[stale-output] post-createAction balance refresh skipped",
      err
    );
  }
}

/**
 * Mark this wallet's unspent default-basket outs of `txid` spendable so the next
 * createAction can chain them — change after a broadcast/Arcade-pinned app spend,
 * or BSV the app just internalized — without waiting on indexer confirmation.
 *
 * Callers that seal an app `noSend`/`unsent` createAction must not invoke this
 * until broadcast/Arcade pin; otherwise the next app chains an unbroadcast parent.
 *
 * Item / BSV-21 basket tips stay untouched (identity remittance path).
 */
export async function keepChangeOfSignedTx(txid: string): Promise<number> {
  const id = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return 0;
  const active = getActiveWallet();
  const storage = active?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return 0;

  try {
    return (await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      const rows = await findOutputsForTxid(sp, id);
      const txCache = new Map<number, TxStatusRow | null>();
      let kept = 0;
      for (const row of rows) {
        const outputId = positiveId(row.outputId);
        const outpoint = outpointFromOutput(row);
        if (outputId == null || !outpoint) continue;
        if (positiveId(row.spentBy) != null) continue;
        const basket = String(row.basket ?? "").toLowerCase();
        if (basket === "1sat" || basket === "bsv21") continue;
        const sats = Math.max(0, Math.trunc(Number(row.satoshis) || 0));
        // Change after createAction *and* plain BSV received via internalize —
        // apps must chain either without waiting for confirmation.
        if (sats < 1) continue;
        // Already spendable — do not re-write / re-log every ingest tick
        // (Arcade-pinned sends with explorer 404 were promoting forever).
        if (row.spendable === true) continue;

        const healed = await healLockingScript(sp, row, txCache);
        const scripted = healed != null || hasLockingScript(row);
        if (!scripted) continue;

        await sp.updateOutput(outputId, {
          spendable: true,
          spentBy: undefined,
          ...(healed != null ? { lockingScript: healed } : {}),
        });
        creditUtxo(outpoint, { satoshis: sats });
        kept += 1;
      }
      if (kept > 0) {
        console.info(
          `[stale-output] kept ${kept} spendable output(s) of ${id.slice(
            0,
            12
          )}`
        );
      }
      return kept;
    })) as number;
  } catch (err) {
    console.warn("[stale-output] keep change skipped", id.slice(0, 12), err);
    return 0;
  }
}

/** Statuses whose change outputs may still be unspendable in the toolbox.
 *  Omit `nosend`/`unsent` — app-held broadcasts must not feed the next app's
 *  fee selection until Arcade/processAction pins them.
 */
const PENDING_CHANGE_TX_STATUSES = [
  "sending",
  "unproven",
  "nonfinal",
  "unfail",
  "unmined",
  "callback",
  "unconfirmed",
  "unknown",
] as const;

/** Live local send txids whose change may still be unspendable. */
export async function listPendingLocalChangeTxids(): Promise<string[]> {
  const active = getActiveWallet();
  const storage = active?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return [];

  const txids = new Set<string>();
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as LocalStorage;
      if (typeof sp.findTransactions !== "function") return;
      for (const status of PENDING_CHANGE_TX_STATUSES) {
        for (let page = 0; page < 5; page += 1) {
          const rows = await sp.findTransactions({
            partial: {},
            status: [status],
            noRawTx: true,
            paged: { limit: 25, offset: page * 25 },
          });
          if (!rows?.length) break;
          for (const row of rows) {
            const txid = String(row.txid ?? "")
              .trim()
              .toLowerCase();
            if (/^[0-9a-f]{64}$/.test(txid)) txids.add(txid);
          }
          if (rows.length < 25) break;
        }
      }
    });
  } catch (err) {
    console.warn("[stale-output] pending tx scan skipped", err);
  }
  return [...txids];
}

/**
 * Promote change from live local sends without paging the whole unspendable set.
 *
 * `restoreLiveSpendableOutputs` only inspects the first {@link RESTORE_MAX} dead
 * rows. Wallets with hundreds of historical script-less change rows never reach
 * a small pending credit (e.g. 8822 sats) — displayed balance includes it but
 * Pay cannot select it. This walks pending local txids and calls
 * {@link keepChangeOfSignedTx} for each.
 */
export async function promotePendingLocalChangeOutputs(opts?: {
  forSpendChain?: boolean;
  /** Retained for caller compatibility; promotion is now always local-only. */
  localOnly?: boolean;
}): Promise<number> {
  const forSpendChain = opts?.forSpendChain === true;
  if (!forSpendChain && shouldYieldChainIngestToSpend()) return 0;
  const active = getActiveWallet();
  const storage = active?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return 0;

  const txids = new Set(await listPendingLocalChangeTxids());
  if (txids.size === 0) return 0;

  let promoted = 0;
  let sealedTotal = 0;
  for (const txid of txids) {
    if (!forSpendChain && shouldYieldChainIngestToSpend()) break;
    // Pending change is local signed state. Explorer absence cannot fail it;
    // competing-spend reconciliation runs separately and proof-first.
    // Same order as utxoHealFromHistory: seal spent inputs FIRST, then keep
    // change. Promoting change while inputs are still spendable is the classic
    // ~2× balance (sibling-abort / Arcade-pin promote without reseal).
    // sealSpentInputsOfSignedTx also keepChange's when it finds inputs; the
    // second keep is a no-op once change is already spendable.
    const sealed = await sealSpentInputsOfSignedTx(txid, undefined);
    sealedTotal += sealed;
    promoted += await keepChangeOfSignedTx(txid);
  }
  if (promoted > 0 || sealedTotal > 0) {
    console.info(
      `[stale-output] promoted ${promoted} pending local change output(s), sealed ${sealedTotal} input(s) from ${txids.size} live tx(s)`
    );
    // Foundation: hero = spendable UTXOs. Toolbox just changed — force a
    // fresh Wallet.balance() publish, do not reuse a coalesced read.
    try {
      const { bumpBalanceAfterHeal } = await import("./session");
      bumpBalanceAfterHeal();
    } catch (err) {
      console.warn("[stale-output] post-promote balance refresh skipped", err);
    }
  }
  return promoted;
}

async function loadLocalRawTx(txid: string): Promise<number[] | null> {
  const storage = getActiveWallet()?.wallet?.storage;
  if (!storage?.runAsStorageProvider) return null;
  try {
    const found = await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      if (typeof sp.getProvenOrRawTx !== "function") return undefined;
      return sp.getProvenOrRawTx(txid);
    });
    const raw = found?.rawTx;
    return Array.isArray(raw) && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

async function findOutputsForTxid(
  sp: { findOutputs?: (args: unknown) => Promise<unknown> },
  txid: string
): Promise<
  Array<ChangeRow & { outputIndex?: number; basket?: string; spentBy?: number }>
> {
  if (typeof sp.findOutputs !== "function") return [];
  try {
    const rows = await sp.findOutputs({
      partial: { txid },
      paged: { limit: 50, offset: 0 },
    });
    return Array.isArray(rows) ? (rows as never) : [];
  } catch (err) {
    if (!isUndefinedPartialFilterError(err)) {
      console.warn("[stale-output] findOutputs by txid skipped", err);
    }
    return [];
  }
}

type LocalStorage = {
  updateOutput: (
    outputId: number,
    update: Record<string, unknown>
  ) => Promise<unknown>;
  findOutputs?: (args: unknown) => Promise<unknown>;
  findTransactions?: (args: unknown) => Promise<TxStatusRow[] | undefined>;
  getProvenOrRawTx?: (
    txid: string
  ) => Promise<{ rawTx?: number[] } | undefined>;
  updateTransactionStatus?: (
    status: string,
    transactionId: number
  ) => Promise<unknown>;
  updateTransaction?: (
    transactionId: number,
    update: Record<string, unknown>
  ) => Promise<unknown>;
};

async function loadTxRow(
  sp: LocalStorage,
  transactionId: number,
  cache: Map<number, TxStatusRow | null>
): Promise<TxStatusRow | null> {
  if (cache.has(transactionId)) return cache.get(transactionId) ?? null;
  if (typeof sp.findTransactions !== "function") {
    cache.set(transactionId, null);
    return null;
  }
  try {
    const rows = await sp.findTransactions({
      partial: { transactionId },
      noRawTx: true,
      paged: { limit: 1, offset: 0 },
    });
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    cache.set(transactionId, row);
    return row;
  } catch (err) {
    console.warn("[stale-output] tx lookup skipped", transactionId, err);
    cache.set(transactionId, null);
    return null;
  }
}

async function healLockingScript(
  sp: LocalStorage,
  output: ChangeRow & { transactionId?: number; outputIndex?: number },
  txCache: Map<number, TxStatusRow | null>,
  opts?: { fromChain?: boolean }
): Promise<number[] | null> {
  if (hasLockingScript(output)) return null;

  let txRow: TxStatusRow | null = null;
  const transactionId = Number(output.transactionId);
  if (Number.isFinite(transactionId) && transactionId > 0) {
    txRow = await loadTxRow(sp, transactionId, txCache);
  }

  const resolved = resolveChangeRowOutpoint(output, txRow);
  if (!resolved?.txid) return null;

  const txid = resolved.txid;
  if (typeof sp.getProvenOrRawTx === "function") {
    try {
      const local = await sp.getProvenOrRawTx(txid);
      const fate = classifyChangeScript(
        resolved,
        local?.rawTx?.length ? local.rawTx : null
      );
      if (fate.kind === "heal") return fate.lockingScript;
    } catch (err) {
      console.warn(
        "[stale-output] change script heal skipped",
        txid.slice(0, 12),
        err
      );
    }
  }

  if (typeof sp.findTransactions === "function") {
    try {
      const rows = await sp.findTransactions({
        partial: { txid },
        noRawTx: false,
        paged: { limit: 1, offset: 0 },
      });
      const raw = rows?.[0]?.rawTx ?? txRow?.rawTx;
      if (Array.isArray(raw) && raw.length) {
        const fate = classifyChangeScript(resolved, raw);
        if (fate.kind === "heal") return fate.lockingScript;
      }
    } catch (err) {
      console.warn(
        "[stale-output] toolbox tx raw heal skipped",
        txid.slice(0, 12),
        err
      );
    }
  }

  if (opts?.fromChain !== true) return null;

  try {
    const active = getActiveWallet();
    if (!active) return null;
    const { fetchRawTxHex } = await import("./oneSatImport");
    const hex = await fetchRawTxHex(txid, active.chain);
    if (!hex) return null;
    const { Transaction } = await import("@bsv/sdk");
    const fate = classifyChangeScript(
      resolved,
      Transaction.fromHex(hex).toBinary()
    );
    return fate.kind === "heal" ? fate.lockingScript : null;
  } catch (err) {
    console.warn(
      "[stale-output] chain script heal skipped",
      txid.slice(0, 12),
      err
    );
    return null;
  }
}

/**
 * After createAction the inputs are this wallet's spent coins and the change is
 * already in storage. Rebuild locking scripts from the local raw tx so the next
 * send can select that change before any indexer has seen the payment.
 */
export async function sealLocalSpendChange(): Promise<void> {
  await sweepChangeScripts({ fromChain: false });
}

const REHIDE_TX_LIMIT = 40;

function txidFromRow(row: { txid?: unknown }): string | null {
  const txid = String(row.txid ?? "")
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(txid) ? txid : null;
}

/**
 * Hide inputs of this wallet's live local spends. Restore used to trust
 * indexer `isUtxo` and flip spent coins back to spendable (and clear
 * `spentBy`) — that inflated Pay and made the next send hang on dead coins.
 */
export async function rehideInputsOfLiveLocalTxs(): Promise<number> {
  if (shouldYieldChainIngestToSpend()) return 0;
  const active = getActiveWallet();
  const storage = active?.wallet?.storage;
  if (!storage || typeof storage.runAsStorageProvider !== "function") return 0;

  const inputs = new Set<string>();
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;
      if (typeof sp.findTransactions !== "function") return;
      let rows: TxStatusRow[] = [];
      try {
        rows =
          (await sp.findTransactions({
            partial: {},
            status: [...LIVE_LOCAL_TX],
            noRawTx: false,
            paged: { limit: REHIDE_TX_LIMIT, offset: 0 },
          })) ?? [];
      } catch (err) {
        if (!isUndefinedPartialFilterError(err)) {
          console.warn("[stale-output] live-tx list skipped", err);
        }
        for (const status of LIVE_LOCAL_TX) {
          if (shouldYieldChainIngestToSpend()) return;
          try {
            const batch = await sp.findTransactions({
              partial: { status },
              noRawTx: false,
              paged: { limit: 15, offset: 0 },
            });
            if (Array.isArray(batch)) rows.push(...batch);
          } catch (inner) {
            console.warn("[stale-output] live-tx list skipped", status, inner);
          }
        }
      }
      for (const row of rows.slice(0, REHIDE_TX_LIMIT)) {
        if (shouldYieldChainIngestToSpend()) return;
        let raw =
          Array.isArray(row.rawTx) && row.rawTx.length > 0 ? row.rawTx : null;
        const txid = txidFromRow(row);
        if (!raw && txid && typeof sp.getProvenOrRawTx === "function") {
          try {
            const found = await sp.getProvenOrRawTx(txid);
            raw =
              Array.isArray(found?.rawTx) && found.rawTx.length > 0
                ? found.rawTx
                : null;
          } catch {
            raw = null;
          }
        }
        if (!raw) continue;
        for (const op of inputOutpointsFromRawTx(raw)) inputs.add(op);
      }
    });
  } catch (err) {
    console.warn("[stale-output] rehide live inputs skipped", err);
    return 0;
  }
  if (inputs.size === 0) return 0;
  const hidden = await hideSpentOutpoints([...inputs]);
  if (hidden > 0) {
    console.info(
      `[stale-output] rehid ${hidden} input(s) of live local spends so they stay unspendable`
    );
  }
  return hidden;
}

async function loadUnspendableChange(
  // Method syntax on purpose: the toolbox signature is narrower than `unknown`,
  // and only a bivariant position accepts it.
  storage: { findOutputs(args: unknown): Promise<unknown[] | undefined> }
): Promise<unknown[]> {
  try {
    const change = await storage.findOutputs({
      partial: { spendable: false, change: true },
      paged: { limit: RESTORE_MAX, offset: 0 },
    });
    if (Array.isArray(change)) return change;
  } catch (err) {
    if (!isUndefinedPartialFilterError(err)) {
      console.warn("[stale-output] change-row lookup skipped", err);
    }
  }
  try {
    const dead = await storage.findOutputs({
      partial: { spendable: false },
      paged: { limit: RESTORE_MAX, offset: 0 },
    });
    return Array.isArray(dead) ? dead : [];
  } catch (err) {
    console.warn("[stale-output] unspendable lookup skipped", err);
    return [];
  }
}

/**
 * Re-enable change left `spendable: false` after a local send.
 *
 * Never asks the indexer `isUtxo`. Indexer lag after a spend answers `true`
 * for coins this wallet already consumed, and restoring those inflated Pay
 * and poisoned the next createAction. Overlay-hidden and locally-spent
 * inputs stay hidden.
 *
 * Restores change of **pending** local txs (still in flight) and **settled**
 * txs (`completed` locally) that never got promoted back to spendable — the
 * usual cause of `spendable=0` with a large `pendingChange` display credit.
 *
 * @returns restore counts; {@link RestoreLiveSpendableResult.unscripted} is
 * how many dead change rows lacked a locking script and were skipped.
 */
export type RestoreLiveSpendableResult = {
  restored: number;
  unscripted: number;
};

export async function restoreLiveSpendableOutputs(opts?: {
  onlyLiveChange?: boolean;
  /**
   * When set, only re-enable unspent change created by this local txid.
   * Used to chain burn fees without touching any other pending output.
   */
  creatorTxid?: string;
  /**
   * Spend-path chaining — do not yield to queued sends. Maintenance scans defer
   * while a spend holds priority; promoting pending change for the next queued
   * tx must run inside that same region.
   */
  forSpendChain?: boolean;
}): Promise<RestoreLiveSpendableResult> {
  const empty: RestoreLiveSpendableResult = { restored: 0, unscripted: 0 };
  const onlyLiveChange = opts?.onlyLiveChange === true;
  const creatorTxid = opts?.creatorTxid?.trim().toLowerCase() || null;
  const forSpendChain = opts?.forSpendChain === true;
  if (!forSpendChain && shouldYieldChainIngestToSpend()) return empty;
  const active = getActiveWallet();
  if (!active) return empty;
  const storage = active.wallet.storage;
  if (!storage || typeof storage.findOutputs !== "function") return empty;
  if (typeof storage.runAsStorageProvider !== "function") return empty;

  try {
    const dead = await loadUnspendableChange(storage);
    if (!dead.length) return empty;

    let restored = 0;
    let unscripted = 0;
    let keptSpent = 0;
    const txCache = new Map<number, TxStatusRow | null>();

    // One storage session for the whole sweep. Re-entering the provider per
    // output cost a session apiece — on a phone carrying a few hundred
    // unspendable rows that was seconds of IndexedDB churn on the UI thread,
    // paid on every refresh and after every send.
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage;

      for (const raw of dead.slice(0, RESTORE_MAX)) {
        if (!forSpendChain && shouldYieldChainIngestToSpend()) {
          console.info(
            `[stale-output] restore yielded to spend after ${restored} restore(s)`
          );
          break;
        }
        const output = raw as ChangeRow & {
          transactionId?: number;
          spentBy?: number;
          outputIndex?: number;
          basket?: string;
          change?: boolean;
          spendable?: boolean;
        };
        const outputId = positiveId(output.outputId);
        if (outputId == null) continue;
        const basket = String(output.basket ?? "").toLowerCase();
        if (basket === "1sat" || basket === "bsv21") continue;
        const overlayKey = outpointFromOutput(output);
        const overlay = overlayKey ? getUtxoLock(overlayKey) : null;
        if (overlay && isQuarantined(overlay)) {
          keptSpent += 1;
          continue;
        }
        if (overlayKey && isUtxoBlockedFromRestore(overlayKey)) {
          const lock = overlay;
          const sealer =
            lock?.spentBy && /^[0-9a-f]{64}$/.test(lock.spentBy)
              ? lock.spentBy
              : null;
          let deadSealer = false;
          if (sealer) {
            // Named seals are signed cheques. Only reclaimSealedInputsNeverSpent
            // may clear them, after a proven conflict/failed sealer and an
            // individual affirmative-unspent check.
            keptSpent += 1;
            continue;
          } else if (!sealer && active?.chain) {
            const parsed = parseOutpoint(overlayKey);
            const isUtxo = active.services?.isUtxo;
            let unspent = false;
            if (parsed && typeof isUtxo === "function") {
              try {
                const result = await isUtxo({
                  txid: parsed.txid,
                  vout: parsed.vout,
                } as never);
                unspent =
                  result === true ||
                  (!!result &&
                    typeof result === "object" &&
                    (result as { isUtxo?: unknown }).isUtxo === true);
              } catch {
                unspent = false;
              }
            }
            if (!unspent) {
              const { spentStatusOfOutpoint } = await import("./legacyScan");
              const status = await spentStatusOfOutpoint(
                overlayKey,
                active.chain
              ).catch(() => "unknown" as const);
              unspent = status === "unspent";
            }
            if (unspent) {
              releaseConsumedUtxo(overlayKey, "restore:blank-seal-unspent");
              deadSealer = true;
            }
          }
          if (!deadSealer) {
            keptSpent += 1;
            continue;
          }
        }

        try {
          let spentBy = positiveId(output.spentBy);
          if (spentBy != null) {
            // Storage spentBy is also a signed-cheque claim. Evidence heal or
            // reclaim clears it; generic change restore never guesses.
            keptSpent += 1;
            continue;
          }

          const creatorId = positiveId(output.transactionId);
          const creator =
            creatorId != null ? await loadTxRow(sp, creatorId, txCache) : null;
          if (creatorTxid) {
            const rowTxid = txidFromRow(creator ?? {})?.toLowerCase();
            if (rowTxid !== creatorTxid) continue;
          }
          const creatorLiveness = txLivenessFromStatus(creator?.status);
          const sats = Math.max(0, Math.trunc(Number(output.satoshis) || 0));
          const isChangeOutput = output.change === true || sats > 1;
          const localChange =
            isChangeOutput && creatorLiveness === "pending" && spentBy == null;
          const settledChange =
            isChangeOutput &&
            creatorLiveness === "settled" &&
            spentBy == null &&
            output.spendable !== true;
          const orphanRecoveredChange =
            isChangeOutput &&
            spentBy == null &&
            output.spendable !== true &&
            creatorLiveness === "none";

          // Spend-path restore stays local (toolbox raw tx). Chain fetches belong
          // on Refresh — they stall Review when explorers are slow or down.
          const healed = await healLockingScript(sp, output, txCache, {
            fromChain: false,
          });
          if (healed == null && !hasLockingScript(output)) {
            unscripted += 1;
            continue;
          }

          if (onlyLiveChange) {
            if (!localChange) continue;
          } else if (!localChange && !settledChange && !orphanRecoveredChange) {
            continue;
          }

          await sp.updateOutput(outputId, {
            spendable: true,
            spentBy: undefined,
            ...(healed != null ? { lockingScript: healed } : {}),
          });
          restored += 1;
        } catch (err) {
          console.warn(
            "[stale-output] restore skipped",
            outputId,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    });

    if (restored > 0) {
      console.info(
        `[stale-output] restored ${restored} live change output(s) previously marked unspendable`
      );
    }
    if (keptSpent > 0) {
      console.info(
        `[stale-output] left ${keptSpent} locally-spent input(s) unspendable (network lag)`
      );
    }
    if (unscripted > 0) {
      logDiag("stale-output", "warn", "unscripted-skipped", {
        count: unscripted,
      });
    }
    return { restored, unscripted };
  } catch (err) {
    console.warn("[stale-output] restore failed", err);
    return empty;
  }
}
